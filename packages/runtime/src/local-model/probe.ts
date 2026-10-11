/**
 * What this machine can actually run, asked of the engine itself.
 *
 * The question is "how much video memory is free", and the only thing that
 * answers it honestly is the binary that is about to use it: `llama-server
 * --list-devices` enumerates the backends it was built with and prints what each
 * one reports. That costs a process launch and no model load, and it cannot
 * disagree with reality the way a driver query or a vendor-specific tool can.
 *
 * Two consequences worth stating, because both are easy to get wrong:
 *
 * - **A CPU-only build always answers "(none)".** Not "no GPU" — "no backend that
 *   could see one". So the probe is only meaningful run against a GPU build, and
 *   a caller that probes the CPU engine learns nothing. `probeDevices` does not
 *   pretend otherwise; it reports what it was told.
 * - **The output format is llama.cpp's, not ours.** It has changed before and
 *   will again, so the parse is deliberately forgiving: it takes the numbers it
 *   recognises and ignores the rest, and a line it cannot read costs that device
 *   rather than the whole answer. `output` is kept so the Settings card can show
 *   the engine's own words when the answer is surprising.
 */
import {execFile} from 'node:child_process';
import {totalmem, freemem} from 'node:os';
import {promisify} from 'node:util';

const run = promisify(execFile);

export interface ProbedDevice {
  /** The engine's name for it, e.g. `Vulkan0`. */
  name: string;
  /** What the engine calls the device. */
  description: string;
  totalBytes?: number;
  freeBytes?: number;
}

export interface DeviceProbe {
  devices: ProbedDevice[];
  /**
   * The most free memory any single device reported.
   *
   * The maximum rather than the sum: llama.cpp offloads to one device unless it
   * is told otherwise, and a sum would report a two-card machine as having twice
   * what either card can hold.
   */
  maxFreeBytes?: number;
  /** The engine's own output, for the card to show when the answer surprises. */
  output: string;
}

export interface ProbeOptions {
  /** Injectable for tests, which must not launch a process. */
  execFileImpl?: (
    file: string,
    args: string[],
    options: {timeout: number},
  ) => Promise<{stdout: string; stderr: string}>;
  /** How long to wait before deciding the engine will not answer. */
  timeoutMs?: number;
}

/**
 * A device list is a process launch, so it is bounded.
 *
 * Generous, because a cold start on a machine with a slow driver is exactly when
 * this runs and a timeout here would silently downgrade somebody's machine to the
 * small model.
 */
const DEFAULT_TIMEOUT_MS = 20_000;

const MIB = 1024 * 1024;

/**
 * Runs the engine's own device enumeration.
 *
 * Never throws. A probe that cannot run is not a failure of the app — it means
 * the answer is "no device we can use", which is the same answer a CPU-only build
 * gives, and the caller's job is to pick a tier that works either way.
 */
export async function probeDevices(
  enginePath: string,
  options: ProbeOptions = {},
): Promise<DeviceProbe> {
  if (enginePath.length === 0) {
    return {devices: [], output: ''};
  }
  const exec = options.execFileImpl ?? run;
  try {
    const {stdout, stderr} = await exec(enginePath, ['--list-devices'], {
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    // The list goes to stdout on some builds and stderr on others; both are read
    // so a build that changes its mind does not read as "no devices".
    const output = `${stdout}${stderr}`;
    return parseDevices(output);
  } catch (failure) {
    /*
     * A build with no backend at all exits non-zero after printing "(none)", and
     * so does one whose libraries are missing. Both mean the same thing here.
     */
    const output =
      failure !== null && typeof failure === 'object'
        ? String(
            (failure as {stdout?: unknown}).stdout ??
              (failure as {stderr?: unknown}).stderr ??
              '',
          )
        : '';
    return parseDevices(output);
  }
}

/**
 * The devices out of the engine's own listing.
 *
 * Two shapes are handled, and the second is the one that matters: a line like
 * `Vulkan0: Intel(R) UHD Graphics 770 (11264 MiB, 11100 MiB free)`, and the
 * `(none)` that a build without a usable backend prints. Anything else is ignored
 * rather than treated as an error, because llama.cpp adds fields to this output as
 * it gains backends.
 *
 * The name rule is what keeps the engine's own log lines out of the answer. A
 * device is named `Vulkan0`, `CUDA0`, `Metal`, `ROCm0` — a capitalised word, no
 * underscores — while the library's log keys are lowercase (`load_backend`,
 * `llama_server`, `srv`). Without that distinction a line announcing which
 * backend was loaded reads as a device, and a machine with no GPU appears to have
 * one called `load_backend`.
 */
export function parseDevices(output: string): DeviceProbe {
  const devices: ProbedDevice[] = [];
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('Available devices')) {
      continue;
    }
    // `(none)`, and any other parenthesised-only line, names no device.
    const nameMatch = /^([A-Z][A-Za-z]*\d{0,3}):\s*(.*)$/u.exec(trimmed);
    if (nameMatch === null) {
      continue;
    }
    const name = nameMatch[1]!;
    const rest = nameMatch[2]!;

    const open = rest.lastIndexOf('(');
    const close = rest.endsWith(')') ? rest.length - 1 : -1;
    const description = (open >= 0 ? rest.slice(0, open) : rest).trim();
    const inside = open >= 0 && close > open ? rest.slice(open + 1, close) : '';

    devices.push({name, description, ...memoryIn(inside)});
  }

  const frees = devices
    .map((device) => device.freeBytes ?? device.totalBytes)
    .filter((value): value is number => value !== undefined);

  return {
    devices,
    ...(frees.length === 0 ? {} : {maxFreeBytes: Math.max(...frees)}),
    output,
  };
}

/**
 * The memory figures out of the parenthesised part.
 *
 * `11264 MiB, 11100 MiB free` is the documented shape; a single figure is
 * treated as the total, because an engine that reports only one number is
 * reporting what the device has. `GiB` is accepted because the same code prints
 * it for large cards, and reading 24 GiB as 24 MiB would be the kind of wrong
 * that silently picks the small model on the best machine in the room.
 */
function memoryIn(inside: string): {
  totalBytes?: number;
  freeBytes?: number;
} {
  const pattern = /([\d.]+)\s*(MiB|GiB|MB|GB)\b(\s*free)?/giu;
  let totalBytes: number | undefined;
  let freeBytes: number | undefined;
  for (const match of inside.matchAll(pattern)) {
    const value = Number(match[1]);
    if (!Number.isFinite(value)) {
      continue;
    }
    const unit = (match[2] ?? '').toLowerCase();
    const scale =
      unit === 'gib' || unit === 'gb' ? 1024 * MIB : MIB;
    const bytes = Math.round(value * scale);
    if (match[3] !== undefined) {
      freeBytes = bytes;
    } else if (totalBytes === undefined) {
      totalBytes = bytes;
    }
  }
  return {
    ...(totalBytes === undefined ? {} : {totalBytes}),
    ...(freeBytes === undefined ? {} : {freeBytes}),
  };
}

/**
 * System memory, which is the constraint when there is no usable GPU.
 *
 * `total` rather than `free`, deliberately: free memory is whatever the browser
 * and the editor happened to be doing when the app started, and choosing a model
 * on it would mean a machine gets the small one because somebody had a tab open.
 * The resolver applies its own headroom to the total instead.
 */
export function systemMemoryBytes(): {total: number; free: number} {
  return {total: totalmem(), free: freemem()};
}
