# OCRFlow 结构恢复、双引擎校勘与逐段翻译方案（1.0 实施记录）

日期：2026-10-20。状态：用户已确认进入开发，基础版本为 1.0。实现及验证范围见 README 与 VALIDATION。

## 1. 已明确的目标

- 保留解析服务的原始结构数据及原始识别文本。
- 恢复脚注与图注，处理跨页断段，保留 PDF 物理页及印刷页码来源。
- 生成整理前后的内容差异报告。
- 双语 HTML 按自然段逐段对齐；请求可以批量发送，展示不能按请求批次对齐。
- 双引擎校勘可开关，两个识别来源由用户分别选择。
- 双引擎不能重复：MinerU 本地与云端属于同一引擎，一组 A/B 中最多使用一次 MinerU。
- 转 Markdown 在现有 MarkItDown、MinerU、AI 视觉 OCR 之外，新增 PaddleOCR 官方 API 与自部署 API。

推荐以现有 Zotero 插件为基础，增加轻量的文档结构层。参考项目用于借鉴数据组织和处理方式，不要求用户额外安装整套 Python/GPU 工作流。

## 2. OCRFlow 当前实现与缺口

以下结论来自当前工作区代码阅读，未运行真实文献转换。

| 位置 | 当前行为 | 对本方案的影响 |
| --- | --- | --- |
| `docflow.js: extractNoteContentFromMineruZip` | 正文读取 ZIP 中的 Markdown；部分 JSON 交给大纲模块；ZIP 在临时处理后删除 | 服务端结构数据没有随结果持久保存，无法据此恢复漏掉的脚注、图注 |
| 同上 | 大纲 JSON 的候选名为 `structured_content.json`、`content_list.json`、`middle_json.json` | 应增加实际支持的 `layout.json`、`*_middle.json` 等产物识别，并用真实响应确认字段 |
| `docflow.js: parseAttachmentWithCloud` | 长 PDF 分卷，正文用空行连接，已对大纲页码加偏移 | 文档结构层也需要保留分卷物理起页，处理卷间断段及注号重复 |
| `workflow.js: parseWithVision` | 逐页识别为 Markdown，添加物理页注释 | 有页级来源，没有可信的区域坐标；不能把模型生成的坐标当作原始定位 |
| `docflow.js: saveResultAsMarkdownAttachment / saveDocumentAttachment` | 保存整理文本、HTML 和图片；可保存配套 Markdown | 可在同一结果目录保存原始数据、结构与报告，具体同步行为需要 Zotero 原生验证 |
| `docflow.js: runTranslationTask` | 多个 Markdown 块合并成请求批次；双语 `pairs` 直接取这些批次 | 左右仅按批次对应，一行可能包含多个自然段 |
| `docflow.js: splitTranslationBlocks` | 已保护代码围栏和展示公式 | 可复用其思想，但脚注、列表、引用和表格需要按结构识别 |
| `docflow.js: convertMarkdownToBasicHTML` | 已处理标题、列表、公式、表格、图片；没有专门脚注引用与定义分支 | 脚注恢复后，还需要 HTML 中的可点击注号、回链及双语锚点隔离 |

当前工作区已有其他未提交修改。1.0 开发基于当前工作区继续，保留已有修改。

## 3. GitHub 参考与取舍

检索与阅读日期为 2026-10-20。下列实现均未在本机跑真实文献基准，作者宣传的准确率不作为 OCRFlow 的验收结论。

### md1012：脚注恢复、双读者、原图核对

- 阅读版本：`b572217`。
- [数据源说明](https://github.com/1012-web/md1012/blob/b572217/references/mineru-outputs.md)、[骨架重建](https://github.com/1012-web/md1012/blob/b572217/scripts/build.py)、[第二读者比对](https://github.com/1012-web/md1012/blob/b572217/scripts/vl_compare.py)。
- 采用：从行级结构和 discarded blocks 恢复内容；注号、图表子块分开处理；跨页段落保留原页界；分歧核原图。
- 调整：其脚注规则主要针对中文史学圈码。OCRFlow 同时存在外文输入，不能直接把所有圈码、上标或数字全局转换成脚注。
- 调整：其内容差异报告忽略标点与空白。OCRFlow 应保留完整差异，再区分文字、标点、结构和空白变化。

### Docling / docling-core：结构对象与来源位置

- docling-core 阅读版本：`a1a8196590`。
- [文档模型概念](https://github.com/docling-project/docling/blob/main/docs/concepts/docling_document.md)、[文档类型实现](https://github.com/docling-project/docling-core/blob/a1a8196590/docling_core/types/doc/document.py)。
- 采用：正文、标题、图片、表格等分类型；区分正文与页眉页脚；阅读顺序独立表达；对象关联页码、区域和来源。
- 调整：仅借鉴满足当前功能的数据字段，不照搬完整文档模型，不把 Docling 运行时加入 Zotero 插件。

### PDF Craft：可复用提取结果、逻辑段落与翻译锚点

- 阅读版本：`14cdcc6954`。
- [结构交换格式](https://github.com/oomol-lab/pdf-craft/blob/14cdcc6954/docs/zh-CN/PCEX_FORMAT.md)、[跨段接合](https://github.com/oomol-lab/pdf-craft/blob/14cdcc6954/pdf_craft/extractor/chapter/mergeable.py)、[翻译对象对应](https://github.com/oomol-lab/pdf-craft/blob/14cdcc6954/pdf_craft/transformer/anchored_translation.py)、[翻译结构检查](https://github.com/oomol-lab/pdf-craft/blob/14cdcc6954/pdf_craft/transformer/xml_translator/xml_translator/validation.py)。
- 采用：一次提取、多次渲染与翻译；逻辑段落可以由跨页来源片段组成；翻译按对象身份回填，不能依赖返回顺序；检查块 ID、脚注和公式锚点是否丢失。
- 调整：不引入其整套 XML/EPUB/PDF 重排系统；只借鉴当前 Markdown 和 HTML 所需机制。

### Marker：保留嵌套结构，再导出不同格式

- 阅读版本：`1749c21dcc`。
- [JSON 渲染器](https://github.com/datalab-to/marker/blob/1749c21dcc/marker/renderers/json.py)、[脚注处理](https://github.com/datalab-to/marker/blob/1749c21dcc/marker/processors/footnote.py)。
- 采用：块 ID、类型、层级、区域与图片资源共同保存；脚注作为独立类型处理。
- 注意：已读脚注处理器主要负责移动脚注块和标记上标，不能据此认为正文注号与注文已可靠匹配。

### BabelDOC：按段落翻译，保护公式与样式

- 阅读版本：`38d3896dcd`。
- [段落识别实现](https://github.com/funstory-ai/BabelDOC/blob/38d3896dcd/babeldoc/format/pdf/document_il/midend/paragraph_finder.py)、[翻译中间层说明](https://github.com/funstory-ai/BabelDOC/blob/38d3896dcd/docs/ImplementationDetails/ILTranslator/ILTranslator.md)。
- 采用：先识别段落，再翻译；公式和特殊格式用占位锚点保护。
- 调整：其主要目标包含 PDF 页面重排；这里仅实现段落对照 HTML，不扩展为 PDF 翻译排版。代码采用 AGPL-3.0，本方案只参考设计，不复制进现有 MIT 插件。

### 补充候选

- [ccantore/pdf-to-md](https://github.com/ccantore/pdf-to-md)：本轮阅读公开 README。以 Nougat 为底稿、Docling 提供图注和脚注等补充证据，另出合并与 OCR 审核报告。可借鉴“指定底稿、补充证据、修改留痕”，不据此引入固定的两个新引擎。
- [Bookflow Scholar](https://github.com/huanghaitck/bookflow-scholar)：阅读版本 `c7a7540fd4`。跨页逻辑单元、独立注释和页码来源的目标贴近本需求；但已读 `translation_units.py` 存在固定书稿 SHA、971 个段落、固定语言与路径，不能据 README 将其视为已泛化的可复用实现。
- GitHub 检索出现的 `jacobhgruber-dev/ocr-pipeline` 本轮直接访问与仓库 API 均返回 404，不作为可靠实施依据。

## 4. 建议流程

原文件 → 引擎 A 原始结果 → 文档结构 → 结构恢复 → 可选双引擎校勘 → 整理正文及差异报告 → 按结构翻译 → Markdown / HTML / 逐段双栏 HTML。

### 4.0 转 Markdown 来源与 PaddleOCR 接入

| 来源 | 接入方式 | 用途 |
| --- | --- | --- |
| MarkItDown | 保留现有 REST / MCP | Office、EPUB、HTML 等转换及 PDF 已有文字层提取 |
| MinerU | 保留本地与官方云端 | PDF / 图片结构解析 |
| AI 视觉 OCR | 保留现有服务商与模型配置 | PDF / 图片视觉识别 |
| PaddleOCR 官方 API | 新增独立设置 | PDF / 图片结构解析，保存原始响应、Markdown 与资源 |
| PaddleOCR 自部署 API | 新增独立设置 | 连接用户已有的文档解析服务，保存结构、Markdown 与资源 |

- PaddleOCR 官方与自部署分别保存地址、鉴权和服务实际支持的模型/解析选项，切换时不覆盖另一种配置。
- 文档转 Markdown 优先对接 PaddleOCR 的文档解析能力；不把仅返回文字检测框的通用 OCR 接口等同于完整文档解析。
- 自部署优先接完整文档解析流水线。官方资料中的 `/layout-parsing` 返回逐页结构与 Markdown；单独的 `genai_server` 是 VLM 识别后端，不能直接视为同一接口。具体接入版本与用户实际部署的响应样本在开发前确定。
- 原始逐页结果先保存，跨页整理后的文本另存，避免只拿合并 Markdown 而丢失页码来源。
- PaddleOCR 可用于普通单引擎转换，也纳入双引擎 A/B 的选择。MarkItDown 继续提供格式转换，不因出现在转 Markdown 菜单中就自动成为扫描件的第二 OCR 引擎。
- 同一底层 PaddleOCR 模型仅因官方/自部署地址不同，不算独立引擎；按下面的互斥规则处理。

接口依据：[PaddleOCR 官方 API 说明](https://www.paddleocr.ai/latest/en/version3.x/inference_deployment/serving/paddleocr_official_api/cli.html)、[PaddleOCR-VL 文档解析与服务化说明](https://github.com/PaddlePaddle/PaddleOCR/blob/main/docs/version3.x/pipeline_usage/PaddleOCR-VL.en.md)。本轮仅查阅文档，没有配置、部署或调用识别服务。

### 4.1 原始结果与结构保存

- 保存服务实际返回的结构 JSON、逐页原始 Markdown 和资源；无结构输出的服务明确记录为“仅文本/页级”。
- MinerU 先读取布局或 middle 数据；content list 可补充信息，不能无条件当作完整正文来源。默认 Markdown 同时保留供对照。
- 存在多种产物时，依据内容结构识别，不只匹配一个固定文件名。
- 只保存本项目实际支持的响应形态，不提前开发任意引擎插件框架。

建议的结果目录：

```text
文献.md 或 文献.html
文献.md                         # HTML 主附件的配套 Markdown
images/
_ocrflow/
  raw/engine-a/                 # 原始结构、Markdown、必要资源
  raw/engine-b/                 # 开启双引擎时生成
  document.json                 # 整理后的结构及来源
  changes.json
  changes.html                  # 用户可读差异报告
  collation.json                # 开启校勘时的差异及处理结果
  translation.json              # 段落与译文对应关系
```

`document.json` 只记录所需信息：文档内唯一的块 ID、类型、顺序、正文、来源片段、脚注和图注关联。来源片段包含原始块引用、物理页、印刷页码（可空）、坐标（可空）及文本范围。

ID 使用文档内顺序编号，不引入文本哈希。跨页合并保留原始片段的引用；一次整理结果内的 ID 用于校勘与翻译对应，不承诺独立重跑 OCR 后仍能用同一 ID 匹配。

主附件、图片和结构文件一起保存；Zotero 同步和导出能否完整携带这些文件，列为必须通过的原生验证，未通过前不宣称可跨设备复用。

### 4.2 脚注、图注和标题恢复

- 保留脚注原标记及物理页，建立“正文引用 → 注文”关联，再生成唯一 Markdown 注号。
- 每页重号、共享注文、续页注文分别处理；枚举编号和文献中的上标数字只有确有注文证据时才转成脚注。
- 注文存在但注号没识别出来时，保留为待关联注释，不猜正文位置，也不因一条漏注使后续全书注号错位。
- 图、表、图注、表注递归读取并关联；保留表格结构与已有截图。无明确关联的图注单独保留并提示。
- HTML 实现文档级脚注编号和回链；双栏原文与译文分别使用独立锚点，避免重复 ID。
- 标题优先使用真实结构信息，扁平层级可按编号形式辅助恢复；标题内容不由模型随意重写。

### 4.3 跨页段落与页码来源

- 先采用服务明确给出的合并关系，再检查相邻正文片段、阅读顺序、段落边界和语言特征。
- 页眉页脚不混入正文；不把脚注、标题、列表或独立公式误接为正文续段。
- 英文换行断词区分排版断字和真实连字符；中文不机械插空格；其他语言保持原始文字和方向信息。
- 原文支持的多栏页面按阅读顺序处理，不能只按纵坐标从上到下串接。
- 合并后形成一个逻辑段落，但保留多个来源片段；在 Markdown 原页界处保留隐藏页码标记。
- PDF 物理页和印刷页码分开记录；封面、前言、罗马页码等不使用全书固定偏移强推。识别不到的印刷页码留空。
- HTML 对照行显示该段的来源页码；有可信坐标时可进一步定位到区域，只有页码时只跳页。
- 译文按完整逻辑段落生成；跨页段落可以标注来源页范围，不假装译文中的某个字是精确原页界。

### 4.4 整理前后差异报告

报告区分两个问题：“整理过程改了什么”和“两套识别有哪些分歧”。前者以引擎 A 的原始结构文本为基线，后者属于校勘报告；不能拿翻译与原文做字符差异报告。

- 每项列出所在段落、来源页、整理前、整理后、变更类型与依据。
- 保留文字、标点、空白的完整变化；另行标记脚注迁移、页眉剥离、跨页接段等结构操作。
- 恢复的脚注原本在 JSON 中但不在默认 Markdown 中，应记“恢复输出”，不能误标为凭空新增。
- 图片路径重写单独记录为资源变化；不把整篇 Base64 数据混进正文差异。
- 报告为“零文字改动”时如实显示；差异数量不等于 OCR 正确率。

## 5. 逐段双栏翻译

### 数据与请求

- 以整理完成的逻辑段落作为翻译单元，每个单元保留块 ID、类型、原文、译文、来源及状态。
- 标题、图注、脚注作为独立单元；图片和纯公式按原内容保留，列表与表格保持结构边界。
- 多个单元按现有模型上下文预算组成一个请求，输入和返回均带 ID；可以批量翻译，也能逐段准确回填。
- 不按返回数组的位置猜对应关系。返回乱序可以按 ID 恢复；缺 ID、重复 ID 或漏单元只重试相关部分。
- 公式、脚注引用、链接目标、图片引用与代码使用受保护锚点或保留字段；译后核对这些具体结构是否完整。
- 极长自然段超过预算时，段内分片翻译并按来源范围重组，展示仍为同一逻辑段落。
- 可提供相邻段落作为上下文，但仅回填当前目标段落。

### 展示与失败处理

- 每个逻辑段落占双栏 HTML 的一行，左原文、右译文，下一行从两侧较高者之后开始。
- 一个译段可以内部包含多个段落，但不能挤到下一个原文段落的位置。
- 图表与图注保持关联；图片可共享显示，原文图注和译文图注成对显示。
- 单段失败保留原文，右侧明确显示未翻译；后续段落继续保持原 ID 对齐。
- 当前会话内的已完成译段继续复用现有队列机制；保存成品时同时保存段落对应关系。本轮不将队列跨重启持久化扩展为额外项目。
- 已有 Markdown 若没有结构文件，仍可按 Markdown 结构分段翻译，但不能补出原本不存在的页码或坐标。

## 6. 双引擎校勘

### 设置建议

- `启用双引擎校勘`：建议默认关闭，用户主动开启。
- `主识别来源 A`、`对照识别来源 B`：分别选择。
- A、B 的来源范围：MinerU 本地、MinerU 云端、PaddleOCR 官方 API、PaddleOCR 自部署 API、已配置服务商中的视觉模型。服务模型/档位遵循接口实际支持值，通用视觉模型按现有配置选择服务商和模型名。
- 用户已明确：双引擎不能一样。MinerU 本地和云端统一视为 MinerU；A 选任一 MinerU 时，B 不提供任何 MinerU 选项；A 没选 MinerU 时，B 可以选 MinerU。
- 按相同原则，PaddleOCR 官方和自部署统一视为 PaddleOCR，不互相充当第二引擎。两个 AI 视觉来源可以选择不同模型，同一底层模型不能仅换服务商名称就算两个引擎；明确配置为 MinerU/PaddleOCR 的模型也按对应引擎处理，不开发猜测模型身份的系统。
- A 改变后，B 若因此不再有效，则清空 B 并提示重新选择，不静默代选其他模型。选择框与任务启动前使用同一互斥规则；重试也不能绕过此规则。
- 翻译模型继续独立选择，不与 OCR 的两个模型绑定。

### 比对与裁决

- A 为底稿，B 是独立识别的对照。B 识别时不先看 A 的答案。
- 按物理页、阅读顺序和内容块对齐，再检查文字替换、漏字、多字、标点及结构差异。
- 文字、标点、结构分别展示；不把标点从所有比对中删除。大段缺失与脚注缺漏明确列出。
- 疑字列表包含 A/B 原文、上下文、来源页及原图。已有可信区域框时裁区域，否则展示整页，不生成虚假精确框。
- 用户已确认：生成疑字清单，由用户对照原图确认后修改。每项可保留 A、采用 B 或手动输入修正；未处理项保持底稿原文。
- 不因 B 与 A 不同就直接覆盖。原图显示原刊本身有误时保留原文，校注另记。
- 第一版不增加 AI 自动裁决；用户确认的改字才写入正文。
- 每次采用修改保留旧字、新字、处理者和依据，并进入内容差异报告。
- B 失败时保留 A 的可用结果，状态明确为“校勘未完成”；可仅重试 B，不能展示为双引擎通过。
- 总校勘状态显示已比较页数和缺失页，不用疑字数量或任意分值宣称全文质量。

## 7. 实施顺序与验收

1.0 按以下顺序实现；真实服务输出质量及同步行为的验证边界见 VALIDATION。

### 第一步：结构保留与正文恢复

完成 PaddleOCR 官方/自部署两种接入、原始结果保存、文档结构、脚注图注恢复、跨页片段和页码来源、差异报告及 HTML 脚注渲染。

验收：用实际支持的 MinerU 本地/云端、PaddleOCR 官方/自部署响应样本，覆盖正常正文、页注重号、共享注文、缺注、图表嵌套、跨页接段和分卷接缝。两种 PaddleOCR 配置各自保存并实际生效。确认字段缺失时会报告实际能力，恢复内容能回到来源页，报告能发现被注入的文字删改和标点变化。

### 第二步：逐段翻译与双栏输出

完成段落 ID、批量请求、按 ID 回填、公式/脚注/图片引用保护、逐段失败重试和双栏渲染。

验收：多个自然段在同一请求中翻译，返回乱序、漏一段、某段失败时仍不串行；代码、公式、表格和图注不被切坏；超长段落可以内部拆分再合并。使用 Zotero 打开结果，确认长短译文、脚注回链及图片显示正常。

### 第三步：可选双引擎校勘

完成开关、两个来源选择、独立识别、块对齐、疑字与结构差异、原图审阅，以及用户确认后的修改执行。

验收：关闭时不请求 B；开启时两个选择各自生效；MinerU 本地/云端不能组合，非 MinerU 的 A 可以搭配 MinerU 的 B，A 切换后失效的 B 会被清空；PaddleOCR 官方/自部署不能组合，相同视觉模型不能组合。B 失败可以单独继续；不同分块方式不会使整页误配；修改有原图依据与报告；未确定结果保留待复核状态。

在开发阶段运行相应自动化测试与构建，并用独立 Zotero 测试文库验证附件保存、阅读跳页、双栏样式以及结构文件随附件同步/导出的实际行为。设计阶段不运行无关测试，也不调用用户的 OCR/翻译服务。

## 8. 已确认选择与后续

1. 两个识别选择框：支持 MinerU 本地/云端、PaddleOCR 官方/自部署及已配置视觉模型；同一引擎不能重复。用户明确指定 MinerU 在 A/B 中最多出现一次，本地和云端不视为不同引擎。
2. 校勘裁决：生成疑字清单，用户对照原图确认后修改；不采用 AI 自动裁决。
3. 转 Markdown 新增 PaddleOCR 官方 API 和自部署 API，保留现有 MarkItDown、MinerU、AI 入口。
4. 用户随后确认进入开发，版本号定为 1.0，并同意使用 karpathy-guidelines 与 context7-mcp。
