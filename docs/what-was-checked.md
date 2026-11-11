# What was checked

[`example/src/checks.ts`](../example/src/checks.ts) runs against the real engine: `generateText`, `streamText`, tools, structured output, reasoning, a conversation with and without a replay, a reply cut off at its limit, and the failures (no such file or repo, a broken or truncated file, an abort during a load and during a call, a tool call that doesn't parse, tool arguments that fail the schema, a prompt that's too long). The runs of 2026-11-05 and 2026-11-06, from a clean install with `hf://litert-community/gemma-4-E2B-it-litert-lm`:

| Date | Where | Runtime | File chosen | Passed |
| --- | --- | --- | --- | --- |
| 2026-11-06 | Pixel 11 Pro, Android 17 | `react-native-litert-lm` 0.8.2 (LiteRT-LM 0.18.1) | `gemma-4-E2B-it.litertlm` | 30 of 30 |
| 2026-11-05 | iPhone 18 Pro, iOS 27.2 | `react-native-litert-lm` 0.8.2 (LiteRT-LM 0.18.1) | `gemma-4-E2B-it-gpu.litertlm` | 30 of 30 |
| 2026-11-05 | Chrome 156 on a Mac, WebGPU | `@litert-lm/core` 0.19.0 | `gemma-4-E2B-it-gpu.litertlm`, `web` branch | 31 of 31 |

Runs from 2026-11-11, after the Hub's `main` replaced `gemma-4-E2B-it-gpu.litertlm`, are in [Tested devices](tested-devices.md#after-main-changed-on-2026-11-11). On the iPhone 18 Pro, 0.1.0 passed 6 of 30, and 0.1.1 passed 30 of 30 from a clean install.

About the runs in the table:

- The runs came from a clean clone, with the steps in [Try the example](../README.md#try-the-example). `npx expo run:ios` wasn't run: the iPhone app was built from the same project with `xcodebuild` and signed with an App ID that already existed.
- Speed, for a reply of two sentences: 94 tokens per second on the iPhone 18 Pro, 27 on the Pixel 11 Pro, 36 in Chrome. On Android the provider works the figure out from the pieces of text the engine streamed. The Pixel's next run, three minutes later, gave 14, with its skin sensor at 40 °C instead of 37 °C. A reply of 1024 tokens took 11 s on the iPhone and 89 s on the Pixel. More in [`docs/tested-devices.md`](tested-devices.md).
- The example's chat was also used on the Pixel 11 Pro, typing on its keyboard, and in Chrome, in a window the size of a phone: a message, a follow-up, Stop during a reply, and a message after Stop.
- Chrome ran headless, from Playwright, with a profile on disk. The checks ran with `--enable-unsafe-webgpu` and `--ignore-gpu-blocklist`, and the chat ran with no flags.
- In Chrome the engine logs `Model expects minimum LiteRT-LM runtime version 0.19.1, but current runtime version is 0.19.0` for this file. Every check passed with it.
- The tool call that doesn't parse is injected, because a model can't be made to write one on demand. The other failures are real.
- With no network: the Pixel 11 Pro had no network at all, and Chrome had the Hub blocked. Both passed 27 of 27, with the checks that need the Hub left out. An iPhone can't be put in airplane mode from a script, so there the app's own requests to the Hub were made to fail.
- A dropped connection: a local server cut Chrome's download at 300 MB, once letting it continue from there and once making it start over, and the model answered both times. The Pixel 11 Pro lost its network during a download, the call failed with `DOWNLOAD_FAILED`, and the next run finished the load.
- With `litert-community/Qwen3-0.6B` on the Pixel 11 Pro, 24 of 28 passed. The misses were three wrong answers from a small model and a call that answered without using the tool.
- A plain Vite app in Chrome passed the "Browser only" install, with `wasmPath` set and a second model on the provider.
- The package as published, 0.1.0 from npm, on 2026-11-06: the example with its dependency switched to it passed 30 of 30 on the Pixel 11 Pro, and 27 of 27 with no network. A new Expo app set up with the README's install lines ran the README's first block, `prepare()`, `generateText`, `streamText` and tools, and passed on the Pixel 11 Pro and in Chrome with no flags. More in [`docs/tested-devices.md`](tested-devices.md).

Not run on a device: `backend: 'npu'`, `speculativeDecoding`, a repo with a `litertlm_manifest.json`, a gated model's `accessToken`, a bare React Native app, Android asking for memory back, and the example's chat on an iPhone.

The example's button runs these checks. A truncated file and a dropped connection need a file and a server of your own, so the button leaves those out. `npx expo run:android` keeps running after the app opens, to show the app's logs. On a phone the results also go to `Documents/checks.log` in the app's container.
