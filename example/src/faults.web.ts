import { createProviderWith } from 'ai-sdk-litert-lm/internal/provider'
import { createWebRuntime, type WebBinding } from 'ai-sdk-litert-lm/internal/web'

const BROKEN_CALL = {
  role: 'assistant',
  tool_calls: [
    { type: 'function', function: { name: 'get_weather', arguments: '{"city":' } },
  ],
}

export function createProviderWithBrokenToolCall() {
  return createProviderWith((modelId, settings) =>
    createWebRuntime(modelId, settings, async () => {
      const core = (await import('@litert-lm/core')) as unknown as WebBinding
      return {
        ...core,
        Engine: {
          create: async (engineSettings) => {
            const engine = await core.Engine.create(engineSettings)
            const createConversation = engine.createConversation.bind(engine)
            engine.createConversation = async (config) => {
              const conversation = await createConversation(config)
              const send = conversation.sendMessageStreaming.bind(conversation)
              conversation.sendMessageStreaming = (message) =>
                send(message).pipeThrough(
                  new TransformStream({
                    flush(controller) {
                      controller.enqueue(BROKEN_CALL as never)
                    },
                  }),
                )
              return conversation
            }
            return engine
          },
        },
      }
    }),
  )
}
