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

## The package from npm

`ai-sdk-litert-lm` 0.1.0, as published on npm, on 2026-11-06:

- The example, with its dependency switched from the local pack to 0.1.0 from npm, passed 30 of 30 on the Pixel 11 Pro from a clean install, and 27 of 27 with no network (`android-p11p-28-registry.log`, `android-p11p-29-registry-offline.log`).
- A new Expo app, made with `create-expo-app` (Expo 58, React Native 0.88.1) and set up with the README's install lines, ran the README's first block, `prepare()`, `generateText`, `streamText` and tools. All five passed on the Pixel 11 Pro (`fresh-android.log`) and in Chrome 156 as the app's web build (`fresh-web-reg.log`).
- A plain Vite page with the README's "Browser only" install ran the README's first block and `generateText` in Chrome 156. Both passed (`fresh-vite.log`).
- Chrome ran headless, with a profile on disk and no flags.

## After `main` changed on 2026-11-11

On 2026-11-11 `gemma-4-E2B-it-gpu.litertlm` on the Hub's `main` became a file that needs LiteRT-LM 0.19.1, and so did the `-gpu.litertlm` file of the Gemma 4 E4B, 12B, 26B-A4B and 31B repos. The runs below came after that: 0.1.0 and 0.1.1 on 2026-11-11, 0.1.2 on 2026-11-12, all with `react-native-litert-lm` 0.8.2 (LiteRT-LM 0.18.1):

| Package | Device | Install | Passed | Log |
| --- | --- | --- | --- | --- |
| 0.1.0 from npm | iPhone 18 Pro, iOS 27.2 | Clean | 6 of 30. `prepare` downloaded the new file, then failed with `RUNTIME_TOO_OLD` | `ios-i18p-15-r6-reg-clean.log` |
| 0.1.0 from npm | iPhone 18 Pro, iOS 27.2 | Over an app that held the earlier file | 6 of 30. It downloaded the new file too, then failed the same way | `ios-i18p-17-r6-reg-old.log` |
| 0.1.1 | iPhone 18 Pro, iOS 27.2 | Clean | 30 of 30, with the file from revision `3d48132a` | `ios-i18p-19-r6-fix-clean2.log` |
| 0.1.1 | iPhone 18 Pro, iOS 27.2 | Over 0.1.0's download of the new file | 29 of 30. The one failure came from the example's own test helper, fixed before the clean run | `ios-i18p-18-r6-fix-new.log` |
| 0.1.1 | Pixel 11 Pro, Android 17 | Clean | 29 of 30, with `gemma-4-E2B-it.litertlm` from `main` as before. The screen went off early in the run, and the one failure came from that | `android-p11p-32-r6-fix.log` |
| 0.1.1 from npm | Pixel 11 Pro, Android 17 | Clean, with the screen kept on | 3 checks, all passed: `prepare`, `streamText` at 29.0 tok/s, and the one that had failed. The other 27 weren't run | `android-p11p-36-r7-awake.log` |
| 0.1.2 | iPhone 18 Pro, iOS 27.2 | Clean | 34 of 34: the 30, with the file from revision `3d48132a`, and four checks added to a copy of the example. Twice, a model id that named the copy on `main`, with its `sha256`, downloaded that copy, which was refused with `RUNTIME_TOO_OLD` and stayed on the phone. Each time, the plain model id then downloaded the copy from before again, from `3d48132a`, and answered: the first time with that copy's `sha256` set, the second with the app's own requests to the Hub made to fail | `ios-i18p-20-r7-e2b.log` |
| 0.1.2 | iPhone 18 Pro, iOS 27.2 | Clean | 28 of 28, with `hf://litert-community/gemma-4-E4B-it-litert-lm` and its file from revision `8b77b27b`. The two checks that put the E2B file's name in the model id don't run with another model | `ios-i18p-21-r7-e4b.log` |
| 0.1.2 | Pixel 11 Pro, Android 17 | Clean. The screen stayed on through the run | 30 of 30, with `gemma-4-E2B-it.litertlm` from `main` | `android-p11p-37-r7-full.log` |

The check that failed on the Pixel 11 Pro was `failure: generateText aborted, then the model still works`. The check sets a timer to abort the call after 300 ms, and the call ran to the end. It failed the same way in the three runs with the screen off, and passed in the rerun that kept the screen on.

The phone's screen timeout is 30 s. In each of those three runs the screen went off less than 30 s after the app opened and stayed off (`Going to sleep due to timeout`). Half a second later the app logged `onHostPause`, and it never resumed. React Native stops its timers while the app is paused, so the abort never came. In another run with the screen off, of `prepare` and `streamText` only, the app's cpuset read while it streamed was `/background`, with CPUs 0–1, the phone's two little cores (`android-p11p-35-r7-speed.log`, with the reading in `r7-speed-state.txt`).

For the rerun, a copy of the example was changed to keep the screen on while its checks ran (`expo-keep-awake`). The screen stayed on and the app stayed in front: its log has no `Going to sleep` and no `onHostPause`. The call was aborted, and `streamText` ran at 29.0 tok/s (27.2 on 2026-11-06). The example now keeps the screen on while its checks run.

The logs are kept by the author, not in this repo. What wasn't run on a device is listed at the end of [What was checked](what-was-checked.md).
