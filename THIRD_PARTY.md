# 来源与第三方组件

OCRFlow 前身为 DocFlow。现有 MIT 许可证及继承代码的版权声明保留在 [LICENSE](LICENSE)，本文件记录代码与组件来源。

## 基础插件与历史源码

| 来源 | 使用范围 | 许可记录 |
| --- | --- | --- |
| [MinerU for Zotero / lisontowind/zotero-mineru](https://github.com/lisontowind/zotero-mineru)，基于 0.1.70.21 | 插件生命周期、MinerU 服务、输出与队列等基础实现 | MIT；版权声明见根目录 LICENSE |
| Auto parent item 0.8.5，由维护者提供的历史项目源码 | 书目提取提示词、字段映射、语言别名等 | 所提供源码未附独立许可证文件；保留此来源事实，不推定另有第三方授权声明 |
| [Paper Outline](https://github.com/DrinkTea905/zotero-paper-outline) | 阅读器大纲查找和交互的适配 | MIT；完整许可见 vendor/paper-outline/LICENSE |

内部 `DocFlow` 名称和旧标签继续保留以兼容已有安装与数据。

## 随包组件

| 组件 | 版本 | 用途 | 许可证 |
| --- | --- | --- | --- |
| [KaTeX](https://github.com/KaTeX/KaTeX) | 0.16.22 | 导出时的离线公式与 MathML 渲染 | [MIT](vendor/katex/LICENSE) |
| [pdf-lib](https://github.com/Hopding/pdf-lib) | 1.17.1 | PDF 计页、复制页面和分段上传 | [MIT](vendor/pdf-lib/LICENSE.md) |
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
