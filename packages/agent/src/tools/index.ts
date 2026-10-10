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
import {MemoryStore} from '../memory/index.js';
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
import type {CatalogTool, CapabilityPreset} from '@marimo/protocol';

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

/**
 * The same grants, in the three sizes a person who has never seen a tool list
 * can choose between.
 *
 * The tiers are *reach*, not harmlessness, and the third stops short of
 * `run_shell` on purpose: every preset here is something somebody could hand to
 * a friend without a paragraph of warning, and running commands on their
 * computer is not. It is one switch away in the power screen, beside the tool
 * list that explains what it does.
 *
 * The middle tier is `SAFE_DEFAULT_TOOLS` itself rather than a copy of it, so
 * the recommended choice and what a brand-new agent is granted cannot drift —
 * and a tool added there appears in the card without anybody remembering to.
 */
export const CAPABILITY_PRESETS: readonly CapabilityPreset[] = [
  {
    id: 'chat',
    label: 'Just chat',
    blurb:
      'It answers questions and remembers what you tell it. It cannot open ' +
      'your files.',
    tools: ['current_time', 'read_memory', 'update_memory', 'prune_memory'],
    recommended: false,
  },
  {
    id: 'assistant',
    label: 'Help around my computer',
    blurb:
      'It can read files in the folder you load, search the web, and note ' +
      'things down for next time. Nothing on this list changes anything.',
    tools: [...SAFE_DEFAULT_TOOLS],
    recommended: true,
  },
  {
    id: 'capable',
    label: 'Do things for me',
    blurb:
      'Everything above, plus writing files, fetching a page you name, ' +
      'keeping lists and setting up jobs that run on a schedule. Anything ' +
      'that changes something still asks you first.',
    tools: [
      ...SAFE_DEFAULT_TOOLS,
      'write_file',
      'http_fetch',
      'list_jobs',
      'create_job',
      'update_job',
      'delete_job',
      'list_todos',
      'add_todo',
      'update_todo',
      'remove_todo',
      'list_notes',
      'add_note',
      'update_note',
      'remove_note',
      'spawn_agent',
      'save_skill',
    ],
    recommended: false,
  },
];

/**
 * The presets, narrowed to the tools this install actually has.
 *
 * An install with no Discord bot and no desk has neither set of tools, and a
 * card that promised them would be the same failure as a switch for a tool that
 * does not exist: something the user chose that grants nothing. Intersecting
 * here means the window can write exactly the list it was handed, and there is
 * no second place where the rule about missing tools lives.
 */
export function capabilityPresets(
  available: Iterable<string>,
): CapabilityPreset[] {
  const names = new Set(available);
  return CAPABILITY_PRESETS.map((preset) => ({
    ...preset,
    tools: preset.tools.filter((name) => names.has(name)),
  }));
}

/**
 * Every tool this install can offer, described the way the model is told about
 * it.
 *
 * Built by constructing the tools rather than by keeping a second list of names
 * and descriptions. A hand-written catalogue drifts: somebody renames a tool or
 * rewrites its description for the model and the settings screen goes on
 * offering the old wording — or worse, the old name, which grants nothing when
 * it is ticked.
 *
 * Nothing here runs: a tool's description is a property of the tool, and the
 * memory store it is handed is not read until `execute`.
 */
export function describeTools(options: {
  workspaceRoot: string;
  model: string;
  webSearch?: WebSearchProvider;
  subagent?: boolean;
  /**
   * Which of the app's services are wired.
   *
   * These have to be named, because the tools they bring are only built when the
   * service is there — and a tool that is built but not *listed* can never be
   * granted, which is a capability that exists and is unreachable. That is not
   * hypothetical: the scheduling and skill tools were missing from this list
   * until a test compared it against what the host actually builds.
   */
  jobs?: boolean;
  skills?: boolean;
  discord?: boolean;
  desk?: boolean;
}): CatalogTool[] {
  const built = createTools(
    {
      apiKey: '',
      baseUrl: '',
      model: options.model,
      temperature: 0,
      systemPrompt: '',
      workspaceRoot: options.workspaceRoot,
      allowPrivateNetworkFetch: false,
    },
    {
      memory: new MemoryStore({workspaceRoot: options.workspaceRoot}),
      model: options.model,
      ...(options.webSearch ? {webSearch: options.webSearch} : {}),
      // Present when the host offers helpers at all; the profile decides whether
      // this profile may use them, which is what the pick-list is for.
      ...(options.subagent === true
        ? {subagent: {build: () => ({}) as never}}
        : {}),
      /*
       * Stand-ins. Nothing here is executed — a description is a property of the
       * tool — so the services only need to exist, not to work.
       */
      ...(options.jobs === true ? {jobService: {} as never} : {}),
      ...(options.skills === true ? {skillService: {} as never} : {}),
      ...(options.discord === true ? {discordService: {} as never} : {}),
      ...(options.desk === true ? {deskService: {} as never} : {}),
    },
  );

  const granted = new Set<string>(SAFE_DEFAULT_TOOLS);
  return built.map((tool) => ({
    name: tool.name,
    description: tool.description,
    blurb: blurbFor(tool.name),
    byDefault: granted.has(tool.name),
  }));
}

/**
 * What a tool does, in words for somebody who has never seen a tool list.
 *
 * A separate map rather than a rewrite of the descriptions above, which are
 * addressed to the model and are better for it — "the same contents are already
 * included in your system prompt" is a useful sentence to an agent and a
 * baffling one to a person.
 *
 * `blurbFor` throws on a name it does not know, and the test beside this file
 * builds every tool and calls it. That is the whole guard: adding a tool without
 * a blurb is a failing test rather than a settings screen with a blank line on
 * it, which is what it would otherwise be — a checkbox nobody can make a
 * decision about.
 */
function blurbFor(name: string): string {
  const blurb = TOOL_BLURBS[name];
  if (blurb === undefined) {
    throw new Error(
      `No plain-language description for the tool "${name}". Add one to ` +
        'TOOL_BLURBS: the settings screen shows it beside the switch, and a ' +
        'switch with nothing beside it is one nobody can decide about.',
    );
  }
  return blurb;
}

const TOOL_BLURBS: Record<string, string> = {
  current_time:
    'What time it is, and what day. Without this it has no idea, and would guess.',
  read_file: 'Open a text file in your folder and read it.',
  list_dir: 'See what is in a folder, with file sizes.',
  search_knowledge_base:
    'Search your folder for a word or phrase and show the lines it appears on.',
  write_file:
    'Create a file, or overwrite one. It asks before replacing a file that already exists.',
  run_shell:
    'Run a command on your computer. This is the broadest thing on this list — ' +
    'it asks every time, and it is worth leaving off unless you want it.',
  http_fetch:
    'Download a web page it has been given the address of. Unlike a search, the ' +
    'address can be anywhere — including inside your own network — so it is off ' +
    'until you ask for it.',
  web_search: 'Search the web and read the results. No account or key needed.',
  read_memory: 'Read its own notes about you and this folder.',
  update_memory:
    'Write something down to remember for next time — a preference, a decision, ' +
    'how something is set up. It keeps these in a file in your folder.',
  prune_memory:
    'Tidy those notes up when they get repetitive or out of date, keeping a copy ' +
    'of the previous version.',
  spawn_agent:
    'Hand a piece of work to a helper with the same abilities, and get its answer ' +
    'back. Helpers cannot see your conversation and cannot ask you anything.',
  list_jobs: 'See what it has been asked to do on a schedule.',
  create_job:
    'Set up something to run on its own later — a summary every morning, a check ' +
    'every hour. It asks before creating one.',
  update_job: 'Change when a scheduled job runs, or what it does.',
  delete_job: 'Remove a scheduled job.',
  save_skill:
    'Write down a procedure it worked out, so it can follow the same steps next ' +
    'time instead of working them out again.',
  list_todos: 'See the to-do list.',
  add_todo: 'Add something to the to-do list.',
  update_todo: 'Tick something off, or change it.',
  remove_todo: 'Delete something from the to-do list.',
  list_notes: 'Read the notes it has kept for you.',
  add_note: 'Write a note.',
  update_note: 'Edit a note.',
  remove_note: 'Delete a note.',
  send_discord_message: 'Post a message to your Discord server.',
  read_discord_messages: 'Read recent messages in a Discord channel.',
  list_discord_channels: 'See which Discord channels it can reach.',
};

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
  return baseTools(config, deps);
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

  /*
   * The helper tool, with the rest and therefore *before* the profile's
   * selection.
   *
   * It used to be appended afterwards, which meant it was never filtered: a
   * profile that had switched helpers off — or allowed nothing at all — was
   * still offered `spawn_agent`, while the settings screen drew a checkbox for
   * it and the catalogue listed it as grantable. The checkbox did nothing, and
   * the README's claim that a tool which is off is not offered was false for
   * this one tool.
   *
   * Depth is still one by construction: `deps.subagent.build` builds an agent
   * from this same function without this dependency, so a helper has no way to
   * ask for one of its own.
   */
  if (deps.subagent) {
    tools.push(createSpawnAgentTool(deps.subagent));
  }

  const granted = filterTools(tools, config.enabledTools);

  /*
   * `save_skill` is added after the profile's selection rather than inside it.
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
  /*
   * Every built-in name this build can produce — computed from the tools that
   * were *built*, before the profile filter, and including the two that are
   * added after it.
   *
   * `tools` covers everything up to and including the helper tool. `save_skill`
   * is not in it, because that one is pushed into `granted` below. Both have to
   * be here: a name the profile has switched off still belongs to the built-in
   * that owns it, because the profile can change between turns.
   */
  const reserved = new Set([...tools.map((tool) => tool.name), 'save_skill']);
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
