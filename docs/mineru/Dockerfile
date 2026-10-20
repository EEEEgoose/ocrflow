# ==========================================================
# MinerU 4.x GPU - China
# NVIDIA GPU / CUDA / vLLM
# ==========================================================

# CUDA 13.0
FROM docker.m.daocloud.io/vllm/vllm-openai:v0.21.0

# 如果驱动不支持 CUDA 13，可以改成：
# FROM docker.m.daocloud.io/vllm/vllm-openai:v0.21.0-cu129


# ----------------------------------------------------------
# System dependencies
# ----------------------------------------------------------

RUN apt-get update && \
    apt-get install -y \
        libgl1 \
        curl \
        patch && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*


# ----------------------------------------------------------
# Install MinerU
# 使用阿里云 PyPI 镜像；页进度补丁对应 4.0.10
# ----------------------------------------------------------

RUN python3 -m pip install -U \
    'mineru[torch]==4.0.10' \
    -i https://mirrors.aliyun.com/pypi/simple \
    --break-system-packages && \
    python3 -m pip cache purge


# ----------------------------------------------------------
# MinerU backend
# ----------------------------------------------------------

ENV MINERU_MODEL_SMALL_BACKEND=torch
ENV MINERU_MODEL_VLM_ENGINE=vllm


# ----------------------------------------------------------
# Download models from ModelScope
#
# standard 模型可以支持：
# basic
# standard
# advanced
# ----------------------------------------------------------

RUN mineru-kit models download \
    --tier standard \
    --small-backend torch \
    --vlm-engine vllm \
    --source modelscope


# ----------------------------------------------------------
# Page progress API patch
# ----------------------------------------------------------

COPY mineru-4.0.10-page-progress.patch /tmp/mineru-4.0.10-page-progress.patch

RUN python3 -c 'from importlib.metadata import version; assert version("mineru") == "4.0.10"' && \
    MINERU_SITE_ROOT="$(python3 -c 'from importlib.util import find_spec; from pathlib import Path; print(Path(find_spec("mineru").origin).parent.parent)')" && \
    cd "$MINERU_SITE_ROOT" && \
    patch --batch --forward -p1 < /tmp/mineru-4.0.10-page-progress.patch && \
    python3 -m py_compile mineru/utils/page_progress.py mineru/backend/analysis/pdf/window.py mineru/parser/api_server.py


# ----------------------------------------------------------
# Runtime model source / PDF processing window
# ----------------------------------------------------------

ENV MINERU_MODEL_SOURCE=local
ENV MINERU_PROCESSING_WINDOW_SIZE=8


# ----------------------------------------------------------
# API port
# ----------------------------------------------------------

EXPOSE 8000


# ----------------------------------------------------------
# 默认启动 MinerU API Server
# ----------------------------------------------------------

CMD ["mineru-kit", "api-server", "--host", "0.0.0.0", "--port", "8000", "--tier", "standard"]
