/**
 * The pins, as code rather than as a file the app has to go and find.
 *
 * This lived in `apps/desktop/local-model.json` and was read by a fetch script at
 * package time. It has to be read at *run* time now, because the app downloads the
 * model on a user's first launch — and a run-time read of a file is exactly the
 * problem this file's history is about: the window would find it through
 * Electron's `process.resourcesPath`, the headless runner would derive the path
 * from its own executable, and when the two disagreed nothing would error.
 *
 * A module has no path to disagree about. Both processes import it, the pins
 * travel with the code they describe, and there is nothing to copy into the
 * installer.
 *
 * The values are validated on import, so a truncated paste or a placeholder digest
 * is a loud failure at startup rather than a first-run download that fails on
 * somebody else's machine.
 */
import {parseManifest} from './manifest.js';
import type {LocalModelManifest} from './manifest.js';

/**
 * The engine, pinned by release tag and by the sha256 of each platform's archive.
 *
 * Every asset here is a GPU build, and there is deliberately no CPU one: this app
 * runs its model on a graphics card or reports that it cannot. The GPU builds
 * still contain a CPU backend — llama.cpp always does — so they run on a machine
 * with no device, they just report none, which is what the first-run probe reads.
 *
 * Vulkan on Linux and Windows, because one 32 MB asset covers NVIDIA, AMD and
 * Intel; the Windows CUDA build is 264 MB and needs a further 391 MB of cudart
 * DLLs, which is a 20x download to help one vendor. macOS needs no choice: its
 * build is Metal. A CUDA or ROCm asset can be added per platform later without
 * changing anything else, which is why the probe asks the engine rather than a
 * vendor tool.
 */
const ENGINE = {
  tag: 'b11429',
  baseUrl: 'https://github.com/ggml-org/llama.cpp/releases/download',
  assets: {
    'linux-x64': {
      file: 'llama-b11429-bin-ubuntu-vulkan-x64.tar.gz',
      sha256: '632c4e98feba2b94407a2130e3133e0c3aefb0ea1ab41337e926d8bfafdd0b74',
    },
    'linux-arm64': {
      file: 'llama-b11429-bin-ubuntu-vulkan-arm64.tar.gz',
      sha256: '702d99c4219b4314cc6d3b10fb41ae96cbfc68226305c2681269dfb51487af34',
    },
    'darwin-arm64': {
      file: 'llama-b11429-bin-macos-arm64.tar.gz',
      sha256: '740288ec6887be94280a5dfa25b5e23a78285cab104519e6c7e218904ee82459',
    },
    'darwin-x64': {
      file: 'llama-b11429-bin-macos-x64.tar.gz',
      sha256: '29ac3ea02be6bd143e824973f2cc5fa74bc4094393a9eaab0ff6814f19dd8522',
    },
    'win32-x64': {
      file: 'llama-b11429-bin-win-vulkan-x64.zip',
      sha256: '1bfe78ad9168b79fa02bf67f6af9f5e17a966d824d77238517f7bef12ac73b36',
    },
  },
  backends: {
    'linux-x64': 'Vulkan',
    'linux-arm64': 'Vulkan',
    'darwin-arm64': 'Metal',
    'darwin-x64': 'Metal',
    'win32-x64': 'Vulkan',
  },
};

/**
 * The weights: one model, two quantizations of it.
 *
 * Qwen3.5-4B is a hybrid — 8 of its 32 layers are full attention and the rest are
 * linear — so the KV cache costs 32 KiB per token rather than the ~144 KiB a dense
 * model of this size would. Context is cheap; the weights are the constraint, and
 * that is what the two tiers differ in.
 *
 * Quantized by unsloth and pinned by revision, so a re-uploaded file cannot change
 * what the app ships. The `mmproj-*.gguf` vision projectors in the same repository
 * are deliberately not pinned: this app is text-only and they are 672 MB to 1.3 GB
 * of dead weight.
 */
const WEIGHTS = {
  repo: 'unsloth/Qwen3.5-4B-GGUF',
  revision: 'e87f176479d0855a907a41277aca2f8ee7a09523',
  license: 'Apache-2.0',
  kvBytesPerToken: 32768,
  tiers: {
    /**
     * The tier for a 4 GB card: 2.7 GB of weights, so it fits with room for a
     * quantized cache at 16K. It is also the tier that fits an integrated GPU
     * sharing system memory.
     */
    low: {
      label: 'Low',
      file: 'Qwen3.5-4B-Q4_K_M.gguf',
      sha256: '00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4',
      bytes: 2_740_937_888,
      contextSize: 16_384,
    },
    /**
     * The tier for a 6 GB card or better: 4.5 GB of weights is roughly 5.2 GB
     * resident at 16K and 5.6 GB at 32K once the cache and compute buffers are
     * counted. The same model as the low tier at a less lossy quantization — same
     * template, same tool calls, just bigger.
     */
    high: {
      label: 'High',
      file: 'Qwen3.5-4B-Q8_0.gguf',
      sha256: '10cc391b403021dd11c614679d2fd92f611c3681d29e29651b717316965d61e1',
      bytes: 4_482_403_488,
      contextSize: 32_768,
    },
  },
};

/**
 * The pins, parsed.
 *
 * Parsed here rather than at the call site because the parse is what turns a
 * hand-edited value into a sentence naming the field that is wrong — and a caller
 * that forgot to parse would be reading a document nothing had checked.
 */
export const MODEL_PINS: LocalModelManifest = parseManifest({
  engine: ENGINE,
  weights: WEIGHTS,
});
