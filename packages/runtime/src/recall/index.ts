/**
 * Recall: the embedding model, and everything that turns it into an answer.
 *
 * The split is the same one `local-model/` makes — the parts that decide are
 * pure and tested directly, and the part that touches the machine is one small
 * class with its seams injected:
 *
 * - `prefixes.ts` is the task instructions the model was trained with. Nothing
 *   enforces them, so they are one function each and everything that embeds a
 *   string goes through them.
 * - `chunk.ts` is how a file becomes pieces a vector can stand for, and the only
 *   thing that ever cuts one, so a hit can be shown as the lines it came from.
 * - `client.ts` is the HTTP shape, including the request form the published docs
 *   get wrong, and the checks that keep a NaN or a wrong-width vector out of an
 *   index where it would never match and never be noticed.
 * - `service.ts` is the second engine's life: started on demand, one request at a
 *   time, stopped after five idle minutes.
 */
export {EmbeddingClient, EmbeddingError} from './client.js';
export type {
  EmbeddingClientOptions,
  EmbeddingPart,
  EmbeddingResult,
} from './client.js';

export {CHUNK_CHARS, CHUNK_OVERLAP_CHARS, chunkText} from './chunk.js';
export type {ChunkOptions, TextChunk} from './chunk.js';

export {
  CONVERSATION_SOURCE,
  ConversationWatermarkStore,
  MAX_CONVERSATION_CHARS,
  conversationSlice,
  renderConversationText,
} from './conversations.js';
export type {
  ConversationEvent,
  ConversationSlice,
  ConversationWatermarkStoreOptions,
} from './conversations.js';

export {
  frameTimes,
  MEDIA_EXTENSIONS,
  MEDIA_KINDS,
  MAX_MEDIA_BYTES,
  mediaKindOf,
} from './media.js';
export type {MediaKind} from './media.js';

export {documentText, QUERY_PREFIX, queryText} from './prefixes.js';

export {RECALL_IDLE_MS, RecallEngine} from './engine.js';
export type {RecallEngineOptions} from './engine.js';

export {RECALL_INDEX_FILE, RecallService, recallIndexDir} from './service.js';
export type {
  MemoryIndexState,
  RecallAnswer,
  RecallHit,
  RecallIndexStatus,
  RecallQuery,
  RecallScope,
  RecallServiceOptions,
} from './service.js';

export {
  REFRESH_CHUNKS,
  REFRESH_CONVERSATIONS,
  REFRESH_FILES,
  REFRESH_MEDIA,
  memoryBullets,
  refreshIndex,
} from './indexer.js';
export type {
  ConversationSource,
  ConversationSummary,
  IndexCoverage,
  MediaSource,
  MemoryBullet,
  RefreshOptions,
  RefreshResult,
} from './indexer.js';

export {
  DEFAULT_LIMIT,
  DEFAULT_PER_SOURCE,
  MAX_LIMIT,
  MIN_SCORE,
  searchVectors,
} from './search.js';
export type {SearchHit, SearchOptions} from './search.js';

export {
  digestOf,
  emptyIndex,
  INDEX_FILE,
  INDEX_VERSION,
  indexMatchesModel,
  MEMORY_SOURCE,
  normalize,
  previewOf,
  readIndex,
  removeIndex,
  VECTORS_FILE,
  writeIndex,
} from './store.js';
export type {
  FileStamp,
  IndexData,
  IndexFile,
  IndexModel,
  IndexRecord,
} from './store.js';
