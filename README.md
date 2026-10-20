# OCRFlow

<img src="icon96.png" width="64" alt="OCRFlow 图标" />

Zotero 10 文档工作流插件：按需建立父条目、提取全文、补充书目信息、生成学术总结和翻译文档。导入文件后，插件默认不自动识别；所有操作从右键 **OCRFlow** 菜单启动。

当前版本：**0.2.17**。支持 Zotero **10.0.***，已在 macOS / Zotero 10.0.6 中进行原生验证。

## 功能

| 操作 | 用途 |
| --- | --- |
| 建立父条目 | 仅根据文件名创建初步条目，并挂载原文件 |
| 建立文本 OCR / 转为 Markdown | 从右键菜单选择 MinerU 本地、MinerU 云端、MarkItDown 或 AI 视觉 OCR |
| 补充父条目信息 | 从 Markdown 提取书目字段；非中文题名译为中文并写入 `shortTitle` |
| 总结文档 | 根据全文生成学术总结，保存为条目笔记 |
| 翻译文档 | 分段翻译 Markdown，可保存 Markdown、HTML 或原文译文双栏 HTML |
| 生成阅读器大纲 | 根据 PDF / 已解析全文生成可导航的大纲 |
| 全文转为笔记 | 将已有全文保存为 Zotero 笔记 |

- 最多保存 5 个服务商配置，每个配置最多两个模型。
- 五项主要工作分别选择模型，单独设置 Prompt 和请求参数。
- 每个模型独立设置并发与上下文；直接填写 `128K`、`1M`、`1.5M`，默认 `32K`。
- 每个模型单独测试连接；测试读取当前填写内容，不自动保存。
- OCR、书目、总结、翻译和大纲进入任务队列，支持进度、重试、终止与文字复制。

## 安装

1. 在本仓库的 Releases 页面下载 `ocrflow-0.2.17.xpi`；也可从源码构建。
2. 在 Zotero 的“工具 → 插件”中选择“从文件安装插件”。
3. 完整退出并重启 Zotero，在设置中打开 **OCRFlow**，填写所需服务。
4. 选中文件或父条目，通过右键 **OCRFlow** 菜单执行操作。

从旧版 DocFlow / OCRFlow 可覆盖安装。旧的 Auto parent item、MinerU for Zotero 如仍在使用，应停用其自动处理功能，避免重复处理。

当前通过手动安装更新；安装声明中保留了 Zotero 所需的占位更新地址。

## 快速开始

```text
导入文件 → 建立父条目 → 建立文本 OCR / 转为 Markdown
                              ↓
                    补充信息 / 总结 / 翻译
```

可以先提取全文再建立父条目。PDF、扫描件和图片可按需生成 HTML；Markdown 始终保留。EPUB 等文档转为 Markdown。

完整说明见 [中文使用手册](README.zh-CN.md)。

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
```

`dist/` 不提交到 Git。开发结构、发布步骤及 GitHub 上传说明见 [开发指南](docs/DEVELOPMENT.md)。

## 文档

- [中文使用手册](README.zh-CN.md)：服务配置、工作流程、输出与排错。
- [更新记录](CHANGELOG.md)：版本变化。
- [开发指南](docs/DEVELOPMENT.md)：模块职责、构建、测试与发布。
- [验证说明](VALIDATION.md)：自动化测试与原生验证范围。
- [来源和第三方组件](THIRD_PARTY.md)：继承代码、依赖版本与许可证。

## 数据与许可证

按操作将文件名、文档文本、原始文件或页面图片发送给用户选定的服务。API Key 保存在本机 Zotero 首选项中，不随源码分发。提交问题时请移除 Key、个人文档和本机路径。

保留现有 [MIT 许可证](LICENSE)及第三方组件的署名与许可。来源记录见 [THIRD_PARTY.md](THIRD_PARTY.md)。
