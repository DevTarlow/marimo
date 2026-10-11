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
import {parseEmbeddingManifest, parseManifest} from './manifest.js';
import type {EmbeddingManifest, LocalModelManifest} from './manifest.js';

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

/**
 * The engine the *recall* model runs on, which is deliberately not the one above.
 *
 * This is the finding the whole feature was gated on, and it was learned by
 * running the pinned build rather than by reading about it:
 *
 *   $ llama-server -m embeddinggemma-2-Q8_0.gguf --embeddings --pooling mean
 *   E llama_model_load: error loading model: unknown model architecture:
 *     'gemma-embedding2'
 *
 * b11429 is the nightly cut of the current stable release, and it was published
 * one day before this model was. `gemma-embedding2` appears in llama.cpp's
 * architecture list after it, so the app's own engine cannot load the model at
 * all. Two ways out, and this is the one that does not put the chat model at
 * risk: give recall its own engine rather than moving the app onto a build the
 * chat path has never been verified against. `--jinja`, the tool-call template
 * and `enable_thinking:false` were all verified against b11429 (see `args.ts`),
 * and a nightly that changes any of them would turn the app's core feature into
 * "the model is offered no tools at all" — the failure that is proved by
 * running, and cannot be seen from the window.
 *
 * b11557 was verified here: it loads the model, returns 768 finite
 * unit-length vectors, and embeds an image, a two-second WAV and a ten-second
 * MP4 into that same space.
 *
 * When the app's own engine is next bumped, this can collapse back to one — and
 * the bump should be tested against both models, which is the work this split
 * exists to avoid doing twice.
 */
const RECALL_ENGINE = {
  tag: 'b11557',
  baseUrl: 'https://github.com/ggml-org/llama.cpp/releases/download',
  assets: {
    'linux-x64': {
      file: 'llama-b11557-bin-ubuntu-vulkan-x64.tar.gz',
      sha256: 'c05ccb11f6de7c907c9ca861a0bb921bc3a52a94912cd0f1d47d53cea0c3dc08',
    },
    'linux-arm64': {
      file: 'llama-b11557-bin-ubuntu-vulkan-arm64.tar.gz',
      sha256: '7c9a2e6de70f005c597de301a53874b2413b3f0b7a25183f6737130248d6786b',
    },
    'darwin-arm64': {
      file: 'llama-b11557-bin-macos-arm64.tar.gz',
      sha256: '83cd5827293f7fa33403627436da2606413e48978bcedfe7aa3e587f62742f5c',
    },
    'darwin-x64': {
      file: 'llama-b11557-bin-macos-x64.tar.gz',
      sha256: 'c6cb1d85c6528bf02202d59ff67b4aa16feec8f442c41dce91dbdbe6a3d6ec93',
    },
    'win32-x64': {
      file: 'llama-b11557-bin-win-vulkan-x64.zip',
      sha256: '6db23c5cf69e51f3dc2bf7f68277f4a791217bab853bd5b93afac1898d450b83',
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
 * The recall model: one repository, two downloads.
 *
 * `text` is the 270M backbone and is what an index of words, code and
 * conversations needs. `media` is the vision and audio projector — 555 MB, and
 * without it in the process there is no image encoder at all, so a picture is
 * not a slower answer, it is one the engine cannot give.
 *
 * Q8_0 rather than the smallest quant: it is 310 MB against 176 MB, and the
 * measurements that matter here are a dozen tokens per bullet of memory and a
 * few hundred per image, where the better quantization is the cheaper half of a
 * download measured in seconds either way. It is also not the F16 file in the
 * same repository, which is deliberate: the model card warns that this model's
 * activations exceed float16's range and return NaN in it, and the first thing
 * `01` does with a vector is check that every value is finite.
 */
const EMBEDDING_WEIGHTS = {
  repo: 'unsloth/embeddinggemma-2-GGUF',
  revision: '031f0d4b35536f69ab3509d4893c923264fcf253',
  license: 'Apache-2.0',
  dims: 768,
  contextSize: 8192,
  pooling: 'mean',
  pieces: {
    text: {
      name: 'text',
      label: 'The recall model',
      file: 'embeddinggemma-2-Q8_0.gguf',
      sha256: '6f1bd4ac6c5df7444f9cca7ca36cafe6cfa34cd6f49fefb1e0b4be8143aed8bc',
      bytes: 309_855_520,
    },
    media: {
      name: 'media',
      label: 'The image and audio encoder',
      file: 'mmproj-Q8_0.gguf',
      sha256: '90e7b0238009e2954f856f2081dcf7f35af026b64c765e98f4777053e1754460',
      bytes: 554_821_120,
    },
  },
} as const;

export const EMBEDDING_PINS: EmbeddingManifest = parseEmbeddingManifest({
  engine: RECALL_ENGINE,
  weights: EMBEDDING_WEIGHTS,
});
