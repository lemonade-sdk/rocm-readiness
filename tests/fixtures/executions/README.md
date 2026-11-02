# Detailed benchmark execution fixtures

Producer revision: `06a147bc08581b64c099e859de9463206f2fc687` in `lemonade-sdk/lemonade`, branch `benchmark-data`.

These fixtures retain the original report fields except model accuracy blocks, which are unrelated to execution status.

- `passed.json`: `results/llamacpp-rocm-stable/Gemma-4-31B-it-GGUF/run-20261027T190934Z.json`
- `failed.json`: `results/llamacpp-rocm-stable/gpt-oss-20b-mxfp4-GGUF/run-20261027T190934Z.json`
- `partial.json`: `results/llamacpp-rocm-stable/MiniCPM5-1B-GGUF/run-20261029T174602Z.json`

The first report has zero failed attempts. The second has explicit all-failed status with four failures and no throughput metrics. The third has one failure at 4K and zero at 32K. Failure totals can include warmup failures; configured measurement count is not a successful-attempt count.
