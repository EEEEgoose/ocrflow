# Marker 整文件任务 API

从 1.2.14 起，OCRFlow 取消客户端逐页拆分。整份 PDF 上传一次，服务端创建任务，使用官方 Marker `PdfConverter` 对整份文件完成版面、正文、跨页结构和输出处理。通过 `job_id` 轮询进度，最后下载完整 Markdown、图片和 metadata。

## 接口

| 请求 | 用途 |
| --- | --- |
| `POST /v1/parse/jobs` | multipart 上传完整 PDF，返回 202 和任务 ID |
| `GET /v1/parse/jobs/{job_id}` | 查询排队、运行、完成、失败或取消状态 |
| `GET /v1/parse/jobs/{job_id}/result` | 完成后下载完整结果；未完成返回 409 |
| `DELETE /v1/parse/jobs/{job_id}` | 取消排队任务或终止对应转换工作进程 |
| `POST /marker/upload` | 同步上传，内部使用同一队列；连接断开时取消对应任务 |

创建任务接受 `file`、`mode`、`force_ocr`、`output_format`、`paginate_output`；插件请求 Markdown 和分页输出。任务目录保存原 PDF、请求选项、状态和结果。结果结构沿用官方 API 的 `success`、`format`、`output`、`images` 和 `metadata`。

`progress.completed/total` 在正文识别阶段表示已返回的页响应数及已读取文字层的页数。它来自 Surya 实际响应，不是计时估算；结构整理与渲染仍可能继续。只有 `status=completed` 才能获取完整结果。并发识别和轮询可能一次跳过多个页数，不保证每个整数均在界面停留。

取消终止该任务的本地工作进程及其子进程，停止后续页面请求；已经发送到共享 Surya / vLLM 的单次推理可能完成。共享推理服务不会被重启或终止。等待超时保留任务 ID，继续等待时不重复上传。任务状态和结果保存在磁盘；服务重启后保留已完成结果、恢复排队任务，并明确标记被中断的运行任务。

从 1.3.3 服务端修复起，同步 `/marker/upload` 会检测连接断开并取消它创建的任务，处理协程被取消时也会清理。异步任务独立于上传连接，仍需调用 DELETE 显式取消。两种请求不会因其他文档连接断开而被连带取消。

1.3.4 插件在状态查询或结果下载短暂断网、遇到 502/503/504 时，按 2、4、8 秒间隔尝试重连三次，继续使用同一任务 ID。持续中断时保留任务供“继续等待”，不会自动重新上传文档。上传本身不自动重试，避免服务端已收文件但客户端未收到响应时重复建任务。

## 部署

服务端代码位于 `server/marker_jobs.py` 与 `server/marker_progress.py`，面向当前 Marker 2.0.0 / Surya 2 的内部接口。依赖既有 Marker 环境中的 FastAPI、uvicorn、python-multipart；测试还使用 httpx。

将 `server/` 放入容器可见路径，例如 `/data/ocrflow-api`，使用原 Marker 镜像、模型缓存和 Surya 环境变量，运行：

```sh
python3 -m uvicorn marker_jobs:app --app-dir /data/ocrflow-api --host 0.0.0.0 --port 8001
```

默认任务目录为 `/data/jobs`，可通过 `MARKER_JOBS_DIR` 指定持久化目录。运行一个 API 进程，由内置队列一次调度一个文档任务；每个任务保留 Marker 原有的文档级结构处理，页面推理按既有并发设置执行。不要增加 uvicorn workers 数量，否则会各自调度同一任务目录。

服务端测试：

```sh
cd /data/ocrflow-api
python3 -m unittest -v test_marker_jobs
```

## 本次 Unraid 部署（2026-10-22）

沿用 Compose Manager Plus 的 Marker 项目及原端口。`marker` 容器运行任务 API；`marker-surya`、GPU、模型缓存及数据挂载保持原有配置。任务代码放在 `/mnt/user/appdata/marker/data/ocrflow-api/`，状态与结果放在 `/mnt/user/appdata/marker/data/jobs/`。

- OCRFlow 服务地址：`http://10.0.0.10:18501`
- API 文档：`http://10.0.0.10:18501/docs`
- Compose 配置：`/mnt/user/appdata/marker/docker-compose.yml`
- 切换前备份：`/mnt/user/appdata/marker/backups/docker-compose.before-marker-jobs-20261022.yml`

插件连接测试检查任务创建接口；仅有 Streamlit 网页或同步官方接口的服务会明确提示更新服务端。已通过真实扫描 PDF 上传、异步进度、整份结果保存、免重传恢复和服务端取消验证。

API 的 Markdown 响应不包含完整布局坐标，插件不会虚构坐标；原始 metadata 继续保存。接口和转换流程参考：[Marker 官方服务源码](https://github.com/datalab-to/marker/blob/master/marker/scripts/server.py)、[官方转换器](https://github.com/datalab-to/marker/blob/master/marker/converters/pdf.py)。
