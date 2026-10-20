// Explicit OCRFlow document actions. Service and rendering code lives in docflow.js.
Object.assign(DocFlow, {
	parseWithMineru: DocFlow.parseAttachmentWithMineru,

	getContextMenuDefinitions() {
		return [
			{ id: "docflow-create-parent", label: "建立父条目", l10nID: "docflow-menu-create-parent",
				getTasks: items => this.collectSourceFiles(items).filter(item => !this.parentForDocument(item)),
				run: options => this.handleDocumentCommand("parent", options), errorPrefix: "建立父条目失败" },
			{ id: this.CONTEXT_MENU_ID, label: "建立文本 OCR / 转为 Markdown", l10nID: "docflow-menu-parse-pdf",
				getTasks: items => this.collectSourceFiles(items),
				children: this.getOCRMenuDefinitions(),
				run: options => this.handleParseCommand(options), errorPrefix: "全文提取失败" },
			{ id: "docflow-fill-metadata", label: "补充父条目信息", l10nID: "docflow-menu-fill-metadata",
				getTasks: items => this.collectDocumentTasks(items),
				run: options => this.handleDocumentCommand("metadata", options), errorPrefix: "补充信息失败" },
			{ id: this.SUMMARY_MENU_ID, label: "总结文档", l10nID: "docflow-menu-ai-summary",
				getTasks: items => this.collectDocumentTasks(items),
				run: options => this.handleDocumentCommand("summary", options), errorPrefix: "总结失败" },
			{ id: this.TRANSLATE_MENU_ID, label: "翻译文档", l10nID: "docflow-menu-ai-translate",
				getTasks: items => this.collectTranslateTasks(items),
				run: options => this.handleTranslateCommand(options), errorPrefix: "翻译失败" },
			{ id: "docflow-generate-outline", label: "生成阅读器大纲", l10nID: "docflow-menu-outline",
				getTasks: items => this.outline?.collectPDFs(items) || [],
				run: ({ selectedItems }) => this.outline.enqueueSelected(selectedItems), errorPrefix: "大纲生成失败" }
		];
	},

	getOCRSourceFiles(items, parserService) {
		let files = this.collectSourceFiles(items);
		return ["mineru", "ai"].includes(parserService)
			? files.filter(file => ["pdf", "png", "jpg", "jpeg"].includes(this.documentExtension(file))) : files;
	},

	getOCRMenuDefinitions() {
		return [
			{ id: "default", label: "使用设置中的服务" },
			{ id: "mineru-local", label: "MinerU（本地服务）", parserService: "mineru", apiMode: "local-v1" },
			{ id: "mineru-cloud", label: "MinerU（官方云端）", parserService: "mineru", apiMode: "cloud" },
			{ id: "markitdown", label: "MarkItDown", parserService: "markitdown" },
			{ id: "ai", label: "AI 视觉 OCR", parserService: "ai" }
		].map(choice => ({
			id: `docflow-ocr-${choice.id}`, label: choice.label, l10nID: `docflow-menu-ocr-${choice.id}`,
			getTasks: items => this.getOCRSourceFiles(items, choice.parserService),
			run: options => this.handleParseCommand({ ...options, parserService: choice.parserService, apiMode: choice.apiMode }),
			errorPrefix: "全文提取失败"
		}));
	},

	parentForDocument(item) {
		if (item?.isRegularItem?.()) return item;
		let id = item?.parentItemID || item?.parentID;
		return id ? Zotero.Items.get(id) : null;
	},

	documentExtension(item) {
		return String(item?.attachmentFilename || item?.getField?.("title") || "").match(/\.([^.]+)$/)?.[1].toLowerCase() ||
			(item?.isPDFAttachment?.() ? "pdf" : "");
	},

	isMarkdownResult(item) {
		if (!item?.isAttachment?.() || item.deleted) return false;
		let ext = this.documentExtension(item);
		return ["md", "markdown"].includes(ext) ||
			(["html", "htm"].includes(ext) && item.getTags().some(tag => tag.tag === "#DocFlow-Parse"));
	},

	collectSourceFiles(items) {
		let files = new Map();
		let add = item => {
			if (!item?.isAttachment?.() || item.deleted || item.getTags().some(tag => tag.tag.startsWith("#DocFlow-"))) return;
			if (["pdf", "epub", "docx", "pptx", "xlsx", "html", "htm", "txt", "md", "markdown", "csv", "jpg", "jpeg", "png"].includes(this.documentExtension(item))) files.set(item.id, item);
		};
		for (let item of items) {
			if (item.isRegularItem?.()) for (let id of item.getAttachments()) add(Zotero.Items.get(id));
			else add(item);
		}
		return [...files.values()];
	},

	relatedDocuments(item) {
		return (item.relatedItems || []).map(key => Zotero.Items.getByLibraryAndKey(item.libraryID, key)).filter(item => item && !item.deleted);
	},

	findDocumentMarkdown(item) {
		if (this.isMarkdownResult(item)) return item;
		let related = this.relatedDocuments(item).filter(doc => this.isMarkdownResult(doc));
		if (related.length) return related.sort((a, b) => String(a.dateAdded || "").localeCompare(String(b.dateAdded || "")) || a.id - b.id).at(-1);
		// Old results without a relation are unambiguous only with one original and one result.
		let parent = this.parentForDocument(item);
		if (!parent) return null;
		let results = parent.getAttachments().map(id => Zotero.Items.get(id)).filter(doc => this.isMarkdownResult(doc));
		return results.length === 1 && this.collectSourceFiles([parent]).length === 1 ? results[0] : null;
	},

	collectDocumentTasks(items) {
		let tasks = new Map();
		let add = item => {
			let source = this.findDocumentMarkdown(item);
			let original = source ? this.relatedDocuments(source).find(doc => !this.isMarkdownResult(doc) && doc.isAttachment?.()) : null;
			let attachment = original || item;
			let key = source?.id || attachment.id;
			if (!tasks.has(key)) tasks.set(key, { attachment, source, explicitSource: this.isMarkdownResult(item), parentItem: this.parentForDocument(attachment) });
		};
		for (let item of items) {
			if (item.isRegularItem?.() || item.isNote?.()) {
				let parent = this.parentForDocument(item);
				if (!parent) continue;
				let files = this.collectSourceFiles([parent]);
				if (files.length) files.forEach(add);
				else parent.getAttachments().map(id => Zotero.Items.get(id)).filter(doc => this.isMarkdownResult(doc)).forEach(add);
			} else if (item.isAttachment?.()) add(item);
		}
		return [...tasks.values()];
	},

	validateAISettings(settings) {
		if (!settings.apiBaseURL || !settings.model) throw new Error("请先在 OCRFlow 设置中填写 AI 接口地址和模型；本地免密服务的 Key 可留空。");
		settings.summaryRequestParams = this.parseOptionalJSONObject(settings.summaryRequestJSON, "AI 额外 JSON 参数");
		return settings;
	},

	async handleDocumentCommand(kind, { window = null, selectedItems = null } = {}) {
		let items = selectedItems || window?.ZoteroPane?.getSelectedItems?.() || [];
		let settings = this.validateAISettings(this.getLLMSettings(kind));
		let tasks = kind === "parent"
			? this.collectSourceFiles(items).filter(item => !this.parentForDocument(item)).map(attachment => ({ attachment }))
			: this.collectDocumentTasks(items);
		if (!tasks.length) throw new Error(kind === "parent" ? "请选择尚无父条目的文件附件。" : "请选择文档附件或包含文档的父条目。");
		await this.enqueueDocumentTasks(kind, tasks, settings);
	},

	async handleParseCommand({ window = null, selectedItems = null, parserService, apiMode } = {}) {
		let settings = this.getSettings(apiMode);
		if (parserService) settings.parserService = parserService;
		let items = selectedItems || window?.ZoteroPane?.getSelectedItems?.() || [];
		let tasks = this.getOCRSourceFiles(items, parserService).map(attachment => ({ attachment, parentItem: this.parentForDocument(attachment) }));
		if (!tasks.length) throw new Error("请选择需要提取全文的原始文件。");
		await this.enqueueDocumentTasks("parse", tasks, settings);
	},

	async enqueueDocumentTasks(kind, tasks, settings) {
		for (let task of tasks) {
			if (this.parseQueue.some(row => row.kind === kind && row.attachment.id === task.attachment.id && ["queued", "running", "stopping"].includes(row.state))) continue;
			this.parseQueue.push({ ...task, kind, settings: { ...settings }, id: this.parseQueueNextID++, state: "queued",
				title: task.title || task.attachment.getField("title") || task.attachment.attachmentFilename,
				detail: "等待处理", error: "", jobID: null, parsedResult: null });
		}
		this.openParseQueueDialog();
		this.refreshParseQueueDialog();
		await this.processParseQueue();
	},

	async requestDocumentAI(messages, settings, signal, json = false) {
		this.validateAISettings(settings);
		let payload = this.mergeRequestPayload({ model: settings.model, stream: false, temperature: 0,
			messages, ...(json ? { response_format: { type: "json_object" } } : {}) }, settings.summaryRequestParams, ["model", "messages", "stream", "response_format"]);
		this.applyAIContextBudget(payload, settings);
		let endpoint = settings.apiBaseURL.replace(/\/+$/, "");
		if (!endpoint.endsWith("/chat/completions")) endpoint += "/chat/completions";
		if (new URL(endpoint).hostname === "api.xiaomimimo.com" && !payload.thinking) payload.thinking = { type: "disabled" };
		let controller = this.createAbortController();
		let abort = () => controller.abort();
		if (signal?.aborted) signal.throwIfAborted();
		signal?.addEventListener("abort", abort, { once: true });
		let timer = setTimeout(abort, 180000);
		try {
			let response = await fetch(endpoint, { method: "POST", signal: controller.signal,
				headers: { "Content-Type": "application/json", ...(settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {}) }, body: JSON.stringify(payload) });
			if (!response.ok) throw new Error(`AI 接口请求失败 ${response.status}: ${(await response.text()).slice(0, 500)}`);
			let data = await response.json();
			let choice = data.choices?.[0];
			if (choice?.finish_reason === "length") throw this.aiOutputLimitError(payload, data);
			let text = choice?.message?.content;
			if (typeof text !== "string" || !text.trim()) throw new Error(data.error?.message || "AI 未返回文本。");
			return text.trim();
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
		}
	},

	async requestMetadataAI(messages, settings, signal) {
		return this.requestDocumentAI(messages, settings, signal, true);
	},

	async runDocumentTask(task) {
		let signal = task.controller.signal;
		let settings = this.validateAISettings(task.settings);
		let attachment = Zotero.Items.get(task.attachment.id);
		if (!attachment || attachment.deleted) throw new Error("原文档已删除。");
		if (task.kind === "parent") {
			if (this.parentForDocument(attachment)) return;
			task.detail = "AI 正在读取文件名";
			this.refreshParseQueueDialog();
			let filename = attachment.attachmentFilename || attachment.getField("title");
			let metadata = await this.identify("", filename, true, {}, settings, signal);
			signal.throwIfAborted();
			task.saving = true;
			await this.createDocumentParent(attachment, metadata);
			return;
		}
		let parent = this.parentForDocument(attachment);
		if (!parent) throw new Error("请先执行“建立父条目”。");
		let source = task.explicitSource ? task.source : this.findDocumentMarkdown(attachment);
		if (source?.deleted) throw new Error("选中的 Markdown 已删除，请重新选择文档。");
		if (!source) throw new Error("没有找到与此文档关联的 Markdown，请先执行“建立文本 OCR / 转为 Markdown”。");
		task.detail = "读取 Markdown";
		this.refreshParseQueueDialog();
		let { markdown } = await this.readSourceMarkdown(source);
		let text = this.removeLocalImageReferences(markdown);
		if (!text.trim()) throw new Error("Markdown 内容为空。");
		if (task.kind === "metadata") {
			await parent.loadAllData();
			let current = {};
			for (let field of this.metadataFields) {
				if (Zotero.ItemFields.isValidForType(field, parent.itemTypeID)) current[field] = parent.getField(field);
			}
			current.creators = parent.getCreatorsJSON();
			let chunks = this.splitAIText(text, settings);
			let completed = 0;
			let results = await this.mapAIWork(chunks, settings.concurrency, async chunk => {
				let identified = await this.identify(chunk, attachment.attachmentFilename || attachment.getField("title"), false, current, settings, signal);
				task.detail = `识别书目信息 ${++completed}/${chunks.length}`;
				this.refreshParseQueueDialog();
				return identified;
			}, signal);
			let metadata = current;
			for (let [i, identified] of results.entries()) {
				// Earlier publication pages take precedence over citations in later chapters.
				if (i === 0) metadata = identified;
				else for (let [key, value] of Object.entries(identified)) {
					if ((!metadata[key] || (Array.isArray(metadata[key]) && !metadata[key].length)) && value) metadata[key] = value;
				}
			}
			signal.throwIfAborted();
			task.saving = true;
			await Zotero.DB.executeTransaction(async () => {
				this.applyMetadata(parent, metadata);
				await parent.save({ notifierData: { skipRenameFile: true } });
			});
		} else {
			let summary = await this.summarizeDocument(text, settings, signal, detail => {
				task.detail = detail; this.refreshParseQueueDialog();
			});
			signal.throwIfAborted();
			task.saving = true;
			await this.saveDocumentSummary(parent, attachment, summary);
		}
	},

	async createDocumentParent(attachment, metadata) {
		let linked = this.relatedDocuments(attachment).filter(item => this.isMarkdownResult(item));
		let parent;
		await Zotero.DB.executeTransaction(async () => {
			if (this.parentForDocument(attachment)) return;
			parent = new Zotero.Item("document");
			parent.libraryID = attachment.libraryID;
			parent.setCollections(attachment.getCollections());
			this.applyMetadata(parent, metadata);
			await parent.save();
			for (let item of [attachment, ...linked]) {
				if (this.parentForDocument(item)) continue;
				item.parentID = parent.id;
				await item.save({ notifierData: { skipRenameFile: true } });
			}
		});
		return parent;
	},

	splitDocumentText(text, limit = 40000) {
		let chunks = [];
		for (let start = 0; start < text.length;) {
			let end = Math.min(start + limit, text.length);
			if (end < text.length) {
				let paragraph = text.lastIndexOf("\n\n", end);
				if (paragraph > start + limit / 2) end = paragraph + 2;
			}
			chunks.push(text.slice(start, end));
			start = end;
		}
		return chunks;
	},

	// UTF-8 bytes provide a conservative token estimate for text across the supported languages.
	estimateAITokens(text) {
		let bytes = 0;
		for (let char of String(text)) {
			let code = char.codePointAt(0);
			bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
		}
		return bytes;
	},

	getAIOutputBudget(settings) {
		let params = settings.translateRequestParams || settings.summaryRequestParams || this.parseOptionalJSONObject(settings.summaryRequestJSON, "请求参数");
		let longOutput = ["translate", "ocr"].includes(settings.workKind);
		let cap = settings.workKind === "translate" ? 16384 : longOutput || settings.workKind === "summary" ? 8192 : 4096;
		return Number(params.max_completion_tokens || params.max_tokens) || settings.outputTokens || Math.min(cap, Math.floor((settings.contextWindow || 32768) / (longOutput ? 2 : 4)));
	},

	getAIChunkBudget(settings) {
		let prompt = OCRFlowPrompts.get(settings.workKind, settings.workPrompt, settings.workKind === "translate" ? settings.translateLanguage : settings.summaryLanguage);
		let overhead = Math.max(["metadata", "parent"].includes(settings.workKind) ? 8192 : 1024, this.estimateAITokens(prompt) + 512);
		let budget = (settings.contextWindow || 32768) - this.getAIOutputBudget(settings) - overhead;
		if (budget < 256) throw new Error("上下文窗口不足以容纳提示词和输出，请增大上下文窗口或减少输出参数。");
		return budget;
	},

	splitAIText(text, settings, limit = 40000) {
		if (!settings.workKind) return this.splitDocumentText(text, limit);
		let budget = this.getAIChunkBudget(settings), chunks = [];
		for (let chunk of this.splitDocumentText(text, Math.min(limit, budget))) {
			while (chunk.length) {
				let low = 1, high = chunk.length;
				while (low < high) {
					let mid = Math.ceil((low + high) / 2);
					if (this.estimateAITokens(chunk.slice(0, mid)) <= budget) low = mid;
					else high = mid - 1;
				}
				let end = low;
				if (end < chunk.length && /[\uDC00-\uDFFF]/.test(chunk[end])) end--;
				chunks.push(chunk.slice(0, end)); chunk = chunk.slice(end);
			}
		}
		return chunks;
	},

	applyAIContextBudget(payload, settings) {
		if (!settings.workKind) return;
		let input = 256;
		for (let message of payload.messages) {
			if (typeof message.content === "string") input += this.estimateAITokens(message.content);
			else for (let part of message.content) input += part.type === "image_url" ? 4096 : this.estimateAITokens(part.text || "");
		}
		let output = this.getAIOutputBudget({ ...settings, summaryRequestParams: payload, translateRequestParams: null });
		if (input + output > settings.contextWindow) throw new Error("请求超过设定的上下文窗口，请增大窗口、缩短 Prompt 或减少输出上限后重试。");
		if (!payload.max_tokens && !payload.max_completion_tokens) payload.max_tokens = output;
	},

	async mapAIWork(items, concurrency = 1, run, signal) {
		let next = 0, failed = false, results = new Array(items.length);
		let worker = async () => {
			while (!failed && next < items.length) {
				signal?.throwIfAborted();
				let index = next++;
				try { results[index] = await run(items[index], index); }
				catch (error) { failed = true; throw error; }
			}
		};
		let workers = await Promise.allSettled(Array.from({ length: Math.min(concurrency || 1, items.length) }, worker));
		let failure = workers.find(result => result.status === "rejected");
		if (failure) throw failure.reason;
		return results;
	},

	async summarizeDocument(text, settings, signal, onStatus = () => {}) {
		let language = settings.summaryLanguage || "中文";
		let prompt = OCRFlowPrompts.get("summary", settings.workPrompt || settings.summaryPrompt, language);
		let chunks = this.splitAIText(text, settings);
		let level = 0;
		while (chunks.length > 1) {
			let summaries = await this.mapAIWork(chunks, settings.concurrency, async (chunk, index) => {
				onStatus(`整理${level ? "分段摘要" : "全文"} ${index + 1}/${chunks.length}`);
				return this.requestDocumentAI([
					{ role: "system", content: `${prompt}\n这是文档的一部分。只总结本部分的信息，保留关键论据、数据和结论；输出不超过 1500 字。` },
					{ role: "user", content: chunk }
				], settings, signal);
			}, signal);
			let combined = summaries.map((text, i) => `## 部分 ${i + 1}\n${text}`).join("\n\n");
			if (combined.length >= chunks.join("").length) throw new Error("分段摘要未能缩短内容，请调整总结提示词或模型后重试。");
			chunks = this.splitAIText(combined, settings);
			level++;
		}
		onStatus("生成学术总结");
		return this.requestDocumentAI([{ role: "system", content: prompt },
			{ role: "user", content: (level ? "请整合以下分段摘要，保留不同章节的重要信息：\n\n" : "请总结以下文档：\n\n") + chunks[0] }], settings, signal);
	},

	async saveDocumentSummary(parent, attachment, summary) {
		let title = `学术总结｜${attachment.getField("title") || attachment.attachmentFilename}`;
		let note = parent.getNotes().map(id => Zotero.Items.get(id)).find(item => !item.deleted &&
			item.hasTag("#DocFlow-Summary") && (item.relatedItems || []).includes(attachment.key));
		if (!note) {
			note = new Zotero.Item("note");
			note.libraryID = parent.libraryID;
			note.parentID = parent.id;
		}
		note.setNote(this.ensureNoteTitleInHTML(this.convertMarkdownToBasicHTML(summary), title));
		note.addTag("#DocFlow-Summary", 0);
		note.addRelatedItem(attachment);
		await note.saveTx();
		return note;
	},

	async parseAttachmentWithMineru(attachment, settings, options = {}) {
		let ext = this.documentExtension(attachment);
		let image = ["png", "jpg", "jpeg"].includes(ext);
		if (ext !== "pdf" && !image) settings.outputFormat = "md";
		if (["txt", "md", "markdown", "csv"].includes(ext)) {
			let bytes = await IOUtils.read(await attachment.getFilePath());
			return { markdownText: new TextDecoder("utf-8").decode(bytes), embeddedImages: [] };
		}
		if ((!image && ext !== "pdf") || settings.parserService === "markitdown") {
			return this.parseWithMarkItDown(attachment, settings, options);
		}
		if (settings.parserService === "ai") return this.parseWithVision(attachment, settings.llmSettings, options);
		if (settings.apiMode !== "local-v1" && !settings.apiToken) throw new Error("请先填写 MinerU 官方 API Token，或选择本地 MinerU、MarkItDown、AI OCR。");
		if (!image) return this.parseWithMineru(attachment, settings, options);
		let bytes = await IOUtils.read(await attachment.getFilePath());
		let pdf = await this.getPDFLibrary().PDFDocument.create();
		let embedded = ext === "png" ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
		let page = pdf.addPage([embedded.width, embedded.height]);
		page.drawImage(embedded, { x: 0, y: 0, width: embedded.width, height: embedded.height });
		let context = { ...options, phase: "图片转为 PDF", jobID: options.jobID || null };
		let pdfBytes = await pdf.save();
		return settings.apiMode === "local-v1"
			? this.parseAttachmentWithLocalV1(pdfBytes, "image.pdf", settings, context)
			: this.parseAttachmentWithCloud(pdfBytes, "image.pdf", attachment.id,
				{ ...settings, recognitionLanguage: this.cloudRecognitionLanguage(attachment, settings.cloudLanguage) }, context);
	},

	async parseWithMarkItDown(attachment, settings, options) {
		if (!settings.markitdownBaseURL) throw new Error("请先在 OCRFlow 设置中填写 MarkItDown 服务地址。");
		let path = await attachment.getFilePath();
		if (!path) throw new Error("附件文件尚未下载。");
		let bytes = await IOUtils.read(path);
		let win = Zotero.getMainWindow();
		options.onStatus?.({ phase: "MarkItDown 转换", displayText: "上传并转换全文" });
		let controller = this.createAbortController();
		let abort = () => controller.abort();
		options.signal?.throwIfAborted();
		options.signal?.addEventListener("abort", abort, { once: true });
		let timer = setTimeout(abort, settings.timeoutMS || 120000);
		try {
			let connection = await OCRFlowMarkItDown.connect(settings.markitdownBaseURL, controller.signal);
			let result;
			if (connection.mode === "mcp") {
				connection.beforeConvert = () => {
					clearTimeout(timer);
					timer = setTimeout(abort, settings.timeoutMS || 120000);
				};
				if (this.documentExtension(attachment) === "pdf" && bytes.length > 2 * 1024 * 1024) {
					return await this.convertPDFInParts(bytes, connection, options);
				}
				let mime = attachment.attachmentContentType || ({ epub: "application/epub+zip", pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })[this.documentExtension(attachment)] || "application/octet-stream";
				try {
					result = { markdown: await OCRFlowMarkItDown.convert(connection, `data:${mime};base64,${this.bytesToBase64(bytes)}`) };
				} catch (error) {
					if (error.status !== 413) throw error;
					if (this.documentExtension(attachment) === "epub") return await this.convertEPUBInParts(path, connection, options);
					if (this.documentExtension(attachment) === "pdf") return await this.convertPDFInParts(bytes, connection, options);
					throw error;
				}
			} else {
				let form = new win.FormData();
				form.append("file", new win.Blob([bytes], { type: attachment.attachmentContentType || "application/octet-stream" }), this.fileNameFromPath(path));
				let response = await win.fetch(connection.endpoint + "/v1/convert", { method: "POST", body: form, signal: controller.signal });
				if (!response.ok) throw new Error(`MarkItDown 请求失败 ${response.status}: ${(await response.text()).slice(0, 500)}`);
				result = await response.json();
			}
			if (typeof result.markdown !== "string" || !result.markdown.trim()) throw new Error("MarkItDown 未返回正文；扫描件请在设置中选择 MinerU 或 AI 视觉 OCR 后重试。");
			return this.inlineStoredImagesInMarkdownAttachment({ markdownText: result.markdown, markdownPath: path });
		} finally {
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", abort);
		}
	},

	async convertPDFInParts(bytes, connection, options) {
		options.onStatus?.({ phase: "MarkItDown 分页转换", displayText: "正在拆分 PDF，避免上传消息过大" });
		let { PDFDocument } = this.getPDFLibrary();
		let source = await PDFDocument.load(this.bytesToBase64(bytes));
		let count = source.getPageCount(), markdown = [], hasEmptyParts = false;
		let convert = async (start, end) => {
			connection.signal?.throwIfAborted();
			let split = async () => {
				let middle = Math.floor((start + end) / 2);
				await convert(start, middle); await convert(middle, end);
			};
			let part = await PDFDocument.create();
			for (let page of await part.copyPages(source, source.getPageIndices().slice(start, end))) part.addPage(page);
			let partBytes = await part.save();
			if (partBytes.length > 2 * 1024 * 1024 && end - start > 1) return split();
			options.onStatus?.({ phase: "MarkItDown 分页转换", displayText: `转换第 ${start + 1}～${end} 页 / 共 ${count} 页` });
			let text;
			try { text = await OCRFlowMarkItDown.convert(connection, `data:application/pdf;base64,${this.bytesToBase64(partBytes)}`); }
			catch (error) {
				if (error.status !== 413) throw error;
				if (end - start > 1) return split();
				throw new Error(`PDF 第 ${start + 1} 页单页仍超过 MarkItDown 上传限制，请选择 MinerU 或 AI 视觉 OCR。`);
			}
			if (text.trim()) markdown.push(text);
			else hasEmptyParts = true;
		};
		for (let start = 0; start < count; start += 16) await convert(start, Math.min(start + 16, count));
		if (!markdown.length) throw new Error("MarkItDown 未提取到 PDF 文字，扫描件请在右键菜单中选择 MinerU 或 AI 视觉 OCR。");
		return { markdownText: markdown.join("\n\n"), embeddedImages: [],
			warning: hasEmptyParts ? "部分分段未提取到文字，可能包含扫描页；需要 OCR 时请选择 MinerU 或 AI 视觉 OCR。" : null };
	},

	async readEPUBForMarkItDown(path, signal) {
		let tempDir = PathUtils.join(PathUtils.tempDir, `ocrflow-epub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
		await IOUtils.makeDirectory(tempDir, { createAncestors: true });
		let zip = Components.classes["@mozilla.org/libjar/zip-reader;1"].createInstance(Components.interfaces.nsIZipReader);
		let parser = new (Zotero.getMainWindow().DOMParser)();
		let read = async name => {
			signal?.throwIfAborted();
			return new TextDecoder("utf-8").decode(await this.readZipEntryBytes(zip, tempDir, name));
		};
		try {
			zip.open(this.pathToNSIFile(path));
			let container = parser.parseFromString(await read("META-INF/container.xml"), "application/xml");
			let opfPath = container.getElementsByTagNameNS("*", "rootfile")[0]?.getAttribute("full-path");
			if (!opfPath) throw new Error("EPUB 缺少正文目录文件。");
			let opf = parser.parseFromString(await read(opfPath), "application/xml");
			let manifest = new Map(Array.from(opf.getElementsByTagNameNS("*", "item"), item => [item.getAttribute("id"), item.getAttribute("href")]));
			let spine = Array.from(opf.getElementsByTagNameNS("*", "itemref"), item => manifest.get(item.getAttribute("idref")));
			if (!spine.length || spine.some(href => !href)) throw new Error("EPUB 正文阅读顺序不完整。");
			let metadata = [];
			for (let [field, label] of [["title", "Title"], ["creator", "Authors"], ["language", "Language"], ["publisher", "Publisher"], ["date", "Date"], ["description", "Description"], ["identifier", "Identifier"]]) {
				let value = Array.from(opf.getElementsByTagNameNS("http://purl.org/dc/elements/1.1/", field), node => node.textContent.trim()).filter(Boolean).join(", ");
				if (value) metadata.push(`**${label}:** ${value}`);
			}
			let bodies = [];
			for (let href of spine) {
				let name = this.resolveArchiveReference(opfPath, href);
				let chapter = parser.parseFromString(await read(name), "text/html");
				for (let image of chapter.querySelectorAll("img[src]")) {
					let src = image.getAttribute("src");
					if (!this.isExternalResourceURL(src)) image.setAttribute("src", this.resolveArchiveReference(name, src));
				}
				bodies.push(`<section>${chapter.body.innerHTML}</section>`);
			}
			let inlined = await this.inlineArchiveImagesInMarkdown({ markdownText: bodies.join("\n"), markdownEntryName: "",
				zipReader: zip, tempDir, entryMap: this.buildArchiveEntryMap(zip) });
			return { metadata: metadata.join("\n"), html: inlined.markdownText, embeddedImages: inlined.embeddedImages, chapters: spine.length };
		} finally {
			try { zip.close(); } catch (_) {}
			await IOUtils.remove(tempDir, { recursive: true }).catch(() => {});
		}
	},

	splitMarkItDownHTML(html) {
		let doc = new (Zotero.getMainWindow().DOMParser)().parseFromString(html, "text/html");
		let encoder = new TextEncoder(), limit = 256 * 1024;
		let serialize = node => node.nodeType === 1 ? node.outerHTML : this.escapeHTML(node.textContent);
		let split = node => {
			if (node.nodeType !== 1 && node.nodeType !== 3) return [];
			let text = serialize(node);
			if (encoder.encode(text).length <= limit) return [text];
			if (node.nodeType === 3) {
				let chars = Array.from(node.textContent), middle = Math.floor(chars.length / 2);
				return [chars.slice(0, middle), chars.slice(middle)].flatMap(part => split(doc.createTextNode(part.join(""))));
			}
			if (!node.childNodes.length) throw new Error("EPUB 中的单个元素过大，无法分批传输。");
			return Array.from(node.childNodes).flatMap(split).map(part => {
				let wrapper = node.cloneNode(false); wrapper.innerHTML = part; return wrapper.outerHTML;
			});
		};
		let chunks = [], current = "", size = 0;
		for (let part of Array.from(doc.body.childNodes).flatMap(split)) {
			let bytes = encoder.encode(part).length;
			if (current && size + bytes > limit) { chunks.push(current); current = ""; size = 0; }
			current += part; size += bytes;
		}
		if (current) chunks.push(current);
		return chunks;
	},

	async convertEPUBInParts(path, connection, options) {
		options.onStatus?.({ phase: "MarkItDown 分批转换", displayText: "上传超出服务限制，正在按阅读顺序拆分 EPUB" });
		let source = await this.readEPUBForMarkItDown(path, connection.signal);
		let chunks = this.splitMarkItDownHTML(source.html), markdown = [];
		for (let i = 0; i < chunks.length; i++) {
			connection.signal?.throwIfAborted();
			options.onStatus?.({ phase: "MarkItDown 分批转换", displayText: `转换第 ${i + 1}/${chunks.length} 批（共 ${source.chapters} 个正文片段）` });
			let html = '<!doctype html><html><head><meta charset="utf-8"></head><body>' + chunks[i] + '</body></html>';
			markdown.push(await OCRFlowMarkItDown.convert(connection, `data:text/html;base64,${this.bytesToBase64(new TextEncoder().encode(html))}`));
		}
		if (!markdown.some(text => text.trim())) throw new Error("MarkItDown 未返回 EPUB 正文。");
		return { markdownText: [source.metadata, ...markdown].filter(Boolean).join("\n\n"), embeddedImages: source.embeddedImages || [] };
	},

	async parseWithVision(attachment, settings, options) {
		this.validateAISettings(settings);
		let pages = [], signal = options.signal;
		let recognize = async (url, page, total) => {
			signal?.throwIfAborted();
			options.onStatus?.({ phase: "AI 视觉 OCR", displayText: `识别第 ${page}/${total} 页` });
			let markdown = await this.requestDocumentAI([
				{ role: "system", content: OCRFlowPrompts.get("ocr", settings.workPrompt) },
				{ role: "user", content: [{ type: "text", text: `请识别第 ${page} 页。` }, { type: "image_url", image_url: { url } }] }
			], settings, signal);
			pages[page - 1] = { page, text: markdown };
		};
		if (attachment.isPDFAttachment?.()) {
			let reader = Zotero.Reader._readers.find(reader => reader.itemID === attachment.id && !reader._isTabClosed)
				|| await Zotero.Reader.open(attachment.id, undefined, { openInBackground: true });
			if (!reader) throw new Error("请打开此 PDF 后再次执行 AI OCR。");
			await reader._initPromise;
			await reader._internalReader?._primaryView?.initializedPromise;
			let app = this.outline.getReaderApp(reader);
			if (!app?.pdfDocument) throw new Error("PDF 阅读器尚未就绪，请稍后重试。");
			let viewWindow = reader._internalReader._primaryView._iframeWindow;
			viewWindow = viewWindow.wrappedJSObject || viewWindow;
			await this.mapAIWork(Array.from({ length: app.pdfDocument.numPages }, (_, i) => i + 1), settings.concurrency, async i => {
				signal?.throwIfAborted();
				let page = await app.pdfDocument.getPage(i);
				page = page.wrappedJSObject || page;
				// PDF.js must receive options created in the reader's script scope.
				let native = page.getViewport(Object.assign(new viewWindow.Object(), { scale: 1 }));
				let viewport = page.getViewport(Object.assign(new viewWindow.Object(), { scale: Math.min(2, 2000 / Math.max(native.width, native.height)) }));
				let doc = viewWindow.document;
				let canvas = doc.createElement("canvas");
				canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
				try {
					await page.render(Object.assign(new viewWindow.Object(), { canvasContext: canvas.getContext("2d"), viewport, background: "white" })).promise;
					await recognize(canvas.toDataURL("image/jpeg", 0.92), i, app.pdfDocument.numPages);
				} finally { canvas.width = 0; canvas.height = 0; }
			}, signal);
		} else {
			let bytes = await IOUtils.read(await attachment.getFilePath());
			let mime = this.documentExtension(attachment) === "png" ? "image/png" : "image/jpeg";
			await recognize(`data:${mime};base64,${this.bytesToBase64(bytes)}`, 1, 1);
		}
		return { markdownText: pages.map(page => `<!-- 第 ${page.page} 页 -->\n\n${page.text}`).join("\n\n"),
			embeddedImages: [], outlinePages: pages.map(page => page.text) };
	}
});
