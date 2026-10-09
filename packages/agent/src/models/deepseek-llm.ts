/**
 * The DeepSeek provider, kept under its original name.
 *
 * DeepSeek was the only backend this app had, so the class and its error were
 * named after it. It is now one entry in a provider catalogue and the client is
 * shared with a locally served model and with Gemini, so the implementation
 * moved to `openai-compat-llm.ts`. These aliases exist so that an import written
 * against the old name keeps working and keeps compiling to the same class —
 * there is exactly one client, not two.
 */
export {
  OpenAiCompatLlm as DeepSeekLlm,
  OpenAiCompatRequestError as DeepSeekRequestError,
} from './openai-compat-llm.js';
export type {OpenAiCompatLlmOptions as DeepSeekLlmOptions} from './openai-compat-llm.js';
