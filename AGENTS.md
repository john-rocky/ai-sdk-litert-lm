# AGENTS.md: for coding agents running a model on the device with the AI SDK

Read this if someone asked you to "run a model on the device with the AI SDK", "add an offline LLM to an Expo app", "use Gemma on a phone with `streamText`" or "run a `.litertlm` file in the browser". This file routes. The README has the details.

**What this is.** A [Vercel AI SDK](https://ai-sdk.dev) provider for [LiteRT-LM](https://ai.google.dev/edge/litert-lm): `litertlm('hf://org/repo')` is a model for `generateText` and `streamText`. On iOS and Android it runs on `react-native-litert-lm`. In a browser it runs on `@litert-lm/core` with WebGPU. The bundler picks the entry through the `react-native` and `browser` export conditions. Independent project, not affiliated with Google or Vercel.

## Route

| Task | Do | Where |
|---|---|---|
| Add it to an Expo app | The install line, the plugin in `app.json`, `import './polyfills'` first, then a native build (Expo Go can't load native modules) | README "Install", `example/polyfills.js` |
| Add it to a web page only | `npm install ai-sdk-litert-lm ai @litert-lm/core` | README "Browser only" |
| Generate or stream text | `generateText({ model: litertlm(id), prompt })`, `streamText({ model: litertlm(id), prompt })` | README, top |
| Choose a model | `hf://org/repo` chooses a file, `hf://org/repo@revision/file.litertlm` names one. A URL works too, and on a phone a path | README "Choose a model", `src/shared/hugging-face.ts` |
| Download before the first message, with progress | `await model.prepare({ onProgress: ({ fraction }) => setProgress(fraction ?? 0) })` | README "Load the model ahead of time" |
| Free the memory | `model.unload()`, or `litertlm.unloadAll()` | `src/shared/types.ts` |
| Tools | `tools` with `stopWhen: stepCountIs(3)` | README "Tools" |
| JSON that fits a schema | `output: Output.object({ schema })` | README "Structured output" |
| A chat that stays fast | Send back `response.messages` as the SDK gave them | README "Long conversations" |
| Set sampling once | `litertlm(id, { temperature, topK, topP, maxContextTokens, backend })` | README "What changes per call" |
| Handle a failure | `LiteRTLMError.isInstance(error)`, then `error.code` | README "Errors", `src/shared/errors.ts` |
| Host the browser's Wasm yourself | `createLiteRTLM({ wasmPath })` | `src/web/index.ts` |
| See it run | `example/` is one Expo app for all three targets, with a chat and a button that runs the checks | README "Try the example", `example/src/checks.ts` |
| Run the tests | `npm install && npm test` (a scripted engine, no phone needed) | `test/` |

## Rules

- On a phone, sampling and tools apply when the model loads. Changing them between calls reloads the model and adds a warning. Keep them the same from call to call, or set sampling on the model.
- Keep the React Native version `npx expo install` picks. An iOS build with another version can crash on launch.
- In a React Native app, copy `example/polyfills.js` into the app and `import './polyfills'` first. The AI SDK needs web APIs React Native doesn't have.
- Given a repo, Android loads the full bundle, and iOS and browsers load the `-gpu.litertlm` file. The GPU-only Gemma 4 E2B file gave wrong text, with no error, on a Pixel 11 Pro. Don't name that file on Android without testing the phones you care about.
- Images and audio in the prompt aren't supported yet. A file part fails with a clear error.
- Numbers in the README and in `docs/tested-devices.md` carry a device and a date. Don't repeat them for another device.
