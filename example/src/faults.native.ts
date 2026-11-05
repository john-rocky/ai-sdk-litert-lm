import { createNativeRuntime } from 'ai-sdk-litert-lm/internal/native'
import { createProviderWith } from 'ai-sdk-litert-lm/internal/provider'
import {
  createLLM,
  getDeviceInfo,
  ModelRegistry,
  resolveFromManifest,
  toolResultPart,
} from 'react-native-litert-lm'

const BROKEN_CALL = '<tool_call>{"name":"get_weather","arguments":{"city":</tool_call>'

export function createProviderWithBrokenToolCall() {
  return createProviderWith((modelId, settings) =>
    createNativeRuntime(modelId, settings, {
      getDeviceInfo,
      listKeptFiles: () => ModelRegistry.listCachedFiles().map((file) => file.fileName),
      resolveFromManifest,
      toolResultPart,
      createLLM: () => {
        const llm = createLLM()
        return new Proxy(llm, {
          get(target, prop, receiver) {
            if (prop !== 'execute') return Reflect.get(target, prop, receiver)
            const execute: typeof target.execute = (parts, onToken, options) =>
              target.execute(
                parts,
                (token, done) => {
                  if (done) onToken?.(BROKEN_CALL, false)
                  onToken?.(token, done)
                },
                options,
              )
            return execute
          },
        })
      },
    }),
  )
}
