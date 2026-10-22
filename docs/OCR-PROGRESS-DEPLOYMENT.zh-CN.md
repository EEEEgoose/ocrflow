# Marker 与 MinerU 本地页进度部署指南

[项目首页](../README.md) · [使用手册](../README.zh-CN.md) · [来源与第三方组件](../THIRD_PARTY.md)

本指南把两种服务端进度方案放在一起：Marker 使用本仓库的整文件任务接口；MinerU 4.0.10 使用随源码提供的页进度补丁。只升级 Zotero 插件不会自动升级服务器。

| 服务 | 已适配环境 | 任务进度 | 默认示例端口 |
| --- | --- | --- | --- |
| Marker | Marker 2.0.0 / Surya 2 的既有环境 | 整份 PDF 上传一次，按真实页面响应更新，随后整理结构和导出 | 18501 |
| MinerU | MinerU 4.0.10 固定版本 | 每个处理窗口结束后更新已完成页数，随后后处理和导出 | 41835 |

## Marker：整文件任务与进度接口

### 1. 前提与文件

先准备已能完成文档转换的 Marker 2.0.0 / Surya 2 环境，包括其模型、推理服务和原有 GPU 配置。本项目提供任务 API 包装，不包含模型，也不替代 Marker / Surya 安装。其他版本的内部接口需先适配。

从本仓库取出：

- [server/marker_jobs.py](../server/marker_jobs.py)：上传、排队、状态、完整结果和取消接口。
- [server/marker_progress.py](../server/marker_progress.py)：观察真实页响应，不拆分原 PDF。
- [server/test_marker_jobs.py](../server/test_marker_jobs.py)：不加载模型的接口与取消测试。

FastAPI、uvicorn、python-multipart 使用已有 Marker 运行环境。测试依赖单独列于 [requirements-test.txt](../server/requirements-test.txt)。

### 2. 启动任务 API

在包含 `server/` 的仓库根目录，使用已安装 Marker 的 Python 环境运行：

```sh
mkdir -p marker-data/jobs
export MARKER_JOBS_DIR="$PWD/marker-data/jobs"
python3 -m uvicorn marker_jobs:app --app-dir ./server --host 0.0.0.0 --port 18501
```

只运行一个 API 进程，不增加 `--workers`。API 一次处理一份文档，页面推理仍按服务原有并发设置执行。

若使用 Docker，把 `server/` 挂载到 Marker 容器，例如 `/opt/ocrflow-api:ro`；任务目录使用持久化挂载。将**原有 Marker 服务**的启动命令替换为：

```yaml
command: [python3, -m, uvicorn, "marker_jobs:app", --app-dir, /opt/ocrflow-api, --host, 0.0.0.0, --port, "8001"]
```

宿主机示例映射 `18501:8001`，`MARKER_JOBS_DIR` 指向容器内的持久化目录，如 `/data/jobs`。保留既有模型缓存、Surya 地址、GPU、网络和卷配置；上述片段不是可直接覆盖原配置的完整 Compose 文件。

先备份原配置与镜像标签，等当前任务结束后再更新 Marker 容器。更新任务 API 不需要重启共享 Surya / vLLM 服务。运行中的文档会因容器重建中断；排队任务和已完成结果因持久化目录而保留。

### 3. 接口与验证

```sh
curl -fsS http://127.0.0.1:18501/openapi.json
```

接口列表必须含 `POST /v1/parse/jobs`。只看到 `/marker/upload` 的官方同步服务、或返回 Streamlit 网页的地址，不能提供插件所需的任务进度。

| 请求 | 用途 |
| --- | --- |
| `POST /v1/parse/jobs` | multipart 上传整份 PDF，返回 202 与 `job_id` |
| `GET /v1/parse/jobs/{job_id}` | 查询排队、运行、完成、失败或取消状态 |
| `GET /v1/parse/jobs/{job_id}/result` | 完成后获取完整 Markdown、图片和 metadata；未完成返回 409 |
| `DELETE /v1/parse/jobs/{job_id}` | 取消排队任务，或终止当前文档的转换进程 |
| `POST /marker/upload` | 同步上传入口；连接断开时取消它创建的任务 |

用测试 PDF 验证整文件上传，将返回的任务 ID 填入后续命令：

```sh
curl -fsS -F 'file=@sample.pdf' -F 'mode=balanced' -F 'force_ocr=false' -F 'output_format=markdown' -F 'paginate_output=true' http://127.0.0.1:18501/v1/parse/jobs
curl -fsS http://127.0.0.1:18501/v1/parse/jobs/实际任务ID
curl -fsS http://127.0.0.1:18501/v1/parse/jobs/实际任务ID/result -o result.json
```

取消这份测试任务可使用 `curl -X DELETE` 请求相同的任务状态地址。不要对正在保留的正式任务运行取消测试。

### 4. 配置插件与理解进度

Zotero 设置 → OCRFlow → 提取服务 → Marker，填写 API **根地址** `http://服务器地址:18501`，不追加 `/marker/upload` 或 `/v1/parse/jobs`。按需选择 Balanced / Fast 和强制 OCR，测试连接后保存。强制 OCR 表示即使有文字层也重新识别。

- `queued`：服务端排队，尚未开始当前文件；不显示 0/N 页作为识别进度。
- `loading` / `layout` / `text`：加载模型、分析版面、读取文字层。这些阶段可能尚未产生已完成 OCR 页数。
- `ocr`：`progress.completed/total` 表示已返回的页响应及已读取文字层的页数。
- `structure` / `rendering` / `saving`：整理全文结构并生成结果。页数达到 N/N 不表示整个任务已经结束。
- `completed`：完整结果可下载；只有此状态才视为整份识别完成。

Marker 不再由插件逐页上传。响应可乱序，轮询也可能跳过中间数字；插件不使用计时器模拟百分比。结果保留物理页来源；接口没有提供的布局坐标不会被补造。

从 1.3.4 起，状态查询和下载短暂断网、或遇到 502/503/504 时，插件按 2、4、8 秒间隔重连三次，继续使用原任务 ID。持续中断可点“继续等待”；上传本身不自动重试，避免重复提交。

### 5. 取消、恢复与排错

异步任务独立于上传连接，需调用 DELETE 显式取消。同步入口从 1.3.3 服务端修复起会检测连接断开，并取消对应任务。取消只停止这一任务的转换进程及后续页面请求；已经送入共享模型的单次推理可能短暂继续，不关闭整个模型服务。

| 现象 | 检查与处理 |
| --- | --- |
| GPU 有请求，当前文件仍排队 | 前面可能有另一份文档；对照任务 ID 查看状态，不能用模型吞吐日志代替本文件进度 |
| 连接中断 | 先查询原任务；在原会话中继续等待，不必重复上传 |
| 取消未确认 | 检查网络与任务 ID，重试终止；未收到服务端确认不等于已停止后台任务 |
| 重启后运行任务变为 failed | 原转换进程已被中断，需要重新处理；排队任务和已完成结果保留 |
| 相同文档有多个任务 | 取消按任务 ID 生效，核对后分别处理遗留任务，不会连带取消其他提交 |

本地验证接口与取消逻辑：

```sh
python3 -m pip install -r server/requirements-test.txt
cd server
python3 -m unittest -v test_marker_jobs
```

部署代码在 Marker 2.0.0 / Surya 2 环境经过真实扫描 PDF、页响应进度、结果保存、取消及 HTTP 断开清理验证。模型许可与来源见 [第三方说明](../THIRD_PARTY.md)。

## MinerU：4.0.10 页进度补丁


OCRFlow 已支持本地 MinerU 的异步任务、页数进度查询和取消任务。要显示“已处理 / 总页数 / 剩余页数”，服务端也需要安装页进度补丁；只升级插件不会为服务端增加这些字段。

以下补丁**仅对应 MinerU 4.0.10**，来源为本项目此前使用的页进度实现，不是要求始终使用的最新 MinerU 版本。其他版本需先适配，不能直接套用。Docker 示例沿用 NVIDIA GPU / vLLM 配置，要求宿主机已具备相应驱动及 Docker GPU 支持，不适用于直接在 macOS 上运行此 GPU 镜像。

### 1. 准备部署文件

从本仓库下载源码或源码压缩包，取出 [docs/mineru](mineru/) 中的以下文件，放进服务器上的同一个部署目录：

- [Dockerfile](mineru/Dockerfile)：安装固定版本并在构建时应用补丁。
- [docker-compose.yml](mineru/docker-compose.yml)：GPU 0、并发 1、宿主机端口 `41835`、处理窗口 8 页的示例。
- [mineru-4.0.10-page-progress.patch](mineru/mineru-4.0.10-page-progress.patch)：页进度补丁。

已有部署应先保存原来的 Dockerfile、Compose 文件及镜像标签，并保留自己的模型目录挂载、GPU、端口等配置。示例使用 CUDA 13.0 基础镜像；若原部署使用其他 CUDA 变体，请继续使用与原驱动匹配的配置。

### 2. 构建并启动

进入上述部署目录。以下命令中的 Compose 服务名为 `mineru-api`，修改过服务名时需相应替换：

```sh
docker compose -f docker-compose.yml config --quiet
docker compose -f docker-compose.yml build mineru-api
```

构建成功且当前解析任务已结束后，再启动或更新服务：

```sh
docker compose -f docker-compose.yml up -d --no-deps mineru-api
docker compose -f docker-compose.yml ps mineru-api
docker compose -f docker-compose.yml logs --tail=100 mineru-api
```

镜像会下载模型、应用补丁并检查相关 Python 文件的语法。示例镜像名为 `mineru-gpu:4.0.10-progress`。更新运行中的容器会中断当前任务，内存中的任务记录也会丢失；无需先删除容器。参见 [Docker Compose up 文档](https://docs.docker.com/reference/cli/docker/compose/up/)。

### 3. 验证补丁已加载

在服务器上执行：

```sh
curl -fsS http://127.0.0.1:41835/v1/health

docker compose -f docker-compose.yml exec -T mineru-api python3 - <<'PYTHON'
import json
import os
import urllib.request
from importlib.metadata import version

assert version("mineru") == "4.0.10"
with urllib.request.urlopen("http://127.0.0.1:8000/openapi.json", timeout=10) as response:
    schema = json.load(response)
assert "page_progress" in schema["components"]["schemas"]["JobFileResult"]["properties"]
print("MinerU 版本:", version("mineru"))
print("处理窗口:", os.environ.get("MINERU_PROCESSING_WINDOW_SIZE"))
print("page_progress 已加入 API")
PYTHON
```

这一步确认服务版本与接口字段；真实进度还需提交文档验证。

### 4. 配置 OCRFlow 并查看进度

在 Zotero 设置 → OCRFlow → MinerU 中选择：

| 设置 | 填写方式 |
| --- | --- |
| 接口类型 | 本地 MinerU 4（V1） |
| API 地址 | `http://服务器地址:41835`，只填根地址，不追加 `/v1`；同机部署可用 `http://127.0.0.1:41835` |
| Token | 按实际服务要求填写；本示例未配置鉴权，可留空 |
| 本地解析档位 | 按服务支持选择，例如 Standard |
| 轮询间隔 | 5–10 秒 |
| 本地任务总等待上限 | 长文档可设为 `0`，持续等待到完成或服务端报错 |

保存设置，提交一份超过 8 页的 PDF。队列应显示页数和阶段；也可在设置的“任务队列”中查询最近任务或指定任务 ID。手动查询服务端时，将下面的 `job_实际任务ID` 替换为队列中的值：

```sh
curl -fsS 'http://127.0.0.1:41835/v1/parse/jobs/job_实际任务ID'
```

返回值的 `files` 数组中，每个 PDF 文件会包含：

```json
"page_progress": {
  "completed": 8,
  "total": 24,
  "remaining": 16,
  "stage": "processing"
}
```

阶段依次为准备输入 `preparing`、页面处理 `processing`、结构整理 `postprocessing`、结果导出 `exporting`、完成 `completed`；失败时为 `failed`。页数达到 100% 后仍可能整理、导出结果，OCRFlow 会等待整个任务完成后下载结果。

页数在**整个处理窗口完成后**更新。例如窗口为 8 时，完成页数可能是 `0 → 8 → 16 → 24`；模型初始化或窗口尚未完成时暂时不变属于正常现象。可修改 Compose 中的 `MINERU_PROCESSING_WINDOW_SIZE`，再运行上面的 `up -d --no-deps` 更新容器；只修改此运行时变量不需要重新构建镜像。

### 已有 Git 源码的部署方式

先保存本地改动；若已应用其他版本补丁，先按原补丁说明撤回，再切换到 [MinerU 4.0.10 标签](https://github.com/opendatalab/MinerU/tree/mineru-4.0.10-released)。将本仓库的补丁文件放到 MinerU 源码根目录，再执行：

```sh
git fetch origin --tags
git switch --detach mineru-4.0.10-released
git apply --check mineru-4.0.10-page-progress.patch
git apply mineru-4.0.10-page-progress.patch
```

Docker 构建上下文应为这份 MinerU 源码目录。使用 [Dockerfile.source](mineru/Dockerfile.source) 替换部署 Dockerfile，按原配置构建、重启并验证；它直接安装已打补丁的源码，不会再次应用补丁。若原 Dockerfile 仍从 PyPI 安装未修改的包，源码中的补丁不会生效。

### 回退与验证范围

更新前保留原配置和原镜像标签，回退时恢复原配置所引用的镜像并重新运行 Compose。不要清理原模型或数据卷。

本仓库的补丁及 GPU 示例来自此前的 4.0.10 适配；本次已核对客户端字段、部署文件和打包范围，未在 GPU 服务器上重新构建或执行真实推理。补丁相关的 MinerU 上游许可保留在 [docs/mineru/LICENSE.md](mineru/LICENSE.md)。这些部署文件只进入源码包，不进入 Zotero 的 XPI 安装包。

