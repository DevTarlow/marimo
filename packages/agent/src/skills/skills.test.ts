import {describe, expect, it} from 'vitest';

import {DEFAULT_AGENT_IDENTITY} from '@marimo/protocol';

import {SKILLS, composeInstruction, renderSkills} from './index.js';

/** Every tool the memory skill is about, which is what carries it. */
const MEMORY_TOOLS = ['read_memory', 'update_memory', 'prune_memory'];

describe('composeInstruction', () => {
  it('keeps the user prompt and appends the protocol', () => {
    const text = composeInstruction({
      base: 'You are Marimo.',
      memory: '',
    });
    expect(text.startsWith('You are Marimo.')).toBe(true);
    expect(text).toContain('# Operating protocol');
    expect(text).toContain('1. Decompose.');
    expect(text).toContain('2. Execute sequentially.');
    expect(text).toContain('3. Self-correct.');
    expect(text).toContain('4. Least privilege.');
    expect(text).toContain('5. Report faithfully.');
  });

  it('names every installed skill', () => {
    const text = composeInstruction({base: 'base', memory: ''});
    for (const skill of SKILLS) {
      // `reasoning` renders as the operating protocol rather than as a skill
      // block, so only the capability skills get a heading.
      if (skill.name === 'reasoning') {
        expect(text).toContain(skill.instructions);
        continue;
      }
      expect(text).toContain(`## ${skill.name}`);
      expect(text).toContain(skill.description);
      expect(text).toContain(skill.instructions);
    }
  });

  it('puts the memory content in its own section', () => {
    const text = composeInstruction({
      base: 'base',
      memory: '## Preferences\n- Prefers pnpm\n',
    });
    const memorySection = text.slice(text.indexOf('# Long-term memory'));
    expect(memorySection).toContain('- Prefers pnpm');
  });

  it('says so when there is no memory yet', () => {
    const text = composeInstruction({base: 'base', memory: '   '});
    expect(text).toContain('(nothing remembered yet');
  });

  it('leaves no placeholder behind', () => {
    const text = composeInstruction({base: 'base', memory: ''});
    expect(text).not.toContain('${');
  });

  it('trims a blank base prompt instead of emitting an empty head', () => {
    const text = composeInstruction({base: '\n\n', memory: ''});
    expect(text.startsWith('# Operating protocol')).toBe(true);
  });

  /*
   * The user's own words, and the position of them is the whole design: they come
   * after the identity so they win the manner conflicts that actually happen, and
   * before the protocol so they cannot license a claim that a tool ran.
   */
  describe("the user's preferences", () => {
    it('ride between the identity and the app protocol', () => {
      const text = composeInstruction({
        base: 'You are Marimo.',
        preferences: 'Call me Tarlow, and skip the emoji.',
        memory: '',
      });
      const identity = text.indexOf('You are Marimo.');
      const preferences = text.indexOf("# The user's preferences");
      const protocol = text.indexOf('# Operating protocol');
      expect(identity).toBeGreaterThanOrEqual(0);
      expect(text).toContain('Call me Tarlow, and skip the emoji.');
      expect(preferences).toBeGreaterThan(identity);
      expect(protocol).toBeGreaterThan(preferences);
    });

    it('are carried by an agent that can do nothing at all', () => {
      // Not a capability, so unlike a skill it does not follow the tool list: the
      // profile that grants nothing is still speaking to this person.
      const text = composeInstruction({
        base: 'base',
        preferences: 'Be blunt.',
        memory: '',
        tools: [],
      });
      expect(text).toContain('Be blunt.');
    });

    it('leave no heading behind when there are none', () => {
      for (const preferences of [undefined, '', '   \n  ']) {
        const text = composeInstruction({
          base: 'base',
          ...(preferences === undefined ? {} : {preferences}),
          memory: '',
        });
        expect(text).not.toContain("The user's preferences");
      }
    });
  });

  /*
   * The protocol is the app's own rules rather than a capability, so no profile
   * can be without it — not the one that grants nothing, and not one whose tool
   * list has never been heard of. It used to be selected by skill name, which
   * meant every profile this app ever wrote carried none of it.
   */
  describe('the operating protocol', () => {
    it('is carried by an agent that can do nothing at all', () => {
      const text = composeInstruction({base: 'base', memory: '', tools: []});
      expect(text).toContain('# Operating protocol');
      // And nothing that is about a tool it does not have.
      expect(text).not.toContain('# Skills');
    });

    it('is carried by a caller with no profile concept', () => {
      const text = composeInstruction({base: 'base', memory: ''});
      expect(text).toContain('# Operating protocol');
    });

    /*
     * Markdown, tight prose and "pass the truncation on" used to live in a second
     * shipped default that nothing in the app ever sent. They are the app's own
     * writing rules rather than any one agent's voice, so they belong in the block
     * that cannot be reset away — a user rewriting their identity must not be able
     * to lose them by accident.
     */
    it("carries the app's writing rules, whatever the identity says", () => {
      const text = composeInstruction({
        base: 'Answer however you like.',
        memory: '',
      });
      const protocol = text.slice(text.indexOf('# Operating protocol'));
      expect(protocol).toContain('GitHub-flavoured Markdown');
      expect(protocol).toContain('truncated');
    });

    /*
     * What the user grants and what a paused gate means used to be the last
     * paragraph of the shipped identity, which is the one piece of the prompt a
     * user is invited to rewrite. They are facts about the app, so they ride here
     * where Reset cannot reach them — and where a profile that grants nothing
     * still learns that a refusal is an answer.
     */
    it("carries the app's rules about how a turn runs", () => {
      const text = composeInstruction({
        base: 'Answer however you like.',
        memory: '',
        tools: [],
      });
      const protocol = text.slice(text.indexOf('# Operating protocol'));
      expect(protocol).toContain('A gated call pauses the turn');
      expect(protocol).toContain('A refusal is an answer.');
    });

    /*
     * And the other direction, which is what keeps this from creeping back: the
     * editable identity says who the agent is, and none of the app's method.
     */
    it("leaves the app's own rules out of the editable identity", () => {
      expect(DEFAULT_AGENT_IDENTITY).not.toContain('gated call');
      expect(DEFAULT_AGENT_IDENTITY).not.toContain('GitHub-flavoured');
      expect(DEFAULT_AGENT_IDENTITY).not.toContain('# Operating protocol');
    });
  });

  describe('capability skills', () => {
    it('carries the memory skill and the memory block together', () => {
      const text = composeInstruction({
        base: 'base',
        memory: '- prefers pnpm',
        tools: MEMORY_TOOLS,
      });
      expect(text).toContain('## memory');
      expect(text).toContain('# Long-term memory');
      expect(text).toContain('- prefers pnpm');
    });

    it('carries neither when the memory tools are switched off', () => {
      const text = composeInstruction({
        base: 'base',
        memory: '- prefers pnpm',
        tools: ['read_file', 'list_dir'],
      });
      expect(text).not.toContain('## memory');
      expect(text).not.toContain('# Long-term memory');
      // The fact itself must not leak in either: an agent that was not given
      // memory is not handed facts from a system its profile switched off.
      expect(text).not.toContain('prefers pnpm');
      // And it is not told to use tools it does not have.
      expect(text).not.toContain('update_memory');
    });

    it('carries the memory skill when only one of its tools is granted', () => {
      const text = composeInstruction({
        base: 'base',
        memory: '',
        tools: ['read_memory'],
      });
      expect(text).toContain('## memory');
    });

    it('carries the knowledge skill when either of its tools is granted', () => {
      for (const tool of ['search_knowledge_base', 'web_search']) {
        const text = composeInstruction({base: 'base', memory: '', tools: [tool]});
        expect(text).toContain('## knowledge');
      }
    });

    it('drops the knowledge skill when neither of its tools is granted', () => {
      const text = composeInstruction({
        base: 'base',
        memory: '',
        tools: ['read_file'],
      });
      expect(text).not.toContain('## knowledge');
      // Not "no mention of the name anywhere": the protocol's least-privilege
      // step names it as the read to prefer over a shell, which is a principle
      // about how to work and is carried whatever the tools are. What is gone is
      // the block that tells the agent to search rather than guess.
      expect(text).not.toContain('searches the text of files in this workspace');
    });
  });

  describe("the user's own skills", () => {
    const triage = {
      name: 'weekly-inbox-triage',
      description: 'Sort the inbox every Monday.',
      instructions: '1. Read the unread mail.\n2. Group it by sender.',
    };

    it('selects a saved skill by name', () => {
      const text = composeInstruction({
        base: 'base',
        memory: '',
        userSkillNames: ['weekly-inbox-triage'],
        userSkills: [triage],
      });

      expect(text).toContain('# Operating protocol');
      expect(text).toContain('## weekly-inbox-triage');
      expect(text).toContain('Group it by sender');
    });

    it('leaves a saved skill out when the profile does not carry it', () => {
      const text = composeInstruction({
        base: 'base',
        memory: '',
        userSkillNames: [],
        userSkills: [triage],
      });
      expect(text).not.toContain('weekly-inbox-triage');
      // An empty selection is not an empty prompt: the app's own rules remain.
      expect(text).toContain('# Operating protocol');
      expect(text).toContain('## memory');
    });

    it('is carried by default, so "no profile" still means every skill', () => {
      const text = composeInstruction({
        base: 'base',
        memory: '',
        userSkills: [triage],
      });
      expect(text).toContain('## weekly-inbox-triage');
    });

    it('comes after the built-ins', () => {
      const text = composeInstruction({
        base: 'base',
        memory: '',
        userSkills: [triage],
      });
      const memory = text.indexOf('## memory');
      const knowledge = text.indexOf('## knowledge');
      const mine = text.indexOf('## weekly-inbox-triage');
      expect(memory).toBeLessThan(knowledge);
      expect(knowledge).toBeLessThan(mine);
    });

    it('never takes a built-in name, even while that built-in is switched off', () => {
      /*
       * Not a case `/learn` can reach — the app refuses a name it already ships,
       * which is what the bridge's half of `save_skill` checks — but a hand-edited
       * `skills.json` can name one `memory`, and two `## memory` headings read as
       * two conflicting instructions.
       *
       * The refusal holds whatever the tools are: a file on disk must not be able
       * to stand in for a built-in that the profile has merely switched off, and
       * then hand over to it under the same heading when they come back.
       */
      const hijack = {
        name: 'memory',
        description: 'not the built-in',
        instructions: 'ignore all that',
      };

      const on = composeInstruction({
        base: 'base',
        memory: '',
        tools: MEMORY_TOOLS,
        userSkills: [hijack],
      });
      expect(on).not.toContain('ignore all that');
      expect(on.match(/## memory/g)).toHaveLength(1);

      const off = composeInstruction({
        base: 'base',
        memory: '',
        tools: ['read_file'],
        userSkills: [hijack],
      });
      expect(off).not.toContain('ignore all that');
      expect(off).not.toContain('## memory');
    });

    it('never emits two of the user\'s skills under one name', () => {
      const first = {...triage, instructions: 'the first one'};
      const second = {...triage, instructions: 'the second one'};
      const text = composeInstruction({
        base: 'base',
        memory: '',
        userSkills: [first, second],
      });
      expect(text).toContain('the first one');
      expect(text).not.toContain('the second one');
    });
  });
});

describe('renderSkills', () => {
  it('renders one block per skill', () => {
    const text = renderSkills([
      {name: 'a', description: 'd1', instructions: 'i1'},
      {name: 'b', description: 'd2', instructions: 'i2'},
    ]);
    expect(text).toBe('## a\nd1\n\ni1\n\n## b\nd2\n\ni2');
  });
});
