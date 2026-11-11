# Changelog

## 0.1.2

- Fixed: on iOS, the `-gpu.litertlm` file of `gemma-4-E4B-it-litert-lm`, `gemma-4-12B-it-litert-lm`, `gemma-4-26B-A4B-it-litert-lm` and `gemma-4-31B-it-litert-lm` was read from `main`, where on 2026-11-11 it became a file that needs LiteRT-LM 0.19.1. A phone with an older engine now reads it from the last revision before that day, as 0.1.1 does for `gemma-4-E2B-it-litert-lm`.
- Fixed: when the Hub's file list didn't come (no network, or HTTP 429 or 5xx), a phone loaded the file of that name it already had, even the copy from `main` its engine can't load. It now names the copy from before, which the binding keeps when it is already there and downloads otherwise.
- Changed: a `sha256` setting for the copy from before is read from that copy's revision, on any engine. 0.1.1 read it from `main`, where the hash didn't match.

## 0.1.1

- Fixed: on iOS, `litertlm('hf://litert-community/gemma-4-E2B-it-litert-lm')` failed with `RUNTIME_TOO_OLD` after a 2.3 GB download. On 2026-11-11 `gemma-4-E2B-it-gpu.litertlm` on the Hub's `main` became a file that needs LiteRT-LM 0.19.1, and `react-native-litert-lm` 0.8.2 ships 0.18.1. An app on 0.1.0 that already held the earlier file downloaded the new one too, and then failed. A phone with an older engine now reads that file from revision `3d48132a`, the last one it can load. A model id that names a revision other than `main`, or a `sha256` setting, is read as before.
- Not fixed yet: the same day `main` also replaced the `-gpu` file of `gemma-4-E4B-it-litert-lm`, `gemma-4-12B-it-litert-lm`, `gemma-4-26B-A4B-it-litert-lm` and `gemma-4-31B-it-litert-lm` with files that need LiteRT-LM 0.19.1. This release doesn't change what a phone reads from those repos, so on iOS it is still the new file. An app can name the revision it tested in the model id.

## 0.1.0

First release.
