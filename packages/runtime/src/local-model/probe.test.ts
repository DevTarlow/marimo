/**
 * Reading the engine's own answer about the hardware.
 *
 * The format is llama.cpp's and it has changed before, so most of these are about
 * what happens when it says something unexpected: a device line with no memory
 * figures, a unit that is GiB rather than MiB, a stray line, and the `(none)` that
 * a build with no usable backend prints. A parse that threw on any of those would
 * turn "this machine has no GPU" into "the app is broken", which are different
 * things to tell somebody.
 */
import {describe, expect, it} from 'vitest';

import {parseDevices, probeDevices, systemMemoryBytes} from './probe.js';

const MIB = 1024 * 1024;

describe('parseDevices', () => {
  it('reads a device with its total and its free memory', () => {
    const probe = parseDevices(
      ['Available devices:', '  Vulkan0: Intel(R) UHD Graphics 770 (11264 MiB, 11100 MiB free)'].join(
        '\n',
      ),
    );

    expect(probe.devices).toHaveLength(1);
    expect(probe.devices[0]).toMatchObject({
      name: 'Vulkan0',
      description: 'Intel(R) UHD Graphics 770',
      totalBytes: 11264 * MIB,
      freeBytes: 11100 * MIB,
    });
    expect(probe.maxFreeBytes).toBe(11100 * MIB);
  });

  it('takes the free figure over the total when they differ', () => {
    const probe = parseDevices(
      '  CUDA0: NVIDIA GeForce RTX 3060 (12288 MiB, 300 MiB free)',
    );
    // Free, not total: a card with a game on it has little to give.
    expect(probe.maxFreeBytes).toBe(300 * MIB);
  });

  /*
   * A single figure is what the device has, because an engine that reports one
   * number is reporting capacity — and reading it as free would be optimistic in
   * the direction that ends in a failed start.
   */
  it('treats a lone figure as the total', () => {
    const probe = parseDevices('  Vulkan0: Some Device (8192 MiB)');
    expect(probe.devices[0]?.totalBytes).toBe(8192 * MIB);
    expect(probe.devices[0]?.freeBytes).toBeUndefined();
    expect(probe.maxFreeBytes).toBe(8192 * MIB);
  });

  /*
   * The unit matters more than it looks: reading 24 GiB as 24 MiB would pick the
   * small model on the best machine in the room, silently.
   */
  it('reads GiB as GiB', () => {
    const probe = parseDevices('  Vulkan0: Big Card (24 GiB, 23 GiB free)');
    expect(probe.maxFreeBytes).toBe(23 * 1024 * MIB);
  });

  it('takes the largest device rather than the sum', () => {
    const probe = parseDevices(
      [
        'Available devices:',
        '  Vulkan0: First (8192 MiB, 8000 MiB free)',
        '  Vulkan1: Second (8192 MiB, 4000 MiB free)',
      ].join('\n'),
    );
    expect(probe.devices).toHaveLength(2);
    // The maximum, because offload goes to one device: a sum would report a
    // two-card machine as having twice what either card can hold.
    expect(probe.maxFreeBytes).toBe(8000 * MIB);
  });

  it('answers no device for the none a CPU-capable build prints', () => {
    const probe = parseDevices('Available devices:\n  (none)');
    expect(probe.devices).toEqual([]);
    expect(probe.maxFreeBytes).toBeUndefined();
  });

  it('answers no device for empty output', () => {
    expect(parseDevices('').devices).toEqual([]);
    expect(parseDevices('\n\n').maxFreeBytes).toBeUndefined();
  });

  /*
   * llama.cpp adds fields to this output as it gains backends, so a line nobody
   * recognises costs that line rather than the answer.
   */
  it('ignores lines it does not recognise without losing the rest', () => {
    const probe = parseDevices(
      [
        'Available devices:',
        '  load_backend: loaded Vulkan backend from libggml-vulkan.so',
        '  Vulkan0: Good Device (4096 MiB, 3900 MiB free)',
        '  something else entirely',
        '  Vulkan1: Device With No Figures',
      ].join('\n'),
    );

    expect(probe.devices.map((device) => device.name)).toEqual([
      'Vulkan0',
      'Vulkan1',
    ]);
    expect(probe.maxFreeBytes).toBe(3900 * MIB);
  });

  it('keeps the engine output, so a surprising answer can be shown', () => {
    const output = 'Available devices:\n  (none)';
    expect(parseDevices(output).output).toBe(output);
  });
});

describe('probeDevices', () => {
  it('asks the engine for its device list and nothing else', async () => {
    const calls: Array<{file: string; args: string[]}> = [];
    const probe = await probeDevices('/opt/model/engine/llama-server', {
      execFileImpl: async (file, args) => {
        calls.push({file, args});
        return {
          stdout: 'Available devices:\n  Vulkan0: Card (8192 MiB, 7000 MiB free)',
          stderr: '',
        };
      },
    });

    expect(calls).toEqual([
      {file: '/opt/model/engine/llama-server', args: ['--list-devices']},
    ]);
    expect(probe.maxFreeBytes).toBe(7000 * MIB);
  });

  /*
   * Some builds print the list on stderr, and a build with no backend exits
   * non-zero after printing "(none)". Neither is a failure of the app: both mean
   * "no device we can use", which is an answer.
   */
  it('reads a list that arrived on stderr', async () => {
    const probe = await probeDevices('/engine', {
      execFileImpl: async () => ({
        stdout: '',
        stderr: 'Available devices:\n  Vulkan0: Card (4096 MiB, 3800 MiB free)',
      }),
    });
    expect(probe.maxFreeBytes).toBe(3800 * MIB);
  });

  it('answers no device when the engine exits non-zero', async () => {
    const probe = await probeDevices('/engine', {
      execFileImpl: async () => {
        throw Object.assign(new Error('exit 1'), {
          stdout: 'Available devices:\n  (none)',
        });
      },
    });
    expect(probe.devices).toEqual([]);
    expect(probe.maxFreeBytes).toBeUndefined();
  });

  it('answers no device when the engine cannot be launched at all', async () => {
    const probe = await probeDevices('/engine', {
      execFileImpl: async () => {
        throw new Error('ENOENT');
      },
    });
    expect(probe.maxFreeBytes).toBeUndefined();
  });

  it('does not launch anything when there is no engine path yet', async () => {
    let called = false;
    const probe = await probeDevices('', {
      execFileImpl: async () => {
        called = true;
        return {stdout: '', stderr: ''};
      },
    });
    expect(called).toBe(false);
    expect(probe.maxFreeBytes).toBeUndefined();
  });
});

describe('systemMemoryBytes', () => {
  it('reports a total larger than zero, which is all the resolver needs', () => {
    const memory = systemMemoryBytes();
    expect(memory.total).toBeGreaterThan(0);
    expect(memory.free).toBeGreaterThanOrEqual(0);
  });
});
