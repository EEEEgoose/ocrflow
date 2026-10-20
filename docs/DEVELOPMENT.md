# 开发与发布

[项目首页](../README.md) · [验证说明](../VALIDATION.md)

## 环境

使用 Node.js 24 或更新版本、Python 3.12 或更新版本。测试和构建使用标准库以及仓库内的 vendor 文件，无需安装 npm / pip 依赖。实际插件运行于 Zotero，不在 Node.js 中运行。

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
| `manifest.json` | 插件名称、版本、图标、Zotero 兼容范围和稳定 ID |
| `bootstrap.js` | 插件启动、模块加载、设置页及菜单注册、关闭清理 |
| `docflow.js` | MinerU、任务队列、模型配置读取、保存、翻译和输出渲染 |
| `workflow.js` | 手动工作流、AI 请求、上下文预算、分段和服务选择 |
| `metadata.js` | 书目提取提示词、JSON 修复和 Zotero 字段映射 |
| `markitdown.js` | REST / MCP 连接与文档转换 |
| `outline.js` | 大纲缓存、生成及阅读器交互 |
| `preferences.js` / `preferences.xhtml` | 设置读取、保存、模型测试与界面；样式随 XHTML 加载 |
| `task-queue.*` | 任务列表、进度、重试、终止与复制 |
| `prefs.js` | 默认首选项，密钥默认留空 |
| `locale/` | 菜单本地化资源 |
| `vendor/` | 已随包分发的库和对应许可证 |
| `tests/` | 内存文库、文件系统和受控服务响应测试 |
| `docs/` | 开发与 GitHub 发布说明 |

保留现有模块边界。内部 `DocFlow` 名称、`chrome://docflow/`、`extensions.docflow.`、`docflow@egooose.local` 及已有标签用于保持安装和数据兼容，不因 GitHub 仓库改名而改动。

## 构建产物

版本从 `manifest.json` 读取：

- `dist/ocrflow-<版本>.xpi`：只包含运行需要的模块、资源及许可证，根目录有 `manifest.json` 和 `bootstrap.js`。
- `dist/ocrflow-<版本>-source.zip`：包含 `ocrflow/` 项目目录，可作为 GitHub 仓库内容；使用明确的文件清单打包。

源码包包含测试、文档、构建脚本和 GitHub 工作流，不包含构建目录、Git 元数据、环境文件或本机测试记录。`.gitignore` 排除本地生成物；XPI 适合放到 Releases，不提交到源码分支。

## 测试

自动化测试不需要真实 AI Key、MinerU / MarkItDown 服务或 Zotero 文库。测试中的地址、Key 和文献均为示例或合成数据。

构建测试会从临时项目运行构建，检查默认和自定义输出位置、XPI 根目录结构以及源码包排除本地文件。原生 Zotero 测试应使用独立测试配置和文库，参考 [验证说明](../VALIDATION.md)。

GitHub Actions 配置在 [ci.yml](../.github/workflows/ci.yml)，执行测试和构建。上传前在本地运行同样的命令；首次上传后的 GitHub 运行结果在 Actions 页面查看。

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

1. 更新 `manifest.json` 版本，并同步 `markitdown.js` 中 MCP `clientInfo.version`。
2. 更新首页、使用手册和 `CHANGELOG.md`；按实际结果更新验证说明。
3. 运行测试和构建，使用独立 Zotero 文库安装 XPI，核对受影响的功能。
4. 在 GitHub 创建对应版本的 Release，上传 XPI 和源码包。

`applications.zotero.update_url` 当前为安装声明所需的占位地址。确定仓库和真实更新清单后，才配置自动更新；当前使用手动覆盖安装。

## 提交改动

说明具体问题、结果行为和验证方式。处理公开问题时使用最小合成样例，保留阿拉伯文、日文、长文件名等相关输入特征；不要把实际文库或账号配置加入测试。

第三方库更新时同步核对版本、许可证和 [来源说明](../THIRD_PARTY.md)。本地提供的 Auto parent item 历史源码没有独立许可证文件，此来源事实在来源说明中保留。
