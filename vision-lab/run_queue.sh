#!/bin/bash
# Embeds every recording with each candidate, one model at a time (they share one GPU).
cd "$(dirname "$0")"
export HF_HUB_DISABLE_PROGRESS_BARS=1 PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True TORCH_ROCM_AOTRITON_ENABLE_EXPERIMENTAL=1
for model in "$@"; do
  echo "=== $model"
  .venv/bin/python embed.py "$model" 2>&1 | grep --line-buffered -v "(null)" | grep --line-buffered -E "loaded|\] video|Error|error|Traceback|done"
done
echo "=== queue finished"
