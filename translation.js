Object.assign(DocFlow, {
	translationBatchBudget(settings) {
		return Math.min(settings.translateChunkSize || 20000, Math.max(256, Math.min(this.getAIChunkBudget(settings) - 1024, this.getAIOutputBudget(settings))));
	},

	translationUnits(markdown, settings) {
		let units = [], page = null;
		for (let block of this.splitTranslationBlocks(markdown)) {
			let startPage = page, pages = [];
			if (!/^(?:```|~~~)/.test(block)) block = block.replace(/<!--ocrflow-page:(\d+)[\s\S]*?-->/g, (_m, value) => { page = Number(value); return ""; }).trim();
			if (!block) continue;
			startPage ||= page;
			pages = [...new Set([startPage, page].filter(Boolean))];
			let prefix = block.match(/^(?:\[\^[^\]]+\]:\s*|#{1,6}\s+)/)?.[0] || "";
			let prepared = this.prepareTranslationText(block.slice(prefix.length)), protectedParts = [], text = prepared.parts.map(part => {
				if (part.literal === undefined) return part.leading + prepared.texts[part.index] + part.trailing;
				let token = `⟦K${protectedParts.length}⟧`; protectedParts.push(part.literal); return token;
			}).join("");
			text = text.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`|\$\$[\s\S]*?\$\$|\$(?:\\.|[^$\n])+\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|\[\^[^\]]+\]|\]\([^)]+\)|<\/?(?:table|thead|tbody|tr|th|td)\b[^>]*>|^\s*(?:[-*+]|\d+\.)\s+|\|/gm, value => {
				let token = `⟦K${protectedParts.length}⟧`; protectedParts.push(value); return token;
			});
			let chunks = this.splitAIText(text, settings, this.translationBatchBudget(settings));
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
			units.push({ id: `p${units.length + 1}`, source: block, prefix, text, page: startPage, pages, protectedParts, fragments, translated });
		}
		return units;
	},

	async translateAlignedBatch(items, settings, signal) {
		let input = items.map(item => ({ id: item.id, text: item.text }));
		let prompt = OCRFlowPrompts.get("translate", settings.workPrompt, settings.translateLanguage) +
			'\nInput is a JSON array of {id,text}. Return a JSON array of {id,text}, one translated text per input ID. Preserve every ID and every ⟦Knumber⟧ token exactly once and in its original order. Never merge entries. Do not translate code, formulas or link targets. Output JSON only.';
		let content = await this.requestDocumentAI([{ role: "system", content: prompt }, { role: "user", content: JSON.stringify(input) }],
			{ ...settings, summaryRequestParams: settings.translateRequestParams }, signal);
		let output;
		try { output = JSON.parse(content.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, "$1")); }
		catch (_) { throw new Error("逐段翻译返回的 JSON 无效"); }
		if (!Array.isArray(output)) throw new Error("逐段翻译必须返回带段落 ID 的数组");
		let found = new Map();
		for (let item of output) {
			if (found.has(item.id) || !input.some(source => source.id === item.id)) throw new Error("译文出现重复或未知段落 ID");
			found.set(item.id, item.text);
		}
		return items.map(item => {
			let text = found.get(item.id), expected = item.text.match(/⟦K\d+⟧/g) || [];
			if (typeof text !== "string" || !text.trim() || JSON.stringify(text.match(/⟦K\d+⟧/g) || []) !== JSON.stringify(expected)) return null;
			return text;
		});
	},

	async runAlignedTranslationTask(task) {
		let settings = task.settings, signal = task.controller.signal;
		let status = text => { signal.throwIfAborted(); task.detail = text; this.setTaskStep?.(task, task.saving ? "save" : "work", task.saving ? "保存译文" : "逐段翻译", text); this.refreshParseQueueDialog(); };
		let budget = this.translationBatchBudget(settings), retryAt = 0;
		if (!task.translation?.units || task.translation.language !== settings.translateLanguage || task.translation.budget !== budget) {
			status("读取自然段与来源");
			let { filePath, markdown } = await this.readSourceMarkdown(task.mineruSource);
			signal.throwIfAborted(); status("读取全文插图与附件资源");
			let source = await this.inlineStoredImagesInMarkdownAttachment({ markdownText: markdown, markdownPath: filePath, signal,
				onImage: count => { if (count === 1 || count % 10 === 0) status(`已读取 ${count} 张插图，正在整理全文资源`); } });
			signal.throwIfAborted(); status("整理自然段与受保护引用");
			let units = this.translationUnits(source.markdownText, settings);
			if (!units.length) throw new Error("Markdown 内容为空");
			task.translation = { language: settings.translateLanguage, budget, units, images: source.embeddedImages };
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
						let output = await this.translateAlignedBatch(remaining, settings, signal);
						error = null;
						remaining.forEach((item, index) => { if (output[index]) item.unit.translated[item.index] = output[index]; });
						remaining = remaining.filter(item => !item.unit.translated[item.index]);
					} catch (e) {
						signal.throwIfAborted(); error = e;
						if (e.status === 429) retryAt = Math.max(retryAt, Date.now() + (e.retryAfterMS > 0 ? e.retryAfterMS : 30000 * 2 ** attempt));
					}
				}
				if (remaining.length) {
					data.lastError = error?.message || "译文漏段或受保护结构发生变化";
					for (let item of remaining) item.error = data.lastError;
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
				settings = task.settings;
				budget = this.translationBatchBudget(settings); retryAt = 0;
			}
		}
		signal.throwIfAborted();
		let pairs = units.map(unit => {
			let complete = unit.translated.filter(Boolean).length === unit.fragments.length;
			let translated = complete ? unit.prefix + unit.translated.join("").replace(/⟦K(\d+)⟧/g, (_m, index) => unit.protectedParts[Number(index)]) : "**未翻译**\n\n" + unit.source;
			return { id: unit.id, source: unit.source, translated, page: unit.page, pages: unit.pages, complete };
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
