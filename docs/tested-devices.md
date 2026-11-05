# Tested devices

[`example/src/checks.ts`](../example/src/checks.ts) run against the real engine, from a clean clone and a clean install, with `hf://litert-community/gemma-4-E2B-it-litert-lm`. Speed is what the `streamText` check reported for a reply of two sentences. On Android the provider works it out from the pieces of text the engine streamed after the first. Elsewhere it's the engine's own figure.

| Date | Device | OS | Runtime | File | Passed | With no network | Speed | Log |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-11-06 | Pixel 11 Pro | Android 17 | `react-native-litert-lm` 0.8.2 (LiteRT-LM 0.18.1) | `gemma-4-E2B-it.litertlm` | 30 of 30 | 27 of 27 | 27.2 tok/s | `android-p11p-25-clone.log`, `android-p11p-26-clone-offline.log` |
| 2026-11-05 | iPhone 18 Pro | iOS 27.2 | `react-native-litert-lm` 0.8.2 (LiteRT-LM 0.18.1) | `gemma-4-E2B-it-gpu.litertlm` | 30 of 30 | The phone stayed online: inside the 30, the app's own requests to the Hub were made to fail | 94.2 tok/s | `ios-i18p-13-clone.log` |
| 2026-11-05 | Chrome 156 on a Mac, WebGPU | macOS | `@litert-lm/core` 0.19.0 | `gemma-4-E2B-it-gpu.litertlm`, `web` branch | 31 of 31 | 27 of 27, with the Hub blocked | 36.3 tok/s | `web-17-clone.log`, `web-18-clone-offline.log` |

The speed moved between runs on the same device. On the Pixel 11 Pro the first run gave 27.2 tok/s with the phone's skin sensor at 37 °C, and the run three minutes later gave 13.8 tok/s at 40 °C. In Chrome the second run gave 52.9 tok/s.

A reply of 1024 tokens took 89 s on the Pixel 11 Pro and 11 s on the iPhone 18 Pro. That check runs on phones only.

Chrome ran headless, from Playwright, with a profile on disk, `--enable-unsafe-webgpu` and `--ignore-gpu-blocklist`. The example's chat also ran there with no flags (`chat-web-noflags.log`).

The logs are kept by the author, not in this repo. What wasn't run on a device is listed at the end of the README's "What was checked".
