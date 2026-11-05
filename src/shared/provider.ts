import { NoSuchModelError } from '@ai-sdk/provider'

import { type LiteRTLMRuntime, SerialQueue } from './backend.js'
import { LanguageModel } from './language-model.js'
import type {
  LiteRTLMLanguageModel,
  LiteRTLMModelSettings,
  LiteRTLMProvider,
} from './types.js'

export type RuntimeFactory = (
  modelId: string,
  settings: LiteRTLMModelSettings,
) => LiteRTLMRuntime

function settingsKey(modelId: string, settings: LiteRTLMModelSettings): string {
  // Functions don't identify a model: a new callback must not load it again.
  return JSON.stringify({ modelId, settings })
}

/**
 * A provider whose models share one queue and one loaded engine: a second model
 * unloads the first, because two models rarely fit in a phone's memory.
 */
export function createProviderWith(createRuntime: RuntimeFactory): LiteRTLMProvider {
  const queue = new SerialQueue()
  const runtimes = new Map<string, LiteRTLMRuntime>()
  let active: LiteRTLMRuntime | undefined

  const exclusive = (runtime: LiteRTLMRuntime): LiteRTLMRuntime => {
    const makeActive = async () => {
      if (active !== undefined && active !== runtime) await active.unload()
      active = runtime
    }
    return {
      warningsFor: (request) => runtime.warningsFor(request),
      prepare: async (options) => {
        await makeActive()
        await runtime.prepare(options)
      },
      generate: async (request, onChunk, abortSignal) => {
        await makeActive()
        return runtime.generate(request, onChunk, abortSignal)
      },
      unload: async () => {
        if (active === runtime) active = undefined
        await runtime.unload()
      },
    }
  }

  const languageModel = (
    modelId: string,
    settings: LiteRTLMModelSettings = {},
  ): LiteRTLMLanguageModel => {
    const key = settingsKey(modelId, settings)
    let runtime = runtimes.get(key)
    if (runtime === undefined) {
      runtime = exclusive(createRuntime(modelId, settings))
      runtimes.set(key, runtime)
    }
    return new LanguageModel(modelId, runtime, queue)
  }

  const provider = ((modelId: string, settings?: LiteRTLMModelSettings) =>
    languageModel(modelId, settings)) as LiteRTLMProvider

  return Object.assign(provider, {
    specificationVersion: 'v4' as const,
    languageModel,
    embeddingModel: (modelId: string): never => {
      throw new NoSuchModelError({ modelId, modelType: 'embeddingModel' })
    },
    imageModel: (modelId: string): never => {
      throw new NoSuchModelError({ modelId, modelType: 'imageModel' })
    },
    unloadAll: () =>
      queue.run(async () => {
        const current = active
        active = undefined
        await current?.unload()
      }),
  })
}
