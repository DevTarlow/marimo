/**
 * Recall, in the window's process.
 *
 * The counterpart of `local-model.ts` for the second engine, and it differs from
 * it in three ways that are the whole of this file.
 *
 * **One service per profile and folder, kept.** The runtime drops its cached
 * runner whenever the service changes identity — a runner holds the tool closures
 * it was built with — so a supplier that built a fresh object per turn would
 * rebuild the agent on every message. The cache key is what the service was
 * derived from, so switching folders replaces it once, which is right: the tool's
 * confinement changed.
 *
 * **Memory is read through the agent's own store.** The service is given a
 * `readMemory`, and it is a `MemoryStore` rather than a file path, because which
 * file memory lives in is that store's business and a second derivation here
 * would be a second opinion about it.
 *
 * **The index lives with the folder it describes**, in `<folder>/.marimo/<agent>/
 * recall/`, the way memory does. Nothing about a project's vectors belongs in the
 * user's config directory, and a folder that moves takes its index with it.
 */
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';

import {MemoryStore, resolveAgentDataDir} from '@marimo/agent';
import {
  EMBEDDING_PINS,
  RecallEngine,
  RecallService,
  embeddingPidFile,
  engineDir,
  installEmbeddingPiece,
  installEngine,
  recallDir,
  recallPiecesInstalled,
  recallSpec,
  resolveRecallFiles,
} from '@marimo/runtime';
import type {DownloadProgress} from '@marimo/runtime';
import type {RecallModelStatus, StoredSettings} from '@marimo/protocol';

export interface RecallHostOptions {
  /** Where the user-data directory is, so the model and the pid file agree. */
  userData: string;
  /**
   * The settings, read per call.
   *
   * A function rather than a value for the same reason the tier is one: the user
   * can turn recall on and off while the window is open, and a copy taken at
   * startup would be a switch that only worked after a restart.
   */
  readSettings: () => Promise<Pick<StoredSettings, 'recall'>>;
  onProgress?: (progress: DownloadProgress & {piece: 'text' | 'media'}) => void;
  onInstalled?: (piece: 'text' | 'media') => void;
  onFailed?: (message: string) => void;
  onIndexed?: (counts: {records: number; chunks: number; memory: number}) => void;
  spawnImpl?: typeof import('node:child_process').spawn;
  fetchImpl?: typeof fetch;
}

export class RecallHost {
  private readonly engine: RecallEngine;
  private readonly services = new Map<
    string,
    {key: string; service: RecallService; memory: MemoryStore}
  >();
  private downloading: AbortController | undefined;
  private progress: RecallModelStatus['installing'];

  constructor(private readonly options: RecallHostOptions) {
    this.engine = new RecallEngine({
      spec: async () =>
        recallSpec({
          dir: this.dir,
          manifest: EMBEDDING_PINS,
          /*
           * Media is off until the projector is a thing this build downloads and
           * uses. The pin knows both pieces, so the card can still say what the
           * second download would cost — but a service that passed a projector
           * path nobody has fetched would be an engine that fails to load a file.
           */
          media: false,
        }),
      pidFile: embeddingPidFile(this.options.userData),
      dims: EMBEDDING_PINS.weights.dims,
      log: (line) => {
        console.log(line);
      },
      ...(this.options.spawnImpl === undefined
        ? {}
        : {spawnImpl: this.options.spawnImpl}),
      ...(this.options.fetchImpl === undefined
        ? {}
        : {fetchImpl: this.options.fetchImpl}),
    });
  }

  /** The directory the recall engine and its weights live in. */
  private get dir(): string {
    return recallDir({userData: this.options.userData});
  }

  /**
   * The service this profile and folder should be given, or `undefined`.
   *
   * `undefined` when recall is off, which is what makes a capability the user
   * switched off *absent* rather than discouraged: the runtime hands the host
   * nothing, and the tool is not built.
   */
  async serviceFor(
    profileId: string,
    workspaceRoot?: string,
  ): Promise<RecallService | undefined> {
    const settings = await this.options.readSettings();
    if (!settings.recall.enabled) {
      return undefined;
    }

    const root =
      workspaceRoot !== undefined &&
      workspaceRoot.length > 0 &&
      settings.recall.workspace
        ? workspaceRoot
        : undefined;
    const indexDir =
      root === undefined
        ? join(this.options.userData, 'recall', profileId)
        : join(resolveAgentDataDir(root, profileId), 'recall');
    const key = `${root ?? ''}\u0000${indexDir}`;

    const existing = this.services.get(profileId);
    if (existing !== undefined && existing.key === key) {
      return existing.service;
    }

    const memory = new MemoryStore({
      workspaceRoot: root ?? this.options.userData,
      profileId,
    });
    const service = new RecallService({
      ...(root === undefined ? {} : {workspaceRoot: root}),
      dir: indexDir,
      model: {
        repo: EMBEDDING_PINS.weights.repo,
        revision: EMBEDDING_PINS.weights.revision,
        dims: EMBEDDING_PINS.weights.dims,
      },
      embed: async (texts) => await this.engine.embedText(texts),
      ...(settings.recall.memory
        ? {readMemory: async () => await memory.read()}
        : {}),
    });
    this.services.set(profileId, {key, service, memory});
    return service;
  }

  /** The card's read: what is installed, what is running, what is indexed. */
  async status(
    profileId: string,
    workspaceRoot?: string,
  ): Promise<RecallModelStatus> {
    const settings = await this.options.readSettings();
    const files = resolveRecallFiles({
      dir: this.dir,
      manifest: EMBEDDING_PINS,
      media: false,
    });
    const engine = await this.engine.status();
    const installed = recallPiecesInstalled({
      dir: this.dir,
      manifest: EMBEDDING_PINS,
    });
    const service = await this.serviceFor(profileId, workspaceRoot);
    const index =
      service === undefined
        ? {records: 0, chunks: 0, memory: 0, changed: 0}
        : await service.status();

    return {
      enabled: settings.recall.enabled,
      media: false,
      state: engine.state,
      ...(engine.detail === undefined ? {} : {detail: engine.detail}),
      enginePresent: files.enginePresent,
      textPresent: files.modelPresent || installed.includes('text'),
      projectorPresent: installed.includes('media'),
      sizeBytes: {
        text: EMBEDDING_PINS.weights.pieces.text.bytes,
        media: EMBEDDING_PINS.weights.pieces.media.bytes,
      },
      command: engine.command,
      log: engine.log,
      ...(this.progress === undefined ? {} : {installing: this.progress}),
      index,
    } as RecallModelStatus;
  }

  /**
   * Fetches the engine and a piece of the model, reporting progress as it goes.
   *
   * Answers as soon as the download has *started*: the caller is an `invoke`, and
   * a call that blocked for half a gigabyte is one nobody could cancel.
   */
  async install(piece: 'text' | 'media'): Promise<{started: boolean}> {
    if (this.downloading !== undefined) {
      return {started: false};
    }
    const controller = new AbortController();
    this.downloading = controller;
    void this.fetch(piece, controller);
    return {started: true};
  }

  cancel(): {cancelled: boolean} {
    if (this.downloading === undefined) {
      return {cancelled: false};
    }
    this.downloading.abort();
    return {cancelled: true};
  }

  /** Indexes the folder the window is looking at, in one bounded pass. */
  async reindex(
    profileId: string,
    workspaceRoot?: string,
  ): Promise<{records: number; chunks: number; memory: number}> {
    const service = await this.serviceFor(profileId, workspaceRoot);
    if (service === undefined) {
      return {records: 0, chunks: 0, memory: 0};
    }
    const status = await service.reindex();
    const counts = {
      records: status.records,
      chunks: status.chunks,
      memory: status.memory,
    };
    this.options.onIndexed?.(counts);
    return counts;
  }

  /** Throws this folder's index away. The files are untouched. */
  async forget(
    profileId: string,
    workspaceRoot?: string,
  ): Promise<{forgotten: boolean}> {
    const service = await this.serviceFor(profileId, workspaceRoot);
    if (service === undefined) {
      return {forgotten: false};
    }
    await service.forget();
    return {forgotten: true};
  }

  /** Stops the engine. Called as the app goes away. */
  async stop(): Promise<void> {
    await this.engine.stop();
  }

  private async fetch(
    piece: 'text' | 'media',
    controller: AbortController,
  ): Promise<void> {
    try {
      /*
       * The engine first, then the weights — the order the chat model's install
       * has, and for the same reason: it is the cheap half, and a platform this
       * build has no engine for should be refused before 310 MB is spent.
       */
      await installEngine({
        dir: this.dir,
        manifest: EMBEDDING_PINS,
        onProgress: (progress) => {
          this.report('text', {...progress, label: 'The recall engine'});
        },
        signal: controller.signal,
        ...(this.options.fetchImpl === undefined
          ? {}
          : {fetchImpl: this.options.fetchImpl}),
      });

      await installEmbeddingPiece({
        dir: this.dir,
        manifest: EMBEDDING_PINS,
        piece,
        onProgress: (progress) => {
          this.report(piece, progress);
        },
        signal: controller.signal,
        ...(this.options.fetchImpl === undefined
          ? {}
          : {fetchImpl: this.options.fetchImpl}),
      });
      this.options.onInstalled?.(piece);
    } catch (failure) {
      // A cancelled download is not a failure to report: the user asked for it.
      if (!controller.signal.aborted) {
        this.options.onFailed?.(describe(failure));
      }
    } finally {
      this.downloading = undefined;
      this.progress = undefined;
    }
  }

  private report(
    piece: 'text' | 'media',
    progress: DownloadProgress,
  ): void {
    this.progress = {
      piece,
      label: progress.label,
      receivedBytes: progress.receivedBytes,
      totalBytes: progress.totalBytes,
      ...(progress.percent === undefined ? {} : {percent: progress.percent}),
    };
    this.options.onProgress?.({...progress, piece});
  }

  /** Reads a file, so a caller can tell a missing model from a refused one. */
  static async exists(file: string): Promise<boolean> {
    try {
      await readFile(file);
      return true;
    } catch {
      return false;
    }
  }

  /** The engine's directory, for a card that shows where things live. */
  get enginePath(): string {
    return engineDir(this.dir);
  }
}

function describe(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}
