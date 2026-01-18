#!/bin/bash
# Startup script for Face Recognition Service with ROCm 7.1+
# Configured for Arch Linux + RX 7800 XT (gfx1100)

# 1. Force use of system zstd to fix "Unsupported frame parameter" errors
# This resolves conflict between system ROCm and Python wheel dependencies
export LD_PRELOAD=/usr/lib/libzstd.so.1

# 2. Select the Discrete GPU
# Maps the RX 7800 XT to device 0 for MIGraphX
export HIP_VISIBLE_DEVICES=0

# 3. Set ROCm library path
export LD_LIBRARY_PATH=/opt/rocm/lib:${LD_LIBRARY_PATH}

# 4. Disable MLIR backend (causes crashes on RDNA 3)
export MIGRAPHX_DISABLE_MLIR=1

# 5. Set MIGraphX model cache path to avoid recompilation across restarts
# This caches compiled MIGraphX models, reducing startup time on subsequent runs
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export ORT_MIGRAPHX_MODEL_CACHE_PATH="${SCRIPT_DIR}/.migraphx_cache"
mkdir -p "${ORT_MIGRAPHX_MODEL_CACHE_PATH}"

# Activate virtual environment and run the service
source .venv/bin/activate
python -m face_service.main
