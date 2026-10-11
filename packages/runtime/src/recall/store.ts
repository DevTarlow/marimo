/**
 * The index, as two files that can always be thrown away.
 *
 * This is the one document in the app that is *not* version-guarded the way
 * everything else is, and the difference is deliberate enough to say out loud.
 * Every other file the app owns is the user's — a conversation, a job, their
 * agents — and a newer or unreadable one is refused rather than replaced, because
 * a lenient read plus a write is how somebody's data disappears. An index is not
 * that. It is a cache of things that are still on disk: memory.md, the files in
 * the folder, the stored conversations. So a version, a model or a width that does
 * not match is a **rebuild**, an unreadable file is deleted, and the worst thing
 * that can happen is time spent embedding again. Refusing it would be a feature
 * that stops working after an upgrade for no reason at all.
 *
 * Two files rather than one, because they have nothing in common but a length:
 *
 *   index.json    what each vector stands for, and what it was built from
 *   vectors.bin   the vectors, `Float32Array`, `count * dims` of them
 *
 * The JSON is the commit point: it is written last, and it carries the count, so
 * a crash between the two writes leaves a file that describes vectors which are
 * not there — which is exactly the case the length check below catches.
 *
 * Vectors are stored **unit length**, normalized on the way in. The engine
 * already returns L2-normalized vectors, but "already" is a fact about a build
 * somebody else made; normalizing here means a query is a dot product and never a
 * division, and it means a vector written by one engine version is comparable
 * with one written by another.
 */
import {createHash} from 'node:crypto';
import {mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

/**
 * The format's version.
 *
 * Bumped when a reader would misinterpret an old file, never for a change a
 * reader can absorb: adding a field to a record is absorbed by a parse that
 * ignores what it does not know, and renumbering the meaning of `startLine`
 * is not.
 */
export const INDEX_VERSION = 1;

export const INDEX_FILE = 'index.json';

/**
 * How many vectors one index may hold.
 *
 * A bound rather than a target, and it exists because of what a search does with
 * the file: the whole vector array is read into memory and scored, on a machine
 * already holding a 4.7B model. At 768 dimensions a record is 3 KB, so this is
 * about 150 MB at the ceiling — past which the answer is not "a bigger index" but
 * "this folder is not the one to index whole".
 *
 * Fifty thousand chunks is roughly a large monorepo, or six copies of this one.
 */
export const MAX_RECORDS = 50_000;
export const VECTORS_FILE = 'vectors.bin';

/**
 * The `path` a memory bullet's record carries.
 *
 * Not a path at all, and named so a reader cannot mistake it for one: memory
 * lives beside the index rather than inside the folder being indexed, and a
 * record set that mixed the two would send `resolveInsideWorkspace` after a file
 * called `(memory)`.
 */
export const MEMORY_SOURCE = '(memory)';

/** One vector's worth of provenance. */
export interface IndexRecord {
  /** Whether this points into the folder, or at the agent's memory file. */
  kind: 'text' | 'memory';
  /**
   * For text, the path relative to the workspace root — relative because the
   * index travels with the folder, and an absolute path in it would be wrong the
   * moment the folder moved. For memory, `MEMORY_SOURCE`.
   */
  path: string;
  /** Text only: the first and last line this vector stands for, 1-based. */
  startLine?: number;
  endLine?: number;
  /** Memory only: the `##` heading the bullet lives under. */
  section?: string;
  /**
   * A digest of the text this vector stands for.
   *
   * The whole reason a hit can be trusted: a chunk is hashed when it is
   * embedded and hashed again when it is shown, so a file edited since the index
   * was built is reported as changed rather than quoted from a copy that no
   * longer matches it.
   */
  sha256: string;
}

/*
 * There is deliberately no `preview` field here, and there was one.
 *
 * It stored the first line of every chunk, which meant this file held snippets of
 * every file the app had read — and this file lives *inside the folder it
 * describes*, where a `git add -A` puts it in a commit and a shared branch. The
 * promise made to the user is that an index holds positions and digests rather
 * than content, and a preview quietly broke it for a saving that turns out not to
 * exist: every hit that is actually returned is read back from its source anyway,
 * to check the digest, so the preview was a copy of text the caller already had.
 *
 * `previewOf` below still exists — it renders one line from text that is already
 * in hand.
 */

/** A file as the index last saw it, for deciding what changed. */
export interface FileStamp {
  path: string;
  size: number;
  mtimeMs: number;
}

export interface IndexFile {
  version: number;
  /** What built it, so a different model means a rebuild rather than a guess. */
  model: {repo: string; revision: string; dims: number};
  builtAt: string;
  /** How many vectors `vectors.bin` must hold. */
  count: number;
  /** One per vector, in vector order: record `i` is vector `i`. */
  records: IndexRecord[];
  /** The files whose text is indexed, for the incremental refresh. */
  files: FileStamp[];
  /** The digest of memory.md when its bullets were last embedded. */
  memoryHash?: string;
}

export interface IndexData {
  file: IndexFile;
  vectors: Float32Array;
}

export interface IndexModel {
  repo: string;
  revision: string;
  dims: number;
}

/** What an empty index looks like, for a folder nobody has indexed yet. */
export function emptyIndex(model: IndexModel, now: Date = new Date()): IndexFile {
  return {
    version: INDEX_VERSION,
    model,
    builtAt: now.toISOString(),
    count: 0,
    records: [],
    files: [],
  };
}

/**
 * The index, or `undefined` when there is not a usable one.
 *
 * Every reason to say no is the same answer — build it again — so they are not
 * distinguished: an absent file, a file from another format version, one built by
 * a different model or a different width, and one whose vector file is the wrong
 * length are all "there is no index here". A *newer* version is included in that,
 * which is the one place this contradicts the rest of the app, and the reason is
 * at the top of this file.
 *
 * `model` is asked for rather than left to the caller to compare, and that is
 * deliberate: a caller who forgets would get vectors of the right *shape* and the
 * wrong *meaning*, scoring every question against a model that did not produce
 * them. It did happen — the first version of this function checked structure only
 * and left the comparison to its three callers — so the check lives where it
 * cannot be skipped.
 */
export async function readIndex(
  dir: string,
  model?: IndexModel,
): Promise<IndexData | undefined> {
  let raw: string;
  try {
    raw = await readFile(join(dir, INDEX_FILE), 'utf8');
  } catch {
    return undefined;
  }

  let file: IndexFile;
  try {
    file = JSON.parse(raw) as IndexFile;
  } catch {
    return undefined;
  }
  if (!isUsable(file)) {
    return undefined;
  }
  if (model !== undefined && !indexMatchesModel(file, model)) {
    return undefined;
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(join(dir, VECTORS_FILE));
  } catch {
    return undefined;
  }
  if (bytes.byteLength !== file.count * file.model.dims * 4) {
    return undefined;
  }

  /*
   * Copied rather than viewed over the buffer it was read into. A `Buffer` that
   * `readFile` returns is not guaranteed to start on a four-byte boundary, and a
   * `Float32Array` view over a misaligned offset does not throw — it reads every
   * number from the wrong byte and returns faithfully garbage vectors.
   */
  const vectors = new Float32Array(file.count * file.model.dims);
  Buffer.from(vectors.buffer).set(bytes);

  return {file, vectors};
}

/** Whether a parsed document is one this build can use. */
function isUsable(file: IndexFile): boolean {
  if (file === null || typeof file !== 'object') {
    return false;
  }
  if (file.version !== INDEX_VERSION) {
    return false;
  }
  const {model} = file;
  if (
    model === null ||
    typeof model !== 'object' ||
    typeof model.repo !== 'string' ||
    typeof model.revision !== 'string' ||
    typeof model.dims !== 'number' ||
    model.dims <= 0
  ) {
    return false;
  }
  if (
    typeof file.count !== 'number' ||
    file.count < 0 ||
    !Array.isArray(file.records) ||
    file.records.length !== file.count ||
    !Array.isArray(file.files)
  ) {
    return false;
  }
  return true;
}

/** Whether this index was built from the model that is pinned now. */
export function indexMatchesModel(
  file: IndexFile,
  model: IndexModel,
): boolean {
  return (
    file.model.repo === model.repo &&
    file.model.revision === model.revision &&
    file.model.dims === model.dims
  );
}

/**
 * Writes both files, vectors first.
 *
 * Temp-then-rename for each, so a reader never sees a half-written one, and in
 * this order so a crash in between leaves an index.json that still names the
 * vectors of the *previous* build — which the length check then refuses. The
 * other order would leave a vectors.bin whose bytes are the new ones and whose
 * description is the old one, which is the one combination that would be read as
 * valid and be wrong.
 */
export async function writeIndex(dir: string, data: IndexData): Promise<void> {
  await mkdir(dir, {recursive: true});

  const vectors = join(dir, `${VECTORS_FILE}.tmp`);
  await writeFile(vectors, Buffer.from(data.vectors.buffer, 0, data.vectors.byteLength));
  await rename(vectors, join(dir, VECTORS_FILE));

  const index = join(dir, `${INDEX_FILE}.tmp`);
  await writeFile(index, `${JSON.stringify(data.file, null, 2)}\n`, 'utf8');
  await rename(index, join(dir, INDEX_FILE));
}

/** Removes both files. Used by Forget, and by a rebuild that has gone wrong. */
export async function removeIndex(dir: string): Promise<void> {
  await rm(join(dir, VECTORS_FILE), {force: true});
  await rm(join(dir, INDEX_FILE), {force: true});
}

/**
 * A vector of unit length.
 *
 * An all-zero vector has no direction to preserve and is returned as it was:
 * every score against it is zero, which is the honest answer, and dividing by a
 * zero norm would put NaNs into the file the client went to some trouble to keep
 * them out of.
 */
export function normalize(vector: Float32Array): Float32Array {
  let total = 0;
  for (const value of vector) {
    total += value * value;
  }
  const length = Math.sqrt(total);
  if (length === 0) {
    return vector;
  }
  const unit = new Float32Array(vector.length);
  for (const [index, value] of vector.entries()) {
    unit[index] = value / length;
  }
  return unit;
}

/** The digest a record carries, for the text it stands for. */
export function digestOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** The longest preview stored with a record, in characters. */
const PREVIEW_CHARS = 160;

/**
 * One line, for a result list.
 *
 * The first line with anything on it, whitespace collapsed: a chunk usually opens
 * with a function signature or a heading, and that is what a person scanning a
 * list needs. A chunk of pure punctuation or an empty line gives an empty string,
 * which the caller renders as the path alone rather than as a blank row.
 */
export function previewOf(text: string): string {
  for (const line of text.split('\n')) {
    const trimmed = line.trim().replaceAll(/\s+/gu, ' ');
    if (trimmed.length > 0) {
      return trimmed.length > PREVIEW_CHARS
        ? `${trimmed.slice(0, PREVIEW_CHARS)}…`
        : trimmed;
    }
  }
  return '';
}
