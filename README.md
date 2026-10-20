# OCRFlow

<img src="icon96.png" width="64" alt="OCRFlow 图标" />

Zotero 10 文档工作流插件：按需建立父条目、提取全文、补充书目信息、生成学术总结和翻译文档。导入文件后，插件默认不自动识别；所有操作从右键 **OCRFlow** 菜单启动。

支持 Zotero **10.0.***，已在 macOS / Zotero 10.0.6 中进行原生验证。

**注意**：本插件借助LLM开发，可能存在错误。

## 功能

| 操作 | 用途 |
| --- | --- |
| 建立父条目 | 仅根据文件名创建初步条目，并挂载原文件 |
| 建立文本 OCR / 转为 Markdown | 从右键菜单选择 MinerU 本地、MinerU 云端、MarkItDown 或 AI 视觉 OCR |
| 补充父条目信息 | 从 Markdown 提取书目字段；非中文题名译为中文并写入 `shortTitle` |
| 总结文档 | 根据全文生成学术总结，保存为条目笔记 |
| 翻译文档 | 分段翻译 Markdown，可保存 Markdown、HTML 或原文译文双栏 HTML |
| 生成阅读器大纲 | 根据 PDF / 已解析全文生成可导航的大纲 |

- 最多保存 5 个服务商配置，每个配置最多两个模型。
- 六项 AI 工作分别选择模型，单独设置提示词和请求参数；内置提示词可查看、编辑和恢复。
- 每个模型独立设置并发、上下文和最大输出长度；直接填写 `128K`、`1M`、`1.5M`，默认 `32K`。
- 每个模型单独测试连接；测试读取当前填写内容，不自动保存。
- OCR、书目、总结、翻译和大纲进入任务队列，支持进度、重试、终止与文字复制。

## 安装

1. 在 [最新 Release](https://github.com/EEEEgoose/ocrflow/releases/latest) 下载 `.xpi` 安装包；也可从源码构建。
2. 在 Zotero 的“工具 → 插件”中选择“从文件安装插件”。
3. 完整退出并重启 Zotero，在设置中打开 **OCRFlow**，填写所需服务。
4. 选中文件或父条目，通过右键 **OCRFlow** 菜单执行操作。

从旧版 DocFlow / OCRFlow 可覆盖安装。旧的 Auto parent item、MinerU for Zotero 如仍在使用，应停用其自动处理功能，避免重复处理。

安装新版后，Zotero 通过最新 Release 中的 `updates.json` 检查更新并下载对应 XPI。使用旧占位更新地址的版本需要先手动覆盖安装一次。

推送到 `main` 后，GitHub Actions 自动测试、构建并发布 Release。发布版本为基础版本加工作流运行序号（例如 `0.2.17.12`），无需为每次推送手动修改版本号。

## 快速开始

```text
导入文件 → 建立父条目 → 建立文本 OCR / 转为 Markdown
                              ↓
                    补充信息 / 总结 / 翻译
```

可以先提取全文再建立父条目。PDF、扫描件和图片可按需生成 HTML；Markdown 始终保留。EPUB 等文档转为 Markdown。

完整说明见 [中文使用手册](README.zh-CN.md)。

## 本地 MinerU 页进度补丁部署

OCRFlow 已支持本地 MinerU 的异步任务、页数进度查询和取消任务。要显示“已处理 / 总页数 / 剩余页数”，服务端也需要安装页进度补丁；只升级插件不会为服务端增加这些字段。

以下补丁**仅对应 MinerU 4.0.10**，来源为本项目此前使用的页进度实现，不是要求始终使用的最新 MinerU 版本。其他版本需先适配，不能直接套用。Docker 示例沿用 NVIDIA GPU / vLLM 配置，要求宿主机已具备相应驱动及 Docker GPU 支持，不适用于直接在 macOS 上运行此 GPU 镜像。

### 1. 准备部署文件

从本仓库下载源码或源码压缩包，取出 [docs/mineru](docs/mineru/) 中的以下文件，放进服务器上的同一个部署目录：

- [Dockerfile](docs/mineru/Dockerfile)：安装固定版本并在构建时应用补丁。
- [docker-compose.yml](docs/mineru/docker-compose.yml)：GPU 0、并发 1、宿主机端口 `41835`、处理窗口 8 页的示例。
- [mineru-4.0.10-page-progress.patch](docs/mineru/mineru-4.0.10-page-progress.patch)：页进度补丁。

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

保存设置，提交一份超过 8 页的 PDF。队列应显示页数和阶段；也可在“任务队列与本地进度”中查询最近任务或指定任务 ID。手动查询服务端时，将下面的 `job_实际任务ID` 替换为队列中的值：

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

Docker 构建上下文应为这份 MinerU 源码目录。使用 [Dockerfile.source](docs/mineru/Dockerfile.source) 替换部署 Dockerfile，按原配置构建、重启并验证；它直接安装已打补丁的源码，不会再次应用补丁。若原 Dockerfile 仍从 PyPI 安装未修改的包，源码中的补丁不会生效。

### 回退与验证范围

更新前保留原配置和原镜像标签，回退时恢复原配置所引用的镜像并重新运行 Compose。不要清理原模型或数据卷。

本仓库的补丁及 GPU 示例来自此前的 4.0.10 适配；本次已核对客户端字段、部署文件和打包范围，未在 GPU 服务器上重新构建或执行真实推理。补丁相关的 MinerU 上游许可保留在 [docs/mineru/LICENSE.md](docs/mineru/LICENSE.md)。这些部署文件只进入源码包，不进入 Zotero 的 XPI 安装包。

## 从源码构建

需要 Node.js 24 或更新版本及 Python 3.12 或更新版本；不需要安装 npm 或 Python 第三方依赖。

在仓库根目录运行：

```sh
node --test tests/*.test.cjs
python3 build.py
```

生成文件位于 `dist/`：

```text
dist/ocrflow-0.2.17.xpi
dist/ocrflow-0.2.17-source.zip
dist/updates.json
```

`dist/` 不提交到 Git。开发结构、发布步骤及 GitHub 上传说明见 [开发指南](docs/DEVELOPMENT.md)。

## 文档

- [中文使用手册](README.zh-CN.md)：服务配置、工作流程、输出与排错。
- [更新记录](CHANGELOG.md)：版本变化。
- [开发指南](docs/DEVELOPMENT.md)：模块职责、构建、测试与发布。
- [验证说明](VALIDATION.md)：自动化测试与原生验证范围。
- [来源和第三方组件](THIRD_PARTY.md)：继承代码、依赖版本与许可证。本插件借鉴了多个现有插件的思路，再次向其表示感谢。

## 数据与许可证

按操作将文件名、文档文本、原始文件或页面图片发送给用户选定的服务。API Key 保存在本机 Zotero 首选项中，不随源码分发。提交问题时请移除 Key、个人文档和本机路径。

保留现有 [MIT 许可证](LICENSE)及第三方组件的署名与许可。来源记录见 [THIRD_PARTY.md](THIRD_PARTY.md)。
