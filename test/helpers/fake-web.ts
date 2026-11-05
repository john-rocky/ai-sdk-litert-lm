import type { Message } from '@litert-lm/core'

import type { WebBinding } from '../../src/web/runtime.js'

export interface ScriptedAnswer {
  chunks: Message[]
  failWith?: Error
  hangAfterChunks?: boolean
}

export const text = (value: string): Message => ({
  role: 'assistant',
  content: [{ type: 'text', text: value }],
})

export const toolCall = (name: string, args: Record<string, any>): Message => ({
  role: 'assistant',
  tool_calls: [{ type: 'function', function: { name, arguments: args } }],
})

/** A scripted stand-in for `@litert-lm/core` that records what it was asked. */
export class FakeWeb {
  answers: ScriptedAnswer[] = []
  engineSettings: any[] = []
  configs: any[] = []
  sent: any[] = []
  conversationsOpen = 0
  conversationsCreated = 0
  cancels = 0
  enginesDeleted = 0
  createError: Error | undefined
  failResolve = false
  /** What `resolveModel` gives, in place of its input. */
  resolvedModel: any
  /** Runs while a conversation opens. */
  onCreateConversation: (() => void) | undefined
  loadedWasmPaths: string[] = []
  resolved: any[] = []

  binding: WebBinding = {
    Backend: { CPU: 2 },
    resolveModel: (async (model: any, options: any) => {
      this.resolved.push({ model, options })
      if (this.createError !== undefined && this.failResolve) {
        const error = this.createError
        this.createError = undefined
        throw error
      }
      return { model: this.resolvedModel ?? model }
    }) as WebBinding['resolveModel'],
    loadLiteRtLm: async (path: string) => {
      this.loadedWasmPaths.push(path)
    },
    Engine: {
      create: async (settings: any) => {
        this.engineSettings.push(settings)
        if (this.createError !== undefined) {
          const error = this.createError
          this.createError = undefined
          throw error
        }
        return this.engine() as never
      },
    },
  }

  private engine() {
    const self = this
    return {
      async createConversation(config: any) {
        self.configs.push(config)
        self.onCreateConversation?.()
        await Promise.resolve()
        self.conversationsOpen += 1
        self.conversationsCreated += 1
        return self.conversation()
      },
      async delete() {
        self.enginesDeleted += 1
      },
    }
  }

  private conversation() {
    const self = this
    let deleted = false
    return {
      sendMessageStreaming(message: any) {
        self.sent.push(message)
        const answer = self.answers.shift()
        return new ReadableStream<Message>({
          async start(controller) {
            if (answer === undefined) {
              controller.error(new Error('No scripted answer left.'))
              return
            }
            for (const chunk of answer.chunks) {
              await Promise.resolve()
              controller.enqueue(chunk)
            }
            if (answer.hangAfterChunks) return
            if (answer.failWith !== undefined) controller.error(answer.failWith)
            else controller.close()
          },
          cancel() {
            self.cancels += 1
          },
        })
      },
      async getBenchmarkInfo() {
        return {
          lastPrefillTokenCount: 11,
          lastDecodeTokenCount: 7,
          lastDecodeTokensPerSecond: 33,
          lastPrefillTokensPerSecond: 100,
          timeToFirstTokenInSecond: 0.25,
        }
      },
      async delete() {
        if (!deleted) self.conversationsOpen -= 1
        deleted = true
      },
    }
  }
}
