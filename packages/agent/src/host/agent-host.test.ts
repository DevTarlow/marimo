/**
 * End-to-end agent tests.
 *
 * These drive the real ADK `Runner`, the real `AgentHost`, the real tool set and
 * the real session store, with only the network replaced by a loopback HTTP
 * server that speaks the DeepSeek streaming protocol. That makes the message
 * translation, the tool-calling loop, and the approval round trip testable
 * without an API key.
 */
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import type {AgentUiEvent} from '@marimo/protocol';

import type {Job} from '@marimo/protocol';

import type {AgentConfig} from '../config.js';

import {resolveMemoryFile} from '../memory/index.js';
import type {JobService} from '../tools/job-tools.js';
import type {WebSearchProvider} from '../tools/web-search-tool.js';
import {AgentHost} from './agent-host.js';

interface RecordedRequest {
  messages: Array<Record<string, unknown>>;
  body: Record<string, unknown>;
}

interface FakeDeepSeek {
  baseUrl: string;
  requests: RecordedRequest[];
  close: () => Promise<void>;
}

type Responder = (
  messages: Array<Record<string, unknown>>,
  callIndex: number,
) => Array<Record<string, unknown>>;

async function startFakeDeepSeek(responder: Responder): Promise<FakeDeepSeek> {
  const requests: RecordedRequest[] = [];

  const server = createServer((request, response) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      raw += chunk;
    });
    request.on('end', () => {
      const body = JSON.parse(raw.length > 0 ? raw : '{}') as Record<
        string,
        unknown
      >;
      const messages = (body['messages'] ?? []) as Array<
        Record<string, unknown>
      >;
      requests.push({messages, body});

      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      });
      for (const chunk of responder(messages, requests.length - 1)) {
        response.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      response.write('data: [DONE]\n\n');
      response.end();
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const {port} = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function textChunks(text: string): Array<Record<string, unknown>> {
  return [
    {choices: [{delta: {content: text}, finish_reason: null}]},
    {choices: [{delta: {}, finish_reason: 'stop'}]},
    {
      choices: [],
      usage: {prompt_tokens: 12, completion_tokens: 4, total_tokens: 16},
    },
  ];
}

/**
 * A turn that thinks first. `reasoning_content` is what the API returns in
 * thinking mode, which is the default.
 */
function reasoningChunks(
  reasoning: string,
  text: string,
): Array<Record<string, unknown>> {
  return [
    {choices: [{delta: {reasoning_content: reasoning}, finish_reason: null}]},
    {choices: [{delta: {content: text}, finish_reason: null}]},
    {choices: [{delta: {}, finish_reason: 'stop'}]},
    {
      choices: [],
      usage: {prompt_tokens: 20, completion_tokens: 8, total_tokens: 28},
    },
  ];
}

function toolCallChunks(
  id: string,
  name: string,
  args: Record<string, unknown>,
): Array<Record<string, unknown>> {
  return [
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id,
                type: 'function',
                function: {name, arguments: JSON.stringify(args)},
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {choices: [{delta: {}, finish_reason: 'tool_calls'}]},
    {
      choices: [],
      usage: {prompt_tokens: 20, completion_tokens: 6, total_tokens: 26},
    },
  ];
}

/**
 * One turn that asks for several calls at once, which is how a turn ends up with
 * more than one approval gate to answer.
 */
function parallelToolCallChunks(
  calls: Array<{id: string; name: string; args: Record<string, unknown>}>,
): Array<Record<string, unknown>> {
  return [
    {
      choices: [
        {
          delta: {
            tool_calls: calls.map((call, index) => ({
              index,
              id: call.id,
              type: 'function',
              function: {name: call.name, arguments: JSON.stringify(call.args)},
            })),
          },
          finish_reason: null,
        },
      ],
    },
    {choices: [{delta: {}, finish_reason: 'tool_calls'}]},
    {
      choices: [],
      usage: {prompt_tokens: 20, completion_tokens: 6, total_tokens: 26},
    },
  ];
}

async function collect(
  stream: AsyncGenerator<AgentUiEvent>,
): Promise<AgentUiEvent[]> {
  const events: AgentUiEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

function typesOf(events: AgentUiEvent[]): string[] {
  return events.map((event) => event.type);
}

/**
 * The identity these fixtures send.
 *
 * A local literal rather than the app's shipped default: what these tests are
 * about is that whatever identity a profile holds reaches the request, and an
 * assertion against the shipped text would fail every time somebody edits it.
 */
const TEST_IDENTITY = 'You are Marimo, a test agent.';

describe('AgentHost', () => {
  let workDir: string;
  let fake: FakeDeepSeek | undefined;
  const openHosts: AgentHost[] = [];

  beforeEach(async () => {
    workDir = await mkdtemp(join(process.cwd(), '.marimo-test-'));
  });

  afterEach(async () => {
    for (const host of openHosts.splice(0)) {
      host.dispose();
    }
    await fake?.close();
    fake = undefined;
    await rm(workDir, {recursive: true, force: true});
  });

  function createConfig(baseUrl: string, apiKey = 'test-key'): AgentConfig {
    return {
      apiKey,
      baseUrl,
      model: 'deepseek-chat',
      temperature: 0,
      systemPrompt: TEST_IDENTITY,
      workspaceRoot: workDir,
      allowPrivateNetworkFetch: false,
    };
  }

  function createHost(
    baseUrl: string,
    apiKey = 'test-key',
    webSearch?: WebSearchProvider,
    jobService?: JobService,
    profileId?: string,
  ): AgentHost {
    const host = new AgentHost({
      sessionsDir: join(workDir, 'sessions'),
      config: {
        ...createConfig(baseUrl, apiKey),
        ...(profileId ? {profileId} : {}),
      },
      ...(webSearch ? {webSearch} : {}),
      ...(jobService ? {jobService} : {}),
    });
    host.init();
    openHosts.push(host);
    return host;
  }

  async function startHost(
    responder: Responder,
    apiKey?: string,
    webSearch?: WebSearchProvider,
  ): Promise<{host: AgentHost; session: string}> {
    fake = await startFakeDeepSeek(responder);
    const host = createHost(fake.baseUrl, apiKey, webSearch);
    const session = await host.createSession();
    return {host, session: session.id};
  }

  it('streams assistant text and reports usage', async () => {
    const {host, session} = await startHost(() =>
      textChunks('Hello from the fake model.'),
    );

    const events = await collect(host.run(session, 'hi'));

    expect(typesOf(events)).toContain('turn.started');
    const deltas = events.filter((event) => event.type === 'text.delta');
    expect(
      deltas
        .map((event) => (event.type === 'text.delta' ? event.text : ''))
        .join(''),
    ).toBe('Hello from the fake model.');

    const completed = events.find((event) => event.type === 'turn.completed');
    expect(completed).toMatchObject({
      type: 'turn.completed',
      usage: {promptTokens: 12, completionTokens: 4, totalTokens: 16},
    });
    expect(typesOf(events)).not.toContain('turn.failed');
  });

  it('sends the system prompt and the tool declarations to the provider', async () => {
    const {host, session} = await startHost(() => textChunks('ok'));
    await collect(host.run(session, 'hi'));

    const request = fake?.requests[0];
    expect(request?.body['stream']).toBe(true);
    expect(request?.body['model']).toBe('deepseek-chat');

    const system = request?.messages[0];
    expect(system).toMatchObject({role: 'system'});
    const systemText = String(system?.['content']);
    expect(systemText).toContain(TEST_IDENTITY);
    // The operating protocol and the memory block ride in the instruction, not
    // in the stored prompt, so even an old saved prompt carries both.
    expect(systemText).toContain('# Operating protocol');
    expect(systemText).toContain('# Long-term memory (memory.md)');

    const tools = request?.body['tools'] as Array<{
      function: {name: string; parameters: unknown};
    }>;
    const names = tools.map((tool) => tool.function.name);
    expect(names).toEqual([
      'current_time',
      'read_file',
      'list_dir',
      'write_file',
      'search_knowledge_base',
      'read_memory',
      'update_memory',
      'prune_memory',
      'http_fetch',
      'run_shell',
      /*
       * Built like every other tool and then filtered by the profile, so a
       * profile that has not granted it does not offer it. That is invariant 9
       * for helpers too: absent, not discouraged.
       */
      'spawn_agent',
    ]);
    expect(tools[1]?.function.parameters).toMatchObject({type: 'object'});

    // The provider validates every declaration on every request, so a numeric
    // bound serialized as a string fails the whole turn, not one tool call:
    // DeepSeek answers `"1" is not of type "integer"` and the request is lost.
    expect(JSON.stringify(tools)).not.toMatch(
      /"(minLength|maxLength|minimum|maximum|minItems|maxItems|multipleOf)":\s*"/,
    );
  });

  it('injects memory.md into the prompt and follows later writes', async () => {
    const {host, session} = await startHost(() => textChunks('ok'));

    await collect(host.run(session, 'first'));
    expect(String(fake?.requests[0]?.messages[0]?.['content'])).toContain(
      '(no memory yet',
    );

    // Anything that writes memory — here the file itself — shows up on the very
    // next request rather than on the next turn.
    await mkdir(join(workDir, '.marimo', 'default'), {recursive: true});
    await writeFile(
      resolveMemoryFile(workDir),
      '## Preferences\n- Prefers pnpm\n',
      'utf8',
    );

    await collect(host.run(session, 'second'));
    const secondSystem = String(fake?.requests[1]?.messages[0]?.['content']);
    expect(secondSystem).toContain('- Prefers pnpm');
  });

  it('runs web_search through the injected provider', async () => {
    const queries: string[] = [];
    const provider: WebSearchProvider = {
      search: async ({query}) => {
        queries.push(query);
        return [
          {
            title: 'Marimo',
            url: 'https://example.com/marimo',
            snippet: 'A reactive notebook',
          },
        ];
      },
    };

    const {host, session} = await startHost(
      (messages) => {
        const hasResult = messages.some(
          (message) => message['role'] === 'tool',
        );
        return hasResult
          ? textChunks('Found it.')
          : toolCallChunks('call_search', 'web_search', {query: 'marimo'});
      },
      'test-key',
      provider,
    );

    const events = await collect(host.run(session, 'search the web'));

    const names = (
      fake?.requests[0]?.body['tools'] as Array<{function: {name: string}}>
    ).map((tool) => tool.function.name);
    expect(names).toContain('web_search');
    expect(queries).toEqual(['marimo']);

    const finished = events.find((event) => event.type === 'tool.finished');
    expect(finished).toMatchObject({type: 'tool.finished', tool: 'web_search'});
    if (finished?.type === 'tool.finished') {
      expect(finished.result).toContain('https://example.com/marimo');
    }
  });

  /*
   * The scheduling tools only exist when the app supplied somewhere to keep
   * jobs, and the conversation a job links back to comes from the running turn:
   * the model never passes a session id, so it cannot point a job at a chat it
   * does not own.
   */
  it('offers the scheduling tools with a job service and links the job to this session', async () => {
    const created: unknown[] = [];
    const jobs: JobService = {
      list: async () => [],
      create: async (input) => {
        created.push(input);
        return {
          id: 'job-1',
          name: input.name,
          description: input.description,
          schedules: input.schedules ?? ['0 9 * * *'],
          enabled: true,
          profileId: input.profileId,
          sessionId: input.sessionId,
          createdAt: '2026-05-01T09:00:00.000Z',
        } satisfies Job;
      },
      update: async () => null,
      remove: async () => false,
    };

    fake = await startFakeDeepSeek((messages) =>
      messages.some((message) => message['role'] === 'tool')
        ? textChunks('Scheduled.')
        : toolCallChunks('call_job', 'create_job', {
            name: 'Morning digest',
            description: 'Summarise new issues.',
            schedules: ['0 9 * * 1-5'],
          }),
    );
    const host = createHost(fake.baseUrl, 'test-key', undefined, jobs);
    const session = await host.createSession();

    const events = await collect(host.run(session.id, 'set that up'));

    const names = (
      fake.requests[0]?.body['tools'] as Array<{function: {name: string}}>
    ).map((tool) => tool.function.name);
    expect(names).toContain('create_job');
    expect(names).toContain('list_jobs');

    // Gated, so the first pass pauses instead of running the tool: nothing was
    // created until the user approved it.
    expect(created).toEqual([]);

    const gate = events.find((event) => event.type === 'approval.request');
    expect(gate).toMatchObject({type: 'approval.request', tool: 'create_job'});

    // Approving resumes the paused call, which is when the job is stamped with
    // the conversation it was asked for in.
    const resumed = await collect(
      host.approve({
        sessionId: session.id,
        callId: gate?.type === 'approval.request' ? gate.callId : '',
        confirmed: true,
      }),
    );
    expect(typesOf(resumed)).toContain('turn.completed');
    expect(created).toEqual([
      {
        name: 'Morning digest',
        description: 'Summarise new issues.',
        sessionId: session.id,
        profileId: '',
        schedules: ['0 9 * * 1-5'],
      },
    ]);
  });

  /*
   * The host answers one turn at a time. The scheduler asks `isBusy` before it
   * dispatches so a job that came due mid-conversation is deferred rather than
   * refused — a refusal would look like a failed job for no reason the user can
   * see.
   */
  it('reports whether a turn is in flight', async () => {
    const {host, session} = await startHost(() => textChunks('done'));

    expect(host.isBusy()).toBe(false);
    expect(host.activeSessionId()).toBeUndefined();

    const stream = host.run(session, 'hi');
    const first = await stream.next();
    expect(first.value).toMatchObject({type: 'turn.started'});
    expect(host.isBusy()).toBe(true);
    expect(host.activeSessionId()).toBe(session);

    await collect(stream);
    expect(host.isBusy()).toBe(false);
    expect(host.activeSessionId()).toBeUndefined();
  });

  it('runs a non-gated tool and feeds the result back', async () => {
    const {host, session} = await startHost((messages) => {
      const hasResult = messages.some((message) => message['role'] === 'tool');
      if (!hasResult) {
        return toolCallChunks('call_time', 'current_time', {});
      }
      const toolMessage = [...messages]
        .reverse()
        .find((message) => message['role'] === 'tool');
      return textChunks(`The clock says: ${String(toolMessage?.['content'])}`);
    });

    const events = await collect(host.run(session, 'what time is it?'));

    const started = events.find((event) => event.type === 'tool.started');
    expect(started).toMatchObject({type: 'tool.started', tool: 'current_time'});

    const finished = events.find((event) => event.type === 'tool.finished');
    expect(finished).toMatchObject({
      type: 'tool.finished',
      tool: 'current_time',
      ok: true,
    });

    const text = events
      .filter((event) => event.type === 'text.delta')
      .map((event) => (event.type === 'text.delta' ? event.text : ''))
      .join('');
    expect(text).toContain('The clock says:');

    expect(fake?.requests).toHaveLength(2);
    expect(
      fake?.requests[1]?.messages.some((message) => message['role'] === 'tool'),
    ).toBe(true);
  });

  it('pauses a gated tool for approval, then runs exactly what was approved', async () => {
    const marker = `marimo-approval-${Date.now()}`;
    const command = `echo ${marker}`;

    const {host, session} = await startHost((messages) => {
      const hasResult = messages.some((message) => message['role'] === 'tool');
      return hasResult
        ? textChunks('The command finished.')
        : toolCallChunks('call_shell', 'run_shell', {command});
    });

    const firstPass = await collect(host.run(session, 'echo the marker'));

    const approval = firstPass.find(
      (event) => event.type === 'approval.request',
    );
    expect(approval).toMatchObject({
      type: 'approval.request',
      tool: 'run_shell',
      args: {command},
    });
    // Nothing may run before the user decides, and the pending call must not be
    // reported as a finished (failed) tool.
    expect(fake?.requests).toHaveLength(1);

    const callId = approval?.type === 'approval.request' ? approval.callId : '';
    expect(callId.length).toBeGreaterThan(0);

    const secondPass = await collect(
      host.approve({sessionId: session, callId, confirmed: true}),
    );

    const finished = secondPass.find((event) => event.type === 'tool.finished');
    expect(finished).toMatchObject({
      type: 'tool.finished',
      tool: 'run_shell',
      ok: true,
    });
    if (finished?.type === 'tool.finished') {
      expect(finished.result).toContain(marker);
    }

    expect(fake?.requests).toHaveLength(2);
    const toolMessage = fake?.requests[1]?.messages.find(
      (message) => message['role'] === 'tool',
    );
    expect(String(toolMessage?.['content'])).toContain(marker);
  });

  it('answers every gate of a round in one message, and only when all are decided', async () => {
    const first = `marimo-round-a-${Date.now()}`;
    const second = `marimo-round-b-${Date.now()}`;

    const {host, session} = await startHost((messages) => {
      const hasResult = messages.some((message) => message['role'] === 'tool');
      return hasResult
        ? textChunks('Both commands finished.')
        : parallelToolCallChunks([
            {id: 'call_a', name: 'run_shell', args: {command: `echo ${first}`}},
            {
              id: 'call_b',
              name: 'run_shell',
              args: {command: `echo ${second}`},
            },
          ]);
    });

    const paused = await collect(host.run(session, 'echo both markers'));
    const gates = paused.filter((event) => event.type === 'approval.request');
    expect(gates).toHaveLength(2);
    // Nothing has run, and the only request is the one that asked for the calls.
    expect(fake?.requests).toHaveLength(1);

    const idOf = (index: number): string => {
      const gate = gates[index];
      return gate?.type === 'approval.request' ? gate.callId : '';
    };

    /*
     * The decision for one gate is held. Resuming here is what produced a
     * request carrying two tool calls and one tool result, which DeepSeek
     * refuses — and, because the gap is in the session, refuses on every later
     * turn of that conversation too.
     */
    const held = await collect(
      host.approve({sessionId: session, callId: idOf(0), confirmed: true}),
    );
    expect(held).toEqual([]);
    expect(fake?.requests).toHaveLength(1);

    const resumed = await collect(
      host.approve({sessionId: session, callId: idOf(1), confirmed: true}),
    );

    const results = resumed
      .filter((event) => event.type === 'tool.finished')
      .map((event) => (event.type === 'tool.finished' ? event.result : ''))
      .join('\n');
    expect(results).toContain(first);
    expect(results).toContain(second);

    // The rule the provider enforces, asserted on what was actually sent: every
    // call the assistant message asked for is answered by a tool message.
    expect(fake?.requests).toHaveLength(2);
    const followUp = fake?.requests[1]?.messages ?? [];
    const asked = followUp
      .filter((message) => message['role'] === 'assistant')
      .flatMap(
        (message) => (message['tool_calls'] ?? []) as Array<{id: string}>,
      )
      .map((call) => call.id);
    const answered = followUp
      .filter((message) => message['role'] === 'tool')
      .map((message) => message['tool_call_id']);
    expect(asked.length).toBeGreaterThan(0);
    expect(answered).toEqual(expect.arrayContaining(asked));
  });

  it('ignores a decision for a gate it is no longer waiting on', async () => {
    const command = `echo marimo-stale-${Date.now()}`;

    const {host, session} = await startHost((messages) => {
      const hasResult = messages.some((message) => message['role'] === 'tool');
      return hasResult
        ? textChunks('Done.')
        : toolCallChunks('call_shell', 'run_shell', {command});
    });

    const paused = await collect(host.run(session, 'echo it'));
    const gate = paused.find((event) => event.type === 'approval.request');
    const callId = gate?.type === 'approval.request' ? gate.callId : '';

    await collect(host.approve({sessionId: session, callId, confirmed: true}));
    expect(fake?.requests).toHaveLength(2);

    // A second click, on a card the window had already taken down.
    const again = await collect(
      host.approve({sessionId: session, callId, confirmed: true}),
    );
    expect(again).toEqual([]);
    expect(fake?.requests).toHaveLength(2);
  });

  it('reports a denial to the model without running the command', async () => {
    const marker = `marimo-denied-${Date.now()}`;
    const command = `echo ${marker}`;

    const {host, session} = await startHost((messages) => {
      const hasResult = messages.some((message) => message['role'] === 'tool');
      return hasResult
        ? textChunks('Understood, not running it.')
        : toolCallChunks('call_shell', 'run_shell', {command});
    });

    const firstPass = await collect(host.run(session, 'run it'));
    const approval = firstPass.find(
      (event) => event.type === 'approval.request',
    );
    const callId = approval?.type === 'approval.request' ? approval.callId : '';

    const secondPass = await collect(
      host.approve({sessionId: session, callId, confirmed: false}),
    );

    for (const event of secondPass) {
      if (event.type === 'tool.finished') {
        expect(event.ok).toBe(false);
      }
    }

    expect(fake?.requests).toHaveLength(2);
    const toolMessage = fake?.requests[1]?.messages.find(
      (message) => message['role'] === 'tool',
    );
    expect(String(toolMessage?.['content'])).not.toContain(marker);
    expect(String(toolMessage?.['content'])).toMatch(/reject/i);
  });

  it('writes a new file without approval, then gates the overwrite', async () => {
    const target = join(workDir, 'notes', 'todo.md');
    // Each turn is two requests: the tool call, then the reply after its result.
    const {host, session} = await startHost((_messages, callIndex) =>
      callIndex % 2 === 0
        ? toolCallChunks(`call_write_${callIndex}`, 'write_file', {
            path: 'notes/todo.md',
            content: 'buy milk',
          })
        : textChunks('Done.'),
    );

    // A brand-new file is created without a prompt.
    const created = await collect(host.run(session, 'write a todo'));
    expect(typesOf(created)).not.toContain('approval.request');
    expect(await readFile(target, 'utf8')).toBe('buy milk');

    // The same call a second time is an overwrite, so the turn pauses.
    const paused = await collect(host.run(session, 'rewrite it'));
    const approval = paused.find((event) => event.type === 'approval.request');
    expect(approval).toMatchObject({
      type: 'approval.request',
      tool: 'write_file',
      args: {path: 'notes/todo.md', content: 'buy milk'},
    });

    // Nothing has changed while the user decides.
    expect(await readFile(target, 'utf8')).toBe('buy milk');
  });

  it('leaves an approved file alone when the overwrite is denied', async () => {
    const target = join(workDir, 'notes.md');
    await writeFile(target, 'original', 'utf8');

    const {host, session} = await startHost((_messages, callIndex) =>
      callIndex % 2 === 0
        ? toolCallChunks(`call_write_${callIndex}`, 'write_file', {
            path: 'notes.md',
            content: 'replaced',
          })
        : textChunks('Understood.'),
    );

    const paused = await collect(host.run(session, 'replace it'));
    const approval = paused.find((event) => event.type === 'approval.request');
    const callId = approval?.type === 'approval.request' ? approval.callId : '';

    const denied = await collect(
      host.approve({sessionId: session, callId, confirmed: false}),
    );

    expect(await readFile(target, 'utf8')).toBe('original');
    const finished = denied.find((event) => event.type === 'tool.finished');
    expect(finished).toMatchObject({type: 'tool.finished', ok: false});
  });

  it('keeps each profile to its own conversations', async () => {
    const {host, session: alphaSession} = await startHost(() =>
      textChunks('ok'),
    );
    await collect(host.run(alphaSession, 'only alpha sees this'));

    const unowned = await host.listSessions();
    expect(unowned.map((entry) => entry.id)).toEqual([alphaSession]);

    // Adopt the pre-profile conversation, then give a second profile its own.
    await host.adoptUnownedSessions('profile-alpha');
    const beta = await host.createSession(undefined, undefined, 'profile-beta');

    const alphaList = await host.listSessions('profile-alpha');
    const betaList = await host.listSessions('profile-beta');
    expect(alphaList.map((entry) => entry.id)).toEqual([alphaSession]);
    expect(betaList.map((entry) => entry.id)).toEqual([beta.id]);

    // A stale window cannot read another agent's history by guessing an id.
    await expect(
      host.getTranscript(alphaSession, 'profile-beta'),
    ).rejects.toThrow(/Unknown session/);
    await expect(
      host.getTranscript(alphaSession, 'profile-alpha'),
    ).resolves.toMatchObject({session: {id: alphaSession}});
  });

  it('reports the folder each conversation was started in', async () => {
    const {host, session} = await startHost(() => textChunks('ok'));
    await collect(host.run(session, 'work in the default folder'));
    await host.adoptUnownedSessions('profile-alpha');

    const filed = await host.createSession(
      undefined,
      undefined,
      'profile-alpha',
      'workspace-scratch',
    );
    expect(filed.workspaceId).toBe('workspace-scratch');

    const listed = await host.listSessions('profile-alpha');
    expect(listed.find((entry) => entry.id === filed.id)?.workspaceId).toBe(
      'workspace-scratch',
    );
    // The conversation from before folders were recorded has none — and is
    // still listed, which is what puts it under "Other chats" rather than
    // losing it.
    expect(
      listed.find((entry) => entry.id === session)?.workspaceId,
    ).toBeUndefined();
  });

  /**
   * A conversation the app started — a Discord mention — carries the source that
   * puts it under its own sidebar heading. It is created with a source rather
   * than being found by title, so a user's chat that happens to be called
   * "Discord" is not swept into that section.
   */
  it('marks a conversation the app started, and only that one', async () => {
    const {host, session} = await startHost(() => textChunks('ok'));
    await collect(host.run(session, 'typed by the user'));
    await host.adoptUnownedSessions('profile-alpha');

    const fromBot = await host.createSession(
      'Discord',
      undefined,
      'profile-alpha',
      undefined,
      'discord',
    );
    expect(fromBot.source).toBe('discord');

    const listed = await host.listSessions('profile-alpha');
    expect(listed.find((entry) => entry.id === fromBot.id)?.source).toBe(
      'discord',
    );
    expect(
      listed.find((entry) => entry.id === session)?.source,
    ).toBeUndefined();
  });

  it('re-files a conversation only for the profile that owns it', async () => {
    const {host, session} = await startHost(() => textChunks('ok'));
    await collect(host.run(session, 'alpha work'));
    await host.adoptUnownedSessions('profile-alpha');

    const moved = await host.setSessionWorkspace(
      session,
      'workspace-scratch',
      'profile-alpha',
    );
    expect(moved.workspaceId).toBe('workspace-scratch');
    expect(
      (await host.listSessions('profile-alpha')).find(
        (entry) => entry.id === session,
      )?.workspaceId,
    ).toBe('workspace-scratch');

    // Re-filing another agent's conversation is the same refusal as reading it.
    await expect(
      host.setSessionWorkspace(session, 'workspace-scratch', 'profile-beta'),
    ).rejects.toThrow(/Unknown session/);

    // Unfiling is "no folder", which is how a conversation reaches Other chats.
    const unfiled = await host.setSessionWorkspace(
      session,
      undefined,
      'profile-alpha',
    );
    expect(unfiled.workspaceId).toBeUndefined();
  });

  /*
   * The read that decides where a turn runs. It is the index and nothing else —
   * the caller resolves the id to a path, because the folders belong to the
   * install rather than to one host — and an unknown conversation answers the
   * same way an unfiled one does, which is the fallback the turn then takes.
   */
  it('reports the folder a conversation is filed under', async () => {
    const {host, session} = await startHost(() => textChunks('ok'));
    await collect(host.run(session, 'alpha work'));
    await host.adoptUnownedSessions('profile-alpha');

    expect(await host.sessionWorkspaceId(session)).toBeUndefined();

    await host.setSessionWorkspace(
      session,
      'workspace-scratch',
      'profile-alpha',
    );
    expect(await host.sessionWorkspaceId(session)).toBe('workspace-scratch');

    await host.setSessionWorkspace(session, undefined, 'profile-alpha');
    expect(await host.sessionWorkspaceId(session)).toBeUndefined();
    expect(await host.sessionWorkspaceId('no-such-session')).toBeUndefined();
  });

  /**
   * The title is what the sidebar shows and what the chat's top bar names, so
   * renaming has to reach the index and come back as the stored summary — and
   * it is refused for another profile's conversation for the same reason reading
   * one is, or a guessed id would be a way to write into someone else's history.
   */
  it('renames a conversation only for the profile that owns it', async () => {
    const {host, session} = await startHost(() => textChunks('ok'));
    await collect(host.run(session, 'alpha work'));
    await host.adoptUnownedSessions('profile-alpha');

    const renamed = await host.renameSession(
      session,
      'Release prep',
      'profile-alpha',
    );
    expect(renamed.title).toBe('Release prep');
    expect(renamed.id).toBe(session);
    expect(
      (await host.listSessions('profile-alpha')).find(
        (entry) => entry.id === session,
      )?.title,
    ).toBe('Release prep');

    await expect(
      host.renameSession(session, 'Beta work', 'profile-beta'),
    ).rejects.toThrow(/Unknown session/);

    // The refused write left the name alone.
    expect(
      (await host.listSessions('profile-alpha')).find(
        (entry) => entry.id === session,
      )?.title,
    ).toBe('Release prep');
  });

  it("deletes a profile's conversations without touching other profiles", async () => {
    const {host, session: alphaSession} = await startHost(() =>
      textChunks('ok'),
    );
    await collect(host.run(alphaSession, 'alpha work'));
    await host.adoptUnownedSessions('profile-alpha');
    const beta = await host.createSession(undefined, undefined, 'profile-beta');
    await collect(host.run(beta.id, 'beta work'));

    const deleted = await host.deleteSessionsForProfile('profile-beta');
    expect(deleted).toBe(1);
    expect(await host.listSessions('profile-beta')).toEqual([]);
    expect(await host.listSessions('profile-alpha')).toHaveLength(1);
  });

  it('uses the profile identity as the system prompt', async () => {
    const {host, session} = await startHost(() => textChunks('ok'));
    host.updateConfig({
      // Same provider as the running host, so the turn still reaches the fake.
      ...createConfig(fake?.baseUrl ?? ''),
      systemPrompt: 'You are a terse research assistant.',
      // Which capability skills come along is now a property of the tool list
      // rather than a second selection, so the narrowest profile is the one that
      // grants nothing — and it still carries the app's operating protocol.
      enabledTools: [],
    });
    await collect(host.run(session, 'hi'));

    const system = String(fake?.requests[0]?.messages[0]?.['content']);
    expect(system).toContain('You are a terse research assistant.');
    expect(system).toContain('# Operating protocol');
    expect(system).not.toContain('## knowledge');
    expect(system).not.toContain('## memory');
  });

  it('gives each profile its own memory file', async () => {
    const {host, session} = await startHost(() => textChunks('ok'));

    // Alpha's memory, written where alpha's memory lives.
    await mkdir(join(workDir, '.marimo', 'alpha'), {recursive: true});
    await writeFile(
      resolveMemoryFile(workDir, 'alpha'),
      '- alpha secret\n',
      'utf8',
    );
    host.updateConfig({
      ...createConfig(fake?.baseUrl ?? ''),
      profileId: 'alpha',
    });
    await collect(host.run(session, 'first'));

    await mkdir(join(workDir, '.marimo', 'beta'), {recursive: true});
    await writeFile(
      resolveMemoryFile(workDir, 'beta'),
      '- beta fact\n',
      'utf8',
    );
    host.updateConfig({
      ...createConfig(fake?.baseUrl ?? ''),
      profileId: 'beta',
    });
    await collect(host.run(session, 'second'));

    const first = String(fake?.requests[0]?.messages[0]?.['content']);
    const second = String(fake?.requests[1]?.messages[0]?.['content']);
    expect(first).toContain('- alpha secret');
    expect(first).not.toContain('- beta fact');
    // The point of the whole feature: switching agent switches what it knows.
    expect(second).toContain('- beta fact');
    expect(second).not.toContain('- alpha secret');
  });

  /*
   * The memory limit is a setting, so it arrives through `updateConfig` like
   * every other one. The tools' own tests prove a limit changes what they warn
   * at; what this checks is that a configuration carrying one is accepted and
   * applied — with the default restored when a later one says nothing about it —
   * rather than the host rejecting or ignoring the field.
   */
  it('applies a memory soft limit from the configuration', async () => {
    const {host} = await startHost(() => textChunks('ok'));
    await host.remember('Notes', 'one fact');
    const oneFact = await host.memoryBytes();

    host.updateConfig({
      ...createConfig(fake?.baseUrl ?? ''),
      memorySoftLimitBytes: 16 * 1024,
    });
    await host.remember('Notes', 'a second fact');
    expect(await host.memoryBytes()).toBeGreaterThan(oneFact);

    host.updateConfig(createConfig(fake?.baseUrl ?? ''));
    await host.remember('Notes', 'a third fact');
    const threeFacts = await host.memoryBytes();
    expect(threeFacts).toBeGreaterThan(oneFact);
    expect(await host.memoryText()).toContain('- a third fact');
  });

  it("refuses another profile's conversation on every path", async () => {
    const {host, session} = await startHost(() => textChunks('ok'));
    await collect(host.run(session, 'alpha work'));
    await host.adoptUnownedSessions('profile-alpha');

    await expect(host.getTranscript(session, 'profile-beta')).rejects.toThrow(
      /Unknown session/,
    );
    await expect(host.deleteSession(session, 'profile-beta')).rejects.toThrow(
      /Unknown session/,
    );
    await expect(
      host.setSessionModel(session, 'deepseek-v4-pro', 'profile-beta'),
    ).rejects.toThrow(/Unknown session/);

    // A turn for the wrong profile is refused before anything reaches the
    // provider, so no tokens are spent and nothing is appended.
    const requestsBefore = fake?.requests.length ?? 0;
    const refused = await collect(
      host.run(session, 'beta attempt', undefined, 'profile-beta'),
    );
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({type: 'turn.failed'});
    expect(fake?.requests.length).toBe(requestsBefore);
  });

  /*
   * The companion's shorter answers, from the inside.
   *
   * Two turns, one conversation, one process: the point of the assertion is not
   * that the text arrives — it is that it *leaves*. A turn's instruction that
   * survived into the next turn would make the window answer in the pet's voice,
   * which is a bug nobody would trace back to the line that failed to clear it.
   */
  it("appends a turn's own instruction, and only for that turn", async () => {
    const {host, session} = await startHost(() => textChunks('Fine.'));

    await collect(host.run(session, 'first', 'ANSWER BRIEFLY, PET.'));
    await collect(host.run(session, 'second'));

    const [first, second] = fake?.requests ?? [];
    const system = (request: RecordedRequest | undefined): string =>
      String(
        request?.messages.find((message) => message['role'] === 'system')?.[
          'content'
        ] ?? '',
      );

    expect(system(first)).toContain('ANSWER BRIEFLY, PET.');
    expect(system(first)).toContain(TEST_IDENTITY);
    expect(system(second)).not.toContain('ANSWER BRIEFLY, PET.');
  });

  it('persists the conversation and projects a readable transcript', async () => {
    const {host, session} = await startHost(() => textChunks('Noted.'));

    await collect(host.run(session, 'remember this'));

    const {messages, session: summary} = await host.getTranscript(session);
    expect(messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
    ]);
    expect(messages[0]?.text).toBe('remember this');
    expect(messages[1]?.text).toBe('Noted.');
    expect(summary.title).toBe('remember this');

    const listed = await host.listSessions();
    expect(listed.map((entry) => entry.id)).toContain(session);
  });

  it('replaces the older half of a conversation with a summary, and rewrites nothing', async () => {
    const {host, session} = await startHost((messages, index) => {
      /*
       * The summariser's call is the one with nothing but the prompt: no system
       * instruction, no tools. Distinguishing it here is what lets the same fake
       * provider answer both kinds of request.
       */
      if (messages.length === 1) {
        return textChunks('They asked for the time and were told it.');
      }
      if (index === 0) {
        return toolCallChunks('call_time', 'current_time', {});
      }
      return textChunks(`answer ${String(index)}`);
    });

    for (let turn = 0; turn < 8; turn += 1) {
      await collect(host.run(session, `question ${String(turn)}`));
    }

    const before = await host.eventsFor(session);
    const result = await host.compact(session);
    expect(result).toEqual({compacted: true});

    /*
     * Append-only, asserted on the file itself: the events already stored are
     * still there, in order, character for character. This is the property that
     * keeps the sidebar's count, the memory review's watermark and any
     * unanswered gate meaningful — a rewrite would leave all three describing a
     * conversation that no longer exists.
     */
    const after = await host.eventsFor(session);
    expect(after).toHaveLength(before.length + 1);
    expect(after.slice(0, before.length)).toEqual(before);

    // The window sees one card where the replaced messages were.
    const {messages} = await host.getTranscript(session);
    expect(messages[0]?.compacted).toBeGreaterThan(0);
    expect(messages[0]?.text).toBe('They asked for the time and were told it.');
    expect(messages.map((message) => message.text)).not.toContain('question 0');

    // And the next turn is *sent* the summary rather than the messages.
    const asked = fake?.requests.length ?? 0;
    await collect(host.run(session, 'and now?'));
    const sent = fake?.requests[asked]?.messages ?? [];
    const contents = sent
      .map((message) => String(message['content'] ?? ''))
      .join('\n');
    expect(contents).toContain('Previous Context Summary');
    expect(contents).toContain('They asked for the time and were told it.');
    expect(contents).not.toContain('question 0');

    /*
     * Invariant 3, on what was actually sent: the tool call the first turn made
     * is inside the compacted span, so if the cut had landed between a call and
     * its result the provider would refuse this request — and every later one.
     */
    const requested = sent
      .filter((message) => message['role'] === 'assistant')
      .flatMap((message) => (message['tool_calls'] ?? []) as Array<{id: string}>)
      .map((call) => call.id);
    const answered = sent
      .filter((message) => message['role'] === 'tool')
      .map((message) => message['tool_call_id']);
    expect(answered).toEqual(expect.arrayContaining(requested));
  });

  it('has nothing to compact in a conversation that already fits', async () => {
    const {host, session} = await startHost(() => textChunks('Noted.'));
    await collect(host.run(session, 'one short question'));

    const result = await host.compact(session);

    // A value rather than an error: a short conversation is not a failure, and
    // the window draws the sentence instead of a red banner.
    expect(result.compacted).toBe(false);
    expect(result.reason).toMatch(/short enough/u);
    expect(await host.eventsFor(session)).toHaveLength(2);
  });

  it('refuses to compact a conversation that is waiting for an approval', async () => {
    const {host, session} = await startHost(() =>
      toolCallChunks('call_shell', 'run_shell', {
        command: `echo marimo-compact-gate-${String(Date.now())}`,
      }),
    );

    const paused = await collect(host.run(session, 'run it'));
    expect(paused.some((event) => event.type === 'approval.request')).toBe(true);

    const result = await host.compact(session);

    expect(result.compacted).toBe(false);
    expect(result.reason).toMatch(/approval/u);
  });

  it('refuses to compact a conversation while a turn is running in it', async () => {
    const {host, session} = await startHost(() => textChunks('thinking'));

    const stream = host.run(session, 'first');
    await stream.next();

    const result = await host.compact(session);
    expect(result.compacted).toBe(false);
    expect(result.reason).toMatch(/turn is running/u);

    await collect(stream);
  });

  it('fails with an actionable message when no API key is configured', async () => {    fake = await startFakeDeepSeek(() => textChunks('unused'));
    const host = createHost(fake.baseUrl, '');
    const session = await host.createSession();

    const events = await collect(host.run(session.id, 'hi'));

    const failure = events.find((event) => event.type === 'turn.failed');
    expect(failure).toMatchObject({type: 'turn.failed'});
    if (failure?.type === 'turn.failed') {
      expect(failure.message).toMatch(/API key/);
    }
    expect(fake.requests).toHaveLength(0);
  });

  it('refuses a second concurrent turn', async () => {
    const {host, session} = await startHost(() => textChunks('slow'));
    const first = host.run(session, 'first');

    // Start consuming the first turn, then try to start another.
    const firstEvent = await first.next();
    expect(firstEvent.value).toMatchObject({type: 'turn.started'});

    const second = await collect(host.run(session, 'second'));
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({type: 'turn.failed'});

    await collect(first);
  });

  it('deletes a session and its conversation history', async () => {
    const {host, session} = await startHost(() => textChunks('ok'));
    await collect(host.run(session, 'hello'));
    await host.deleteSession(session);

    expect(await host.listSessions()).toEqual([]);
    await expect(host.getTranscript(session)).rejects.toThrow(
      /Unknown session/,
    );
  });

  it('streams reasoning as a separate channel, not as answer text', async () => {
    const {host, session} = await startHost(() =>
      reasoningChunks('Weighing the options.', 'Here is the answer.'),
    );

    const events = await collect(host.run(session, 'think about it'));

    const reasoning = events
      .filter((event) => event.type === 'reasoning.delta')
      .map((event) => (event.type === 'reasoning.delta' ? event.text : ''))
      .join('');
    expect(reasoning).toBe('Weighing the options.');

    const text = events
      .filter((event) => event.type === 'text.delta')
      .map((event) => (event.type === 'text.delta' ? event.text : ''))
      .join('');
    expect(text).toBe('Here is the answer.');

    // Reopening the conversation must show the same reasoning.
    const {messages} = await host.getTranscript(session);
    expect(messages[1]?.reasoning).toBe('Weighing the options.');
    expect(messages[1]?.text).toBe('Here is the answer.');
  });

  it("echoes each turn's reasoning back on the next request", async () => {
    // DeepSeek requires a turn's reasoning_content on every later request that
    // carries tools, and answers 400 when it is missing. This asserts the round
    // trip: response -> ADK thought part -> session -> next request.
    const {host, session} = await startHost((_messages, callIndex) =>
      callIndex === 0
        ? reasoningChunks('I should think before answering.', 'First answer.')
        : textChunks('Second answer.'),
    );

    await collect(host.run(session, 'first question'));
    await collect(host.run(session, 'second question'));

    expect(fake?.requests).toHaveLength(2);
    const secondRequest = fake?.requests[1]?.messages ?? [];
    const assistant = secondRequest.find(
      (message) =>
        message['role'] === 'assistant' &&
        typeof message['content'] === 'string' &&
        String(message['content']).includes('First answer.'),
    );

    expect(assistant?.['reasoning_content']).toBe(
      'I should think before answering.',
    );
    // Reasoning must not be duplicated into the visible content.
    expect(String(assistant?.['content'])).not.toContain('think before');
  });

  it("uses each conversation's own model choice", async () => {
    const {host, session} = await startHost(() => textChunks('ok'));
    const other = await host.createSession('other chat', 'deepseek-v4-pro');

    expect(await host.resolveModel(session)).toBe('deepseek-chat');
    expect(await host.resolveModel(other.id)).toBe('deepseek-v4-pro');

    await collect(host.run(session, 'default model'));
    await collect(host.run(other.id, 'pro model'));

    expect(fake?.requests[0]?.body['model']).toBe('deepseek-chat');
    expect(fake?.requests[1]?.body['model']).toBe('deepseek-v4-pro');
  });

  it('switches a conversation model without touching other chats', async () => {
    const {host, session} = await startHost(() => textChunks('ok'));
    const other = await host.createSession();

    await host.setSessionModel(session, 'deepseek-reasoner');

    expect(await host.resolveModel(session)).toBe('deepseek-reasoner');
    // No explicit choice on the other chat, so it still follows the default.
    expect(await host.resolveModel(other.id)).toBe('deepseek-chat');

    await collect(host.run(session, 'use the new model'));
    expect(fake?.requests[0]?.body['model']).toBe('deepseek-reasoner');

    const listed = await host.listSessions();
    expect(listed.find((entry) => entry.id === session)?.model).toBe(
      'deepseek-reasoner',
    );
    expect(
      listed.find((entry) => entry.id === other.id)?.model,
    ).toBeUndefined();
  });

  it('rejects a model change for an unknown conversation', async () => {
    const {host} = await startHost(() => textChunks('ok'));
    await expect(
      host.setSessionModel('nope', 'deepseek-flash'),
    ).rejects.toThrow(/Unknown session/);
  });

  /**
   * Gates outlive the process that raised them.
   *
   * A paused turn is waiting for a person, and people close windows. Before
   * this, `approve` consulted an in-memory round alone, so after a relaunch the
   * card was still on screen and pressing Approve did nothing at all — no
   * error, no effect, no way to tell it had not worked. The conversation is the
   * only thing that survives, so the question is read back out of it.
   */
  describe('a gate that outlives its process', () => {
    /** A turn that asks to run a command, then answers once it has run. */
    function shellCommand(command: string) {
      return (messages: Array<Record<string, unknown>>) =>
        messages.some((message) => message['role'] === 'tool')
          ? textChunks('The command finished.')
          : toolCallChunks('call_shell', 'run_shell', {command});
    }

    it('reads a pending gate back out of the conversation', async () => {
      const command = 'echo persisted-gate';
      const {host, session} = await startHost(shellCommand(command));

      await collect(host.run(session, 'run it'));

      const pending = await host.pendingGates(session);
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({tool: 'run_shell', args: {command}});
      expect(pending[0]?.callId.length).toBeGreaterThan(0);
    });

    it('answers one the raising process never saw decided', async () => {
      const marker = `marimo-restart-${Date.now()}`;
      const command = `echo ${marker}`;

      const {host, session} = await startHost(shellCommand(command));
      const first = await collect(host.run(session, 'echo the marker'));

      const approval = first.find((event) => event.type === 'approval.request');
      const callId =
        approval?.type === 'approval.request' ? approval.callId : '';
      expect(callId.length).toBeGreaterThan(0);

      /*
       * The restart: the object that raised the gate is gone, and so is
       * everything it was holding. A second host over the same session
       * directory is what the app looks like after a relaunch.
       */
      host.dispose();
      const restarted = createHost(fake?.baseUrl ?? '');

      expect(
        (await restarted.pendingGates(session)).map((gate) => gate.callId),
      ).toEqual([callId]);

      const second = await collect(
        restarted.approve({sessionId: session, callId, confirmed: true}),
      );

      const finished = second.find((event) => event.type === 'tool.finished');
      expect(finished).toMatchObject({type: 'tool.finished', ok: true});
      if (finished?.type === 'tool.finished') {
        expect(finished.result).toContain(marker);
      }
    });

    it('honours a refusal given after the restart', async () => {
      const marker = `marimo-refused-${Date.now()}`;
      const command = `echo ${marker}`;
      const {host, session} = await startHost(shellCommand(command));
      const first = await collect(host.run(session, 'run it'));
      const approval = first.find((event) => event.type === 'approval.request');
      const callId =
        approval?.type === 'approval.request' ? approval.callId : '';

      host.dispose();
      const restarted = createHost(fake?.baseUrl ?? '');

      const second = await collect(
        restarted.approve({sessionId: session, callId, confirmed: false}),
      );

      const finished = second.find((event) => event.type === 'tool.finished');
      expect(finished).toMatchObject({ok: false});

      /*
       * The assertion that matters is not the wording — that belongs to ADK, and
       * pinning it here would make a dependency's phrasing a test failure. It is
       * that the command did not run: a refusal that still executed the thing it
       * refused would be the worst bug this file could have.
       */
      if (finished?.type === 'tool.finished') {
        expect(finished.result).not.toContain(marker);
      }
    });

    it('stops reporting a gate once it has been answered', async () => {
      const {host, session} = await startHost(shellCommand('echo once'));
      const first = await collect(host.run(session, 'run it'));
      const approval = first.find((event) => event.type === 'approval.request');
      const callId =
        approval?.type === 'approval.request' ? approval.callId : '';

      await collect(
        host.approve({sessionId: session, callId, confirmed: true}),
      );

      expect(await host.pendingGates(session)).toEqual([]);
    });

    it('reports nothing for a conversation that never asked', async () => {
      const {host, session} = await startHost(() => textChunks('hello'));
      await collect(host.run(session, 'hi'));
      expect(await host.pendingGates(session)).toEqual([]);
    });

    it('reports nothing for a conversation that does not exist', async () => {
      const {host} = await startHost(() => textChunks('ok'));
      // An empty answer rather than a throw: a window asks this for whatever it
      // is showing, including a conversation deleted in another window a moment
      // ago, and that must not become an error on screen.
      expect(await host.pendingGates('no-such-session')).toEqual([]);
    });

    it('ignores an approval for a call that is not waiting', async () => {
      const {host, session} = await startHost(shellCommand('echo x'));
      await collect(host.run(session, 'run it'));

      // Nothing is driven: sending ADK a confirmation for a question it never
      // asked is what it refuses outright.
      const events = await collect(
        host.approve({
          sessionId: session,
          callId: 'a-call-that-was-never-made',
          confirmed: true,
        }),
      );
      expect(events).toEqual([]);
    });
  });

  /*
   * The two failures a small local model actually produces. Both come from a
   * real `Qwen3-1.7B` conversation: a turn that called `web_search` and
   * `read_file` alternately with identical arguments until the context was
   * spent, and then a turn that ended on reasoning with no reply at all, so the
   * user got nothing. A prompt asking the model not to do either is the first
   * thing a model this size loses, which is why both are enforced here.
   */

  it('warns on a repeated tool call and refuses the third', async () => {
    const queries: string[] = [];
    const provider: WebSearchProvider = {
      search: async ({query}) => {
        queries.push(query);
        return [
          {
            title: 'Marimo',
            url: 'https://example.com/marimo',
            snippet: 'A reactive notebook',
          },
        ];
      },
    };

    const {host, session} = await startHost(
      (messages) => {
        const results = messages.filter(
          (message) => message['role'] === 'tool',
        ).length;
        return results < 3
          ? toolCallChunks(`call_search_${results}`, 'web_search', {
              query: 'marimo',
            })
          : textChunks('Answered.');
      },
      'test-key',
      provider,
    );

    const events = await collect(host.run(session, 'search for marimo'));

    /*
     * The number that matters. The tool ran for the first and second calls and
     * not for the third: a refusal that still executed the thing it refused
     * would be worse than the loop it was meant to break.
     */
    expect(queries).toEqual(['marimo', 'marimo']);

    const finished = events.filter((event) => event.type === 'tool.finished');
    expect(finished).toHaveLength(3);
    if (
      finished[0]?.type === 'tool.finished' &&
      finished[1]?.type === 'tool.finished' &&
      finished[2]?.type === 'tool.finished'
    ) {
      expect(finished[0].ok).toBe(true);
      expect(finished[0].result).not.toContain('[repeated call]');

      // Still allowed through, so the model sees the result *and* the warning.
      expect(finished[1].ok).toBe(true);
      expect(finished[1].result).toContain('https://example.com/marimo');
      expect(finished[1].result).toContain('[repeated call]');

      // Refused, and marked failed so the window draws it as a call that did not
      // happen rather than one that quietly returned something odd.
      expect(finished[2].ok).toBe(false);
      expect(finished[2].result).toContain('Refused');
    }

    expect(typesOf(events)).toContain('turn.completed');
  });

  it('forgets the count when the turn ends', async () => {
    const queries: string[] = [];
    const provider: WebSearchProvider = {
      search: async ({query}) => {
        queries.push(query);
        return [{title: query, url: `https://example.com/${query}`, snippet: ''}];
      },
    };

    const {host, session} = await startHost(
      (_messages, callIndex) =>
        callIndex % 2 === 0
          ? toolCallChunks(`call_search_${callIndex}`, 'web_search', {
              query: 'marimo',
            })
          : textChunks('Found it.'),
      'test-key',
      provider,
    );

    const first = await collect(host.run(session, 'search for marimo'));
    const second = await collect(host.run(session, 'search for marimo again'));

    // One call per turn with identical arguments is two turns doing the same
    // thing, not one turn looping. Counting across turns would warn on the
    // second one, and warn on the same harmless pattern forever after.
    expect(queries).toEqual(['marimo', 'marimo']);
    for (const call of [...first, ...second]) {
      if (call.type === 'tool.finished') {
        expect(call.result).not.toContain('[repeated call]');
      }
    }
  });

  it('lets a repeated call with different arguments through', async () => {
    const queries: string[] = [];
    const provider: WebSearchProvider = {
      search: async ({query}) => {
        queries.push(query);
        return [
          {title: query, url: `https://example.com/${query}`, snippet: ''},
        ];
      },
    };

    const {host, session} = await startHost(
      (messages) => {
        const results = messages.filter(
          (message) => message['role'] === 'tool',
        ).length;
        return results < 2
          ? toolCallChunks(`call_search_${results}`, 'web_search', {
              query: results === 0 ? 'first' : 'second',
            })
          : textChunks('Both done.');
      },
      'test-key',
      provider,
    );

    const events = await collect(host.run(session, 'search twice'));

    // The guard is about the same call, not about the same tool: changing the
    // query is the model doing exactly what the warning asks of it.
    expect(queries).toEqual(['first', 'second']);
    for (const call of events) {
      if (call.type === 'tool.finished') {
        expect(call.result).not.toContain('[repeated call]');
      }
    }
  });

  it('recovers the reply from a turn that produced only reasoning', async () => {
    const {host, session} = await startHost((_messages, callIndex) =>
      callIndex === 0
        ? reasoningChunks('I should ask which recipe they want.', '')
        : textChunks('Which recipe would you like for today?'),
    );

    const events = await collect(host.run(session, 'add in the one for today'));

    expect(typesOf(events)).not.toContain('turn.failed');
    expect(typesOf(events)).toContain('turn.completed');
    expect(
      events
        .filter((event) => event.type === 'text.delta')
        .map((event) => (event.type === 'text.delta' ? event.text : ''))
        .join(''),
    ).toBe('Which recipe would you like for today?');

    // The second request is the recovery, and it carries the two things the
    // model needs to answer from: what was asked, and what it already worked out.
    const recovery = String(fake?.requests[1]?.messages[0]?.['content']);
    expect(recovery).toContain('add in the one for today');
    expect(recovery).toContain('I should ask which recipe they want.');

    /*
     * Stored, not merely streamed. The window re-reads the transcript the moment
     * the turn completes, so a recovered reply that was only sent as a delta
     * would vanish on the reload that follows it.
     */
    const {messages} = await host.getTranscript(session);
    const last = messages[messages.length - 1];
    expect(last?.text).toContain('Which recipe would you like for today?');
  });

  it('reports a turn that stays silent even after a second attempt', async () => {
    const {host, session} = await startHost(() =>
      reasoningChunks('thinking, and never saying', ''),
    );

    const events = await collect(host.run(session, 'hi'));

    // Reported as a failure rather than as words the model never said: a
    // sentence in the transcript would read as an answer, and there was none.
    expect(typesOf(events)).not.toContain('turn.completed');
    const failed = events.find((event) => event.type === 'turn.failed');
    expect(failed).toMatchObject({type: 'turn.failed'});
    if (failed?.type === 'turn.failed') {
      expect(failed.message).toContain('second attempt');
    }
    expect(typesOf(events)).not.toContain('text.delta');
  });

  it('counts a whitespace-only reply as silence', async () => {
    const {host, session} = await startHost((_messages, callIndex) =>
      callIndex === 0 ? textChunks('   ') : textChunks('Here is your answer.'),
    );

    const events = await collect(host.run(session, 'well?'));

    // A bubble holding a space is the same nothing to the person looking at it,
    // so it gets the same recovery rather than being taken as an answer.
    expect(typesOf(events)).not.toContain('turn.failed');
    const text = events
      .filter((event) => event.type === 'text.delta')
      .map((event) => (event.type === 'text.delta' ? event.text : ''))
      .join('');
    expect(text).toContain('Here is your answer.');
    expect(fake?.requests).toHaveLength(2);
  });

  it('does not treat a turn that is waiting for approval as silent', async () => {
    await writeFile(join(workDir, 'notes.md'), 'original', 'utf8');

    const {host, session} = await startHost(() =>
      toolCallChunks('call_write', 'write_file', {
        path: 'notes.md',
        content: 'replaced',
      }),
    );

    const paused = await collect(host.run(session, 'replace it'));
    expect(paused.some((event) => event.type === 'approval.request')).toBe(true);

    // One request, which is the gate. A recovery call would show up as a second:
    // a turn waiting on the user is not a turn that said nothing.
    expect(fake?.requests).toHaveLength(1);
  });
});
