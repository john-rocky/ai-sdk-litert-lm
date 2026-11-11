# Use it

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
