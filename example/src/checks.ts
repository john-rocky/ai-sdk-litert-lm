import {
  generateText,
  jsonSchema,
  type LanguageModel,
  type ModelMessage,
  Output,
  stepCountIs,
  streamText,
  tool,
} from 'ai'
import { createLiteRTLM, litertlm, LiteRTLMError } from 'ai-sdk-litert-lm'
import { Platform } from 'react-native'

import { createProviderWithBrokenToolCall } from './faults'
import { documentsPath, removeKeptModels, writeLogFile } from './device-files'
import { MODEL_ID } from './model'

export type CheckOptions = {
  /** The model to check with. Defaults to the app's model. */
  model?: string
  /** A truncated copy of a real bundle: a URL, or a path on a phone. */
  truncated?: string
  /** A file that isn't a bundle at all: a URL, or a path on a phone. Defaults to a README on the Hub. */
  broken?: string
  /** False on a device with no route to the Hub. The checks that need one are skipped and say so. */
  network?: boolean
  /** Leave a browser's download in place, to see the next run find it. */
  keep?: boolean
  /** A URL whose first request loses its connection part way. */
  cut?: string
  /** The same, from a server that then sends the whole file again. */
  cutWhole?: string
}

/** A phone's app container moves between installs, so `documents/x` means x in its Documents. */
function inDocuments(path: string | undefined): string | undefined {
  return path?.startsWith('documents/') ? `${documentsPath()}/${path.slice('documents/'.length)}` : path
}

/** Read `?checks=1&model=...` from the URL the app opened with. */
export function parseCheckRequest(url: string | null | undefined): CheckOptions | undefined {
  if (url === null || url === undefined) return undefined
  const query = /[?&]checks=1(&|$)/.test(url) ? url.slice(url.indexOf('?') + 1) : undefined
  if (query === undefined) return undefined
  const read = (key: string) => {
    const match = new RegExp(`(?:^|&)${key}=([^&]*)`).exec(query)
    return match?.[1] !== undefined ? decodeURIComponent(match[1]) : undefined
  }
  return {
    model: read('model'),
    truncated: inDocuments(read('truncated')),
    broken: read('broken'),
    network: read('network') !== '0',
    keep: read('keep') === '1',
    cut: read('cut'),
    cutWhole: read('cutWhole'),
  }
}

function describeDevice(): string {
  if (Platform.OS === 'web') return `Browser: ${navigator.userAgent}`
  const c = Platform.constants as unknown as Record<string, unknown>
  return Platform.OS === 'android'
    ? `${String(c.Model)} / Android ${String(c.Release)} (API ${String(Platform.Version)})`
    : `iOS ${String(Platform.Version)}`
}

const metadata = (result: { providerMetadata?: Record<string, any> }) =>
  (result.providerMetadata?.['litert-lm'] ?? {}) as {
    continued?: boolean
    reloaded?: boolean
    tokensPerSecond?: number
    timeToFirstTokenMs?: number
  }

const LEAK = /<\/?tool_call>|<\/?think(ing)?>|<\|?channel|<\|tool_call|<start_of_turn>|<end_of_turn>/

const weatherInput = jsonSchema<{ city: string }>({
  type: 'object',
  properties: { city: { type: 'string', description: 'The city name' } },
  required: ['city'],
})

const weatherIn = (city: string) => ({ city, temperature: 21, unit: 'celsius', sky: 'clear' })

const weatherTool = tool({
  description: 'Get the current weather for a city.',
  inputSchema: weatherInput,
  execute: async ({ city }) => weatherIn(city),
})

/** Run every check against the real engine. Each line goes to the console and to `log`. */
export async function runChecks(
  options: CheckOptions,
  log: (line: string) => void,
): Promise<void> {
  const lines: string[] = []
  const say = (line: string) => {
    console.log(line)
    log(line)
    lines.push(`${new Date().toISOString().slice(11, 19)} ${line}`)
    writeLogFile(lines)
  }
  const modelId = options.model ?? MODEL_ID
  let passed = 0
  let failed = 0
  let failurePathsPassed = 0

  const check = async (
    name: string,
    run: () => Promise<string>,
    kind: 'path' | 'failure' = 'path',
  ) => {
    const started = Date.now()
    say(`### RUN ${name}`)
    try {
      const detail = await run()
      passed += 1
      if (kind === 'failure') failurePathsPassed += 1
      say(`### PASS ${name} (${Date.now() - started} ms) ${detail}`)
    } catch (error) {
      failed += 1
      say(`### FAIL ${name} (${Date.now() - started} ms) ${String(error)}`)
    }
  }
  const expect = (condition: boolean, message: string) => {
    if (!condition) throw new Error(message)
  }

  say(`### DEVICE: ${describeDevice()}`)
  say(`### MODEL: ${modelId}`)

  const model = litertlm(modelId)

  await check(
    'failure: abort while the model downloads or loads',
    async () => {
      const controller = new AbortController()
      const started = Date.now()
      const timer = setTimeout(() => controller.abort(), 5000)
      try {
        await model.prepare({ abortSignal: controller.signal })
        return `finished in ${Date.now() - started} ms, before the abort`
      } catch (error) {
        expect((error as Error).name === 'AbortError', `Not an abort: ${String(error)}`)
        expect(Date.now() - started < 7000, `Rejected after ${Date.now() - started} ms`)
        return `rejected after ${Date.now() - started} ms`
      } finally {
        clearTimeout(timer)
      }
    },
    'failure',
  )

  await check('prepare', async () => {
    let lastProgress = -1
    await model.prepare({
      onProgress: ({ fraction }) => {
        const percent = Math.round((fraction ?? 0) * 10)
        if (percent !== lastProgress) {
          lastProgress = percent
          say(`download ${percent * 10}%`)
        }
      },
    })
    return 'loaded'
  })

  let firstAnswer: ModelMessage[] = []
  await check('generateText', async () => {
    const result = await generateText({
      model,
      prompt: 'What is the capital of France? Answer with one word.',
      maxOutputTokens: 32,
    })
    expect(result.text.includes('Paris'), `Unexpected answer: ${result.text}`)
    expect(!LEAK.test(result.text), `Markers in the text: ${result.text}`)
    firstAnswer = result.response.messages
    const m = metadata(result)
    return `"${result.text.trim()}" finish=${result.finishReason} usage=${result.usage.inputTokens}/${result.usage.outputTokens} ttft=${Math.round(m.timeToFirstTokenMs ?? -1)}ms tok/s=${(m.tokensPerSecond ?? -1).toFixed(1)}`
  })

  await check('streamText', async () => {
    const result = streamText({
      model,
      prompt: 'Write two sentences about the sea.',
      maxOutputTokens: 96,
    })
    let chunks = 0
    let text = ''
    for await (const delta of result.textStream) {
      chunks += 1
      text += delta
    }
    expect(chunks >= 2, `Only ${chunks} chunk(s)`)
    expect(!LEAK.test(text), `Markers in the text: ${text}`)
    const m = metadata({ providerMetadata: await result.providerMetadata })
    return `${chunks} chunks, ${text.length} chars, finish=${await result.finishReason} ttft=${Math.round(m.timeToFirstTokenMs ?? -1)}ms tok/s=${(m.tokensPerSecond ?? -1).toFixed(1)}: "${text.slice(0, 80).trim()}"`
  })

  await check('conversation continues without a replay', async () => {
    const first = await generateText({
      model,
      prompt: 'What is the capital of France? Answer with one word.',
      maxOutputTokens: 32,
    })
    const messages: ModelMessage[] = [
      { role: 'user', content: 'What is the capital of France? Answer with one word.' },
      ...first.response.messages,
      { role: 'user', content: 'Which country is that city in? Answer with one word.' },
    ]
    const continued = await generateText({ model, messages, maxOutputTokens: 32 })
    expect(metadata(continued).continued === true, 'The call replayed the conversation.')
    expect(continued.text.includes('France'), `Unexpected answer: ${continued.text}`)

    // The same question with an edited history has to replay it.
    const edited = await generateText({
      model,
      messages: [
        { role: 'user', content: 'What is the capital of France? Answer with one word.' },
        { role: 'assistant', content: 'Paris.' },
        { role: 'user', content: 'Which country is that city in? Answer with one word.' },
      ],
      maxOutputTokens: 32,
    })
    expect(metadata(edited).continued === false, 'An edited history did not replay.')
    expect(edited.text.includes('France'), `Unexpected answer after a replay: ${edited.text}`)
    return `continued ttft=${Math.round(metadata(continued).timeToFirstTokenMs ?? -1)}ms, replayed ttft=${Math.round(metadata(edited).timeToFirstTokenMs ?? -1)}ms`
  })

  await check('tools: a call, its result, and a final answer', async () => {
    let called: string | undefined
    const result = await generateText({
      model,
      tools: {
        get_weather: tool({
          description: weatherTool.description,
          inputSchema: weatherInput,
          execute: async ({ city }) => {
            called = city
            return weatherIn(city)
          },
        }),
      },
      stopWhen: stepCountIs(3),
      prompt: 'What is the weather in Tokyo right now? Use the get_weather tool.',
      maxOutputTokens: 128,
    })
    expect(called?.toLowerCase().includes('tokyo') === true, `Tool not called for Tokyo: ${called}`)
    expect(result.steps.length >= 2, `Only ${result.steps.length} step(s)`)
    expect(result.text.trim().length > 0, 'No final answer.')
    expect(!LEAK.test(result.text), `Markers in the text: ${result.text}`)
    return `called with "${called}", ${result.steps.length} steps, reloaded=${metadata(result.steps[0] as never).reloaded}, second step continued=${metadata(result.steps[1] as never).continued}: "${result.text.trim().slice(0, 80)}"`
  })

  await check('streamText with a tool', async () => {
    const result = streamText({
      model,
      tools: { get_weather: weatherTool },
      stopWhen: stepCountIs(3),
      prompt: 'What is the weather in Oslo right now? Use the get_weather tool.',
      maxOutputTokens: 128,
    })
    const seen: string[] = []
    for await (const part of result.fullStream) {
      if (part.type === 'tool-call' || part.type === 'tool-result' || part.type === 'finish') {
        seen.push(part.type)
      }
    }
    expect(seen.includes('tool-call'), `No tool call: ${seen.join(',')}`)
    expect(seen.includes('tool-result'), `No tool result: ${seen.join(',')}`)
    return seen.join(',')
  })

  await check('structured output', async () => {
    const result = await generateText({
      model,
      prompt: 'Name the capital of Japan and its country.',
      maxOutputTokens: 64,
      output: Output.object({
        schema: jsonSchema<{ capital: string; country: string }>({
          type: 'object',
          properties: { capital: { type: 'string' }, country: { type: 'string' } },
          required: ['capital', 'country'],
          additionalProperties: false,
        }),
      }),
    })
    expect(result.output.capital.includes('Tokyo'), `Unexpected output: ${JSON.stringify(result.output)}`)
    return JSON.stringify(result.output)
  })

  await check('JSON with no schema', async () => {
    const result = await generateText({
      model,
      prompt: 'Give the capital of Japan as a JSON object with the key "capital".',
      maxOutputTokens: 64,
      output: Output.json(),
    })
    const json = JSON.stringify(result.output)
    expect(json.includes('Tokyo'), `Unexpected output: ${json}`)
    return `${json} warnings=${JSON.stringify((result.warnings ?? []).map((w) => w.type))}`
  })

  await check('structured output and a tool in one call', async () => {
    let called: string | undefined
    const result = await generateText({
      model,
      tools: {
        get_weather: tool({
          description: weatherTool.description,
          inputSchema: weatherInput,
          execute: async ({ city }) => {
            called = city
            return weatherIn(city)
          },
        }),
      },
      stopWhen: stepCountIs(3),
      prompt: 'What is the weather in Tokyo right now? Use the get_weather tool, then report it.',
      maxOutputTokens: 128,
      output: Output.object({
        schema: jsonSchema<{ city: string; temperature: number }>({
          type: 'object',
          properties: { city: { type: 'string' }, temperature: { type: 'number' } },
          required: ['city', 'temperature'],
        }),
      }),
    })
    expect(called?.toLowerCase().includes('tokyo') === true, `Tool not called for Tokyo: ${called}`)
    expect(result.output.temperature === 21, `Unexpected output: ${JSON.stringify(result.output)}`)
    return `called with "${called}", ${JSON.stringify(result.output)}`
  })

  await check('a reply cut off at maxOutputTokens says so', async () => {
    const cut = await generateText({
      model,
      prompt: 'Count from 1 to 200, one number per line.',
      maxOutputTokens: 16,
    })
    expect(
      cut.finishReason === 'length',
      `finish=${cut.finishReason} after ${cut.usage.outputTokens} tokens`,
    )
    const whole = await generateText({ model, prompt: 'Say the word red.', maxOutputTokens: 64 })
    expect(whole.finishReason === 'stop', `finish=${whole.finishReason}: ${whole.text}`)
    // Reported, not required: a script can take several tokens per piece of text on Android.
    const japanese = await generateText({
      model,
      prompt: '日本の四季について、できるだけ長く書いてください。',
      maxOutputTokens: 64,
    })
    return `cut after ${cut.usage.outputTokens} tokens, whole finish=${whole.finishReason}, Japanese finish=${japanese.finishReason} after ${japanese.usage.outputTokens} tokens`
  })

  if (Platform.OS !== 'web') {
    await check('a long reply with no limit stops at 1024 tokens and says so', async () => {
      const result = await generateText({
        model,
        prompt: 'Count from 1 to 3000, one number per line. Do not stop early.',
      })
      expect(
        result.finishReason === 'length',
        `finish=${result.finishReason} after ${result.usage.outputTokens} tokens`,
      )
      return `after ${result.usage.outputTokens} tokens`
    })
  }

  await check('sampling set per call reloads with a warning on a phone', async () => {
    const result = await generateText({
      model,
      prompt: 'Say hello in one word.',
      temperature: 0.2,
      topK: 5,
      maxOutputTokens: 16,
    })
    const m = metadata(result)
    if (Platform.OS !== 'web') {
      expect(m.reloaded === true, 'No reload.')
      expect((result.warnings ?? []).length > 0, 'No warning.')
    }
    expect(result.text.trim().length > 0, 'No answer.')
    return `reloaded=${m.reloaded}, warnings=${JSON.stringify(result.warnings ?? [])}`
  })

  await check('reasoning does not leak into the text', async () => {
    const result = await generateText({
      model,
      prompt: 'What is 17 times 23? Answer with the number.',
      reasoning: 'high',
      maxOutputTokens: 512,
    })
    expect(!LEAK.test(result.text), `Markers in the text: ${result.text}`)
    return `text="${result.text.trim().slice(0, 60)}" reasoning chars=${result.reasoningText?.length ?? 0} finish=${result.finishReason}`
  })

  await check('two calls at once run one after the other', async () => {
    const [a, b] = await Promise.all([
      generateText({ model, prompt: 'Say the word red.', maxOutputTokens: 16 }),
      generateText({ model, prompt: 'Say the word blue.', maxOutputTokens: 16 }),
    ])
    expect(a.text.toLowerCase().includes('red'), `First: ${a.text}`)
    expect(b.text.toLowerCase().includes('blue'), `Second: ${b.text}`)
    return `"${a.text.trim()}" / "${b.text.trim()}"`
  })

  // Failure paths. Each one must give a typed error, or a clean stop, and leave the app working.
  const expectCode = async (id: string, codes: string[]): Promise<string> => {
    const provider = createLiteRTLM()
    try {
      await generateText({ model: provider(id), prompt: 'Hello', maxOutputTokens: 8 })
    } catch (error) {
      expect(LiteRTLMError.isInstance(error), `Not a LiteRTLMError: ${String(error)}`)
      const code = (error as LiteRTLMError).code
      expect(codes.includes(code), `Code ${code}: ${(error as Error).message}`)
      return `${code}: ${(error as Error).message.slice(0, 160)}`
    }
    throw new Error('The call succeeded.')
  }

  await check(
    'failure: no such file',
    () =>
      expectCode(
        Platform.OS === 'web'
          ? 'https://huggingface.co/litert-community/this-repo-does-not-exist/resolve/main/model.litertlm'
          : '/data/local/tmp/this-file-does-not-exist.litertlm',
        ['MODEL_NOT_FOUND', 'DOWNLOAD_FAILED'],
      ),
    'failure',
  )
  if (options.network !== false) {
    await check(
      'failure: no such repo',
      () => expectCode('hf://litert-community/this-repo-does-not-exist', ['MODEL_NOT_FOUND']),
      'failure',
    )
    await check(
      'failure: no such file named on the Hub',
      () =>
        expectCode('hf://litert-community/this-repo-does-not-exist/model.litertlm', ['MODEL_NOT_FOUND']),
      'failure',
    )
  } else {
    say('### SKIP failure: no such repo (no network)')
    say('### SKIP failure: no such file named on the Hub (no network)')
  }
  if (options.network !== false || options.broken !== undefined) {
    await check(
      'failure: a broken file (text, not a bundle)',
      () =>
        expectCode(
          options.broken ??
            'https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/main/README.md',
          ['INVALID_MODEL'],
        ),
      'failure',
    )
  } else {
    say('### SKIP failure: a broken file (no network)')
  }
  if (options.truncated !== undefined) {
    const truncated = options.truncated
    await check(
      'failure: a broken file (a truncated bundle)',
      () => expectCode(truncated, ['INVALID_MODEL']),
      'failure',
    )
  }

  await check(
    'failure: abort mid-stream, then the model still works',
    async () => {
      const controller = new AbortController()
      const result = streamText({
        model,
        prompt: 'Count from 1 to 200, one number per line.',
        maxOutputTokens: 512,
        abortSignal: controller.signal,
      })
      let chunks = 0
      let abortedPart = false
      const started = Date.now()
      let abortAt = 0
      for await (const part of result.fullStream) {
        if (part.type === 'text-delta') {
          chunks += 1
          if (chunks === 5) {
            abortAt = Date.now()
            controller.abort()
          }
        }
        if (part.type === 'abort') abortedPart = true
      }
      expect(abortedPart, 'No abort part.')
      expect(chunks >= 5 && chunks < 200, `${chunks} chunks.`)
      const stopMs = Date.now() - abortAt
      const next = await generateText({
        model,
        prompt: 'What is the capital of France? Answer with one word.',
        maxOutputTokens: 32,
      })
      expect(next.text.includes('Paris'), `After the abort: ${next.text}`)
      expect(metadata(next).continued === false, 'Continued a cancelled conversation.')
      return `aborted after ${chunks} chunks in ${abortAt - started} ms, stream ended ${stopMs} ms later, next call answered "${next.text.trim()}"`
    },
    'failure',
  )

  await check(
    'failure: generateText aborted, then the model still works',
    async () => {
      const controller = new AbortController()
      setTimeout(() => controller.abort(), 300)
      let name = 'none'
      try {
        await generateText({
          model,
          prompt: 'Count from 1 to 200, one number per line.',
          maxOutputTokens: 512,
          abortSignal: controller.signal,
        })
      } catch (error) {
        name = (error as Error).name
      }
      expect(name === 'AbortError', `Error: ${name}`)
      const next = await generateText({ model, prompt: 'Say the word green.', maxOutputTokens: 16 })
      expect(next.text.toLowerCase().includes('green'), `After the abort: ${next.text}`)
      return `rejected with ${name}, next call answered "${next.text.trim()}"`
    },
    'failure',
  )

  await check(
    'failure: a tool call whose JSON does not parse',
    async () => {
      // A second provider holds its own engine, so free the first one before it loads.
      await model.unload()
      const faulty = createProviderWithBrokenToolCall()
      const result = streamText({
        model: faulty(modelId),
        tools: { get_weather: weatherTool },
        prompt: 'Say the word yellow.',
        maxOutputTokens: 16,
      })
      let toolError = ''
      let text = ''
      for await (const part of result.fullStream) {
        if (part.type === 'tool-error') toolError = String(part.error)
        if (part.type === 'text-delta') text += part.text
      }
      await faulty.unloadAll()
      expect(toolError.length > 0, 'No tool error.')
      expect(!LEAK.test(text), `Markers in the text: ${text}`)
      return `tool error: ${toolError.slice(0, 120)}; text "${text.trim().slice(0, 40)}"`
    },
    'failure',
  )

  await check(
    'failure: tool arguments that fail the schema',
    async () => {
      // The model gets a tool that only accepts Paris, and a question about Tokyo.
      const result = await generateText({
        model,
        tools: {
          get_weather: tool({
            description: 'Get the current weather for a city.',
            inputSchema: jsonSchema<{ city: 'Paris' }>(
              {
                type: 'object',
                properties: { city: { type: 'string', description: 'The city name' } },
                required: ['city'],
              },
              {
                validate: (value) =>
                  (value as { city?: unknown }).city === 'Paris'
                    ? { success: true, value: value as { city: 'Paris' } }
                    : { success: false, error: new Error('The city must be Paris.') },
              },
            ),
            execute: async () => ({ temperature: 18 }),
          }),
        },
        prompt: 'What is the weather in Tokyo right now? Use the get_weather tool.',
        maxOutputTokens: 128,
      })
      const toolErrors = result.content.filter((part) => part.type === 'tool-error')
      expect(!LEAK.test(result.text), `Markers in the text: ${result.text}`)
      return `tool errors=${toolErrors.length}, finish=${result.finishReason}`
    },
    'failure',
  )

  await check(
    'failure: a prompt longer than the context',
    async () => {
      const small = litertlm(modelId, { maxContextTokens: 256 })
      const words = Array.from({ length: 1200 }, (_, i) => `word${i}`).join(' ')
      try {
        const result = await generateText({
          model: small,
          prompt: `Repeat these words: ${words}`,
          maxOutputTokens: 16,
        })
        return `no error: the engine answered with ${result.text.length} chars, finish=${result.finishReason}`
      } catch (error) {
        expect(LiteRTLMError.isInstance(error), `Not a LiteRTLMError: ${String(error)}`)
        const code = (error as LiteRTLMError).code
        expect(code === 'CONTEXT_TOO_LONG', `Code ${code}: ${(error as Error).message}`)
        return `${code}: ${(error as Error).message.slice(0, 160)}`
      } finally {
        await small.unload()
      }
    },
    'failure',
  )

  await check('the model works after every failure', async () => {
    const result = await generateText({
      model: model as LanguageModel,
      prompt: 'What is the capital of Italy? Answer with one word.',
      maxOutputTokens: 32,
    })
    expect(result.text.includes('Rome'), `Unexpected answer: ${result.text}`)
    return `"${result.text.trim()}"`
  })

  await check('unload, then load again', async () => {
    await model.unload()
    const result = await generateText({
      model,
      prompt: 'What is the capital of Spain? Answer with one word.',
      maxOutputTokens: 32,
    })
    expect(result.text.includes('Madrid'), `Unexpected answer: ${result.text}`)
    return `"${result.text.trim()}"`
  })

  if (modelId.startsWith('hf://')) {
    // The file this platform chose for the default model, named: it should not download again.
    const named = `${MODEL_ID}/gemma-4-E2B-it${Platform.OS === 'android' ? '' : '-gpu'}.litertlm`
    const answers = async (id: string, question: string, answer: string) => {
      const loaded = createLiteRTLM()(id)
      try {
        const result = await generateText({
          model: loaded,
          prompt: `${question} Answer with one word.`,
          maxOutputTokens: 32,
        })
        expect(result.text.includes(answer), `Unexpected answer: ${result.text}`)
        return `"${result.text.trim()}"`
      } finally {
        await loaded.unload()
      }
    }
    const withoutTheHub = async (run: () => Promise<string>) => {
      await model.unload()
      const realFetch = globalThis.fetch
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        if (url.includes('huggingface.co')) throw new TypeError('Network request failed')
        return realFetch(input, init)
      }) as typeof fetch
      try {
        return await run()
      } finally {
        globalThis.fetch = realFetch
      }
    }

    if (options.network !== false && modelId === MODEL_ID) {
      await check('a file named in the model id, already here, does not download again', async () => {
        await model.unload()
        const started = Date.now()
        const answer = await answers(named, 'What is the capital of Greece?', 'Athens')
        expect(Date.now() - started < 60000, `Took ${Date.now() - started} ms`)
        return `${answer} in ${Date.now() - started} ms`
      })
    }
    await check('no network: a model downloaded earlier still loads', () =>
      withoutTheHub(() => answers(modelId, 'What is the capital of Portugal?', 'Lisbon')),
    )
    if (modelId === MODEL_ID) {
      await check('no network: a named file downloaded earlier still loads', () =>
        withoutTheHub(() => answers(named, 'What is the capital of Norway?', 'Oslo')),
      )
    }
  }

  const downloadsAfterADrop = async (url: string) => {
    await model.unload()
    const dropped = createLiteRTLM()(url)
    let lastFraction = 0
    try {
      await dropped.prepare({
        onProgress: ({ fraction }) => {
          lastFraction = fraction ?? lastFraction
        },
      })
      expect(lastFraction === 1, `The download ended at ${lastFraction}.`)
      const result = await generateText({
        model: dropped,
        prompt: 'What is the capital of Austria? Answer with one word.',
        maxOutputTokens: 32,
      })
      expect(result.text.includes('Vienna'), `Unexpected answer: ${result.text}`)
      return `"${result.text.trim()}"`
    } finally {
      await dropped.unload()
    }
  }
  if (options.cut !== undefined) {
    const url = options.cut
    await check(
      'a dropped connection: the download goes on from there',
      () => downloadsAfterADrop(url),
      'failure',
    )
  }
  if (options.cutWhole !== undefined) {
    const url = options.cutWhole
    await check(
      'a dropped connection, and a server with no ranges: the download starts over',
      () => downloadsAfterADrop(url),
      'failure',
    )
  }

  if (Platform.OS === 'web' && options.keep !== true) {
    await check('the download is kept, and can be removed', async () => {
      const kept = (await removeKeptModels()) ?? []
      expect(kept.length > 0, 'Nothing was kept.')
      return kept.join(', ')
    })
  }

  say(`### FAILURE-PATHS: ${failurePathsPassed} PASS`)
  say(`### RESULT ${passed} PASS ${failed} FAIL`)
}
