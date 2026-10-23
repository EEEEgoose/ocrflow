# 开发与发布

[项目首页](../README.md) · [验证说明](../VALIDATION.md)

## 环境

使用 Node.js 24 或更新版本、Python 3.12 或更新版本。测试和构建使用标准库以及仓库内的 vendor 文件，无需安装 npm / pip 依赖。实际插件运行于 Zotero，不在 Node.js 中运行。

Marker 任务服务位于 `server/`，运行在已安装 Marker 的服务端。服务端独立测试可在 Python 3.12 环境先安装 `server/requirements-test.txt`，然后在 `server/` 目录运行 `python3 -m unittest -v test_marker_jobs`；测试不加载模型或调用 GPU。CI 同时执行插件与服务端测试。

在仓库根目录执行：

```sh
node --test tests/*.test.cjs
python3 build.py
```

macOS / Linux 也可使用 `bash build-xpi.sh`。两种构建入口都支持指定输出目录：

```sh
python3 build.py --output-dir ./dist
```

相对输出路径相对于运行命令时的目录解析，默认始终是项目根目录的 `dist/`。

## 代码结构

| 文件或目录 | 职责 |
| --- | --- |
| `title-translation.js` / `translation-services.js` | 标题翻译收集与写入、DeepL / DeepLX 接口与设置选项；使用现有加密配置与任务队列 |
| `localization.js` / `locale/en-US/ui.js` | 跟随 Zotero 的界面语言；翻译静态界面与动态状态，文献内容和配置值保持原样 |
| `manifest.json` | 插件名称、版本、图标、Zotero 兼容范围和稳定 ID |
| `bootstrap.js` | 插件启动、模块加载、设置页及菜单注册、关闭清理 |
| `task-sidebar.js` / `task-sidebar.css` | 主窗口任务面板、执行步骤、真实进度、文档选择跟随与侧栏清理 |
| `docflow.js` | MinerU、任务队列、模型配置读取、保存、翻译和输出渲染 |
| `config.js` / `config-preferences.js` | 加密配置仓库、导入导出、Zotero 同步附件与设置页入口 |
| `datalab.js` | 在线 Convert API、轮询、签名结果下载与停止等待 |
| `workflow.js` | 手动工作流、AI 请求、上下文预算、分段和服务选择 |
| `prompts.js` | 工作默认提示词、书目字段格式，供运行代码和设置页共同读取 |
| `metadata.js` | 书目提取提示词、JSON 修复和 Zotero 字段映射 |
| `markitdown.js` | REST / MCP 连接与文档转换 |
| `outline.js` | 大纲缓存、生成及阅读器交互 |
| `preferences.js` / `preferences.xhtml` | 设置读取、保存、模型测试与界面；样式随 XHTML 加载 |
| `task-queue.*` | 任务列表、进度、重试、终止与复制 |
| `prefs.js` | 默认首选项，密钥默认留空 |
| `locale/` | 菜单本地化资源 |
| `vendor/` | 已随包分发的库和对应许可证 |
| `release_notes.py` | 按前一正式标签的更新记录差异生成新增功能与修复说明 |
| `tests/` | 内存文库、文件系统和受控服务响应测试 |
| `docs/` | 开发与 GitHub 发布说明 |

保留现有模块边界。内部 `DocFlow` 名称、`chrome://docflow/`、`extensions.docflow.`、`docflow@egooose.local` 及已有标签用于保持安装和数据兼容，不因 GitHub 仓库改名而改动。

## 构建产物

基础版本从 `manifest.json` 读取。三段版本首次按基础版本构建，例如 `1.3.1`；同一输出目录后续构建递增为 `1.3.2`、`1.3.3`。GitHub 发布按同一主次版本已发布 Release 的最大补丁号递增，并以基础版本为下限。保留本地输出目录以延续序号。两段基础版本追加构建序号，四段基础版本递增最后一段，显式 `--version` 使用指定值：

- `dist/ocrflow-<版本>.xpi`：只包含运行需要的模块、资源及许可证，根目录有 `manifest.json` 和 `bootstrap.js`。
- `dist/ocrflow-<版本>-source.zip`：包含 `ocrflow/` 项目目录，可作为 GitHub 仓库内容；使用明确的文件清单打包。
- `dist/updates.json`：Zotero 更新清单，版本、兼容范围和 XPI 下载链接与本次构建一致。

XPI 使用逐文件清单，不递归收录 `vendor/` 或 `locale/`；排除测试、开发文档、构建脚本、第三方 README、SVG 图标源文件和本地配置。必要的第三方许可证与来源说明保留。

可通过 `python3 build.py --version 0.2.17.12` 指定发布版本。两个压缩包内的安装声明和更新清单使用此版本，本地源码文件不会被改写。

源码包包含测试、文档、构建脚本和 GitHub 工作流，不包含构建目录、Git 元数据、环境文件或本机测试记录。`.gitignore` 排除本地生成物；XPI 适合放到 Releases，不提交到源码分支。

## 测试

自动化测试不需要真实 AI Key、MinerU / MarkItDown 服务或 Zotero 文库。测试中的地址、Key 和文献均为示例或合成数据。

构建测试会从临时项目运行构建，检查默认和自定义输出位置、XPI 根目录结构以及源码包排除本地文件。原生 Zotero 测试应使用独立测试配置和文库，参考 [验证说明](../VALIDATION.md)。

GitHub Actions 配置在 [ci.yml](../.github/workflows/ci.yml)。推送到 `main` 时，测试通过后自动构建并发布 Release；Pull Request 只测试和构建，不发布。也可在 Actions 页面选择 `main` 手动运行。发布使用内置 `GITHUB_TOKEN`，工作流已声明 `contents: write`，无需另设个人 Token。

发布前，在 `CHANGELOG.md` 本次版本下用 `### 新增功能`、`### 修复问题` 分别记录变化。发布工具读取前一正式标签的更新记录，只提取本次新增条目，因此不会因历史安装包号和开发记录号不一致而漏掉功能；没有新增记录或分类时停止发布，要求补齐说明。

可在本地预览：

```sh
git fetch origin --tags
python3 release_notes.py --version 1.3.5 --previous-ref v1.3.4 --output /tmp/ocrflow-release-notes.md
```

CI 完整获取 Git 标签，按前一正式 Release 生成说明，用 `--notes-file` 同时创建或更新发布页，不再只使用提交列表。历史发布说明保存在 `docs/releases/`；它们按对应标签之间的真实代码变化整理，不更改已有版本号、标签或安装资产。

工作流配置参考官方 [checkout](https://github.com/actions/checkout)、[setup-node](https://github.com/actions/setup-node) 和 [setup-python](https://github.com/actions/setup-python)。

## 上传到 GitHub

1. 使用整理后的项目目录作为仓库根目录，确认其中有 README、`manifest.json`、`.github/` 和 `.gitignore`。
2. 在 GitHub 创建一个空仓库并选择可见性。本地已包含 README、许可证和忽略规则。
3. 可用 GitHub 的上传文件功能上传目录内容；使用 Git 时，在项目根目录运行以下命令，将占位地址替换为自己的仓库地址。

```sh
git init -b main
git add .
git commit -m "Prepare OCRFlow source repository"
git remote add origin YOUR_REPOSITORY_URL
git push -u origin main
```

以上命令是供维护者执行的说明；构建脚本不会创建仓库、提交或推送。

## 发布新版本

1. 修改代码并在更新记录的“新增功能”“修复问题”下记录本次变化，再更新相应文档；需要提升基础版本时，更新 `manifest.json` 和 `markitdown.js` 中 MCP `clientInfo.version`，基础版本支持两段（如 1.0）或三段数字。
2. 运行测试和构建，使用独立 Zotero 文库核对受影响的功能。
3. 提交并推送到 `main`。工作流将基础版本与 `github.run_number` 组合，例如 `0.2.17.12`；每次新运行使用递增序号，重跑同一次运行沿用原版本。
4. 工作流创建 `v<发布版本>` 标签和 Release，上传 XPI、源码包、`updates.json` 后再正式发布为最新版本。已发布的同版本在重跑时跳过，未完成的草稿可继续上传并发布。

`applications.zotero.update_url` 指向 `https://github.com/EEEEgoose/ocrflow/releases/latest/download/updates.json`。清单中的 `update_link` 指向该版本 Release 的 XPI，不使用会变化的最新安装包链接。旧版若仍使用占位更新地址，需要手动安装新版一次；此后由 Zotero 检查更新。

## 提交改动

说明具体问题、结果行为和验证方式。处理公开问题时使用最小合成样例，保留阿拉伯文、日文、长文件名等相关输入特征；不要把实际文库或账号配置加入测试。

第三方库更新时同步核对版本、许可证和 [来源说明](../THIRD_PARTY.md)。Auto parent item 是作者自有项目，OCRFlow 在其基础上继续开发；相关来源记录见来源说明。

## 配置存储

运行模块通过 `DocFlow.getPref/setPref` 访问配置，设置页使用主环境的同一仓库。配置值不再写入明文首选项；只有最近本地任务 ID 这类运行标识仍由首选项保留。加密保存与同步方法属于主插件环境，设置窗口关闭不会持有存储任务。关闭插件前等待本地加密保存完成。

完整导入按格式、类型和模型引用校验后应用；加密包格式固定声明 AES-256-GCM / PBKDF2-SHA256-600000，密码不进入包内容。Zotero 同步使用个人文库的密文附件和父版本关系，远端仅在本机确认后应用。
