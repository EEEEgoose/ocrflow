# 来源与第三方组件

OCRFlow 由作者在自有项目 Auto parent item 的基础上开发，曾使用 DocFlow 名称。现有 MIT 许可证及继承代码的版权声明保留在 [LICENSE](LICENSE)，本文件记录作者自有代码与第三方组件的来源。

## 基础插件与历史源码

| 来源 | 使用范围 | 许可记录 |
| --- | --- | --- |
| [MinerU for Zotero / lisontowind/zotero-mineru](https://github.com/lisontowind/zotero-mineru)，基于 0.1.70.21 | 插件生命周期、MinerU 服务、输出与队列等基础实现 | MIT；版权声明见根目录 LICENSE |
| Auto parent item 0.8.5，作者自有项目 | 书目提取提示词、字段映射、语言别名等 | 作者自有代码，作为 OCRFlow 的基础继续开发并按本项目 MIT 许可证发布 |
| [Paper Outline](https://github.com/DrinkTea905/zotero-paper-outline) | 阅读器大纲查找和交互的适配 | MIT；完整许可见 vendor/paper-outline/LICENSE |

内部 `DocFlow` 名称和旧标签继续保留以兼容已有安装与数据。

## 随包组件

| 组件 | 版本 | 用途 | 许可证 |
| --- | --- | --- | --- |
| [KaTeX](https://github.com/KaTeX/KaTeX) | 0.16.22 | 导出时的离线公式与 MathML 渲染 | [MIT](vendor/katex/LICENSE) |
| [pdf-lib](https://github.com/Hopding/pdf-lib) | 1.17.1 | PDF 计页、复制页面和分段上传；Marker 使用整文件上传，不由插件拆页 | [MIT](vendor/pdf-lib/LICENSE.md) |
| Paper Outline 适配记录 | 继承版本未单独标注 | 阅读器大纲适配来源记录 | [MIT](vendor/paper-outline/LICENSE) |

随包文件及说明位于 `vendor/`。构建不联网下载或更新这些组件；更新时同步维护版本和许可证。

## 接口与实现参考

以下项目用于实现或接口核对，未作为完整库随包分发：

- [PDF.js 示例](https://mozilla.github.io/pdf.js/examples/index.html)：使用 Zotero 自带的阅读器实现页面渲染。
- [MarkItDown](https://github.com/microsoft/markitdown)：外部转换服务的接口与格式参考。
- [MinerU 云端 API](https://mineru.net/doc/docs/index_en/)：官方云端服务接口。
- [OpenRouter 推理返回格式](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)。
- [SiliconFlow 推理返回格式](https://docs.siliconflow.cn/docs/userguide/capabilities/reasoning)。
- Zotero 10 阅读器、设置页和附件接口，以安装应用源码及原生验证为依据。

## 可选的 MinerU 服务端补丁

`docs/mineru/` 保存 MinerU 4.0.10 页进度补丁及 Docker 部署示例，修改作者为 Egooose。补丁涉及的上游代码保留 [MinerU 许可](docs/mineru/LICENSE.md)。这些文件仅随源码分发，不包含在 Zotero XPI 中；插件其余组件的许可记录见上文。

## 1.0 结构与校勘设计参考

- [PaddleOCR 官方 API](https://www.paddleocr.ai/latest/en/version3.x/inference_deployment/serving/paddleocr_official_api/cli.html) 与 [PaddleOCR-VL 服务接口](https://github.com/PaddlePaddle/PaddleOCR/blob/main/docs/version3.x/pipeline_usage/PaddleOCR-VL.en.md)：官方异步任务及自部署文档解析协议，未随包分发模型或 SDK。
- [md1012](https://github.com/1012-web/md1012)、[Docling](https://github.com/docling-project/docling)、[PDF Craft](https://github.com/oomol-lab/pdf-craft)、[Marker](https://github.com/datalab-to/marker)：结构保留、脚注图注恢复、来源映射与翻译单元的设计参考，未随包分发这些库。
- [BabelDOC](https://github.com/funstory-ai/BabelDOC)：段落翻译与公式占位的设计参考，未复制或分发其 AGPL 代码。

## Marker 任务服务与外部运行环境

`server/marker_jobs.py`、`server/marker_progress.py` 是 OCRFlow 的服务端任务包装与进度观察实现，按本项目 MIT 许可证提供，只进入源码包，不进入 Zotero XPI。它们调用外部安装的 Marker / Surya，不包含其完整库、容器镜像或模型权重。

| 外部组件 | 本项目实际使用方式 | 上游来源与许可 |
| --- | --- | --- |
| Marker 2.0.0 | 外部 `PdfConverter`、正文 / 结构处理与 Markdown 输出，整份 PDF 一次转换 | [2.0.0 源码](https://github.com/datalab-to/marker/tree/v2.0.0)、[Apache-2.0 代码许可](https://github.com/datalab-to/marker/blob/v2.0.0/LICENSE) |
| Surya 2 | 外部页面识别与模型推理，任务包装观察实际页响应 | [源码与说明](https://github.com/datalab-to/surya)、[代码许可](https://github.com/datalab-to/surya/blob/master/LICENSE)；具体版本以服务端安装为准 |
| Marker / Surya 模型权重 | 由部署者另行获取，不随插件或源码包分发 | [Marker 2.0.0 模型使用说明](https://github.com/datalab-to/marker/tree/v2.0.0#commercial-usage)；模型权重许可独立于代码许可 |
| FastAPI / uvicorn / python-multipart | Marker 环境中的外部 HTTP 运行依赖 | [FastAPI](https://github.com/fastapi/fastapi)、[uvicorn](https://github.com/encode/uvicorn)、[python-multipart](https://github.com/Kludex/python-multipart)；不打包进 XPI |
| httpx | 仅服务端接口测试使用 | [httpx](https://github.com/encode/httpx)；固定测试依赖见 `server/requirements-test.txt` |

Marker 2.0.0 的上游区分 Apache-2.0 代码许可与独立的模型权重条款；不应将代码许可视为模型许可。本文件记录调用与分发边界，实际部署须以所安装版本附带的许可和模型声明为准。

MinerU 补丁与 Marker 任务接口的安装、验证和取消说明统一见 [本地页进度部署指南](docs/OCR-PROGRESS-DEPLOYMENT.zh-CN.md)。外部 API 服务及模型均不因为出现在配置列表中而成为随包组件。
