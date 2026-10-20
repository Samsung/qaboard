# Inputs, models and their licenses

## Inputs
None downloaded. The tasks (`tasks/<category>/<name>.yaml`), the prompts (`prompts/`) and the fleet fixture
(generated from a seed by `qa/fleet.py`) are ours, dedicated to the public domain (CC0 1.0). The prices in
`qa/prices.yaml` are made up.

## Models
Downloaded by `qa/models.py` from Hugging Face at a pinned revision, checked against `inputs.lock.yaml` (SHA-256), and
kept outside the project. Not committed, not mirrored. Checked on their model cards (2026-10-13).

| Model | Weights | License |
|---|---|---|
| Qwen2.5-0.5B-Instruct, by the Qwen team (Alibaba Cloud) | [`Qwen/Qwen2.5-0.5B-Instruct-GGUF`](https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF), `qwen2.5-0.5b-instruct-q8_0.gguf` | Apache-2.0 |
| SmolLM2-360M-Instruct, by Hugging Face | [`HuggingFaceTB/SmolLM2-360M-Instruct-GGUF`](https://huggingface.co/HuggingFaceTB/SmolLM2-360M-Instruct-GGUF), `smollm2-360m-instruct-q8_0.gguf` | Apache-2.0 |

## Python dependencies
| Package | Used for | License |
|---|---|---|
| [`llama-cpp-python`](https://github.com/abetlen/llama-cpp-python) 0.3.35 | Runs the models on the CPU; bundles [llama.cpp](https://github.com/ggml-org/llama.cpp) (MIT) | MIT |
| [`PyYAML`](https://github.com/yaml/pyyaml) | Tasks, prices, the lock file | MIT |

To add a model: only weights under an OSI-approved license. Add it to `inputs.lock.yaml` (URL at a pinned revision,
SHA-256, size), to `qa/prices.yaml`, and a row here.
