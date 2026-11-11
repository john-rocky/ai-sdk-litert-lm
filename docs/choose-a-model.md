# Choose a model

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

A file on `main` can change under the same name. On 2026-11-11 `gemma-4-E2B-it-gpu.litertlm` became a file that needs LiteRT-LM 0.19.1. A phone with an older engine reads that one file from revision `3d48132a`, the last one it can load, unless `sha256` is set or the model id names a revision other than `main` (on a phone, `@main` is the same as no revision). For an app you ship, name the revision yourself: `hf://org/repo@<commit>/file.litertlm`.

A phone uses the repo's `litertlm_manifest.json` instead if it has one. Files built for one chip are never chosen, and `backend: 'cpu'` skips the GPU-only file, which can't run on a CPU. When several files are left, the order is: the file named after the repo, then `model`, then INT4, then the shortest name. To load another one, name it in the model id.

Android gets the full bundle because the GPU-only Gemma 4 E2B file gave wrong text, with no error, on a Pixel 11 Pro with `react-native-litert-lm` 0.8.2 (LiteRT-LM 0.18.1). If you've tested your phones and want the smaller file, name it: `hf://litert-community/gemma-4-E2B-it-litert-lm/gemma-4-E2B-it-gpu.litertlm`.

The [Web LLM Models](https://huggingface.co/collections/litert-community/web-llm-models) collection lists what runs in a browser. For a phone, look in [litert-community](https://huggingface.co/litert-community) and read the model's card.

If a model answers as though it never saw the question, look at the file first. The chat template in some older files loses the user's turn on LiteRT-LM 0.18 and newer, with no error. `qwen3_0_6b_mixed_int4.litertlm` did this on a Pixel 11 Pro, and the [Qwen3-8B](https://huggingface.co/litert-community/Qwen3-8B) and [Qwen3-14B](https://huggingface.co/litert-community/Qwen3-14B) cards report it for all of their files.
