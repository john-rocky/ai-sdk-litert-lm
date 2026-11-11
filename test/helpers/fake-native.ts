import type { LiteRTLMInstance } from 'react-native-litert-lm'

import type { NativeBinding } from '../../src/native/runtime.js'

function cancelledError(): Error {
  return Object.assign(new Error('The message was cancelled.'), { code: 'INFERENCE_CANCELLED' })
}

export interface ScriptedTurn {
  /** Tokens the engine streams, in order. */
  tokens: string[]
  /** Rejects after the tokens, the way the engine reports a failed stream. */
  failWith?: Error
  /** Leaves the message generating until it is cancelled. */
  hangAfterTokens?: boolean
  /** Waits this long before each token, like a slow phone. */
  delayMs?: number
}

/** A scripted stand-in for the phone's LiteRT-LM binding that records what it was asked. */
export class FakeNative {
  turns: ScriptedTurn[] = []
  loads: { path: string; config: Record<string, any>; options: any }[] = []
  resets: { historyJson?: string; systemPrompt?: string }[] = []
  executes: { parts: any[]; options: any }[] = []
  loadError: Error | undefined
  closes = 0
  unloads = 0
  instancesCreated = 0
  manifest: any = null
  platform: 'android' | 'ios' = 'android'
  manifestCalls: any[] = []
  keptFiles: string[] = []
  /** The LiteRT-LM versions the engine is older than. */
  engineOlderThan: string[] = ['0.19.1']
  /** False once the system has taken the engine's memory back. */
  ready = true
  /** Holds a load until it is called, like a long download. */
  holdLoad: Promise<void> | undefined

  private cancel: (() => void) | undefined

  /** The system takes the engine's memory back: a message in progress ends as cancelled. */
  freeMemory(): void {
    this.ready = false
    this.cancel?.()
  }

  binding: NativeBinding = {
    createLLM: () => {
      this.instancesCreated += 1
      return this.instance()
    },
    engineIsOlderThan: (version) => this.engineOlderThan.includes(version),
    getDeviceInfo: (() => ({ platform: this.platform })) as NativeBinding['getDeviceInfo'],
    listKeptFiles: () => this.keptFiles,
    resolveFromManifest: (async (repo: string, options: unknown) => {
      this.manifestCalls.push({ repo, options })
      return this.manifest
    }) as NativeBinding['resolveFromManifest'],
    toolResultPart: (name, response) => ({
      type: 'toolResult',
      name,
      responseJson: JSON.stringify(response) ?? 'null',
    }),
  }

  private instance(): LiteRTLMInstance {
    const self = this
    return {
      async loadModel(path: string, config: Record<string, any>, options: any) {
        self.loads.push({ path, config, options })
        self.ready = true
        options?.onProgress?.(0.5)
        if (self.holdLoad !== undefined) await self.holdLoad
        if (self.loadError !== undefined) {
          const error = self.loadError
          self.loadError = undefined
          throw error
        }
      },
      resetConversation(historyJson?: string, systemPrompt?: string) {
        self.resets.push({ historyJson, systemPrompt })
        self.cancel?.()
      },
      execute(parts: any[], onToken: (token: string, done: boolean) => void, options: any) {
        self.executes.push({ parts, options })
        const turn = self.turns.shift()
        if (turn === undefined) return Promise.reject(new Error('No scripted turn left.'))
        return new Promise<string>((resolve, reject) => {
          let cancelled = false
          self.cancel = () => {
            cancelled = true
            self.cancel = undefined
            onToken('', true)
            reject(cancelledError())
          }
          void (async () => {
            for (const token of turn.tokens) {
              if (turn.delayMs !== undefined) {
                await new Promise((wake) => setTimeout(wake, turn.delayMs))
              } else {
                await Promise.resolve()
              }
              // A cancelled message streams nothing more, as with the engine.
              if (cancelled) return
              onToken(token, false)
            }
            if (turn.hangAfterTokens || cancelled) return
            self.cancel = undefined
            if (turn.failWith !== undefined) {
              onToken(`Error: ${turn.failWith.message}`, true)
              reject(turn.failWith)
              return
            }
            onToken('', true)
            resolve(turn.tokens.join(''))
          })()
        })
      },
      isReady: () => self.ready,
      getStats: () => ({
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        timeToFirstToken: 120,
        totalTime: 500,
        tokensPerSecond: 42,
      }),
      countTokens: () => -1,
      getContextTokenCount: () => -1,
      async unload() {
        self.unloads += 1
      },
      close() {
        self.closes += 1
      },
    } as unknown as LiteRTLMInstance
  }
}
