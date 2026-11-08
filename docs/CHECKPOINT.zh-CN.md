# 检查点：逐段翻译审核修复（2026-11-08）

基线提交：`572b6c5`（Release 1.5.7）。本次修改尚未提交，与此前未提交的改动（运行页眉识别、MiMo 结构化翻译、拆分降级等）位于同一批文件中。

验证：`node --test tests/*.test.cjs` 共 357 项全部通过（修改前为 347 项，新增 10 项，均在 `tests/ocr-v1.test.cjs` 末尾）。

## 修改清单

| # | 问题 | 修改 | 位置 |
|---|---|---|---|
| 1 | `document.json` 损坏或结构不对时，整个翻译任务失败 | 读取或解析失败、缺少 `blocks`/`pages` 时按"没有该文件"处理，只用 `Zotero.debug` 记日志，翻译不再过滤页眉 | `translation.js` `runAlignedTranslationTask` |
| 2 | 缓存失效判断用的是批次预算，但分段依据的是段落预算；升级后 MiMo 任务的进度会丢 | 改为比较 `paragraphBudget`，旧缓存的 `budget` 字段兜底；新缓存写入 `paragraphBudget` | 同上 |
| 3 | 格式错误时拆分请求数没有上限 | 单次 `translateAlignedBatch` 调用最多发 3N 个请求，配额在递归中共用；用完时抛 `TranslationQuotaError`，不参与拆分 | `translation.js` `translateAlignedBatch` |
| 4 | 单段回退会误判正常译文 | 原文本身是 JSON 时不当作包装；只解包 `translation`/`translated`/`text`/`result` 这几个单值键；其他对象报格式错误；原文含 `"id":` 时不误判；剥离 ```` ```markdown ```` 栅栏 | `translation.js` `translateAlignedParagraph` |
| 5 | 页眉过滤会删掉同页正文里的同名段落 | 只删每页前两个块里的页眉（允许页码在前），每页每个页眉只删一次 | `translation.js` `translationParagraphs` |
| 6 | MiMo 判断条件在三处重复，写法不一致 | 新增 `isOpenRouterMiMo(settings)`，用 hostname 判断，只精确匹配 `xiaomi/mimo-v2.6-flash`（不含 `:free`） | `workflow.js`；`translation.js` 两处调用 |
| 7 | `finish_reason: "error"` 时拿不到 OpenRouter 放在 choice 里的错误信息 | 优先读 `choice.error.message` | `workflow.js` `sendDocumentAI` |
| 8 | 5xx 和网络错误会立即连续重试 | 5xx、`TypeError`（网络失败）、"AI 请求中断"按 2 秒、4 秒、8 秒逐次加倍冷却，服务端给了 `Retry-After` 就按它来，最多 60 秒；只在还有下一次重试时才等；状态栏显示提示，可随时终止 | `translation.js` 自动重试 `catch`；`locale/en-US/ui.js` 新增一条翻译 |
| 9 | 每轮自动重试都重建拆分树 | 单段请求失败（格式错误、截断、丢失标记）的段落打上 `isolated` 标记，之后的自动重试直接单段请求，不再批量请求和拆分；用户手动"重试"时清除标记 | `translation.js` `translateAlignedBatch`、`runAlignedTranslationTask` |

## 行为变化

- 8 段全部返回格式错误、默认重试 2 次时，自动重试阶段的请求数从 69 降到 39（23 + 8 + 8）。
- 手动重试仍只请求没翻好的段落；清除 `isolated` 只影响这些段落的请求方式，会先合成一个批次再请求。
- 429 的退避（30 秒起步、所有批次共用等待截止时间）、格式错误立即重试、超时（20 分钟）后立即重试，这些都没有改。

## 已知限制

- 第 3 项的 3N 配额正好是完整降级路径的上限（2N−1 次批量请求 + N 次单段请求），按现在的算法不会触发，只是防止以后改算法时请求数失控。
- 第 8 项的冷却是各批次分开计时的；并发数大时，多个批次仍可能在相近的时间点各自重试。
- 第 8 项把 `TypeError` 当成网络错误，如果是代码本身的 bug，也会先等几秒再失败。
- 第 2 项为了保住旧缓存的进度，这类任务恢复后仍沿用当时的分段结果，所以不会过滤页眉。

## 新增测试（`tests/ocr-v1.test.cjs`）

1. `document.json` 内容损坏时翻译仍能完成
2. 旧缓存字段 `budget` 能保住进度；段落预算变化时重建分段
3. 一直返回格式错误时请求数为 23；配额用完时抛 `TranslationQuotaError`
4. 单段回退：JSON 形态的原文、`"id":` 原文、单值包装、markdown 栅栏、未知对象
5. 页眉只在页首附近删除，同页正文里的同名标题保留，页码在前时也能识别页眉
6. `isOpenRouterMiMo` 的匹配范围
7. `choice.error.message` 能出现在报错里
8. 5xx 和网络错误的冷却时长、60 秒上限，格式错误不冷却
9. `isolated`：自动重试只发单段请求，共 39 次；手动重试恢复批量请求
10. `isolated` 段落在后续自动重试中单段成功后能正常保存
