/**
 * The tool set handed to the root agent.
 *
 * Kept as one factory so a future milestone (or a test) can build an agent with
 * a narrower tool set without touching the agent definition. The order is the
 * order the model sees; it is asserted by a test so a new tool has to be placed
 * deliberately rather than dropped in.
 *
 * `save_skill` is the one tool that is not part of a profile's selection; the
 * comment beside it says why.
 *
 * Gating is declared by the tools themselves: `run_shell` always, and
 * `write_file` only when it would replace an existing file. `web_search` appears
 * only when the host injected a provider, and `GOOGLE_SEARCH` only for a model
 * that supports the built-in. The scheduling, Discord and desk tools appear only
 * when the app injected the service behind them, because a tool the app cannot
 * carry out is a promise the model would make and break.
 */
import type {BaseTool} from '@google/adk';

import type {AgentConfig} from '../config.js';
import type {MemoryStore} from '../memory/index.js';
import {deskTools} from './desk-tools.js';
import type {DeskService} from './desk-tools.js';
import {discordTools} from './discord-tools.js';
import type {DiscordService} from './discord-tools.js';
import {
  createCurrentTimeTool,
  createListDirTool,
  createReadFileTool,
  createWriteFileTool,
} from './fs-tools.js';
import {
  createCreateJobTool,
  createDeleteJobTool,
  createListJobsTool,
  createUpdateJobTool,
} from './job-tools.js';
import type {JobService} from './job-tools.js';
import {groundingTools} from './grounding.js';
import {createSearchKnowledgeBaseTool} from './knowledge-tools.js';
import {
  createPruneMemoryTool,
  createReadMemoryTool,
  createUpdateMemoryTool,
} from './memory-tools.js';
import {createShellTool} from './shell-tool.js';
import {createSpawnAgentTool} from './subagent-tool.js';
import type {SubagentDeps} from './subagent-tool.js';
import {createSaveSkillTool} from './skill-tools.js';
import type {SkillService} from './skill-tools.js';
import {createHttpFetchTool} from './web-tools.js';
import {createWebSearchTool} from './web-search-tool.js';
import type {WebSearchProvider} from './web-search-tool.js';

import {buildMcpTools} from '../mcp/tools.js';
import type {McpServerConnection, McpToolInfo} from '../mcp/client.js';
import type {McpServer} from '@marimo/protocol';

/**
 * What a brand-new profile may do before the user has chosen anything.
 *
 * The line is not "harmless" but *reach*: everything here can look and nothing
 * here can change the machine or act in the world. Reading a file, listing a
 * directory, remembering something and searching the web are all things a person
 * asking a question would expect an assistant to be able to do; writing,
 * running a command, fetching an arbitrary URL and spawning a helper are all
 * things they would expect to be asked about first.
 *
 * `http_fetch` is the one worth arguing about, since `web_search` also reaches
 * the network. The difference is the destination: a search goes to one known
 * engine, and a fetch goes wherever the model points it, including inside the
 * user's own network.
 */
export const SAFE_DEFAULT_TOOLS = [
  'current_time',
  'read_file',
  'list_dir',
  'search_knowledge_base',
  'read_memory',
  'update_memory',
  'prune_memory',
  'web_search',
] as const;

export interface ToolDependencies {
  /** Shared with the agent's instruction provider, so memory stays one file. */
  memory: MemoryStore;
  /** Model the agent will call; decides whether Gemini grounding applies. */
  model: string;
  /** Present only in the desktop app; without it `web_search` is not offered. */
  webSearch?: WebSearchProvider;
  /**
   * Present only in the desktop app; without it the scheduling tools are not
   * offered, because a job nobody can run is worse than no tool at all.
   */
  jobService?: JobService;
  /**
   * Present only when the desktop app has a Discord bot connected; without it
   * there is no token to post with and no channel to post to, so the tools would
   * be promises the model could not keep.
   */
  discordService?: DiscordService;
  /**
   * Present only in the desktop app; without it the to-do and notes tools are
   * not offered, because there is no document for them to read or write.
   */
  deskService?: DeskService;
  /**
   * Present only when the app has somewhere to keep a user's skills; without it
   * `save_skill` is not offered, and `/learn` has nothing to write with.
   */
  skillService?: SkillService;
  /**
   * The MCP servers that are connected, with the tools each one offers.
   *
   * The connection is passed in rather than made here, because connecting is the
   * app's business: it owns the configuration, the secrets, and the decision to
   * retry. This function only decides what the model is offered.
   */
  mcpServers?: readonly McpToolsetSource[];
  /**
   * How to build a helper agent, when the host offers them at all.
   *
   * Absent means the tool is absent — not "present and discouraged". A helper
   * the profile has switched off must not be something the model can be talked
   * into trying.
   */
  subagent?: SubagentDeps;
}

/** One connected MCP server and what it said it can do. */
export interface McpToolsetSource {
  server: McpServer;
  connection: McpServerConnection;
  tools: readonly McpToolInfo[];
}

export function createTools(
  config: AgentConfig,
  deps: ToolDependencies,
): BaseTool[] {
  const tools = baseTools(config, deps);
  /*
   * Offered last, and only when the host can build a child. Depth is one by
   * construction: `deps.subagent.build` builds an agent from this same function
   * without this dependency, so a helper has no way to ask for one of its own.
   */
  if (deps.subagent) {
    tools.push(createSpawnAgentTool(deps.subagent));
  }
  return tools;
}

function baseTools(config: AgentConfig, deps: ToolDependencies): BaseTool[] {
  const tools: BaseTool[] = [
    createCurrentTimeTool(),
    createReadFileTool({workspaceRoot: config.workspaceRoot}),
    createListDirTool({workspaceRoot: config.workspaceRoot}),
    createWriteFileTool({workspaceRoot: config.workspaceRoot}),
    createSearchKnowledgeBaseTool({workspaceRoot: config.workspaceRoot}),
    createReadMemoryTool({memory: deps.memory}),
    createUpdateMemoryTool({memory: deps.memory}),
    createPruneMemoryTool({memory: deps.memory}),
    createHttpFetchTool({
      allowPrivateNetworkFetch: config.allowPrivateNetworkFetch,
    }),
  ];

  if (deps.webSearch) {
    tools.push(createWebSearchTool({provider: deps.webSearch}));
  }

  tools.push(createShellTool({workspaceRoot: config.workspaceRoot}));
  tools.push(...groundingTools(deps.model));

  /*
   * The desk: the to-do list and the notes. Offered only when the app has the
   * two documents, for the same reason as the scheduling tools — a tool that
   * could not read anything is a promise the model would make and break.
   */
  if (deps.deskService) {
    tools.push(...deskTools({desk: deps.deskService}));
  }

  /*
   * Scheduling is offered only when the app has somewhere to keep jobs. The
   * conversation a job is attached to comes from the running turn rather than
   * from here, so these tools are shared by every conversation of the agent.
   */
  if (deps.jobService) {
    const jobContext = {
      jobs: deps.jobService,
      profileId: config.profileId ?? '',
    };
    tools.push(
      createListJobsTool(jobContext),
      createCreateJobTool(jobContext),
      createUpdateJobTool(jobContext),
      createDeleteJobTool(jobContext),
    );
  }

  /*
   * Discord, likewise: the connection belongs to the app rather than to a
   * conversation, so the tools are shared by every conversation of the agent.
   */
  if (deps.discordService) {
    tools.push(...discordTools({discord: deps.discordService}));
  }

  const granted = filterTools(tools, config.enabledTools);

  /*
   * `save_skill` is added after the profile's selection rather than inside it,
   * and it is the only tool that is.
   *
   * Every other tool is a capability the user grants, so a profile that should
   * not be able to run a shell simply does not list it. This one is the mechanism
   * behind `/learn` — a command the user types — so a profile that predates the
   * command, or one whose checkboxes were saved before it existed, must still be
   * able to run it. It is left out of `profiles.catalog` for the same reason:
   * there is no checkbox, because there is nothing to switch off.
   */
  if (deps.skillService) {
    granted.push(createSaveSkillTool({skills: deps.skillService}));
  }

  /*
   * MCP servers come last, and after the profile's selection rather than inside
   * it. A server has its own `enabled` flag, which is its switch — so there is no
   * per-tool checkbox for `enabledTools` to filter, and a profile that lists
   * sixty built-in tools should not have to list a server's tools too.
   *
   * `reserved` is every built-in name *before* the profile filter, not after.
   * A tool the profile has switched off still owns its name: the profile can be
   * changed between turns, and a server that had quietly taken `read_file` would
   * then be shadowed by the built-in coming back — or worse, the other way round.
   *
   * A name collision throws rather than dropping a tool. That is deliberate and
   * it is why the app checks names when a server connects: by the time this runs,
   * a collision is a programming error, not something a user can be told about
   * usefully in the middle of a turn.
   */
  const reserved = new Set(tools.map((tool) => tool.name));
  for (const source of deps.mcpServers ?? []) {
    granted.push(
      ...buildMcpTools({
        server: source.server,
        connection: source.connection,
        tools: source.tools,
        reserved,
      }),
    );
  }

  return granted;
}

/**
 * Applies the profile's tool selection.
 *
 * `undefined` means the caller has no profile and gets everything; an empty
 * array means the profile deliberately allows nothing, which is a legitimate
 * setting and must not be confused with "unrestricted".
 */
function filterTools(
  tools: BaseTool[],
  enabled: string[] | undefined,
): BaseTool[] {
  if (enabled === undefined) {
    return tools;
  }
  const allowed = new Set(enabled);
  return tools.filter((tool) => allowed.has(tool.name));
}

export {resolveInsideWorkspace, PathOutsideWorkspaceError} from './paths.js';
export {
  createSpawnAgentTool,
  DEFAULT_SUBAGENT_LIMITS,
  SUBAGENT_NAME_PATTERN,
} from './subagent-tool.js';
export type {SubagentDeps, SubagentLimits} from './subagent-tool.js';
