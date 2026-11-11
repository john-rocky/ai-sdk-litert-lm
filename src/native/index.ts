import {
  compareVersions,
  createLLM,
  getDeviceInfo,
  LITERT_LM_VERSION,
  ModelRegistry,
  resolveFromManifest,
  toolResultPart,
} from 'react-native-litert-lm'

import { createProviderWith } from '../shared/provider.js'
import type { LiteRTLMProvider, LiteRTLMProviderSettings } from '../shared/types.js'
import { createNativeRuntime, type NativeBinding } from './runtime.js'

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

const binding: NativeBinding = {
  createLLM: createLLM as NativeBinding['createLLM'],
  engineIsOlderThan: (version) => compareVersions(LITERT_LM_VERSION, version) < 0,
  getDeviceInfo,
  listKeptFiles: () => ModelRegistry.listCachedFiles().map((file) => file.fileName),
  resolveFromManifest,
  toolResultPart,
}

/** Create a LiteRT-LM provider. Most apps use the default {@link litertlm}. */
export function createLiteRTLM(_settings: LiteRTLMProviderSettings = {}): LiteRTLMProvider {
  return createProviderWith((modelId, settings) =>
    createNativeRuntime(modelId, settings, binding),
  )
}

/** The default LiteRT-LM provider: `litertlm('hf://org/repo')`. */
export const litertlm = createLiteRTLM()
