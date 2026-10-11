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
  ConversationWatermarkStore,
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
import type {
  ConversationEvent,
  ConversationSummary,
  DownloadProgress,
  EmbeddingPart,
  MediaKind,
} from '@marimo/runtime';
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
  onIndexed?: (counts: {
    records: number;
    chunks: number;
    memory: number;
    conversations: number;
    media: number;
  }) => void;
  /**
   * The stored conversations, for the third corpus.
   *
   * Injected rather than read here, because conversations belong to the session
   * store and this class has no business knowing where one lives. The indexer
   * asks for the list and then for one conversation's events, which is what keeps
   * a search from reading every transcript in the app to answer one question.
   */
  listConversations?: (
    profileId: string,
  ) => Promise<readonly ConversationSummary[]>;
  readConversation?: (
    profileId: string,
    sessionId: string,
  ) => Promise<{title: string; events: readonly ConversationEvent[]}>;
  /**
   * Media, decoded into the content parts the embedding client takes.
   *
   * The one piece of this that has to be Electron: decoding a sound or a clip
   * needs a browser engine, which is exactly what this process is. Absent when
   * the projector is not installed, which is what makes the `media` scope
   * disappear rather than return nothing.
   */
  decodeMedia?: (path: string, kind: MediaKind) => Promise<EmbeddingPart[]>;
  /**
   * Read indexes and never build one.
   *
   * The headless runner's mode. It may start the engine to embed a question; it is
   * refused the refresh, because a scheduled run has nobody watching it, can be
   * killed mid-write, and must not fight the window over the same files.
   */
  readOnly?: boolean;
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
  /** The media switch the running engine was last seen under; see `serviceFor`. */
  private lastMedia: boolean | undefined;

  constructor(private readonly options: RecallHostOptions) {
    this.engine = new RecallEngine({
      spec: async () =>
        recallSpec({
          dir: this.dir,
          manifest: EMBEDDING_PINS,
          /*
           * The media switch, read per call like everything else here. The
           * projector is only passed when the file is actually on disk —
           * `resolveRecallFiles` checks that — so a switch turned on before the
           * download finishes starts an engine that is ready for text rather than
           * one that fails to load a file that is not there.
           */
          media: (await this.options.readSettings()).recall.media,
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

    /*
     * The engine's argv carries `--mmproj` or it does not, and that is decided
     * when the process is spawned — `ensureRunning` answers with the engine that
     * is already up, whatever the spec now says. So a media switch that moved
     * while one was running has to replace it, or the switch is one that only
     * takes effect after a restart: a media request against a process with no
     * image encoder fails, and the sentence it fails with is about the request.
     * One model load on the next request is the whole cost.
     */
    if (this.lastMedia !== undefined && this.lastMedia !== settings.recall.media) {
      await this.engine.stop();
    }
    this.lastMedia = settings.recall.media;

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
    /*
     * The projector on disk, not the switch: a switch turned on before the
     * download has finished must not offer a media scope whose every request the
     * engine would refuse for a missing encoder.
     */
    const mediaReady =
      settings.recall.media &&
      this.options.decodeMedia !== undefined &&
      resolveRecallFiles({dir: this.dir, manifest: EMBEDDING_PINS, media: true})
        .projectorPresent;
    const conversationsOn =
      settings.recall.conversations &&
      this.options.listConversations !== undefined &&
      this.options.readConversation !== undefined;
    /*
     * What the service was derived from, and new switches belong in here. A
     * cached service keeps the scopes it was built with, so turning media or
     * conversations on without rebuilding would be a switch that only took
     * effect after a restart — and the runtime is told to drop its runner when
     * this object changes identity, which is exactly right for a new tool list.
     */
    const key = [
      root ?? '',
      indexDir,
      settings.recall.memory ? 'memory' : '',
      conversationsOn ? 'conversations' : '',
      mediaReady ? 'media' : '',
      settings.recall.codeQueries ? 'code' : 'search',
    ].join('\u0000');

    const existing = this.services.get(profileId);
    if (existing !== undefined && existing.key === key) {
      return existing.service;
    }

    const memory = new MemoryStore({
      workspaceRoot: root ?? this.options.userData,
      profileId,
    });
    const watermark = new ConversationWatermarkStore({
      file: join(indexDir, 'conversations.json'),
    });
    const list = this.options.listConversations;
    const read = this.options.readConversation;
    const decode = this.options.decodeMedia;

    const service = new RecallService({
      ...(root === undefined ? {} : {workspaceRoot: root}),
      dir: indexDir,
      model: {
        repo: EMBEDDING_PINS.weights.repo,
        revision: EMBEDDING_PINS.weights.revision,
        dims: EMBEDDING_PINS.weights.dims,
      },
      embed: async (texts) => await this.engine.embedText(texts),
      codeQueries: settings.recall.codeQueries,
      ...(this.options.readOnly === true ? {readOnly: true} : {}),
      ...(settings.recall.memory
        ? {readMemory: async () => await memory.read()}
        : {}),
      ...(conversationsOn && list !== undefined && read !== undefined
        ? {
            conversations: {
              list: async () => await list(profileId),
              read: async (sessionId: string) => await read(profileId, sessionId),
            },
            watermark,
          }
        : {}),
      ...(mediaReady && decode !== undefined
        ? {
            media: {
              decode,
              embedParts: async (inputs) => await this.engine.embedParts(inputs),
            },
          }
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
      media: settings.recall.media,
    });
    const engine = await this.engine.status();
    const installed = recallPiecesInstalled({
      dir: this.dir,
      manifest: EMBEDDING_PINS,
    });
    const service = await this.serviceFor(profileId, workspaceRoot);
    const index =
      service === undefined
        ? {records: 0, chunks: 0, memory: 0, conversations: 0, media: 0, changed: 0}
        : await service.status();

    return {
      enabled: settings.recall.enabled,
      media: settings.recall.media,
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
  ): Promise<{
    records: number;
    chunks: number;
    memory: number;
    conversations: number;
    media: number;
  }> {
    const service = await this.serviceFor(profileId, workspaceRoot);
    if (service === undefined) {
      return {records: 0, chunks: 0, memory: 0, conversations: 0, media: 0};
    }
    const status = await service.reindex();
    const counts = {
      records: status.records,
      chunks: status.chunks,
      memory: status.memory,
      conversations: status.conversations,
      media: status.media,
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

      /*
       * The projector lands *after* an engine may already be up, and `--mmproj`
       * is fixed when the process is spawned. An engine started without it has
       * no image encoder in the process at all, so a media request against it
       * fails with a sentence about the request rather than about the earlier
       * start. Stopping it here is what makes the next request start one that
       * carries the projector — cheap, because the engine starts on demand and
       * is idle when nothing is being embedded.
       */
      if (piece === 'media') {
        await this.engine.stop();
      }

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
