Object.assign(DocFlow, {
	translationParagraphBudget(settings) {
		return Math.min(settings.translateChunkSize || 20000, Math.max(256, Math.min(this.getAIChunkBudget(settings) - 1024, this.getAIOutputBudget(settings))));
	},

	translationBatchBudget(settings) {
		let budget = this.translationParagraphBudget(settings);
		if (this.isOpenRouterMiMo(settings)) return Math.min(budget, 4096);
		return budget;
	},

	translationParagraphs(markdown, document = null) {
		if(this.stripPageDisplay)markdown=this.stripPageDisplay(markdown);
		let headers = new Map();
		for (let block of document ? OCRFlowDocument.runningHeaders(document) : []) {
			let page = block.fragments[0].page;
			if (!headers.has(page)) headers.set(page, new Set());
			headers.get(page).add(OCRFlowDocument.runningHeaderKey(block.text));
		}
		let paragraphs = [], page = null, pageUnit="page", boundary = false, blocksOnPage = new Map();
		let join = (left, right) => left + (/\s$/.test(left) || /^\s/.test(right) || /[-\u00ad]$/.test(left) || /[\u3400-\u9fff]$/.test(left) && /^[\u3400-\u9fff]/.test(right) ? "" : " ") + right;
		let prose = text => !/^(?:#{1,6}\s|\[\^[^\]]+\]:|[-*+]\s|\d+[.)、]\s|>|\||!\[|<|```|~~~|\$\$|\\\[|[-*_]{3,}\s*$)/.test(text);
		for (let block of this.splitTranslationBlocks(markdown)) {
			if (/^(?:```|~~~)/.test(block)) { paragraphs.push({text:block, page, pages:page ? [page] : []}); boundary = false; continue; }
			let text = "", pages = [], startsAtBoundary = boundary;
			for (let part of block.split(/(<!--ocrflow-(?:page|slide):\d+[\s\S]*?-->)/g)) {
				let marker = part.match(/^<!--ocrflow-(page|slide):(\d+)[\s\S]*?-->$/);
				if (marker) { pageUnit=marker[1];page = Number(marker[2]); boundary = true; if (!text.trim()) startsAtBoundary = true; continue; }
				if (part.trim()) {
					if (page && !pages.includes(page)) pages.push(page);
					text = boundary && text.trim() ? join(text, part) : text + part;
					boundary = false;
				} else text += part;
			}
			text = text.trim(); if (!text) continue;
			// Running headers sit at the top of a page (a page number may precede them); drop each one once.
			let position = pages.length ? blocksOnPage.get(pages[0]) || 0 : 0;
			if (pages.length) blocksOnPage.set(pages[0], position + 1);
			let pageHeaders = pages.length === 1 && position < 2 ? headers.get(pages[0]) : null, headerKey = OCRFlowDocument.runningHeaderKey(text);
			if (pageHeaders?.has(headerKey)) {
				pageHeaders.delete(headerKey);
				boundary = startsAtBoundary;
				continue;
			}
			let previous = paragraphs.at(-1);
			if (startsAtBoundary && previous && previous.pages.at(-1) + 1 === pages[0] && prose(previous.text) && prose(text) &&
				!/[。！？.!?;；：:؟…]([”’"»」』）)]|\[\^[^\]]+\])*$/.test(previous.text)) {
				previous.text = join(previous.text, text);
				previous.pages = [...new Set([...previous.pages, ...pages])];
			} else paragraphs.push({text, page:pages[0] || null, pages, pageUnit});
		}
		return paragraphs;
	},

	translationUnits(markdown, settings, document = null) {
		let units = [];
		for (let {text:block, page:startPage, pages, pageUnit} of this.translationParagraphs(markdown, document)) {
			let prefix = block.match(/^(?:\[\^[^\]]+\]:\s*|#{1,6}\s+)/)?.[0] || "";
			let prepared = this.prepareTranslationText(block.slice(prefix.length)), protectedParts = [], text = prepared.parts.map(part => {
				if (part.literal === undefined) return part.leading + prepared.texts[part.index] + part.trailing;
				let token = `⟦K${protectedParts.length}⟧`; protectedParts.push(part.literal); return token;
			}).join("");
			text = text.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`|\$\$[\s\S]*?\$\$|\$(?:\\.|[^$\n])+\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|\[\^[^\]]+\]|\]\([^)]+\)|<\/?(?:table|thead|tbody|tr|th|td)\b[^>]*>|^\s*(?:[-*+]|\d+\.)\s+|\|/gm, value => {
				let token = `⟦K${protectedParts.length}⟧`; protectedParts.push(value); return token;
			});
			let chunks = this.splitAIText(text, settings, this.translationParagraphBudget(settings));
			// Do not split protected tokens, even when a very long paragraph exceeds its budget.
			let fragments = [], rest = text;
			for (let chunk of chunks) {
				let end = chunk.length;
				let open = rest.lastIndexOf("⟦", end - 1), close = rest.indexOf("⟧", open);
				if (open >= 0 && close >= end) end = close + 1;
				fragments.push(rest.slice(0, end)); rest = rest.slice(end);
				if (!rest) break;
			}
			if (rest) fragments.push(rest);
			let translated = fragments.map(fragment => fragment.replace(/⟦K\d+⟧/g, "").trim() ? null : fragment);
			units.push({ id: `p${units.length + 1}`, source: block, prefix, text, page: startPage, pages, pageUnit, protectedParts, fragments, translated });
		}
		return units;
	},

	// One call issues at most 3N requests: a full split tree has 2N-1 batch requests plus N single-paragraph fallbacks.
	async translateAlignedBatch(items, settings, signal, quota = { left: 3 * items.length }) {
		signal?.throwIfAborted();
		let completed = items.map(item => item.unit?.translated[item.index] || null);
		if (completed.every(Boolean)) return completed;
		if (completed.some(Boolean)) {
			let pending = items.filter((_item, index) => !completed[index]);
			let translated = await this.translateAlignedBatch(pending, settings, signal, quota);
			let next = 0;
			return completed.map(text => text || translated[next++]);
		}
		let spend = () => {
			if (quota.left-- > 0) return;
			let error = new Error("逐段翻译格式错误过多，已停止拆分重试。");
			error.name = "TranslationQuotaError";
			throw error;
		};
		let formatError = error => ["TranslationResponseFormatError", "AIOutputLimitError"].includes(error.name);
		// A paragraph that already failed on its own will not fare better inside a batch: mark it and skip batching on later attempts.
		let single = async item => {
			spend();
			try {
				let text = await this.translateAlignedParagraph(item, settings, signal);
				if (!text) item.isolated = true;
				return text;
			} catch (error) {
				if (formatError(error)) item.isolated = true;
				throw error;
			}
		};
		if (items.some(item => item.isolated)) {
			let results = new Map(), failure = null, others = items.filter(item => !item.isolated);
			for (let item of items.filter(item => item.isolated)) {
				try {
					let text = await single(item);
					results.set(item, text);
					if (text && item.unit) item.unit.translated[item.index] = text;
				} catch (error) {
					signal?.throwIfAborted();
					if (!formatError(error)) throw error;
					failure = error; item.error = error.message;
				}
			}
			if (others.length) (await this.translateAlignedBatch(others, settings, signal, quota)).forEach((text, index) => results.set(others[index], text));
			let output = items.map(item => results.get(item) || null);
			if (failure && output.every(text => !text)) throw failure;
			return output;
		}
		let output;
		try {
			spend();
			output = await this.requestAlignedTranslationBatch(items, settings, signal);
		} catch (error) {
			signal?.throwIfAborted();
			if (!formatError(error)) throw error;
			if (items.length === 1) {
				output = [await single(items[0])];
			} else {
				let middle = Math.ceil(items.length / 2);
				output = [];
				let failure = null;
				for (let part of [items.slice(0, middle), items.slice(middle)]) {
					try { output.push(...await this.translateAlignedBatch(part, settings, signal, quota)); }
					catch (partError) {
						signal?.throwIfAborted();
						if (!formatError(partError)) throw partError;
						failure = partError;
						for (let item of part) item.error = partError.message;
						output.push(...part.map(() => null));
					}
				}
				if (failure && output.every(text => !text)) throw failure;
			}
		}
		output.forEach((text, index) => {
			if (text && items[index].unit) items[index].unit.translated[items[index].index] = text;
		});
		return output;
	},

	async translateAlignedParagraph(item, settings, signal) {
		let prompt = OCRFlowPrompts.get("translate", settings.workPrompt, settings.translateLanguage) +
			"\nTranslate this single paragraph. Return only its translated body as plain Markdown, without JSON, paragraph IDs, code fences or explanations. Preserve every ⟦Knumber⟧ token exactly once and in its original order. Do not translate code, formulas or link targets.";
		let text = await this.requestDocumentAI([{ role: "system", content: prompt }, { role: "user", content: item.text }],
			{ ...settings, summaryRequestJSON: JSON.stringify(settings.translateRequestParams || {}) }, signal);
		let value;
		try { value = JSON.parse(text.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, "$1")); } catch (_error) {}
		let sourceJSON = /^\s*[[{]/.test(item.text), isObject = value !== null && typeof value === "object";
		// JSON source fields belong to the document, even when they resemble protocol IDs.
		let wrapped = !sourceJSON && isObject && (Array.isArray(value)
			? value.length > 0
			: Array.isArray(value.translations) || typeof value.id === "string" || Object.hasOwn(value, item.id));
		if (wrapped) return this.parseAlignedTranslationResponse(text, [item])[0];
		let keys = isObject && !Array.isArray(value) ? Object.keys(value) : [];
		if (!sourceJSON && keys.length === 1 && ["translation", "translated", "text", "result"].includes(keys[0]) && typeof value[keys[0]] === "string") text = value[keys[0]];
		else if (isObject && !sourceJSON) throw this.translationResponseError("单段翻译仍返回 JSON 包装，请重试此段。", text);
		else if (typeof value === "string") text = value;
		let wrapperKey = /"(?:translations|id)"\s*:/, paragraphKey = new RegExp('"' + this.escapeRegExp(item.id) + '"\\s*:');
		if (!wrapperKey.test(item.text) && !paragraphKey.test(item.text) && (wrapperKey.test(text) || paragraphKey.test(text))) throw this.translationResponseError("单段翻译仍返回 JSON 包装，请重试此段。", text);
		if (!/^(?:```|~~~)/.test(item.text)) text = text.replace(/^```(?:markdown|md)?[ \t]*\n([\s\S]*?)\n```\s*$/i, "$1");
		let expected = item.text.match(/⟦K\d+⟧/g) || [];
		return text.trim() && JSON.stringify(text.match(/⟦K\d+⟧/g) || []) === JSON.stringify(expected) ? text : null;
	},

	translationResponseError(message, content) {
		let error = new Error(message);
		error.name = "TranslationResponseFormatError";
		error.responseText = content;
		return error;
	},

	parseAlignedTranslationResponse(content, items) {
		let output;
		try { output = JSON.parse(content.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, "$1")); }
		catch (error) {
			throw this.translationResponseError("逐段翻译返回的 JSON 无效（" + error.message + "）。返回开头为 " + content.slice(0, 120).replace(/\s+/g, " "), content);
		}
		if (output && typeof output === "object" && !Array.isArray(output)) {
			if (Array.isArray(output.translations)) output = output.translations;
			else if (typeof output.id === "string" && Object.hasOwn(output, "text")) output = [output];
			else output = Object.entries(output).map(([id, text]) => ({ id, text }));
		}
		if (typeof output === "string" && items.length === 1) output = [{ id: items[0].id, text: output }];
		if (!Array.isArray(output)) throw this.translationResponseError("逐段翻译必须返回带段落 ID 的数组", content);
		let found = new Map();
		for (let item of output) {
			if (!item || typeof item.id !== "string") throw this.translationResponseError("译文段落条目或 ID 无效", content);
			if (found.has(item.id) || !items.some(source => source.id === item.id)) throw this.translationResponseError("译文出现重复或未知段落 ID", content);
			found.set(item.id, item.text);
		}
		return items.map(item => {
			let text = found.get(item.id), expected = item.text.match(/⟦K\d+⟧/g) || [];
			if (typeof text !== "string" || !text.trim() || JSON.stringify(text.match(/⟦K\d+⟧/g) || []) !== JSON.stringify(expected)) return null;
			return text;
		});
	},

	async requestAlignedTranslationBatch(items, settings, signal) {
		let input = items.map(item => ({ id: item.id, text: item.text }));
		let structured = this.isOpenRouterMiMo(settings);
		let responseFormat = false;
		let requestParams = settings.translateRequestParams;
		if (structured) {
			responseFormat = {
				type: "json_schema",
				json_schema: {
					name: "ocrflow_translation",
					strict: true,
					schema: {
						type: "object",
						additionalProperties: false,
						required: input.map(item => item.id),
						properties: Object.fromEntries(input.map(item => [item.id, { type: "string" }]))
					}
				}
			};
			requestParams = { ...requestParams, provider: { ...requestParams?.provider, require_parameters: true } };
		}
		let outputInstruction = structured ? 'Return one JSON object mapping each input ID directly to its translated text. Use the exact input IDs as keys and translated strings as values. Do not nest an array.' : 'Return a JSON array of {id,text}.';
		let prompt = OCRFlowPrompts.get("translate", settings.workPrompt, settings.translateLanguage) +
			'\nInput is a JSON array of {id,text}. ' + outputInstruction + ' Return one translated text per input ID. Preserve every ID and every ⟦Knumber⟧ token exactly once and in its original order. Never merge entries. Do not translate code, formulas or link targets. Output JSON only.';
		let content = await this.requestDocumentAI([{ role: "system", content: prompt }, { role: "user", content: JSON.stringify(input) }],
			{ ...settings, summaryRequestJSON: JSON.stringify(requestParams || {}) }, signal, responseFormat);
		return this.parseAlignedTranslationResponse(content, items);
	},

	async runAlignedTranslationTask(task) {
		let settings = task.settings, signal = task.controller.signal;
		let status = text => { signal.throwIfAborted(); task.detail = text; this.setTaskStep?.(task, task.saving ? "save" : "work", task.saving ? "保存译文" : "逐段翻译", text); this.refreshParseQueueDialog(); };
		let budget = this.translationBatchBudget(settings), paragraphBudget = this.translationParagraphBudget(settings), retryAt = 0;
		let cached = task.translation;
		// Legacy `budget` may describe a batch, so retain its existing units and completed translations.
		if (!cached?.units || cached.language !== settings.translateLanguage || cached.paragraphBudget != null && cached.paragraphBudget !== paragraphBudget) {
			status("读取自然段与来源");
			let { filePath, markdown } = await this.readSourceMarkdown(task.mineruSource);
			let structurePath = PathUtils.join(PathUtils.parent(filePath), "_ocrflow", "document.json");
			let document = null;
			try {
				if (await IOUtils.exists(structurePath)) {
					let parsed = JSON.parse(new TextDecoder().decode(await IOUtils.read(structurePath)));
					if (Array.isArray(parsed?.blocks) && Array.isArray(parsed?.pages)) document = parsed;
				}
			} catch (error) { globalThis.Zotero?.debug?.("OCRFlow: ignored unreadable document.json: " + error.message); }
			signal.throwIfAborted(); status("读取全文插图与附件资源");
			let source = await this.inlineStoredImagesInMarkdownAttachment({ markdownText: markdown, markdownPath: filePath, signal,
				onImage: count => { if (count === 1 || count % 10 === 0) status(`已读取 ${count} 张插图，正在整理全文资源`); } });
			signal.throwIfAborted(); status("整理自然段与受保护引用");
			let units = this.translationUnits(source.markdownText, settings, document);
			if (!units.length) throw new Error("Markdown 内容为空");
			task.translation = { language: settings.translateLanguage, paragraphBudget, units, images: source.embeddedImages };
		}
		let data = task.translation, units = data.units;
		let fragments = units.flatMap(unit => unit.fragments.map((text, index) => ({ id: `${unit.id}.${index}`, text, unit, index })));
		let pending = fragments.filter(item => !item.unit.translated[item.index]), round = 0;
		while (pending.length && !data.partial) {
			let batches = [], batch = [], size = 0;
			for (let item of pending) {
				let length = this.estimateAITokens(JSON.stringify({ id: item.id, text: item.text }));
				if (batch.length && size + length > budget) { batches.push(batch); batch = []; size = 0; }
				batch.push(item); size += length;
			}
			if (batch.length) batches.push(batch);
			status(`正在请求模型翻译；已完成 ${units.filter(unit => unit.translated.every(Boolean)).length}/${units.length} 个自然段，本轮 ${batches.length} 批`);
			let rateLimited = false;
			await this.mapAIWork(batches, settings.translateConcurrency || settings.concurrency || 1, async items => {
				if (rateLimited) { for (let item of items) item.error = "服务限流，暂未请求此段：" + data.lastError; return; }
				let remaining = items, error;
				for (let attempt = 0; remaining.length && attempt <= (settings.translateRetryCount ?? 2); attempt++) {
					try {
						let wait = retryAt - Date.now();
						if (wait > 0) {
							status(`服务限流（HTTP 429），等待 ${Math.ceil(wait / 1000)} 秒后继续翻译；可终止任务。`);
							await this.delayParsePoll(wait, {signal});
						}
						for (let item of remaining) delete item.error;
						let output = await this.translateAlignedBatch(remaining, settings, signal);
						error = null;
						remaining.forEach((item, index) => { if (output[index]) item.unit.translated[item.index] = output[index]; });
						remaining = remaining.filter(item => !item.unit.translated[item.index]);
					} catch (e) {
						signal.throwIfAborted(); error = e;
						if (e.status === 429) retryAt = Math.max(retryAt, Date.now() + (e.retryAfterMS > 0 ? e.retryAfterMS : 30000 * 2 ** attempt));
						// Transient server or connection failures: back off briefly (2s, 4s, 8s…, at most 60s) instead of retrying at once.
						else if (attempt < (settings.translateRetryCount ?? 2) && (e.status >= 500 || e.name === "TypeError" || /^AI 请求中断/.test(e.message))) {
							let wait = Math.min(60000, e.retryAfterMS > 0 ? e.retryAfterMS : 2000 * 2 ** attempt);
							status(`服务暂时不可用，${Math.ceil(wait / 1000)} 秒后重试；可终止任务。`);
							await this.delayParsePoll(wait, {signal});
						}
					}
				}
				if (remaining.length) {
					data.lastError = error?.message || remaining.find(item => item.error)?.error || "译文漏段或受保护结构发生变化";
					for (let item of remaining) item.error ||= data.lastError;
					if (error?.status === 429) rateLimited = true;
				}
				task.progress = {completed:units.filter(unit => unit.translated.filter(Boolean).length === unit.fragments.length).length, total:units.length, unit:"段"};
				status(`翻译 ${task.progress.completed}/${units.length} 个自然段`);
			}, signal);
			pending = fragments.filter(item => !item.unit.translated[item.index]);
			if (!pending.length) break;
			let completed = fragments.length - pending.length;
			let decisionOptions = {
				title: task.title, failures: pending.map(item => ({ chunkIndex: fragments.indexOf(item), totalChunks: fragments.length, error: item.error })),
				savable: units.filter(unit => unit.translated.every(Boolean)).length,
				retryRound: ++round, completed, total: fragments.length, autoRetryCount: settings.translateRetryCount ?? 2 };
			let action = this.requestTaskDecision ? await this.requestTaskDecision(task, decisionOptions) : this.confirmRetryFailedChunks(this.parseQueueWindow || Zotero.getMainWindow(), decisionOptions);
			if (action === "save") data.partial = true;
			else if (action !== "retry") throw new Error(data.lastError);
			else {
				// The user may have switched model or parameters: give every paragraph a fresh batch attempt.
				for (let item of fragments) delete item.isolated;
				settings = task.settings;
				budget = this.translationBatchBudget(settings); retryAt = 0;
			}
		}
		signal.throwIfAborted();
		let pairs = units.map(unit => {
			let complete = unit.translated.filter(Boolean).length === unit.fragments.length;
			let translated = complete ? unit.prefix + unit.translated.join("").replace(/⟦K(\d+)⟧/g, (_m, index) => unit.protectedParts[Number(index)]) : "**未翻译**\n\n" + unit.source;
			return { id: unit.id, source: unit.source, translated, page: unit.page, pages: unit.pages, pageUnit:unit.pageUnit, complete };
		});
		let completed = pairs.filter(pair => pair.complete).length;
		if (!completed) throw new Error("没有完整译段可保存");
		if (this.parseQueueStopped) throw new Error("翻译已停止，未保存附件。");
		task.partial = !!data.partial;
		task.saving = true; status("保存逐段译文");
		task.resultAttachment = await this.saveTranslationAsMarkdownAttachment({ parentItem: task.parentItem, sourceAttachment: task.mineruSource,
			translatedText: pairs.map(pair => pair.translated).join("\n\n"), language: settings.translateLanguage,
			images: data.images, settings, pairs: settings.outputFormat === "html" && settings.translationMode === "bilingual" ? pairs : null,
			translationData: pairs, partial: data.partial ? { completed, total: units.length } : null });
		return data.partial ? `已保存部分译文 ${completed}/${units.length} 段` : "逐段翻译附件已保存";
	}
});
