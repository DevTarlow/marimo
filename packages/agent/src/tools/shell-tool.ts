/**
 * `run_shell`: execute a command in the user's workspace.
 *
 * This is the only tool that can change the machine, so it is gated behind
 * ADK's confirmation flow (`requireConfirmation: true`): the framework pauses
 * the turn, the app shows the exact command, and nothing runs until the user
 * approves. The desktop UI never renders a shell the user cannot see.
 */
import {spawn} from 'node:child_process';

import {FunctionTool} from '@google/adk';
import {z} from 'zod';

import {resolveInsideWorkspace} from './paths.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_CHARS = 40_000;

export interface ShellToolContext {
  workspaceRoot: string;
}

export function createShellTool(context: ShellToolContext) {
  return new FunctionTool({
    name: 'run_shell',
    description:
      'Run a shell command in the workspace and return its exit code, stdout and ' +
      'stderr. The user must approve every command before it runs, so state ' +
      'clearly what a command is for. Commands are not interactive: they cannot ' +
      'read stdin, and they are killed after the timeout.',
    parameters: z.object({
      command: z.string().describe('Shell command to run, e.g. "ls -la src".'),
      cwd: z
        .string()
        .optional()
        .describe(
          'Working directory inside the workspace. Defaults to the workspace root.',
        ),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          `Timeout in milliseconds. Defaults to ${DEFAULT_TIMEOUT_MS}.`,
        ),
    }),
    requireConfirmation: true,
    execute: async ({command, cwd, timeoutMs}) => {
      const workingDir = cwd
        ? await resolveInsideWorkspace(context.workspaceRoot, cwd)
        : context.workspaceRoot;
      const timeout = Math.min(timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
      return await runCommand(command, workingDir, timeout);
    },
  });
}

interface CommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
}

function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(command, {
      cwd,
      shell: true,
      // A process group is what makes it possible to kill the whole tree the
      // shell spawned, not just the shell itself.
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {...process.env, GIT_PAGER: 'cat', PAGER: 'cat'},
    });

    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const append = (target: 'stdout' | 'stderr', chunk: Buffer): void => {
      if (target === 'stdout') {
        stdout += chunk.toString('utf8');
        if (stdout.length > MAX_OUTPUT_CHARS) {
          stdout = stdout.slice(0, MAX_OUTPUT_CHARS);
          truncated = true;
        }
      } else {
        stderr += chunk.toString('utf8');
        if (stderr.length > MAX_OUTPUT_CHARS) {
          stderr = stderr.slice(0, MAX_OUTPUT_CHARS);
          truncated = true;
        }
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => append('stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer) => append('stderr', chunk));

    const timer = setTimeout(() => {
      timedOut = true;
      terminate(child);
    }, timeoutMs);

    const finish = (result: CommandResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(formatResult(command, cwd, result));
    };

    child.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Failed to start command: ${error.message}`));
    });

    child.on('close', (exitCode, signal) => {
      finish({
        exitCode,
        signal,
        stdout,
        stderr,
        timedOut,
        truncated,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

function terminate(child: ReturnType<typeof spawn>): void {
  if (child.pid === undefined) {
    return;
  }
  try {
    if (process.platform === 'win32') {
      child.kill('SIGKILL');
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch {
    child.kill('SIGKILL');
  }
}

function formatResult(
  command: string,
  cwd: string,
  result: CommandResult,
): string {
  const lines = [
    `$ ${command}`,
    `cwd: ${cwd}`,
    `exit: ${result.exitCode ?? 'none'}${result.signal ? ` (signal ${result.signal})` : ''} in ${result.durationMs}ms`,
  ];
  if (result.timedOut) {
    lines.push('timed out: the command was killed');
  }
  if (result.truncated) {
    lines.push(`output truncated at ${MAX_OUTPUT_CHARS} characters`);
  }
  if (result.stdout.length > 0) {
    lines.push('', 'stdout:', result.stdout.trimEnd());
  }
  if (result.stderr.length > 0) {
    lines.push('', 'stderr:', result.stderr.trimEnd());
  }
  if (result.stdout.length === 0 && result.stderr.length === 0) {
    lines.push('', '(no output)');
  }
  return lines.join('\n');
}
