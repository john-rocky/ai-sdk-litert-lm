import { createProviderWith } from '../shared/provider.js'
import type { LiteRTLMProvider, LiteRTLMProviderSettings } from '../shared/types.js'
import { createBindingLoader, createWebRuntime, type WebBinding } from './runtime.js'

export { LiteRTLMError, type LiteRTLMErrorCode } from '../shared/errors.js'
export type {
  LiteRTLMBackendName,
  LiteRTLMCallMetadata,
  LiteRTLMLanguageModel,
  LiteRTLMModelSettings,
  LiteRTLMPrepareOptions,
  LiteRTLMProgress,
  LiteRTLMProvider,
  LiteRTLMProviderSettings,
} from '../shared/types.js'

/** Create a LiteRT-LM provider. Most apps use the default {@link litertlm}. */
export function createLiteRTLM(providerSettings: LiteRTLMProviderSettings = {}): LiteRTLMProvider {
  // Loaded on the first call: the runtime's Wasm is large, and this module may be imported on a server.
  const loadBinding = createBindingLoader(
    providerSettings.wasmPath,
    () => import('@litert-lm/core') as unknown as Promise<WebBinding>,
  )
  return createProviderWith((modelId, settings) => createWebRuntime(modelId, settings, loadBinding))
}

/** The default LiteRT-LM provider: `litertlm('hf://org/repo')`. */
export const litertlm = createLiteRTLM()
