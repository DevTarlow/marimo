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
export type {
  SecretCipher,
  SecretRead,
  SecretWriterOptions,
} from './secrets.js';

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
export type {
  FileLockOptions,
  ProcessLock,
  ProcessLockOptions,
} from './lock.js';

/* Format versions, and refusing to overwrite a document we cannot read. */
export {
  assertWritable,
  DOCUMENT_VERSION,
  DocumentTooNewError,
  quarantineDocument,
  readVersionedDocument,
} from './migrations.js';
export type {
  DocumentMigration,
  DocumentRead,
  ReadVersionedOptions,
} from './migrations.js';

/* The agent, assembled from what the user configured. */
export {AgentRuntime} from './agent/runtime.js';
export type {
  AgentRuntimeOptions,
  HostResult,
  RuntimeServices,
} from './agent/runtime.js';
export {
  activeWorkspaceRoot,
  parseProfile,
  resolveAgentConfig,
} from './agent/resolve.js';
export {createJobRunner} from './agent/job-runner.js';
export type {JobRunnerOptions} from './agent/job-runner.js';
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
export {
  DEFAULT_SCHEDULE,
  isPlaceholder,
  JobStore,
} from './jobs.js';
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
  workspaceLabel,
} from './profiles.js';
export type {
  ProfileFile,
  ProfileSeed,
  ProfileSnapshot,
  ProfileStoreOptions,
} from './profiles.js';

/* Preferences. */
export {
  chooseModel,
  defaultAvailableModels,
  defaultStoredSettings,
  mergeProviders,
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
