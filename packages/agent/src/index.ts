export {AgentHost, pendingGatesIn} from './host/agent-host.js';
export type {
  AgentHostOptions,
  ApproveParams,
  PendingGate,
} from './host/agent-host.js';

/*
 * MCP servers: one connection each, and the tools they offer.
 */
export {
  buildMcpTools,
  MAX_TOOL_NAME_CHARS,
  McpError,
  McpServerConnection,
  McpToolNameError,
  mcpToolNameFor,
  renderResult,
  sanitiseSchema,
} from './mcp/index.js';
export type {
  McpConnectionOptions,
  McpErrorKind,
  McpResolvedSecrets,
  McpToolBuildOptions,
  McpToolInfo,
} from './mcp/index.js';
/*
 * One OpenAI-compatible client serves every provider. `DeepSeekLlm` remains as
 * an alias of it, because the class was named after the only backend the app had
 * and that name is part of this package's surface.
 */
export {
  OpenAiCompatLlm,
  OpenAiCompatRequestError,
} from './models/openai-compat-llm.js';
export type {OpenAiCompatLlmOptions} from './models/openai-compat-llm.js';
export {DeepSeekLlm, DeepSeekRequestError} from './models/deepseek-llm.js';
export type {DeepSeekLlmOptions} from './models/deepseek-llm.js';
export {FileSessionService} from './sessions/file-session-service.js';
export type {
  AdkEvent,
  SessionIndexEntry,
} from './sessions/file-session-service.js';
export {projectTranscript} from './host/transcript.js';
export {createTools} from './tools/index.js';
export type {McpToolsetSource, ToolDependencies} from './tools/index.js';
export {
  createCreateJobTool,
  createDeleteJobTool,
  createListJobsTool,
  createUpdateJobTool,
  DEFAULT_JOB_SCHEDULE,
} from './tools/job-tools.js';
export type {JobService, JobToolContext} from './tools/job-tools.js';
export {
  createListDiscordChannelsTool,
  createReadDiscordMessagesTool,
  createSendDiscordMessageTool,
  discordTools,
  DISCORD_MESSAGE_LIMIT,
  DISCORD_READ_MAX,
} from './tools/discord-tools.js';
export type {
  DiscordService,
  DiscordToolContext,
} from './tools/discord-tools.js';
export {deskTools} from './tools/desk-tools.js';
export type {
  DeskEdit,
  DeskService,
  DeskToolContext,
} from './tools/desk-tools.js';
export {
  createSaveSkillTool,
  SKILL_INSTRUCTIONS_MAX,
} from './tools/skill-tools.js';
export type {SkillService, SkillToolContext} from './tools/skill-tools.js';
export type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
} from './tools/web-search-tool.js';
export {
  AGENT_DATA_DIR,
  DEFAULT_PROFILE_ID,
  DEFAULT_SECTION,
  MAX_MEMORY_BYTES,
  MEMORY_FILE_NAME,
  MemoryStore,
  MemoryTooLargeError,
  resolveAgentDataDir,
  resolveMemoryFile,
} from './memory/index.js';
export type {
  MemoryPruneRequest,
  MemoryStoreOptions,
  MemoryUpdate,
} from './memory/index.js';
export {SKILLS, composeInstruction} from './skills/index.js';
export type {Skill} from './skills/index.js';
export {
  resolveInsideWorkspace,
  PathOutsideWorkspaceError,
} from './tools/paths.js';
export {DEFAULT_SYSTEM_PROMPT} from './config.js';
export type {AgentConfig} from './config.js';
export {iterateSseData} from './models/sse.js';
export {
  normalizeSchema,
  systemInstructionToText,
  toOpenAiMessages,
  toOpenAiTools,
} from './models/openai-mapping.js';
export type {
  OpenAiMessage,
  OpenAiTool,
  OpenAiToolCall,
} from './models/openai-mapping.js';
