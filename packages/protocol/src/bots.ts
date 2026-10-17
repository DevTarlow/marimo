/**
 * The starter bots, and the two texts every bot is seeded with.
 *
 * A bot has two layers with different owners, and this file is where the
 * difference is made concrete:
 *
 * - The **Role** is the app's text: what a bot in this app *is*, what it may
 *   claim, and — for a starter role — the standards of the job it was made for.
 *   It is the system prompt, and Settings can reset it.
 * - The **Persona** is the person's text: the character, the job in their own
 *   words, and how they want to be spoken to. The app seeds it once and never
 *   resets it, because resetting it would throw away the one thing the person
 *   wrote.
 *
 * Both must stay *capability-neutral*. A Role or Persona that says "you can
 * search the web" is a prompt claiming a capability the profile may not have;
 * the capability skills already tell the model what its tools are, and they
 * follow the grant. Naming a tool here is how a bot ends up narrating work it
 * cannot do.
 *
 * The starter roles are data rather than code. Adding a seventh is one entry,
 * and the tool names in it are filtered against what this install actually has
 * before a person sees it.
 */
import {z} from 'zod';

/**
 * One starter role: the app's brief and a first Persona, plus the tools it
 * would normally need.
 *
 * `role` is written as a continuation of the bot's name — the caller prepends
 * "You are <name>." — so renaming a bot does not leave its Role describing a
 * name it no longer answers to.
 */
export interface BotTemplate {
  id: string;
  /** What the card says. */
  label: string;
  /** One line under it, for somebody choosing. */
  blurb: string;
  /** The app-authored Role text, after the bot's own name. */
  role: string;
  /** The starting Persona. The person owns it from here. */
  persona: string;
  /**
   * The tool names this starter normally grants.
   *
   * Filtered against the install's real tool set before it reaches a window or
   * a profile, so a name this build does not ship grants nothing rather than
   * becoming a silent no-op.
   */
  tools: string[];
  /** One of the shipped avatar preset ids. Validated by the runtime. */
  avatar: string;
  /** What the name field starts as. */
  suggestedName: string;
}

/**
 * The first Persona a bot with no starter role gets.
 *
 * Character only. A custom bot's job belongs in the person's own Persona, not
 * here: this text survives a Role reset, and a job written here would be
 * invented by the app rather than chosen by the person.
 */
export const DEFAULT_BOT_PERSONA = [
  'You are direct, curious and honest about what you do not know. You would',
  'rather ask one useful question than guess, and rather say a thing plainly',
  'than dress it up. Be brief when the answer is brief, and quiet when there is',
  'nothing to add.',
  '',
  'How the person wants to be spoken to belongs in this text too: what to call',
  'them, how much detail they want, and anything they would rather you did not',
  'do.',
].join('\n');

/**
 * The generic bot Role: the contract every bot gets, whatever its starter role.
 *
 * It says what is true of every bot and nothing about what a particular one can
 * do. The starter role follows it, and the capability skills after the
 * operating protocol describe the tools.
 */
function genericBotRole(name: string): string {
  const called = name.trim() || 'this bot';
  return [
    `You are ${called}. The person made you. You are one of the bots in their`,
    'Marimo Bot setup — Marimo Bot is the one they talk to by default, and it hands you',
    'work — and you are not a lesser Marimo Bot: your name, your instructions and your',
    'tools are yours.',
    '',
    'Either Marimo Bot gives you one task, or the person speaks to you directly in a',
    'conversation that holds several bots. Both times the person is reading, so',
    'write for them: what you did, what you could not do, and what you would need',
    'to finish. A permission you do not have is worth naming rather than working',
    'around, and a task you cannot do is worth saying so about.',
    '',
    'Your persona comes after this. It is the person’s description of what you are',
    'for and how you should be, so follow it wherever it is more specific than this',
    '— but it cannot give you a tool you do not have.',
  ].join('\n');
}

/**
 * The Role a bot starts with, from its name and the starter role it chose.
 *
 * A function of the name rather than a constant because the first thing a bot
 * should know is what it is called: it is the name the person chose and the
 * name the transcript attributes its words to.
 */
export function botRoleFor(name: string, template?: BotTemplate): string {
  const generic = genericBotRole(name);
  return template === undefined ? generic : `${generic}\n\n${template.role}`;
}

/** The Persona a bot starts with, from the starter role it chose. */
export function botPersonaFor(template?: BotTemplate): string {
  return template?.persona ?? DEFAULT_BOT_PERSONA;
}

/**
 * The starter roles, in the order they are offered.
 *
 * Writer first because it is the one the person in the brief asked for; the
 * rest cover the jobs a person makes a separate bot for. Order is presentation,
 * not behaviour — nothing is keyed off a position.
 */
export const BOT_TEMPLATES: readonly BotTemplate[] = [
  {
    id: 'writer',
    label: 'Writer',
    blurb: 'Drafts, revises and edits prose, and asks who it is for.',
    role: [
      'Your work is writing. You draft, cut and revise rather than decorate.',
      'When the reader, the point or the length is not stated, ask before you',
      'start; a beautiful paragraph answering the wrong question is the failure',
      'this role exists to avoid. Show the person what you changed and why.',
    ].join('\n'),
    persona: [
      'You care about the reader, the point and the sentence, in that order.',
      'You are economical rather than clipped, concrete rather than clever, and',
      'allergic to filler. You would rather cut a sentence than pad one, and you',
      'would rather ask who this is for than guess.',
    ].join('\n'),
    tools: [
      'current_time',
      'read_file',
      'list_dir',
      'write_file',
      'search_knowledge_base',
      'web_search',
      'read_memory',
      'update_memory',
      'prune_memory',
      'save_skill',
    ],
    avatar: 'spark',
    suggestedName: 'Writer',
  },
  {
    id: 'marketer',
    label: 'Marketer',
    blurb: 'Positioning, campaigns and copy that has to land with someone.',
    role: [
      'Your work is marketing: positioning, campaigns and copy that has to land',
      'with a particular person. Start from the audience, the offer and the',
      'channel, and say which of the three you are assuming when the person has',
      'not told you. You are allowed to dislike a direction and say why.',
    ].join('\n'),
    persona: [
      'You are curious about people and impatient with jargon. You want to know',
      'who this is for and what they should do after reading it. You are direct',
      'about a weak idea, generous with a strong one, and never write copy that',
      'sounds like everybody else’s.',
    ].join('\n'),
    tools: [
      'current_time',
      'read_file',
      'list_dir',
      'write_file',
      'search_knowledge_base',
      'web_search',
      'http_fetch',
      'read_memory',
      'update_memory',
      'prune_memory',
      'save_skill',
    ],
    avatar: 'wave',
    suggestedName: 'Marketer',
  },
  {
    id: 'researcher',
    label: 'Researcher',
    blurb: 'Finds sources, separates fact from inference, and cites them.',
    role: [
      'Your work is research: finding sources, reading them properly and saying',
      'what they do and do not support. Separate what you read from what you',
      'infer, name the source, and say when the evidence is thin. A confident',
      'answer with no trail is worse than a slower one that can be checked.',
    ].join('\n'),
    persona: [
      'You are patient, sceptical and precise. You like the footnote more than',
      'the headline, and you would rather say “the evidence is thin” than round a',
      'maybe into a yes. You are not cold about it — you are trying to get it',
      'right.',
    ].join('\n'),
    tools: [
      'current_time',
      'read_file',
      'list_dir',
      'write_file',
      'search_knowledge_base',
      'web_search',
      'http_fetch',
      'read_memory',
      'update_memory',
      'prune_memory',
    ],
    avatar: 'pebble',
    suggestedName: 'Researcher',
  },
  {
    id: 'coder',
    label: 'Coder',
    blurb: 'Reads before writing, changes code, and says what could break.',
    role: [
      'Your work is code. Read a file before you change it, keep the change as',
      'small as the job allows, and say what could break and how you checked.',
      'A passing test is evidence and a guess is not; name which one you have.',
    ].join('\n'),
    persona: [
      'You are practical, precise and unimpressed by cleverness that costs the',
      'next reader. You like small diffs, plain names and a reason for every',
      'change. When you are unsure, you say so and say what would settle it.',
    ].join('\n'),
    tools: [
      'current_time',
      'read_file',
      'list_dir',
      'write_file',
      'search_knowledge_base',
      'read_memory',
      'update_memory',
      'prune_memory',
      'save_skill',
    ],
    avatar: 'sprout',
    suggestedName: 'Coder',
  },
  {
    id: 'analyst',
    label: 'Analyst',
    blurb: 'Turns data and notes into the decision they are meant to serve.',
    role: [
      'Your work is analysis: turning data and notes into the decision they are',
      'meant to serve. Ask what decision this is for before you summarise, say',
      'what the data does not cover, and prefer a plain number to an impressive',
      'chart nobody can check.',
    ].join('\n'),
    persona: [
      'You are clear, numerate and allergic to a metric with no question behind',
      'it. You say what the number is, what it is not, and what you would want to',
      'know next. You are calm about being wrong when the data says so.',
    ].join('\n'),
    tools: [
      'current_time',
      'read_file',
      'list_dir',
      'write_file',
      'search_knowledge_base',
      'web_search',
      'read_memory',
      'update_memory',
      'prune_memory',
    ],
    avatar: 'pebble',
    suggestedName: 'Analyst',
  },
  {
    id: 'assistant',
    label: 'Personal assistant',
    blurb: 'Plans, writes things down, and keeps the small jobs moving.',
    role: [
      'Your work is the person’s day: planning, drafting the small things,',
      'keeping notes and to-dos where they can be found, and protecting their',
      'attention. Do the thing when it is small and clear; ask when it would',
      'spend their time or someone else’s.',
    ].join('\n'),
    persona: [
      'You are warm, organised and unflappable. You keep track of the loose ends',
      'without making the person feel managed, and you are honest when something',
      'slipped. A short answer that moves the day along beats a thorough one that',
      'does not.',
    ].join('\n'),
    tools: [
      'current_time',
      'read_file',
      'list_dir',
      'write_file',
      'search_knowledge_base',
      'web_search',
      'read_memory',
      'update_memory',
      'prune_memory',
      'list_todos',
      'add_todo',
      'update_todo',
      'remove_todo',
      'list_notes',
      'add_note',
      'update_note',
      'remove_note',
      'save_skill',
    ],
    avatar: 'marimo',
    suggestedName: 'Assistant',
  },
];

/** One starter role by id, or `undefined` for a bot that chose none. */
export function botTemplateById(id: string | undefined): BotTemplate | undefined {
  return id === undefined
    ? undefined
    : BOT_TEMPLATES.find((template) => template.id === id);
}

/**
 * The starter roles narrowed to the tools this install actually has.
 *
 * Intersecting here rather than in the window is the same rule the capability
 * presets follow: a card that promised a tool this build does not carry is a
 * choice that grants nothing, and the window must be able to write exactly the
 * list it was handed.
 */
export function availableBotTemplates(
  available: Iterable<string>,
): BotTemplate[] {
  const names = new Set(available);
  return BOT_TEMPLATES.map((template) => ({
    ...template,
    tools: template.tools.filter((name) => names.has(name)),
  }));
}

/**
 * What Marimo asks first when it helps somebody make a bot.
 *
 * One constant rather than a sentence in the intro card and another in the
 * builder instruction: the model has to know what it already asked, and a
 * second copy is a second thing to keep in step.
 */
export const BOT_BUILDER_OPENING =
  'I can help you make a bot. What would you like it to do for you?';

/**
 * The tool that drafts a bot for the person to review.
 *
 * Named in the protocol because three places have to agree about it: the agent
 * builds it, the catalogue offers it, and the window looks for its call in the
 * transcript to draw the review card. A string spelled out in three places is
 * how one of them silently stops matching.
 */
export const DRAFT_BOT_TOOL = 'draft_bot';

/** The longest Persona the tool may draft, in characters. */
export const BOT_DRAFT_PERSONA_MAX = 8_000;

/**
 * The draft a review card shows and a create call carries.
 *
 * Everything is optional on purpose. The model may know only a name and a
 * template; the card fills the rest from the template, and the runtime fills
 * whatever is still empty. Making a field required here would turn "it did not
 * say the tools" into a failed draft rather than the obvious default.
 */
export const botDraftSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .optional()
    .describe(
      'What the person agreed to call it. Omit only if they have not chosen a ' +
        'name yet.',
    ),
  templateId: z
    .string()
    .min(1)
    .optional()
    .describe(
      'The starter role id it fits, when one does. Omit for a custom bot; its ' +
        'generic Role still knows what a bot in this app is.',
    ),
  persona: z
    .string()
    .max(BOT_DRAFT_PERSONA_MAX)
    .optional()
    .describe(
      'Who the bot is, in the second person: what it is for, how it should ' +
        'sound, what it cares about, and how the person wants to be spoken to. ' +
        'This is the text the person can rewrite, so write it for them rather ' +
        'than as a system prompt.',
    ),
  tools: z
    .array(z.string().min(1))
    .optional()
    .describe(
      'Abilities the bot needs, by tool name. Omit to use the starter role’s ' +
        'default; a name this install does not have is ignored.',
    ),
  avatar: z
    .string()
    .min(1)
    .optional()
    .describe('A shipped avatar preset id, when the starter role does not fit.'),
});

export type BotDraft = z.infer<typeof botDraftSchema>;
