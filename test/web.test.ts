import { generateText, jsonSchema, Output, stepCountIs, streamText, tool } from 'ai'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { LiteRTLMError } from '../src/shared/errors.js'
import { createProviderWith } from '../src/shared/provider.js'
import { createBindingLoader, createWebRuntime } from '../src/web/runtime.js'
import { FakeWeb, text, toolCall } from './helpers/fake-web.js'

const MODEL = 'hf://org/gemma'

function setup() {
  const fake = new FakeWeb()
  const provider = createProviderWith((modelId, settings) =>
    createWebRuntime(modelId, settings, async () => fake.binding),
  )
  return { fake, provider }
}

const weather = tool({
  description: 'Get the weather for a city.',
  inputSchema: jsonSchema<{ city: string }>({
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  }),
  execute: async ({ city }) => ({ city, temperature: 21 }),
})

describe('generateText and streamText in a browser', () => {
  it('generates text and reports usage', async () => {
    const { fake, provider } = setup()
    fake.answers.push({ chunks: [text('Par'), text('is')] })

    const result = await generateText({
      model: provider(MODEL),
      system: 'Be brief.',
      prompt: 'Capital of France?',
      temperature: 0.5,
      topK: 7,
      topP: 0.9,
      seed: 3,
      maxOutputTokens: 64,
    })

    expect(result.text).toBe('Paris')
    expect(result.usage.inputTokens).toBe(11)
    expect(result.usage.outputTokens).toBe(7)
    expect(result.providerMetadata?.['litert-lm']).toMatchObject({
      continued: false,
      tokensPerSecond: 33,
      timeToFirstTokenMs: 250,
    })
    expect(fake.configs[0]).toEqual({
      preface: { messages: [{ role: 'system', content: 'Be brief.' }] },
      sessionConfig: {
        samplerParams: { temperature: 0.5, k: 7, p: 0.9, seed: 3 },
        maxOutputTokens: 64,
      },
    })
    expect(fake.sent[0]).toEqual({ role: 'user', content: 'Capital of France?' })
  })

  it('streams text as it is generated', async () => {
    const { fake, provider } = setup()
    fake.answers.push({ chunks: [text('Hel'), text('lo')] })

    const result = streamText({ model: provider(MODEL), prompt: 'Say hello.' })
    const deltas: string[] = []
    for await (const delta of result.textStream) deltas.push(delta)

    expect(deltas).toEqual(['Hel', 'lo'])
  })

  it('reads the think tags an older bundle leaves in the text', async () => {
    const { fake, provider } = setup()
    fake.answers.push({ chunks: [text('<think>Hmm'), text('</think>\n\nParis')] })
    const result = await generateText({ model: provider(MODEL), prompt: 'France?' })
    expect(result.text).toBe('Paris')
    expect(result.reasoningText).toBe('Hmm')
  })

  it('separates reasoning from the answer', async () => {
    const { fake, provider } = setup()
    fake.answers.push({
      chunks: [
        { role: 'assistant', channels: { thought: 'Let me think.' } },
        { role: 'assistant', content: 'Paris' },
      ],
    })

    const result = await generateText({ model: provider(MODEL), prompt: 'France?', reasoning: 'high' })

    expect(result.text).toBe('Paris')
    expect(result.reasoningText).toBe('Let me think.')
    expect(fake.configs[0].preface.extra_context).toEqual({ enable_thinking: true })
  })

  it('creates one engine for repeated calls', async () => {
    const { fake, provider } = setup()
    fake.answers.push({ chunks: [text('a')] }, { chunks: [text('b')] })

    await generateText({ model: provider(MODEL), prompt: 'One' })
    await generateText({ model: provider(MODEL), prompt: 'Two' })

    expect(fake.engineSettings).toHaveLength(1)
  })

  it('reads the model id and backend the way the runtime expects', async () => {
    const { fake, provider } = setup()
    fake.answers.push({ chunks: [text('a')] }, { chunks: [text('b')] }, { chunks: [text('c')] })

    await generateText({ model: provider('org/gemma'), prompt: 'Hi' })
    expect(fake.engineSettings[0]).toMatchObject({ model: 'hf://org/gemma', benchmarkEnabled: true })
    expect(fake.engineSettings[0].backend).toBeUndefined()

    await generateText({
      model: provider('https://example.com/gemma.litertlm', { backend: 'cpu', maxContextTokens: 2048 }),
      prompt: 'Hi',
    })
    expect(fake.engineSettings[1]).toMatchObject({
      model: 'https://example.com/gemma.litertlm',
      backend: 2,
      mainExecutorSettings: { maxNumTokens: 2048 },
    })

    await generateText({
      model: provider('hf://org/gated', { accessToken: 't', sha256: 'abc', backend: 'gpu' }),
      prompt: 'Hi',
    })
    expect(fake.engineSettings[2].model).toEqual({ url: 'hf://org/gated', accessToken: 't', sha256: 'abc' })
    expect(fake.resolved[0].options.backend).toBeUndefined()
    expect(fake.resolved[1].options.backend).toBe(2)
    expect(fake.engineSettings[2].backend).toBeUndefined()
  })

  it('loads the Wasm from its path once, for every model of a provider', async () => {
    const fake = new FakeWeb()
    const loadBinding = createBindingLoader('/wasm-one/', async () => fake.binding)
    const provider = createProviderWith((modelId, settings) =>
      createWebRuntime(modelId, settings, loadBinding),
    )
    fake.answers.push({ chunks: [text('a')] }, { chunks: [text('b')] })

    await generateText({ model: provider(MODEL), prompt: 'Hi' })
    await generateText({ model: provider(MODEL, { maxContextTokens: 512 }), prompt: 'Hi' })

    expect(fake.loadedWasmPaths).toEqual(['/wasm-one/'])
  })

  it('tries the Wasm path again after a failure', async () => {
    const fake = new FakeWeb()
    let attempts = 0
    fake.binding.loadLiteRtLm = async () => {
      attempts += 1
      if (attempts === 1) throw new Error('Could not load the Wasm')
    }
    const loadBinding = createBindingLoader('/wasm-two/', async () => fake.binding)
    const provider = createProviderWith((modelId, settings) =>
      createWebRuntime(modelId, settings, loadBinding),
    )
    fake.answers.push({ chunks: [text('b')] })
    const model = provider(MODEL)

    const error = await generateText({ model, prompt: 'Hi' }).catch((e: unknown) => e)
    expect((error as LiteRTLMError).code).toBe('LOAD_FAILED')

    expect((await generateText({ model, prompt: 'Hi' })).text).toBe('b')
    expect(attempts).toBe(2)
  })

  it('does not send the message when the call is aborted while the conversation opens', async () => {
    const { fake, provider } = setup()
    const controller = new AbortController()
    fake.onCreateConversation = () => controller.abort()

    const error = await generateText({
      model: provider(MODEL),
      prompt: 'Hi',
      abortSignal: controller.signal,
      maxRetries: 0,
    }).catch((e: unknown) => e)

    expect((error as Error).name).toBe('AbortError')
    expect(fake.sent).toHaveLength(0)
    expect(fake.conversationsOpen).toBe(0)
  })

  it('ends a direct stream when the caller aborts while the conversation opens', async () => {
    const { fake, provider } = setup()
    const controller = new AbortController()
    fake.onCreateConversation = () => controller.abort()

    const { stream } = await provider(MODEL).doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
      abortSignal: controller.signal,
    })
    const reader = stream.getReader()

    await expect(
      (async () => {
        for (;;) {
          const { done } = await reader.read()
          if (done) return
        }
      })(),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('reports a reply cut off at maxOutputTokens, and only that', async () => {
    const { fake, provider } = setup()
    fake.answers.push({ chunks: [text('a')] }, { chunks: [text('a')] })
    const model = provider(MODEL)

    // The fake reports 7 generated tokens.
    expect((await generateText({ model, prompt: 'Hi', maxOutputTokens: 7 })).finishReason).toBe('length')
    expect((await generateText({ model, prompt: 'Hi', maxOutputTokens: 8 })).finishReason).toBe('stop')
  })
})

describe('conversation reuse', () => {
  it('continues in the same conversation when the prompt extends it', async () => {
    const { fake, provider } = setup()
    fake.answers.push({ chunks: [text('Paris')] }, { chunks: [text('Rome')] })
    const model = provider(MODEL)

    const first = await generateText({ model, prompt: 'France?' })
    const second = await generateText({
      model,
      messages: [
        { role: 'user', content: 'France?' },
        ...first.response.messages,
        { role: 'user', content: 'Italy?' },
      ],
    })

    expect(second.providerMetadata?.['litert-lm']).toMatchObject({ continued: true })
    expect(fake.conversationsCreated).toBe(1)
  })

  it('opens a new conversation, closing the old one, when the history differs', async () => {
    const { fake, provider } = setup()
    fake.answers.push({ chunks: [text('Paris')] }, { chunks: [text('Rome')] })
    const model = provider(MODEL)

    await generateText({ model, prompt: 'France?' })
    await generateText({
      model,
      messages: [
        { role: 'user', content: 'France?' },
        { role: 'assistant', content: 'Edited.' },
        { role: 'user', content: 'Italy?' },
      ],
    })

    expect(fake.conversationsCreated).toBe(2)
    expect(fake.conversationsOpen).toBe(1)
    expect(fake.configs[1].preface.messages).toEqual([
      { role: 'user', content: 'France?' },
      { role: 'assistant', content: 'Edited.' },
    ])
  })

  it('opens a new conversation when sampling changes, with no reload', async () => {
    const { fake, provider } = setup()
    fake.answers.push({ chunks: [text('a')] }, { chunks: [text('b')] })
    const model = provider(MODEL)

    const first = await generateText({ model, prompt: 'Hi', temperature: 0.1 })
    const second = await generateText({
      model,
      temperature: 0.9,
      messages: [
        { role: 'user', content: 'Hi' },
        ...first.response.messages,
        { role: 'user', content: 'Again' },
      ],
    })

    expect(second.providerMetadata?.['litert-lm']).toMatchObject({ continued: false, reloaded: false })
    expect(fake.engineSettings).toHaveLength(1)
    expect(second.warnings ?? []).toHaveLength(0)
  })

  it('closes the conversation on unload', async () => {
    const { fake, provider } = setup()
    fake.answers.push({ chunks: [text('a')] })
    const model = provider(MODEL)

    await generateText({ model, prompt: 'Hi' })
    await model.unload()

    expect(fake.conversationsOpen).toBe(0)
    expect(fake.enginesDeleted).toBe(1)
  })
})

describe('tools', () => {
  it('runs a tool loop in one conversation', async () => {
    const { fake, provider } = setup()
    fake.answers.push(
      { chunks: [toolCall('weather', { city: 'Tokyo' })] },
      { chunks: [text('It is 21 degrees.')] },
    )

    const result = await generateText({
      model: provider(MODEL),
      tools: { weather },
      stopWhen: stepCountIs(3),
      prompt: 'Weather in Tokyo?',
    })

    expect(result.text).toBe('It is 21 degrees.')
    expect(result.steps[0]?.finishReason).toBe('tool-calls')
    expect(fake.conversationsCreated).toBe(1)
    expect(fake.configs[0].preface.tools[0]).toMatchObject({
      type: 'function',
      function: { name: 'weather', description: 'Get the weather for a city.' },
    })
    expect(fake.sent[1]).toEqual({
      role: 'tool',
      content: [
        { type: 'tool_response', name: 'weather', response: { city: 'Tokyo', temperature: 21 } },
      ],
    })
  })

  it('replays a tool exchange in the preface', async () => {
    const { fake, provider } = setup()
    fake.answers.push({ chunks: [text('Done.')] })

    await generateText({
      model: provider(MODEL),
      messages: [
        { role: 'user', content: 'Weather?' },
        {
          role: 'assistant',
          content: [{ type: 'tool-call', toolCallId: '1', toolName: 'weather', input: { city: 'Rome' } }],
        },
        {
          role: 'tool',
          content: [
            { type: 'tool-result', toolCallId: '1', toolName: 'weather', output: { type: 'json', value: { t: 21 } } },
          ],
        },
        { role: 'user', content: 'And now?' },
      ],
    })

    expect(fake.configs[0].preface.messages).toEqual([
      { role: 'user', content: 'Weather?' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ type: 'function', function: { name: 'weather', arguments: { city: 'Rome' } } }],
      },
      { role: 'tool', content: [{ type: 'tool_response', name: 'weather', response: { t: 21 } }] },
    ])
  })
})

describe('structured output', () => {
  it('asks in the system text, warns, and removes a code fence', async () => {
    const { fake, provider } = setup()
    fake.answers.push({ chunks: [text('```json\n{"city":"Paris"}\n```')] })

    const result = await generateText({
      model: provider(MODEL),
      prompt: 'Capital of France?',
      output: Output.object({
        schema: jsonSchema<{ city: string }>({
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
        }),
      }),
    })

    expect(result.output).toEqual({ city: 'Paris' })
    expect(fake.configs[0].preface.messages[0].content).toContain('JSON Schema')
    expect(result.warnings?.[0]).toMatchObject({ type: 'compatibility', feature: 'structured output' })
  })
})

describe('the download cache', () => {
  const modelFiles = (files: Map<string, Uint8Array>) =>
    [...files.keys()].filter((name) => name.endsWith('.litertlm')).length

  /** A stand-in for the origin private file system that keeps files in memory. */
  function stubFileSystem() {
    const files = new Map<string, Uint8Array>()
    const store = {
      files,
      writeError: undefined as Error | undefined,
      /** Writes that work before one fails. */
      writeFailsAfter: undefined as number | undefined,
    }
    const directory = {
      getFileHandle: async (name: string, options?: { create?: boolean }) => {
        if (!files.has(name)) {
          if (options?.create !== true) throw new DOMException('No such file', 'NotFoundError')
          files.set(name, new Uint8Array(0))
        }
        return {
          getFile: async () => new File([files.get(name) as BlobPart], name),
          createWritable: async () => {
            if (store.writeError !== undefined) throw store.writeError
            let parts: BlobPart[] = []
            return {
              write: async (chunk: BlobPart) => {
                if (store.writeFailsAfter !== undefined && parts.length >= store.writeFailsAfter) {
                  throw new DOMException('Quota exceeded', 'QuotaExceededError')
                }
                parts.push(chunk)
              },
              truncate: async () => {
                parts = []
              },
              abort: async () => {
                parts = []
              },
              close: async () => {
                files.set(name, new Uint8Array(await new Blob(parts).arrayBuffer()))
              },
            }
          },
        }
      },
      removeEntry: async (name: string) => {
        if (!files.delete(name)) throw new DOMException('No such file', 'NotFoundError')
      },
    }
    vi.stubGlobal('navigator', {
      storage: { getDirectory: async () => ({ getDirectoryHandle: async () => directory }) },
    })
    return store
  }

  const stubDownload = (bytes: number, status = 200) => {
    const fetchStub = vi.fn(
      async () =>
        new Response(new Uint8Array(bytes), {
          status,
          headers: { 'Content-Length': String(bytes) },
        }),
    )
    vi.stubGlobal('fetch', fetchStub)
    return fetchStub
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const URL_ID = 'https://example.com/gemma.litertlm'

  it('downloads once, reports progress and loads the cached file', async () => {
    const { fake, provider } = setup()
    stubFileSystem()
    const fetchStub = stubDownload(4096)
    fake.answers.push({ chunks: [text('a')] }, { chunks: [text('b')] })
    const model = provider(URL_ID)
    const progress: unknown[] = []

    await model.prepare({ onProgress: (p) => progress.push(p) })
    await generateText({ model, prompt: 'Hi' })
    await model.unload()
    await generateText({ model, prompt: 'Hi' })

    expect(fetchStub).toHaveBeenCalledTimes(1)
    expect(fake.engineSettings).toHaveLength(2)
    expect(fake.engineSettings[0].model).toBeInstanceOf(Blob)
    expect(fake.engineSettings[1].model.size).toBe(4096)
    expect(progress[0]).toEqual({ fraction: 1 })
  })

  it('downloads again when a cut-off download left an empty file', async () => {
    const { fake, provider } = setup()
    const { files } = stubFileSystem()
    const fetchStub = stubDownload(16)
    fake.answers.push({ chunks: [text('a')] }, { chunks: [text('b')] })
    const model = provider(URL_ID)

    await generateText({ model, prompt: 'Hi' })
    await model.unload()
    for (const name of files.keys()) files.set(name, new Uint8Array(0))
    await generateText({ model, prompt: 'Hi' })

    expect(fetchStub).toHaveBeenCalledTimes(2)
    expect(fake.engineSettings[1].model.size).toBe(16)
  })

  /** A response that gives these bytes in one chunk, then loses the connection. */
  const droppedAfter = (bytes: Uint8Array, headers: Record<string, string>) => {
    let reads = 0
    return new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          reads += 1
          if (reads === 1) controller.enqueue(bytes)
          else controller.error(new TypeError('network error'))
        },
      }),
      { headers },
    )
  }

  /** The rest of a file, the way a server answers a range request. */
  const rest = (whole: Uint8Array, from: number, headers: Record<string, string> = {}) =>
    new Response(whole.slice(from), {
      status: 206,
      headers: {
        'Content-Length': String(whole.length - from),
        'Content-Range': `bytes ${from}-${whole.length - 1}/${whole.length}`,
        ...headers,
      },
    })

  const WHOLE = Uint8Array.from({ length: 16 }, (_, i) => i)
  const keptModel = (files: Map<string, Uint8Array>) =>
    [...files.entries()].find(([name]) => name.endsWith('.litertlm'))?.[1]

  it('picks up a dropped connection where it stopped', async () => {
    vi.stubGlobal('setTimeout', (run: () => void) => run())
    const { fake, provider } = setup()
    const { files } = stubFileSystem()
    const ranges: (string | undefined)[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { headers: Record<string, string> }) => {
        ranges.push(init.headers.Range)
        return ranges.length === 1
          ? droppedAfter(WHOLE.slice(0, 6), { 'Content-Length': '16' })
          : rest(WHOLE, 6)
      }),
    )
    const progress: (number | undefined)[] = []
    fake.answers.push({ chunks: [text('ok')] })

    await generateText({
      model: provider('https://h.co/g.litertlm', {
        onProgress: ({ fraction }) => {
          progress.push(fraction)
        },
      }),
      prompt: 'Hi',
    })

    expect(ranges).toEqual([undefined, 'bytes=6-'])
    expect(progress.slice(0, 2)).toEqual([6 / 16, 1])
    expect(keptModel(files)).toEqual(WHOLE)
  })

  it('starts over when the server sends the whole file again', async () => {
    vi.stubGlobal('setTimeout', (run: () => void) => run())
    const { fake, provider } = setup()
    const { files } = stubFileSystem()
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1
        return calls === 1
          ? droppedAfter(WHOLE.slice(0, 6), { 'Content-Length': '16' })
          : new Response(WHOLE, { headers: { 'Content-Length': '16' } })
      }),
    )
    fake.answers.push({ chunks: [text('ok')] })

    await generateText({ model: provider('https://h.co/g.litertlm'), prompt: 'Hi' })

    expect(keptModel(files)).toEqual(WHOLE)
  })

  it.each([
    ['from another offset', () => rest(WHOLE, 5)],
    ['of another size', () => rest(WHOLE, 6, { 'Content-Range': 'bytes 6-15/99' })],
    ['of a file that changed', () => rest(WHOLE, 6, { ETag: '"new"' })],
    ['with no range to check', () => rest(WHOLE, 6, { 'Content-Range': '' })],
  ])('starts over on a range answer %s', async (_name, answer) => {
    vi.stubGlobal('setTimeout', (run: () => void) => run())
    const { fake, provider } = setup()
    const { files } = stubFileSystem()
    const ranges: (string | undefined)[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { headers: Record<string, string> }) => {
        ranges.push(init.headers.Range)
        if (ranges.length === 1) {
          return droppedAfter(WHOLE.slice(0, 6), { 'Content-Length': '16', ETag: '"old"' })
        }
        return ranges.length === 2
          ? answer()
          : new Response(WHOLE, { headers: { 'Content-Length': '16', ETag: '"new"' } })
      }),
    )
    fake.answers.push({ chunks: [text('ok')] })

    await generateText({ model: provider('https://h.co/g.litertlm'), prompt: 'Hi' })

    expect(ranges).toEqual([undefined, 'bytes=6-', undefined])
    expect(keptModel(files)).toEqual(WHOLE)
  })

  it('keeps a file whose every byte arrived before the connection went', async () => {
    const { fake, provider } = setup()
    const { files } = stubFileSystem()
    const fetchStub = vi.fn(async () => droppedAfter(WHOLE, { 'Content-Length': '16' }))
    vi.stubGlobal('fetch', fetchStub)
    fake.answers.push({ chunks: [text('ok')] })

    await generateText({ model: provider('https://h.co/g.litertlm'), prompt: 'Hi' })

    expect(fetchStub).toHaveBeenCalledTimes(1)
    expect(keptModel(files)).toEqual(WHOLE)
  })

  it('gives up on a connection that stays lost, and keeps nothing', async () => {
    const waits: number[] = []
    vi.stubGlobal('setTimeout', (run: () => void, ms: number) => {
      waits.push(ms)
      run()
    })
    const { fake, provider } = setup()
    const { files } = stubFileSystem()
    let calls = 0
    const fetchStub = vi.fn(async () => {
      calls += 1
      if (calls === 1) return droppedAfter(WHOLE.slice(0, 6), { 'Content-Length': '16' })
      throw new TypeError('Failed to fetch')
    })
    vi.stubGlobal('fetch', fetchStub)

    const error = await generateText({ model: provider('https://h.co/g.litertlm'), prompt: 'Hi' }).catch(
      (e: unknown) => e,
    )

    expect((error as LiteRTLMError).code).toBe('DOWNLOAD_FAILED')
    expect(waits).toEqual([1000, 2000, 4000, 8000, 16000])
    expect(modelFiles(files)).toBe(0)
    expect(fake.engineSettings).toHaveLength(0)
  })

  it('fails at once when the download never started', async () => {
    const { provider } = setup()
    stubFileSystem()
    const fetchStub = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    vi.stubGlobal('fetch', fetchStub)

    const error = await generateText({ model: provider('https://h.co/g.litertlm'), prompt: 'Hi' }).catch(
      (e: unknown) => e,
    )

    expect((error as LiteRTLMError).code).toBe('DOWNLOAD_FAILED')
    expect(fetchStub).toHaveBeenCalledTimes(1)
  })

  it('stops waiting to try again when the call is aborted', async () => {
    const { provider } = setup()
    stubFileSystem()
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1
        if (calls === 1) return droppedAfter(WHOLE.slice(0, 6), { 'Content-Length': '16' })
        throw new TypeError('Failed to fetch')
      }),
    )
    const controller = new AbortController()
    const prepared = provider('https://h.co/g.litertlm')
      .prepare({ abortSignal: controller.signal })
      .catch((e: unknown) => e)
    await new Promise((resolve) => setTimeout(resolve, 10))
    const started = Date.now()
    controller.abort()

    expect(((await prepared) as Error).name).toBe('AbortError')
    expect(Date.now() - started).toBeLessThan(500)
  })

  it('lets the runtime read the URL when a write fails part way', async () => {
    const { fake, provider } = setup()
    const store = stubFileSystem()
    store.writeFailsAfter = 0
    stubDownload(16)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    fake.answers.push({ chunks: [text('ok')] })

    await generateText({ model: provider('https://h.co/g.litertlm'), prompt: 'Hi' })

    expect(warn).toHaveBeenCalledOnce()
    expect(fake.engineSettings[0].model).toBe('https://h.co/g.litertlm')
    expect(modelFiles(store.files)).toBe(0)
    warn.mockRestore()
  })

  it('loads the file from the last time when the Hub does not answer', async () => {
    const first = setup()
    stubFileSystem()
    const fetchStub = stubDownload(16)
    first.fake.answers.push({ chunks: [text('a')] })
    await generateText({ model: first.provider('hf://org/gemma'), prompt: 'Hi' })

    const second = setup()
    second.fake.failResolve = true
    second.fake.createError = new Error("Couldn't resolve hf://org/gemma@web: Failed to fetch")
    second.fake.answers.push({ chunks: [text('b')] })
    const result = await generateText({ model: second.provider('hf://org/gemma'), prompt: 'Hi' })

    expect(result.text).toBe('b')
    expect(fetchStub).toHaveBeenCalledTimes(1)
    expect(second.fake.engineSettings[0].model).toBeInstanceOf(Blob)
  })

  it('also when the Hub limits the rate', async () => {
    const first = setup()
    stubFileSystem()
    stubDownload(16)
    first.fake.answers.push({ chunks: [text('a')] })
    await generateText({ model: first.provider('hf://org/gemma'), prompt: 'Hi' })

    const second = setup()
    second.fake.failResolve = true
    second.fake.createError = new Error("Couldn't resolve hf://org/gemma@web: We had to rate limit your IP")
    second.fake.answers.push({ chunks: [text('b')] })
    expect((await generateText({ model: second.provider('hf://org/gemma'), prompt: 'Hi' })).text).toBe('b')
  })

  it.each([
    ["Couldn't resolve hf://org/gemma@web: 503 Service Unavailable"],
    ["Couldn't resolve hf://org/gemma@web: 429 Too Many Requests"],
    ['Load failed'],
    ['Unexpected token < in JSON at position 0'],
  ])('also when asking the Hub gives "%s"', async (message) => {
    const first = setup()
    stubFileSystem()
    stubDownload(16)
    first.fake.answers.push({ chunks: [text('a')] })
    await generateText({ model: first.provider('hf://org/gemma'), prompt: 'Hi' })

    const second = setup()
    second.fake.failResolve = true
    second.fake.createError = new Error(message)
    second.fake.answers.push({ chunks: [text('b')] })
    expect((await generateText({ model: second.provider('hf://org/gemma'), prompt: 'Hi' })).text).toBe('b')
  })

  it('does not use the kept file when the Hub says the repo is gone', async () => {
    const first = setup()
    stubFileSystem()
    stubDownload(16)
    first.fake.answers.push({ chunks: [text('a')] })
    await generateText({ model: first.provider('hf://org/gemma'), prompt: 'Hi' })

    const second = setup()
    second.fake.failResolve = true
    second.fake.createError = new Error("Couldn't resolve hf://org/gemma@web: Repository not found")
    const error = await generateText({ model: second.provider('hf://org/gemma'), prompt: 'Hi' }).catch(
      (e: unknown) => e,
    )

    expect((error as LiteRTLMError).code).toBe('MODEL_NOT_FOUND')
  })

  it('says the download failed when the Hub does not answer and nothing is kept', async () => {
    const { fake, provider } = setup()
    stubFileSystem()
    fake.failResolve = true
    fake.createError = new Error("Couldn't resolve hf://org/gemma@web: Failed to fetch")

    const error = await generateText({ model: provider('hf://org/gemma'), prompt: 'Hi' }).catch((e: unknown) => e)

    expect((error as LiteRTLMError).code).toBe('DOWNLOAD_FAILED')
  })

  it('notes where a Hub model is only once it has loaded', async () => {
    const { fake, provider } = setup()
    const { files } = stubFileSystem()
    stubDownload(16)
    fake.createError = new Error('Unable to open zip archive')

    await generateText({ model: provider('hf://org/gemma'), prompt: 'Hi' }).catch(() => {})

    expect([...files.keys()].filter((name) => name.endsWith('.json'))).toHaveLength(0)
  })

  it('needs no note for a URL', async () => {
    const { fake, provider } = setup()
    const { files } = stubFileSystem()
    stubDownload(16)
    fake.answers.push({ chunks: [text('ok')] })

    await generateText({ model: provider('https://h.co/g.litertlm'), prompt: 'Hi' })

    expect([...files.keys()].filter((name) => name.endsWith('.json'))).toHaveLength(0)
  })

  it('does not download a file again for a new commit that leaves it alone', async () => {
    const first = setup()
    stubFileSystem()
    const fetchStub = stubDownload(16)
    first.fake.resolvedModel = { url: 'https://h.co/resolve/aaa/g.litertlm', sha256: 'c'.repeat(64) }
    first.fake.answers.push({ chunks: [text('a')] })
    await generateText({ model: first.provider('hf://org/gemma'), prompt: 'Hi' })

    const second = setup()
    second.fake.resolvedModel = { url: 'https://h.co/resolve/bbb/g.litertlm', sha256: 'c'.repeat(64) }
    second.fake.answers.push({ chunks: [text('b')] })
    await generateText({ model: second.provider('hf://org/gemma'), prompt: 'Hi' })

    expect(fetchStub).toHaveBeenCalledTimes(1)
  })

  it('asks the Hub once for a model that loads again', async () => {
    const { fake, provider } = setup()
    stubFileSystem()
    stubDownload(16)
    fake.answers.push({ chunks: [text('a')] }, { chunks: [text('b')] })
    const model = provider('hf://org/gemma')

    await generateText({ model, prompt: 'Hi' })
    await model.unload()
    await generateText({ model, prompt: 'Hi' })

    expect(fake.resolved).toHaveLength(1)
  })

  it('sends a token', async () => {
    const { fake, provider } = setup()
    stubFileSystem()
    const fetchStub = stubDownload(16)
    fake.answers.push({ chunks: [text('a')] })

    await generateText({ model: provider(URL_ID, { accessToken: 't' }), prompt: 'Hi' })

    const call = fetchStub.mock.calls[0] as unknown as [string, RequestInit]
    expect(call[1].headers).toEqual({ Authorization: 'Bearer t' })
  })

  it('reports a file that is not there, and keeps nothing', async () => {
    const { provider } = setup()
    const { files } = stubFileSystem()
    stubDownload(16, 404)

    const error = await generateText({ model: provider(URL_ID), prompt: 'Hi' }).catch((e: unknown) => e)

    expect((error as LiteRTLMError).code).toBe('MODEL_NOT_FOUND')
    expect(modelFiles(files)).toBe(0)
  })

  it('forgets a file that is not a model, so a retry downloads it again', async () => {
    const { fake, provider } = setup()
    const { files } = stubFileSystem()
    const fetchStub = stubDownload(16)
    fake.createError = new Error("Invalid magic number. Expected 'LITERTLM', got '<htm'")
    const model = provider(URL_ID)

    const error = await generateText({ model, prompt: 'Hi' }).catch((e: unknown) => e)
    expect((error as LiteRTLMError).code).toBe('INVALID_MODEL')
    expect(modelFiles(files)).toBe(0)

    fake.answers.push({ chunks: [text('ok')] })
    expect((await generateText({ model, prompt: 'Hi' })).text).toBe('ok')
    expect(fetchStub).toHaveBeenCalledTimes(2)
  })

  it('forgets a kept file the engine runs out of, and calls a URL that does it a download failure', async () => {
    const outOfBytes = 'RET_CHECK failure (model_data.cc:369) data Error fetching data.'

    const kept = setup()
    const { files } = stubFileSystem()
    stubDownload(16)
    kept.fake.createError = new Error(outOfBytes)
    const fromFile = await generateText({ model: kept.provider(URL_ID), prompt: 'Hi' }).catch((e: unknown) => e)
    expect((fromFile as LiteRTLMError).code).toBe('INVALID_MODEL')
    expect(modelFiles(files)).toBe(0)

    vi.unstubAllGlobals()
    const direct = setup()
    direct.fake.createError = new Error(outOfBytes)
    const fromUrl = await generateText({ model: direct.provider(URL_ID), prompt: 'Hi' }).catch((e: unknown) => e)
    expect((fromUrl as LiteRTLMError).code).toBe('DOWNLOAD_FAILED')
  })

  it('keeps the file when the failure is not the file', async () => {
    const { fake, provider } = setup()
    const { files } = stubFileSystem()
    stubDownload(16)
    fake.createError = new Error('Failed to create the WebGPU device')

    const error = await generateText({ model: provider(URL_ID), prompt: 'Hi' }).catch((e: unknown) => e)

    expect((error as LiteRTLMError).code).toBe('LOAD_FAILED')
    expect(modelFiles(files)).toBe(1)
  })

  it('lets the runtime read the URL when the file system is full', async () => {
    const { fake, provider } = setup()
    const store = stubFileSystem()
    store.writeError = new DOMException('Quota exceeded', 'QuotaExceededError')
    stubDownload(16)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    fake.answers.push({ chunks: [text('ok')] })

    await generateText({ model: provider(URL_ID), prompt: 'Hi' })

    expect(fake.engineSettings[0].model).toBe(URL_ID)
    expect(modelFiles(store.files)).toBe(0)
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })

  it('stops the download on abort', async () => {
    const { provider } = setup()
    stubFileSystem()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        await new Promise((_, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          )
        })
        return new Response()
      }),
    )
    const controller = new AbortController()
    const pending = provider(URL_ID).prepare({ abortSignal: controller.signal })
    setTimeout(() => controller.abort(), 5)

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('streams from the URL where the browser has no Cache API', async () => {
    const { fake, provider } = setup()
    fake.answers.push({ chunks: [text('ok')] })

    await generateText({ model: provider(URL_ID), prompt: 'Hi' })

    expect(fake.engineSettings[0].model).toBe(URL_ID)
  })
})

describe('warnings', () => {
  it('names what the browser cannot do', async () => {
    const { fake, provider } = setup()
    fake.answers.push({ chunks: [text('a')] })

    const result = await generateText({
      model: provider(MODEL, { speculativeDecoding: true }),
      prompt: 'Hi',
      frequencyPenalty: 0.1,
      presencePenalty: 0.1,
      stopSequences: ['x'],
    })

    expect((result.warnings ?? []).map((warning) => (warning as { feature: string }).feature)).toEqual([
      'stopSequences',
      'frequencyPenalty',
      'presencePenalty',
      'speculativeDecoding',
    ])
  })
})

describe('failure paths', () => {
  const failures: [string, string][] = [
    ['hf://org/x has no .litertlm model file', 'MODEL_NOT_FOUND'],
    ['HTTP 404 for the model', 'MODEL_NOT_FOUND'],
    [
      "Couldn't access hf://org/x@web: Invalid username or password.. The repo may not exist, or it may be private or gated.",
      'MODEL_NOT_FOUND',
    ],
    ["Invalid magic number. Expected 'LITERTLM', got '---", 'INVALID_MODEL'],
    ['Failed to fetch', 'DOWNLOAD_FAILED'],
    ['memory access out of bounds', 'OUT_OF_MEMORY'],
    ['Failed to parse the flatbuffer', 'LOAD_FAILED'],
    ['RET_CHECK failure (llm_executor.cc:404)', 'LOAD_FAILED'],
    ['Out of memory: could not allocate 140401664 bytes', 'OUT_OF_MEMORY'],
    ['Signature prefill not found in interpreter', 'LOAD_FAILED'],
    ["Couldn't resolve hf://org/x@web: Repository not found", 'MODEL_NOT_FOUND'],
    ["Couldn't resolve hf://org/x@web: 404 Not Found", 'MODEL_NOT_FOUND'],
    ["Couldn't resolve hf://org/x: no revision named 'web' or 'main' exists", 'MODEL_NOT_FOUND'],
    ["hf://org/x@main/y.litertlm doesn't exist", 'MODEL_NOT_FOUND'],
    ['Load failed', 'DOWNLOAD_FAILED'],
  ]

  it.each(failures)('reports "%s" as %s and can try again', async (message, code) => {
    const { fake, provider } = setup()
    fake.createError = new Error(message)
    const model = provider(MODEL)

    const error = await generateText({ model, prompt: 'Hi' }).catch((e: unknown) => e)
    expect(LiteRTLMError.isInstance(error)).toBe(true)
    expect((error as LiteRTLMError).code).toBe(code)
    expect((error as LiteRTLMError).message).toBe(message)

    fake.answers.push({ chunks: [text('ok')] })
    expect((await generateText({ model, prompt: 'Hi' })).text).toBe('ok')
  })

  it('reports a repo that does not exist before anything downloads', async () => {
    const { fake, provider } = setup()
    fake.failResolve = true
    fake.createError = new Error("Couldn't access hf://org/x@web. The repo may not exist, or it may be private.")

    const error = await generateText({ model: provider(MODEL), prompt: 'Hi' }).catch((e: unknown) => e)

    expect((error as LiteRTLMError).code).toBe('MODEL_NOT_FOUND')
    expect(fake.engineSettings).toHaveLength(0)
  })

  it('refuses the NPU', async () => {
    const { provider } = setup()

    const error = await generateText({
      model: provider(MODEL, { backend: 'npu' }),
      prompt: 'Hi',
    }).catch((e: unknown) => e)

    expect((error as LiteRTLMError).code).toBe('LOAD_FAILED')
  })

  it('explains a missing @litert-lm/core', async () => {
    const provider = createProviderWith((modelId, settings) =>
      createWebRuntime(modelId, settings, async () => {
        throw new Error('Cannot find module')
      }),
    )

    const error = await generateText({ model: provider(MODEL), prompt: 'Hi' }).catch((e: unknown) => e)

    expect((error as LiteRTLMError).message).toContain('Is it installed?')
  })

  it('reports a failed generation and closes the conversation', async () => {
    const { fake, provider } = setup()
    fake.answers.push({ chunks: [text('par')], failWith: new Error('GPU device lost') })

    const errors: unknown[] = []
    const result = streamText({
      model: provider(MODEL),
      prompt: 'Hi',
      onError: ({ error }) => errors.push(error),
    })
    let streamed = ''
    for await (const delta of result.textStream) streamed += delta

    expect(streamed).toBe('par')
    expect((errors[0] as LiteRTLMError).code).toBe('GENERATION_FAILED')
    expect(fake.conversationsOpen).toBe(0)
  })

  it.each([
    ['Failed to create invocation context'],
    ['Runtime context is not set.'],
    ['DEADLINE_EXCEEDED'],
    ['Maximum call stack size exceeded'],
  ])('does not call "%s" a prompt that is too long', async (message) => {
    const { fake, provider } = setup()
    fake.answers.push({ chunks: [], failWith: new Error(message) })

    const error = await generateText({ model: provider(MODEL), prompt: 'Hi', maxRetries: 0 }).catch(
      (e: unknown) => e,
    )

    expect((error as LiteRTLMError).code).toBe('GENERATION_FAILED')
  })

  it('reports a prompt longer than the context', async () => {
    const { fake, provider } = setup()
    fake.answers.push({ chunks: [], failWith: new Error('Input token ids are too long') })

    const error = await generateText({ model: provider(MODEL), prompt: 'Hi' }).catch((e: unknown) => e)

    expect((error as LiteRTLMError).code).toBe('CONTEXT_TOO_LONG')
  })

  it('stops on abort, closes the conversation, and works again', async () => {
    const { fake, provider } = setup()
    fake.answers.push({ chunks: [text('one '), text('two ')], hangAfterChunks: true }, { chunks: [text('fresh')] })
    const model = provider(MODEL)
    const controller = new AbortController()

    const result = streamText({ model, prompt: 'Count.', abortSignal: controller.signal })
    let aborted = false
    for await (const part of result.fullStream) {
      if (part.type === 'text-delta' && !controller.signal.aborted) controller.abort()
      if (part.type === 'abort') aborted = true
    }

    expect(aborted).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(fake.cancels).toBe(1)

    const next = await generateText({ model, prompt: 'Again.' })
    expect(next.text).toBe('fresh')
    expect(fake.conversationsOpen).toBe(1)
  })

  it('reports a tool call with no name as a tool error', async () => {
    const { fake, provider } = setup()
    fake.answers.push({
      chunks: [{ role: 'assistant', tool_calls: [{ type: 'function', function: {} as never }] }],
    })

    const result = await generateText({ model: provider(MODEL), tools: { weather }, prompt: 'Weather?' })

    expect(result.content.some((part) => part.type === 'tool-error')).toBe(true)
  })

  it('reports tool arguments that fail the schema as a tool error', async () => {
    const { fake, provider } = setup()
    const strict = tool({
      inputSchema: jsonSchema<{ city: string }>(
        { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
        {
          validate: (value) =>
            typeof (value as { city?: unknown }).city === 'string'
              ? { success: true, value: value as { city: string } }
              : { success: false, error: new Error('city must be a string') },
        },
      ),
      execute: async () => 'never',
    })
    fake.answers.push({ chunks: [toolCall('strict', { city: 5 })] })

    const result = await generateText({ model: provider(MODEL), tools: { strict }, prompt: 'Weather?' })

    expect(result.content.some((part) => part.type === 'tool-error')).toBe(true)
  })
})
