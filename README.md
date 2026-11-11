# ai-sdk-litert-lm

[LiteRT-LM](https://ai.google.dev/edge/litert-lm) provider for the [Vercel AI SDK](https://ai-sdk.dev). Run `.litertlm` models with `generateText` and `streamText` on iOS, on Android and in the browser, with the same line of code. Gemma 4 E2B streamed a short answer at 94 tokens per second on an iPhone 18 Pro (2026-11-05) and 27 on a Pixel 11 Pro (2026-11-06).

```ts
import { streamText } from 'ai'
import { litertlm } from 'ai-sdk-litert-lm'

const result = streamText({
  model: litertlm('hf://litert-community/gemma-4-E2B-it-litert-lm'),
  prompt: 'What can you do without a network connection?',
})

for await (const text of result.textStream) console.log(text)
```

On a phone the provider runs on [`react-native-litert-lm`](https://github.com/hung-yueh/react-native-litert-lm). In a browser it runs on Google's [`@litert-lm/core`](https://www.npmjs.com/package/@litert-lm/core) with WebGPU. Your bundler picks the right one, so an Expo app that targets all three shares its AI code.

## Install

### Expo (iOS, Android, web)

```bash
npx expo install ai-sdk-litert-lm ai react-native-litert-lm react-native-nitro-modules @ungap/structured-clone @stardazed/streams-text-encoding
# For the web target:
npx expo install @litert-lm/core react-dom react-native-web
```

`npx expo install` picks the React Native version your Expo release expects. Keep it: an iOS build with another version can crash on launch.

Add the plugin to `app.json`:

```json
{
  "expo": {
    "plugins": [
      [
        "react-native-litert-lm",
        { "ios": { "extendedVirtualAddressing": true, "increasedMemoryLimit": true } }
      ]
    ]
  }
}
```

The two iOS settings let an app load models of about 2 GB and more, and they need a paid Apple Developer account. For a smaller model, `"plugins": ["react-native-litert-lm"]` is enough.

The AI SDK needs a few web APIs that React Native doesn't have. Copy [`example/polyfills.js`](example/polyfills.js) into your app and import it first:

```ts
import './polyfills'
```

Then build a native app. Expo Go can't load native modules:

```bash
npx expo prebuild
npx expo run:android --variant release
npx expo run:ios --configuration Release --device
```

### Bare React Native

Install `ai-sdk-litert-lm`, `ai`, `react-native-litert-lm` and `react-native-nitro-modules`, then follow the [polyfill guide](https://www.react-native-ai.dev/docs/polyfills) for bare apps, which also adds web streams. For a web build, use the Browser only install below.

### Browser only

```bash
npm install ai-sdk-litert-lm ai @litert-lm/core
```

## Choose a model

| Model id | What loads |
| --- | --- |
| `hf://org/repo` or `org/repo` | A file chosen from the repo, see below |
| `hf://org/repo@revision/file.litertlm` | That file at that revision |
| `https://…/model.litertlm` | That URL |
| `/path/to/model.litertlm` | A file on the phone |

Some repos hold a GPU-only `-gpu.litertlm` file next to a full bundle. Given a repo, the provider chooses:

| Where | File |
| --- | --- |
| Browser | The `-gpu.litertlm` file, chosen by `@litert-lm/core` |
| iOS | The `-gpu.litertlm` file |
| Android | The full bundle |

For a `litert-community` repo, `@litert-lm/core` looks on the repo's `web` branch before `main`, so a browser can get a different file of the same name than a phone does. A phone reads `main` unless the model id names a revision, with the one exception below.

A phone uses the repo's `litertlm_manifest.json` instead if it has one. Files built for one chip are never chosen, and `backend: 'cpu'` skips the GPU-only file, which can't run on a CPU. When several files are left, the order is: the file named after the repo, then `model`, then INT4, then the shortest name. To load another one, name it in the model id.

Android gets the full bundle because the GPU-only Gemma 4 E2B file gave wrong text, with no error, on a Pixel 11 Pro with `react-native-litert-lm` 0.8.2 (LiteRT-LM 0.18.1). If you've tested your phones and want the smaller file, name it: `hf://litert-community/gemma-4-E2B-it-litert-lm/gemma-4-E2B-it-gpu.litertlm`.

A file on `main` can change under the same name. On 2026-11-11 `gemma-4-E2B-it-gpu.litertlm` became a file that needs LiteRT-LM 0.19.1. A phone with an older engine reads that one file from revision `3d48132a`, the last one it can load, unless the model id names a revision or `sha256` is set. For an app you ship, name the revision yourself: `hf://org/repo@<commit>/file.litertlm`.

The [Web LLM Models](https://huggingface.co/collections/litert-community/web-llm-models) collection lists what runs in a browser. For a phone, look in [litert-community](https://huggingface.co/litert-community) and read the model's card.

If a model answers as though it never saw the question, look at the file first. The chat template in some older files loses the user's turn on LiteRT-LM 0.18 and newer, with no error. `qwen3_0_6b_mixed_int4.litertlm` did this on a Pixel 11 Pro, and the [Qwen3-8B](https://huggingface.co/litert-community/Qwen3-8B) and [Qwen3-14B](https://huggingface.co/litert-community/Qwen3-14B) cards report it for all of their files.

## Load the model ahead of time

The first call downloads and loads the model. To do that on your own schedule and show progress:

```ts
const model = litertlm('hf://litert-community/gemma-4-E2B-it-litert-lm')

await model.prepare({
  onProgress: ({ fraction }) => setProgress(fraction ?? 0),
})
```

`model.unload()` frees the memory, and the next call loads the model again. One provider keeps one model in memory, so loading a second model unloads the first. Calls run one at a time, in order.

Downloads are kept. A phone keeps them in the app's own storage. A browser keeps them in the [origin private file system](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system), which exists only on HTTPS and localhost. Without it, or without room in it, the model downloads on every load: a Chrome context with no profile on disk ran out at about 2 GB. A browser can also clear this storage when the disk runs low, unless the page has called [`navigator.storage.persist()`](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist) and been granted it. To free the space in a browser:

```ts
const root = await navigator.storage.getDirectory()
await root.removeEntry('litert-lm-models', { recursive: true })
```

A dropped connection doesn't lose the download if the server takes range requests, as the Hub does. A browser picks up where it stopped. On a phone the call fails with `DOWNLOAD_FAILED`, and `react-native-litert-lm` goes on from there on the next call.

A downloaded model loads with no network. When the Hub doesn't answer, a browser uses the file from the last time. A phone keeps files by name, not by repo, so it looks for a file whose name is the repo's name, alone or with a build suffix such as `-gpu` or `_mixed_int4`. Any other name may be another model, and the call fails with `DOWNLOAD_FAILED`. For those, name the file in the model id.

A phone keeps one file per name. With a Hugging Face id the provider passes the file's hash, so another revision or another repo's file of that name replaces it. With a plain URL, pass `sha256` to get the same.

## Tools

```ts
import { generateText, stepCountIs, tool } from 'ai'
import { z } from 'zod'

const { text } = await generateText({
  model,
  tools: {
    get_weather: tool({
      description: 'Get the current weather for a city.',
      inputSchema: z.object({ city: z.string() }),
      execute: async ({ city }) => ({ city, temperature: 21 }),
    }),
  },
  stopWhen: stepCountIs(3),
  prompt: 'What is the weather in Tokyo?',
})
```

A tool call that doesn't parse, or that fails its schema, arrives as a `tool-error` part, the same as with any other provider, so the model can try again on the next step. The engine can't force a call: `toolChoice: 'required'` gives a warning and the model decides.

## Structured output

`Output.object` works on both. On a phone the engine constrains the output to the schema. A model held to a schema can't call a tool. So a call that also has tools sends the schema to the model as an instruction instead. `Output.json()` has no schema, so it's an instruction too. In a browser the runtime has no such constraint, so it's always an instruction. An instruction comes with a warning on the call, and a reply that doesn't match fails the way it does with any provider.

## Reasoning

In a browser a model's thoughts arrive as `reasoning` parts, and `reasoning: 'none'` turns them off.

A phone's runtime doesn't hand thoughts to JavaScript, so the provider turns thinking off unless a call sets `reasoning`. Otherwise a model that thinks by default would spend `maxOutputTokens` on text nobody can read. With `reasoning: 'high'` on a phone, the model thinks, `reasoningText` stays empty, and the thoughts count against `maxOutputTokens`, so leave room: on a Pixel 11 Pro, Qwen3-0.6B returned empty text for 17 × 23 with 512 tokens. A call that ends with no text this way reports `finishReason: 'length'`.

`<think>` tags that a bundle leaves at the start of its text become `reasoning` parts on both. After the answer has begun, a tag is text.

## Long conversations

A phone or a browser that replays a whole conversation for every message gets slow as the chat grows. The provider keeps the conversation in the engine, and when a call's messages extend what the engine already holds, it sends only the new message. Send the messages back as the SDK gave them to you:

```ts
const messages = [{ role: 'user', content: 'Hello' }]
const first = await generateText({ model, messages })
messages.push(...first.response.messages, { role: 'user', content: 'And then?' })
const second = await generateText({ model, messages }) // Only the last message goes to the engine
```

`providerMetadata['litert-lm'].continued` tells you whether a call did this. A different history replays, which is always correct and only slower.

## What changes per call

On a phone, sampling and tools apply when the model loads. The provider honors them by reloading the model when they change, and the call carries a warning, so keep them the same from call to call. In a browser they apply to a conversation, so a change starts a new one with no reload.

| Setting | Phone | Browser |
| --- | --- | --- |
| `maxOutputTokens` | Per call, 1024 if not set | Per call |
| `temperature`, `topK`, `topP` | Reload when changed | Per call |
| `tools` | Reload when changed | Per call |
| `Output.object` | Reload when turned on or off | Per call, as an instruction |
| `reasoning` | Per call, off by default, thoughts not reported | Per call, the model's default otherwise |
| `frequencyPenalty`, `presencePenalty` | Per call | Not supported, warns |
| `seed` | Not supported, warns | Per call |
| `stopSequences` | Not supported, warns | Not supported, warns |

To set sampling once, pass it with the model. These don't reload:

```ts
const model = litertlm('hf://litert-community/gemma-4-E2B-it-litert-lm', {
  temperature: 0.2,
  maxContextTokens: 4096,
  backend: 'gpu',
})
```

`speculativeDecoding: true` turns on a bundle's multi-token drafter, which can make decoding faster. The browser ignores it with a warning. A phone hashes the download and checks it against `sha256`. A browser doesn't hash the file: for a Hugging Face id it only compares `sha256` with the Hub's listing.

Images and audio in the prompt aren't supported yet: a file part fails with a clear error.

A reply that stops at `maxOutputTokens` reports `finishReason: 'length'`. Usage figures come from the engine, except on Android, where `react-native-litert-lm` 0.8.2 can't count tokens: the output count is the pieces of text the engine streamed, and the input count estimates from the last message's characters. If the engine puts several tokens in one piece, a reply cut off at the limit can report `stop` there. That didn't happen in English or Japanese on a Pixel 11 Pro.

## Errors

Failures from the engine are `LiteRTLMError`s with a `code`:

```ts
import { LiteRTLMError } from 'ai-sdk-litert-lm'

try {
  await generateText({ model, prompt })
} catch (error) {
  if (LiteRTLMError.isInstance(error) && error.code === 'MODEL_NOT_FOUND') {
    // ...
  }
}
```

| Code | Meaning |
| --- | --- |
| `MODEL_NOT_FOUND` | No such file or repo, or a repo without a usable `.litertlm` file |
| `INVALID_MODEL` | The file is not a readable bundle |
| `DOWNLOAD_FAILED` | The download failed |
| `OUT_OF_MEMORY` | The engine ran out of memory, or refused to load because it would |
| `RUNTIME_TOO_OLD` | The bundle needs a newer LiteRT-LM |
| `LOAD_FAILED` | The engine could not start for another reason |
| `CONTEXT_TOO_LONG` | The prompt is longer than the conversation can hold |
| `GENERATION_FAILED` | Generation failed for another reason |

`streamText` reports these through `onError` and the stream's `error` part, like any other provider. An aborted call stops generation, and the model stays loaded for the next one. A phone's runtime can't cancel a download: the call rejects at once, the download goes on, and the next call picks it up.

If Android asks for memory back, the engine is freed. A call in progress ends with `OUT_OF_MEMORY`, and the next call loads the model again.

## Try the example

[`example/`](example) is one Expo app for all three targets: a small chat, and a button that runs the checks below, failures included, against the real engine. A truncated file and a dropped connection need a file and a server of your own, so the button leaves those out.

```bash
git clone https://github.com/john-rocky/ai-sdk-litert-lm
cd ai-sdk-litert-lm
npm install
npm pack
cd example
npm install

npx expo start --web          # Browser
npx expo run:android --variant release   # Android
npx expo run:ios --configuration Release --device   # iOS
```

For iOS, first change `ios.bundleIdentifier` in `example/app.json` to an id your team can sign. `npx expo run:android` keeps running after the app opens, to show the app's logs. The button writes its results to the screen and, on a phone, to `Documents/checks.log` in the app's container.

## What was checked

[`example/src/checks.ts`](example/src/checks.ts) runs against the real engine: `generateText`, `streamText`, tools, structured output, reasoning, a conversation with and without a replay, a reply cut off at its limit, and the failures (no such file or repo, a broken or truncated file, an abort during a load and during a call, a tool call that doesn't parse, tool arguments that fail the schema, a prompt that's too long). The last runs, from a clean install with `hf://litert-community/gemma-4-E2B-it-litert-lm`:

| Date | Where | Runtime | File chosen | Passed |
| --- | --- | --- | --- | --- |
| 2026-11-06 | Pixel 11 Pro, Android 17 | `react-native-litert-lm` 0.8.2 (LiteRT-LM 0.18.1) | `gemma-4-E2B-it.litertlm` | 30 of 30 |
| 2026-11-05 | iPhone 18 Pro, iOS 27.2 | `react-native-litert-lm` 0.8.2 (LiteRT-LM 0.18.1) | `gemma-4-E2B-it-gpu.litertlm` | 30 of 30 |
| 2026-11-05 | Chrome 156 on a Mac, WebGPU | `@litert-lm/core` 0.19.0 | `gemma-4-E2B-it-gpu.litertlm`, `web` branch | 31 of 31 |

About those runs:

- The runs came from a clean clone, with the steps above. `npx expo run:ios` wasn't run: the iPhone app was built from the same project with `xcodebuild` and signed with an App ID that already existed.
- Speed, for a reply of two sentences: 94 tokens per second on the iPhone 18 Pro, 27 on the Pixel 11 Pro, 36 in Chrome. On Android the provider works the figure out from the pieces of text the engine streamed. The Pixel's next run, three minutes later, gave 14, with its skin sensor at 40 °C instead of 37 °C. A reply of 1024 tokens took 11 s on the iPhone and 89 s on the Pixel. More in [`docs/tested-devices.md`](docs/tested-devices.md).
- The example's chat was also used on the Pixel 11 Pro, typing on its keyboard, and in Chrome, in a window the size of a phone: a message, a follow-up, Stop during a reply, and a message after Stop.
- Chrome ran headless, from Playwright, with a profile on disk. The checks ran with `--enable-unsafe-webgpu` and `--ignore-gpu-blocklist`, and the chat ran with no flags.
- In Chrome the engine logs `Model expects minimum LiteRT-LM runtime version 0.19.1, but current runtime version is 0.19.0` for this file. Every check passed with it.
- The tool call that doesn't parse is injected, because a model can't be made to write one on demand. The other failures are real.
- With no network: the Pixel 11 Pro had no network at all, and Chrome had the Hub blocked. Both passed 27 of 27, with the checks that need the Hub left out. An iPhone can't be put in airplane mode from a script, so there the app's own requests to the Hub were made to fail.
- A dropped connection: a local server cut Chrome's download at 300 MB, once letting it continue from there and once making it start over, and the model answered both times. The Pixel 11 Pro lost its network during a download, the call failed with `DOWNLOAD_FAILED`, and the next run finished the load.
- With `litert-community/Qwen3-0.6B` on the Pixel 11 Pro, 24 of 28 passed. The misses were three wrong answers from a small model and a call that answered without using the tool.
- A plain Vite app in Chrome passed the "Browser only" install, with `wasmPath` set and a second model on the provider.
- The package as published, 0.1.0 from npm, on 2026-11-06: the example with its dependency switched to it passed 30 of 30 on the Pixel 11 Pro, and 27 of 27 with no network. A new Expo app set up with the install lines above ran the README's first block, `prepare()`, `generateText`, `streamText` and tools, and passed on the Pixel 11 Pro and in Chrome with no flags. More in [`docs/tested-devices.md`](docs/tested-devices.md).

Not run on a device: `backend: 'npu'`, `speculativeDecoding`, a repo with a `litertlm_manifest.json`, a gated model's `accessToken`, a bare React Native app, Android asking for memory back, and the example's chat on an iPhone.

## Development

```bash
npm install
npm test
npm run typecheck
```

## License

MIT. Independent project, not affiliated with Google or Vercel.
