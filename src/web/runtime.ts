import type { SharedV4Warning } from '@ai-sdk/provider'
import type {
  Conversation as CoreConversation,
  ConversationConfig,
  Engine,
  EngineSettings,
  Message,
  ModelSource,
  resolveModel,
  ToolCall,
} from '@litert-lm/core'

import type {
  GenerationRequest,
  GenerationResult,
  LiteRTLMRuntime,
  OutputChunk,
} from '../shared/backend.js'
import { createAbortError, errorMessage, LiteRTLMError, type LiteRTLMErrorCode } from '../shared/errors.js'
import { parseHuggingFaceId } from '../shared/hugging-face.js'
import { DEFAULT_CHANNELS, OutputParser } from '../shared/output-parser.js'
import { canonicalJson, transcriptKey, type Turn, withJsonInstruction } from '../shared/prompt.js'
import type { LiteRTLMModelSettings, LiteRTLMPrepareOptions } from '../shared/types.js'
import {
  type CachedModel,
  loadFromCache,
  type ModelLocation,
  recallKept,
  rememberLocation,
} from './model-cache.js'

/** The parts of `@litert-lm/core` the runtime uses. Replaced in tests. */
export interface WebBinding {
  Engine: { create(settings: EngineSettings): Promise<Engine> }
  Backend: { CPU: number }
  resolveModel: typeof resolveModel
  loadLiteRtLm?: (path: string) => Promise<unknown>
}

/** The one Wasm path loaded in this page: the runtime refuses to load a second time. */
let loadedWasmPath: string | undefined

/** Load the runtime's module once per provider, and its Wasm from the provider's path if it has one. */
export function createBindingLoader(
  wasmPath: string | undefined,
  importCore: () => Promise<WebBinding>,
): () => Promise<WebBinding> {
  let binding: Promise<WebBinding> | undefined
  const importOnce = async () => {
    const core = await importCore()
    if (wasmPath !== undefined && wasmPath !== loadedWasmPath) {
      await core.loadLiteRtLm?.(wasmPath)
      loadedWasmPath = wasmPath
    }
    return core
  }
  return () => {
    binding ??= importOnce().catch((error: unknown) => {
      binding = undefined
      throw error
    })
    return binding
  }
}

function toCoreMessage(turn: Turn): Message {
  switch (turn.role) {
    case 'user':
      return { role: 'user', content: turn.text }
    case 'assistant':
      return {
        role: 'assistant',
        content: turn.text,
        ...(turn.toolCalls.length > 0
          ? {
              tool_calls: turn.toolCalls.map((call): ToolCall => ({
                type: 'function',
                function: {
                  name: call.name,
                  arguments: (typeof call.arguments === 'string'
                    ? safeParseObject(call.arguments)
                    : (call.arguments ?? {})) as ToolCall['function']['arguments'],
                },
              })),
            }
          : {}),
      }
    case 'tool':
      return {
        role: 'tool',
        content: turn.results.map((result) => ({
          type: 'tool_response' as const,
          name: result.name,
          response: result.value as never,
        })),
      }
  }
}

function safeParseObject(json: string): unknown {
  try {
    return JSON.parse(json) as unknown
  } catch {
    return {}
  }
}

/** What the Hub and `@litert-lm/core` say about a repo or file that isn't there. */
const MODEL_NOT_THERE =
  /\bhttp 40[134]\b|couldn't resolve .*(not found|\b404\b)|no \.litertlm|no suitable model file|invalid hugging face|may not exist|doesn't exist|no revision named/

function classifyLoadError(error: unknown, fromKeptFile: boolean): LiteRTLMErrorCode {
  const message = errorMessage(error).toLowerCase()
  // The engine ran out of bytes: a truncated file, or a connection that dropped.
  if (message.includes('error fetching data')) {
    return fromKeptFile ? 'INVALID_MODEL' : 'DOWNLOAD_FAILED'
  }
  if (message.includes('out of memory') || message.includes('memory access out of bounds')) {
    return 'OUT_OF_MEMORY'
  }
  if (message.includes('invalid magic')) return 'INVALID_MODEL'
  if (MODEL_NOT_THERE.test(message)) return 'MODEL_NOT_FOUND'
  if (
    message.includes('failed to fetch') ||
    message.includes('load failed') ||
    message.includes('network') ||
    message.includes('rate limit')
  ) {
    return 'DOWNLOAD_FAILED'
  }
  return 'LOAD_FAILED'
}

function classifyGenerateError(error: unknown): LiteRTLMErrorCode {
  const message = errorMessage(error).toLowerCase()
  if (message.includes('input token') || message.includes('too long')) return 'CONTEXT_TOO_LONG'
  return 'GENERATION_FAILED'
}

type ResolvedModel = Awaited<ReturnType<WebBinding['resolveModel']>>['model']

function isModelSource(model: ResolvedModel | undefined): model is ModelSource {
  return (
    typeof model === 'object' &&
    !(model instanceof Blob) &&
    !(model instanceof ReadableStream) &&
    'url' in model
  )
}

/** The runtime reports reasoning on its own channel, unless a bundle's template leaves tags in the text. */
const REASONING_CHANNELS = DEFAULT_CHANNELS.filter((channel) => channel.type === 'reasoning')

/** Text and reasoning in a message chunk. */
function* contentOf(chunk: Message): Generator<OutputChunk> {
  const thought = chunk.channels?.thought
  if (thought !== undefined && thought.length > 0) yield { type: 'reasoning', text: thought }
  if (typeof chunk.content === 'string') {
    if (chunk.content.length > 0) yield { type: 'text', text: chunk.content }
    return
  }
  for (const part of chunk.content ?? []) {
    if (part.type === 'text' && part.text.length > 0) yield { type: 'text', text: part.text }
  }
}

function toolCallsOf(chunk: Message): Extract<OutputChunk, { type: 'tool-call' }>[] {
  return (chunk.tool_calls ?? []).map((call) => {
    const fn = (call.function ?? {}) as { name?: unknown; arguments?: unknown }
    return {
      type: 'tool-call',
      name: typeof fn.name === 'string' ? fn.name : '',
      argumentsJson:
        typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
    }
  })
}

export function createWebRuntime(
  modelId: string,
  settings: LiteRTLMModelSettings,
  loadBinding: () => Promise<WebBinding>,
): LiteRTLMRuntime {
  let engine: Engine | undefined
  let live: { conversation: CoreConversation; configKey: string; historyKey: string } | undefined
  /** What the model id resolved to. Asking the Hub once is enough. */
  let resolved: ResolvedModel | undefined

  const load = async (options?: LiteRTLMPrepareOptions): Promise<void> => {
    if (engine !== undefined) return
    const binding = await loadBinding().catch((error: unknown) => {
      throw new LiteRTLMError(
        'LOAD_FAILED',
        `Could not load @litert-lm/core. Is it installed? ${errorMessage(error)}`,
        error,
      )
    })
    if (settings.backend === 'npu') {
      throw new LiteRTLMError('LOAD_FAILED', 'The browser has no NPU backend. Use gpu or cpu.')
    }
    // `hf://` is what the runtime reads. A bare `org/repo` means the same here as on a phone.
    const id =
      parseHuggingFaceId(modelId) !== undefined && !modelId.startsWith('hf://')
        ? `hf://${modelId}`
        : modelId
    const source: string | ModelSource =
      settings.accessToken !== undefined || settings.sha256 !== undefined
        ? { url: id, accessToken: settings.accessToken, sha256: settings.sha256 }
        : id
    // Left unset for the GPU: only then does a `hf://` repo give its `-gpu.litertlm` file.
    const backend =
      settings.backend === 'cpu'
        ? { backend: binding.Backend.CPU as NonNullable<EngineSettings['backend']> }
        : {}
    const onProgress = options?.onProgress ?? settings.onProgress

    const modelKey = `${id} ${settings.backend ?? ''}`
    let location: ModelLocation | undefined
    let cached: CachedModel | undefined
    try {
      try {
        resolved ??= (await binding.resolveModel(source, { ...backend, signal: options?.abortSignal })).model
      } catch (error) {
        // Only the Hub saying the repo isn't there counts against what it said the last time.
        if (classifyLoadError(error, false) === 'MODEL_NOT_FOUND') throw error
        if (options?.abortSignal?.aborted) throw error
        cached = await recallKept(modelKey)
        if (cached === undefined) throw error
      }
      if (cached === undefined && (typeof resolved === 'string' || isModelSource(resolved))) {
        location =
          typeof resolved === 'string'
            ? { url: resolved }
            : { url: resolved.url, sha256: resolved.sha256 }
        cached = await loadFromCache(location, {
          accessToken: settings.accessToken,
          onProgress,
          signal: options?.abortSignal,
        })
      }
      engine = await binding.Engine.create({
        model: (cached?.file ?? resolved) as EngineSettings['model'],
        benchmarkEnabled: true,
        ...backend,
        ...(settings.maxContextTokens !== undefined
          ? { mainExecutorSettings: { maxNumTokens: settings.maxContextTokens } }
          : {}),
      })
      // Only a Hub id needs asking again, and only a file that loaded is worth finding again.
      if (id.startsWith('hf://') && location !== undefined && cached !== undefined) {
        await rememberLocation(modelKey, location)
      }
    } catch (error) {
      if (options?.abortSignal?.aborted) throw createAbortError()
      if (error instanceof LiteRTLMError) throw error
      const code = classifyLoadError(error, cached !== undefined)
      // Whatever was at that URL isn't a model. It may be a page in place of the file.
      if (code === 'INVALID_MODEL') await cached?.evict().catch(() => {})
      throw new LiteRTLMError(code, errorMessage(error), error)
    }
    onProgress?.({ fraction: 1 })
  }

  const conversationConfigKey = (request: GenerationRequest): string =>
    canonicalJson({
      tools: request.tools,
      temperature: request.temperature ?? settings.temperature,
      topK: request.topK ?? settings.topK,
      topP: request.topP ?? settings.topP,
      seed: request.seed,
      maxOutputTokens: request.maxOutputTokens,
      thinking: request.thinking,
    })

  const dropConversation = async () => {
    const conversation = live?.conversation
    live = undefined
    await conversation?.delete().catch(() => {})
  }

  const openConversation = async (request: GenerationRequest): Promise<CoreConversation> => {
    const { system, history } = request.conversation
    const messages: Message[] = []
    if (system !== undefined) messages.push({ role: 'system', content: system })
    messages.push(...history.map(toCoreMessage))

    const temperature = request.temperature ?? settings.temperature
    const topK = request.topK ?? settings.topK
    const topP = request.topP ?? settings.topP
    const samplerParams = {
      ...(temperature !== undefined ? { temperature } : {}),
      ...(topK !== undefined ? { k: topK } : {}),
      ...(topP !== undefined ? { p: topP } : {}),
      ...(request.seed !== undefined ? { seed: request.seed } : {}),
    }
    const config: ConversationConfig = {
      preface: {
        ...(messages.length > 0 ? { messages } : {}),
        ...(request.tools.length > 0
          ? {
              tools: request.tools.map((tool) => ({
                type: 'function',
                function: {
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.parameters as never,
                },
              })),
            }
          : {}),
        ...(request.thinking !== undefined
          ? { extra_context: { enable_thinking: request.thinking } }
          : {}),
      },
      sessionConfig: {
        ...(Object.keys(samplerParams).length > 0 ? { samplerParams } : {}),
        ...(request.maxOutputTokens !== undefined
          ? { maxOutputTokens: request.maxOutputTokens }
          : {}),
      },
    }
    return (engine as Engine).createConversation(config)
  }

  return {
    warningsFor(request) {
      const warnings: SharedV4Warning[] = []
      if (request.frequencyPenalty !== undefined) {
        warnings.push({ type: 'unsupported', feature: 'frequencyPenalty' })
      }
      if (request.presencePenalty !== undefined) {
        warnings.push({ type: 'unsupported', feature: 'presencePenalty' })
      }
      if (settings.speculativeDecoding !== undefined) {
        warnings.push({
          type: 'unsupported',
          feature: 'speculativeDecoding',
          details: 'Speculative decoding is available on phones only.',
        })
      }
      if (request.jsonSchema !== undefined) {
        warnings.push({
          type: 'compatibility',
          feature: 'structured output',
          details:
            'The browser runtime has no per-message constraint, so the schema goes to the model as an instruction and the output is not guaranteed to match.',
        })
      }
      return warnings
    },

    prepare: (options) => load(options),

    async generate(request, onChunk, abortSignal) {
      if (abortSignal?.aborted) throw createAbortError()
      await load({ abortSignal })
      if (abortSignal?.aborted) throw createAbortError()

      // The browser runtime has no structured output: ask for it in the system text.
      const conversationRequest =
        request.jsonSchema !== undefined
          ? {
              ...request,
              conversation: {
                ...request.conversation,
                system: withJsonInstruction(request.conversation.system, request.jsonSchema),
              },
            }
          : request
      const { system, history, final } = conversationRequest.conversation
      const configKey = conversationConfigKey(conversationRequest)
      const historyKey = transcriptKey(system, history)
      const continued = live?.configKey === configKey && live.historyKey === historyKey

      let aborted = false
      let reader: ReadableStreamDefaultReader<Message> | undefined
      const onAbort = () => {
        aborted = true
        void reader?.cancel().catch(() => {})
      }
      abortSignal?.addEventListener('abort', onAbort)

      try {
        let conversation: CoreConversation
        if (continued && live !== undefined) {
          conversation = live.conversation
          live = undefined
        } else {
          await dropConversation()
          try {
            conversation = await openConversation(conversationRequest)
          } catch (error) {
            throw new LiteRTLMError(classifyGenerateError(error), errorMessage(error), error)
          }
        }

        let text = ''
        const toolCalls: { name: string; argumentsJson: string }[] = []
        const parser = new OutputParser(REASONING_CHANNELS, (chunk) => {
          if (chunk.type === 'text') text += chunk.text
          onChunk(chunk)
        })

        try {
          // An abort while the conversation opened never sends the message.
          if (!aborted) {
            reader = conversation.sendMessageStreaming(toCoreMessage(final)).getReader()
          }
          while (reader !== undefined) {
            const { done, value } = await reader.read()
            if (done || aborted) break
            for (const chunk of contentOf(value)) {
              if (chunk.type === 'text') parser.push(chunk.text)
              else onChunk(chunk)
            }
            for (const call of toolCallsOf(value)) {
              toolCalls.push(call)
              onChunk(call)
            }
          }
        } catch (error) {
          await conversation.delete().catch(() => {})
          if (aborted) throw createAbortError()
          throw new LiteRTLMError(classifyGenerateError(error), errorMessage(error), error)
        }
        if (aborted) {
          // A cancelled conversation holds a partial answer. The next call starts a new one.
          await conversation.delete().catch(() => {})
          throw createAbortError()
        }
        parser.finish()

        const result: GenerationResult = { continued, reloaded: false }
        try {
          const info = await conversation.getBenchmarkInfo()
          result.inputTokens = info.lastPrefillTokenCount
          result.outputTokens = info.lastDecodeTokenCount
          result.tokensPerSecond = info.lastDecodeTokensPerSecond
          result.timeToFirstTokenMs = info.timeToFirstTokenInSecond * 1000
          result.cutOff =
            request.maxOutputTokens !== undefined &&
            result.outputTokens >= request.maxOutputTokens
        } catch {
          // Usage stays unknown.
        }

        live = {
          conversation,
          configKey,
          historyKey: transcriptKey(system, [
            ...history,
            final,
            {
              role: 'assistant',
              text,
              toolCalls: toolCalls.map((call) => ({
                name: call.name,
                arguments: safeParseObject(call.argumentsJson),
              })),
            },
          ]),
        }
        return result
      } finally {
        abortSignal?.removeEventListener('abort', onAbort)
      }
    },

    async unload() {
      await dropConversation()
      const current = engine
      engine = undefined
      await current?.delete().catch(() => {})
    },
  }
}
