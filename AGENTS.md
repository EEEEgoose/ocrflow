# AGENTS.md

本文件面向在本仓库中工作的 AI 编码代理。更完整的开发与发布说明见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)，验证方法见 [VALIDATION.md](VALIDATION.md)。

## 项目概况

OCRFlow 是一个 Zotero 插件，提供 OCR 识别（MinerU、PaddleOCR、Marker／Datalab、MarkItDown）、AI 总结与逐段翻译、书目提取、大纲和标题翻译等功能。插件运行在 Zotero 中，不在 Node.js 中运行；Node.js 只用于测试。`server/` 是运行在 Marker 服务端的独立 Python 任务服务。

## 环境与命令

- Node.js 24 及以上，Python 3.12 及以上。不需要安装 npm 或 pip 依赖，测试和构建只用标准库和 `vendor/` 中的文件。不要引入 `package.json`、`node_modules` 或新的第三方依赖。
- 所有命令都在仓库根目录执行：

```sh
node --test tests/*.test.cjs                   # 全部插件测试
node --test tests/ocr-v1.test.cjs              # 单个测试文件
node --test --test-name-pattern="关键词" tests/ocr-v1.test.cjs
python3 build.py                               # 构建到 dist/
```

- 服务端测试：先安装 `server/requirements-test.txt`，然后在 `server/` 目录运行 `python3 -m unittest -v test_marker_jobs`。

提交任何改动前都要跑通全部插件测试。

## 代码结构与约定

- **模块形式**：`docflow.js` 定义全局对象 `DocFlow`，其他运行模块用 `Object.assign(DocFlow, { ... })` 往上挂方法。模块之间通过 `this.xxx` 互相调用，加载顺序见 [bootstrap.js](bootstrap.js)。`document.js` 等少数模块定义独立的全局对象（如 `OCRFlowDocument`）。
- **新增运行文件**时，要同时加到 `bootstrap.js` 的加载列表和 [build.py](build.py) 的 `assets` 列表里，否则安装包里没有这个文件。
- **代码风格**：JS 用 Tab 缩进，沿用所在文件已有的写法，包括较紧凑的单行写法。不要顺手重排格式或重构无关代码。
- **兼容标识不能改**：`DocFlow`、`chrome://docflow/`、`extensions.docflow.`、`docflow@egooose.local` 和已有标签名用于保持安装和数据兼容。
- **配置**：运行代码通过 `DocFlow.getPref/setPref` 读写配置，配置值加密保存，不要把密钥写进明文首选项或测试。默认首选项在 `prefs.js`，密钥默认留空。
- 各文件的职责见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) 的"代码结构"一节。

## 界面文字与本地化

- 源码里的界面文字和报错信息用中文写。英文翻译放在 [locale/en-US/ui.js](locale/en-US/ui.js) 的 `OCRFlowEnglish` 中，键是中文原文。
- 含动态内容的文字用 `{0}`、`{1}` 占位，例如 `"服务暂时不可用，{0} 秒后重试；可终止任务。"`。本地化层在显示时会按模式自动匹配，代码里直接拼接中文即可，不必为每处都调用 `ocrflowText`。
- `tests/localization.test.cjs` 会检查：英文译文里不能有中文字符，占位符要和原文一致，三个 `.xhtml` 文件里的中文静态文字都要有英文翻译。新增或修改界面文字时，要同步更新英文翻译表。
- 运行模块开头的 `var ocrflowText = typeof ocrflowText === "function" ? ocrflowText : ...` 是测试环境下的兜底，保持原样。

## 测试约定

- 测试文件是 `tests/*.test.cjs`，用 `node:test` 和 `node:vm` 把运行模块加载进沙箱。Zotero、`IOUtils`、`PathUtils`、`fetch` 都用内存中的替身代替，参考 `tests/ocr-v1.test.cjs` 里的 `setup()`。
- 测试里不能发真实网络请求，`tests/ocr-v1.test.cjs` 的 `setup()` 中 `fetch` 默认会直接报错。要模拟服务响应时，替换 `s.context.fetch` 或 `s.m.requestDocumentAI`。
- 沙箱中返回的数组和测试所在环境的数组原型不同，用 `assert.deepEqual` 比较前先 `Array.from(...)`。
- 测试数据只用最小的合成样例，不要放入真实文库、账号、地址或 Key。需要保留输入特征时（阿拉伯文、日文、长文件名等），用合成文本构造。
- 修 bug 时先写一个能复现问题的测试，再改代码让它通过。

## 改动与发布

- 推送到 `main` 会触发 CI 自动构建并发布 Release。除非用户明确要求，不要提交或推送；需要提交时先开分支。
- 用户可见的改动要记到 [CHANGELOG.md](CHANGELOG.md) 当前版本下的 `### 新增功能` 或 `### 修复问题`。发布工具按这两个分类提取说明，缺少分类会导致发布中止。
- 不要提交 `dist/`、`outputs/`、`*.xpi`、`*.zip`、`.env` 等本地生成物（已在 `.gitignore` 中排除）。
- 第三方库更新时，同步核对版本、许可证和 [THIRD_PARTY.md](THIRD_PARTY.md)。
- 涉及较多改动的工作，可在 [docs/CHECKPOINT.zh-CN.md](docs/CHECKPOINT.zh-CN.md) 记录修改清单、行为变化、已知限制和新增测试，方便后续接手。
