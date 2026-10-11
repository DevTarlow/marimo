/**
 * The Electron-free half of Marimo Agent.
 *
 * Everything here runs in two places: inside the Electron main process, and
 * inside the headless job runner, which is the same binary started as plain Node
 * with no `app`, no window and no display. That is why this package imports
 * nothing from Electron, and why paths and secrets arrive as arguments rather
 * than being looked up — see `paths.ts` and `secrets.ts` for why each seam is
 * where it is.
 *
 * The stores are re-exported rather than reimplemented: `jobs.json` has exactly
 * one reader and one writer, and the app and the runner are two callers of it
 * rather than two versions of it.
 */

/* Where everything lives. */
export {
  defaultUserDataDir,
  resolveAppPaths,
  secretFile,
  secretFileName,
} from './paths.js';
export type {AppPaths} from './paths.js';

/* Secrets, with the cipher injected. */
export {FileSecretStore} from './secrets.js';
export type {SecretCipher, SecretRead} from './secrets.js';

/* The agent's memory suggestions, waiting for an answer. */
export {
  MAX_PENDING_PROPOSALS,
  MemoryProposalStore,
} from './memory-proposals.js';
export type {
  MemoryProposalStoreOptions,
  NewProposal,
} from './memory-proposals.js';

/* Waking the job runner when the app is closed. */
export {
  planService,
  runnerEnvironment,
  SERVICE_LABEL,
  SERVICE_UNIT,
} from './service/plan.js';
export type {
  PlannedCommand,
  PlannedFile,
  ServicePlan,
  ServicePlatform,
  ServiceProbe,
  ServiceSpec,
} from './service/plan.js';
export {
  installService,
  nodeServiceHost,
  serviceState,
  uninstallService,
} from './service/apply.js';
export type {
  CommandResult,
  ServiceFailure,
  ServiceHost,
  ServiceOutcome,
  ServiceState,
} from './service/apply.js';

/* A lock that works between processes, for the files they share. */
export {
  FileLockTimeoutError,
  holdProcessLock,
  isProcessHeld,
  processIsAlive,
  withFileLock,
} from './lock.js';
export type {FileLockOptions, ProcessLock, ProcessLockOptions} from './lock.js';

/*
 * The model the app runs itself.
 *
 * Here rather than in the desktop app because both halves of the app need it —
 * the window to answer a question, the headless runner to run a job with the
 * window closed — and this is the package both of them already share.
 */
export {
  bundledModelDir,
  defaultGpuLayers,
  engineArgs,
  freePort,
  LOCAL_CONTEXT_SIZE,
  LocalModelService,
  localModelPidFile,
  localModelSpec,
  MODEL_DIR_ENV,
  MODEL_FILE_NAME,
  resolveLocalModelFiles,
} from './local-model/index.js';
export type {
  EngineSpec,
  LocalModelFiles,
  LocalModelOptions,
  LocalModelSpec,
} from './local-model/index.js';

/*
 * Format versions, and refusing to overwrite a document we cannot read.
 *
 * Re-exported from `@marimo/agent`, where it lives — the conversation index
 * needs the same rule and cannot import from here, and one implementation is
 * better than two. Kept in this package's public API so a caller still finds it
 * beside the stores that use it.
 */
export {
  assertWritable,
  DOCUMENT_VERSION,
  DocumentTooNewError,
  quarantineDocument,
  readVersionedDocument,
} from '@marimo/agent';
export type {
  DocumentMigration,
  DocumentRead,
  ReadVersionedOptions,
} from '@marimo/agent';

/* The agent, assembled from what the user configured. */
export {AgentRuntime} from './agent/runtime.js';
export type {
  AgentRuntimeOptions,
  HostResult,
  RuntimeServices,
} from './agent/runtime.js';
export {parseProfile, resolveAgentConfig} from './agent/resolve.js';
export {createJobRunner} from './agent/job-runner.js';
export type {JobRunnerOptions} from './agent/job-runner.js';
/*
 * What the floating companion asks for, in words. Exported because the settings
 * screen describes the three lengths and the agent is the thing that acts on
 * them; a second copy of these sentences in the renderer is a second thing to
 * keep true.
 */
export {turnInstruction} from './agent/pet-turn.js';
export type {
  ResolvedAgent,
  ResolveAgentOptions,
  StoredSkillForPrompt,
} from './agent/resolve.js';

/* MCP servers: which exist, which are up, and where their credentials live. */
export {
  McpManager,
  mcpSecretFile,
  secretReaderFor,
} from './agent/mcp-manager.js';
export type {
  McpConnectionState,
  McpManagerOptions,
  McpStatus,
} from './agent/mcp-manager.js';

/* Scheduled jobs. */
export {DEFAULT_SCHEDULE, isPlaceholder, JobStore} from './jobs.js';
export type {JobRunRecord, JobStoreOptions, NewJob} from './jobs.js';

/* The thing that runs them. */
export {JobScheduler} from './scheduler.js';
export type {JobRunner, JobSchedulerOptions} from './scheduler.js';

/* The jobs rail's pure reading of a job, shared with the window. */
export {
  jobBadge,
  jobTone,
  lastRunLabel,
  relativeWhen,
  sortJobs,
  visibleJobs,
  weekdayName,
} from './job-rules.js';
export type {JobTone} from './job-rules.js';

/* Agents. */
export {
  LastProfileError,
  ProfileStore,
  UnknownProfileError,
} from './profiles.js';
export type {
  ProfileFile,
  ProfileSeed,
  ProfileSnapshot,
  ProfileStoreOptions,
} from './profiles.js';

/* The folders every agent works in. */
export {
  WorkspaceStore,
  workspaceLabel,
  workspaceRootFor,
} from './workspaces.js';
export type {LegacyWorkspaces, WorkspaceStoreOptions} from './workspaces.js';

/* Preferences. */
export {
  defaultStoredSettings,
  readLegacyProfileSeed,
  SettingsStore,
} from './settings.js';

/* Skills. */
export {
  DuplicateSkillNameError,
  normaliseName,
  ReservedSkillNameError,
  SkillStore,
  SkillTooLongError,
} from './skills.js';
export type {SkillDraft, SkillStoreOptions} from './skills.js';
