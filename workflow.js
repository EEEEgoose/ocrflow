// Explicit OCRFlow document actions. Service and rendering code lives in docflow.js.
Object.assign(DocFlow, {
	parseWithMineru: DocFlow.parseAttachmentWithMineru,

	getContextMenuDefinitions() {
		return [
			{ id: "docflow-organize", group: "quick", icon: "organize", label: "一键整理", l10nID: "docflow-menu-organize",
				getTasks: items => this.collectOrganizeTasks(items),
				run: options => this.handleOrganizeCommand(options), errorPrefix: "整理失败" },
			{ id: this.CONTEXT_MENU_ID, group: "document", icon: "ocr", label: "识别文档", l10nID: "docflow-menu-parse-pdf",
				getTasks: items => this.collectSourceFiles(items),
				children: this.getOCRMenuDefinitions(),
				run: options => this.handleParseCommand(options), errorPrefix: "全文提取失败" },
			{ id: "docflow-create-parent", group: "document", icon: "parent", label: "建立父条目", l10nID: "docflow-menu-create-parent",
				getTasks: items => this.collectSourceFiles(items).filter(item => !this.parentForDocument(item)),
				run: options => this.handleDocumentCommand("parent", options), errorPrefix: "建立父条目失败" },
			{ id: "docflow-fill-metadata", group: "document", icon: "metadata", label: "补全条目", l10nID: "docflow-menu-fill-metadata",
				getTasks: items => this.collectDocumentTasks(items),
				run: options => this.handleDocumentCommand("metadata", options), errorPrefix: "补充信息失败" },
			{ id: this.SUMMARY_MENU_ID, group: "reading", icon: "summary", label: "总结文献", l10nID: "docflow-menu-ai-summary",
				getTasks: items => this.collectDocumentTasks(items),
				run: options => this.handleDocumentCommand("summary", options), errorPrefix: "总结失败" },
			{ id: this.TRANSLATE_MENU_ID, group: "reading", icon: "translate", label: "翻译文献", l10nID: "docflow-menu-ai-translate",
				getTasks: items => this.collectTranslateTasks(items),
				run: options => this.handleTranslateCommand(options), errorPrefix: "翻译失败" },
			{ id: "docflow-generate-outline", group: "reading", icon: "outline", label: "生成大纲", l10nID: "docflow-menu-outline",
				getTasks: items => this.outline?.collectPDFs(items) || [],
				run: ({ selectedItems }) => this.outline.enqueueSelected(selectedItems), errorPrefix: "大纲生成失败" },
			{ id: "ocrflow-review-collation", group: "review", icon: "review", label: "审阅 OCR 校勘", l10nID: "ocrflow-menu-review-collation",
				getTasks: items => this.collectDocumentTasks(items).filter(task => task.source),
				run: options => this.openCollationReview(options), errorPrefix: "校勘打开失败" },
			{ id: "ocrflow-view-changes", group: "review", icon: "changes", label: "查看整理差异", l10nID: "ocrflow-menu-changes",
				getTasks: items => this.collectDocumentTasks(items).filter(task => task.source),
				run: options => this.openChangesReport(options), errorPrefix: "差异报告打开失败" }
		];
	},

	getOCRSourceFiles(items, parserService) {
		let files = this.collectSourceFiles(items);
		if (parserService === "marker") return files.filter(file => this.documentExtension(file) === "pdf");
		return ["mineru", "ai", "paddle-cloud", "paddle-local"].includes(parserService)
			? files.filter(file => ["pdf", "png", "jpg", "jpeg"].includes(this.documentExtension(file))) : files;
	},

	getOCRMenuDefinitions() {
		return [
			{ id: "default", label: "使用设置中的服务" },
			{ id: "mineru-local", label: "MinerU（本地服务）", parserService: "mineru", apiMode: "local-v1" },
			{ id: "mineru-cloud", label: "MinerU（官方云端）", parserService: "mineru", apiMode: "cloud" },
			{ id: "markitdown", label: "MarkItDown", parserService: "markitdown" },
			{ id: "paddle-cloud", label: "PaddleOCR（官方 API）", parserService: "paddle-cloud" },
			{ id: "paddle-local", label: "PaddleOCR（自部署 API）", parserService: "paddle-local" },
			{ id: "marker", label: "Marker（在线 / 自部署）", parserService: "marker" },
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
		let originals = parent.getAttachments().map(id => Zotero.Items.get(id)).filter(doc =>
			doc?.isAttachment?.() && !doc.deleted && doc.isFileAttachment?.() !== false && !doc.isLinkedURLAttachment?.() &&
			!doc.getTags().some(tag => tag.tag.startsWith("#DocFlow-")));
		return results.length === 1 && originals.length === 1 ? results[0] : null;
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
		if (!tasks.length) throw new Error("请选择需要识别文档的原始文件。");
		await this.enqueueDocumentTasks("parse", tasks, settings);
	},

	collectOrganizeTasks(items) {
		let tasks = new Map();
		let original = item => this.isMarkdownResult(item)
			? this.relatedDocuments(item).find(doc => doc.isAttachment?.() && !this.isMarkdownResult(doc) &&
				!doc.getTags().some(tag => tag.tag.startsWith("#DocFlow-"))) || item : item;
		let usable = item => item?.isAttachment?.() && !item.deleted && item.isFileAttachment?.() !== false &&
			!item.isLinkedURLAttachment?.() &&
			!item.getTags().some(tag => tag.tag.startsWith("#DocFlow-") && tag.tag !== "#DocFlow-Parse");
		let explicitParents = new Set(items.filter(usable).map(item => this.parentForDocument(item)?.id));
		for (let item of items) {
			if (item?.deleted) continue;
			if (item.isRegularItem?.()) {
				if (explicitParents.has(item.id)) continue;
				let files = item.getAttachments().map(id => Zotero.Items.get(id)).filter(usable);
				let originals = files.filter(file => !file.hasTag("#DocFlow-Parse"));
				if (originals.length) files = originals;
				if (files.length !== 1) {
					tasks.set(item.id, { attachment: item });
					continue;
				}
				item = files[0];
			}
			if (!usable(item)) continue;
			let attachment = original(item);
			tasks.set(attachment.id, { attachment,
				source: this.isMarkdownResult(item) ? item : null, explicitSource: this.isMarkdownResult(item) });
		}
		return [...tasks.values()];
	},

	getOrganizeSettings(apiMode) {
		return { ...this.getSettings(apiMode), metadataSettings: this.getLLMSettings("metadata"),
			outlineSettings:this.getLLMSettings("outline"), summarySettings:this.getLLMSettings("summary"), translationSettings:this.getLLMSettings("translate") };
	},

	async handleOrganizeCommand({ window = null, selectedItems = null } = {}) {
		let items = selectedItems || window?.ZoteroPane?.getSelectedItems?.() || [];
		let tasks = this.collectOrganizeTasks(items);
		if (!tasks.length) throw new Error("请选择需要整理的父条目或文件附件。");
		let settings = this.getOrganizeSettings();
		let fresh = [];
		for (let next of tasks) {
			let previous = this.parseQueue.find(task => task.kind === "organize" &&
				(task.attachment.id === next.attachment.id ||
					task.attachment.isRegularItem?.() && task.attachment.id === this.parentForDocument(next.attachment)?.id));
			if (!previous) fresh.push(next);
			else if (!previous.active && !previous.cancelFailed && !["queued", "running", "stopping"].includes(previous.state)) {
				previous.settings = previous.jobID
					? { ...this.getOrganizeSettings(previous.settings.apiMode), parserService: previous.settings.parserService }
					: { ...settings };
				previous.attachment = next.attachment;
				previous.explicitSource = next.explicitSource;
				if (next.explicitSource) previous.source = next.source;
				previous.state = "queued";
				previous.error = "";
			}
		}
		await this.enqueueDocumentTasks("organize", fresh, settings);
	},

	async runOrganizeTask(task) {
		let signal = task.controller.signal;
		let attachment = Zotero.Items.get(task.attachment.id);
		if (!attachment || attachment.deleted) throw new Error("待整理的条目已删除。");
		if (attachment.isRegularItem?.()) {
			let candidates = this.collectOrganizeTasks([attachment]);
			if (candidates[0]?.attachment.id === attachment.id) {
				task.state = "waiting";
				task.detail = attachment.getAttachments().length
					? "请直接选择要整理的原文件；需要一份可读取的主文档。"
					: "等待附件：添加文件后，点击“继续整理”。";
				return;
			}
			attachment = candidates[0].attachment;
			task.attachment = attachment;
		}
		let source = task.explicitSource ? task.source : this.findDocumentMarkdown(attachment);
		if (source?.deleted) throw new Error("选中的全文附件已删除，请重新选择文档。");
		if (source?.getTags().some(tag => tag.tag.startsWith("#DocFlow-") && tag.tag !== "#DocFlow-Parse")) source = null;
		if (!source && task.source && !task.source.deleted) source = task.source;
		if (!source || task.parsedResult) {
			let path = await attachment.getFilePath();
			if (!path || !await IOUtils.exists(path)) {
				task.state = "waiting";
				task.detail = "附件文件尚未在本机就绪；下载或恢复文件后，点击“继续整理”。";
				return;
			}
			task.detail = "识别文档";
			this.refreshParseQueueDialog();
			let saved = await this.runParseTask(task);
			if (!saved) return;
			source = saved.attachment;
			task.source = source;
			task.parseWarning = task.detail === "解析附件已保存" ? "" : task.detail;
			task.jobID = null;
			task.phase = "";
			task.saving = false;
		}
		task.source = source;
		this.setTaskStep?.(task,"extract","识别文档","全文已就绪，复用已保存结果","completed");
		task.resultAttachment ||= source;
		signal.throwIfAborted();
		if (task.organizeSourceID !== source.id) { task.organizeStages = {}; task.organizeSourceID = source.id; }
		let hadParent = !!this.parentForDocument(attachment);
		this.setTaskStep?.(task,"parent","建立条目",hadParent ? "已有父条目" : "从全文识别条目信息",hadParent ? "skipped" : "running");
		if (task.metadataSourceID !== source.id || !this.parentForDocument(attachment)) {
			let settings = this.validateAISettings(task.settings.metadataSettings);
			task.cancelSettings=settings;task.cancelJobID=null;
			task.detail = "读取正文中的书目信息";
			task.displaySettings = settings;
			this.setTaskStep?.(task, hadParent ? "metadata" : "parent", hadParent ? "补全条目" : "建立条目", task.detail);
			this.refreshParseQueueDialog();
			let { markdown } = await this.readSourceMarkdown(source);
			let text = this.removeLocalImageReferences(markdown);
			if (!text.trim()) throw new Error("Markdown 内容为空，请先重新识别文档。");
			let parent = this.parentForDocument(attachment);
			let current = parent ? await this.readDocumentMetadata(parent) : {};
			let metadata = await this.extractDocumentMetadata(task, text, current, settings);
			signal.throwIfAborted();
			task.saving = true;
			// Zotero or another plugin may have supplied a parent during extraction.
			parent = this.parentForDocument(attachment);
			if (parent) {
				await Zotero.DB.executeTransaction(async () => {
					this.applyMetadata(parent, metadata, { fillMissing: true });
					await parent.save({ notifierData: { skipRenameFile: true } });
					if (source.id !== attachment.id && !this.parentForDocument(source)) {
						source.parentID = parent.id;
						await source.save({ notifierData: { skipRenameFile: true } });
					}
				});
			} else {
				parent = await this.createDocumentParent(attachment, metadata, source) || this.parentForDocument(attachment);
			}
			task.metadataSourceID = source.id;
			task.saving = false;
		}
		if (!hadParent) this.setTaskStep?.(task,"parent","建立条目","父条目已建立","completed");
		this.setTaskStep?.(task,"metadata","补全条目","缺失条目信息已补全","completed");
		await this.runOrganizeReadingStages(task);
	},

	async runOrganizeReadingStages(task) {
		let source = task.source, stages = task.organizeStages ||= {}, signal = task.controller.signal;
		let parent = this.parentForDocument(source) || this.parentForDocument(task.attachment);
		if (!parent) throw new Error("建立条目未完成，无法继续全流程。");
		for (let [kind,label,settings] of [["outline","生成大纲",task.settings.outlineSettings],["summary","总结文献",task.settings.summarySettings],["translate","翻译文献",task.settings.translationSettings]]) {
			signal.throwIfAborted(); task.saving = false; task.progress = null;
			if (["completed","skipped"].includes(stages[kind]?.state)) { this.setTaskStep?.(task,kind,label,stages[kind].detail,stages[kind].state); continue; }
			this.setTaskStep?.(task,kind,label,"准备执行");
			task.displaySettings=settings;task.cancelSettings=settings;task.cancelJobID=null;task.jobID=null;
			try {
				if (kind === "outline") {
					let candidates = task.attachment.isPDFAttachment?.() ? [task.attachment] : this.relatedDocuments(source).filter(item=>item.isPDFAttachment?.());
					if (!candidates.length) candidates = this.collectSourceFiles([parent]).filter(item=>item.isPDFAttachment?.());
					if (candidates.length !== 1) { stages[kind]={state:"skipped",detail:"未关联唯一 PDF，此文件不生成大纲"};this.setTaskStep?.(task,kind,label,stages[kind].detail,"skipped");continue; }
					await this.outline.generate(candidates[0],{settings,signal,onReady:()=>{task.saving=true;},onStatus:detail=>{task.detail=detail;this.setTaskStep?.(task,kind,label,detail);}});
				} else {
					let child = stages[kind]?.task || {kind,attachment:task.attachment,source,explicitSource:true,mineruSource:source,parentItem:parent,parentTask:task,organizeStage:kind};
					stages[kind] = {state:"running",task:child}; child.settings={...settings};child.controller=task.controller;
					for (let name of ["detail","progress","saving"]) Object.defineProperty(child,name,{configurable:true,get:()=>task[name],set:value=>{task[name]=value;}});
					if (kind === "summary") await this.runDocumentTask(child);
					else {
						child.partial=false;if(child.translation)child.translation.partial=false;
						child.settings.translateRequestParams=this.parseOptionalJSONObject(child.settings.translateRequestJSON,"翻译请求参数");await this.runTranslationTask(child);
					}
					if (child.resultAttachment) (task.organizeResults ||= {})[kind]=child.resultAttachment;
					if (child.partial) { stages[kind]={state:"failed",task:child,detail:"已保存部分译文，仍有未完成段落"};this.setTaskStep?.(task,kind,label,stages[kind].detail,"failed");continue; }
				}
				signal.throwIfAborted(); stages[kind]={state:"completed",detail:"已完成"};this.setTaskStep?.(task,kind,label,"已完成","completed");
			} catch (error) {
				signal.throwIfAborted(); stages[kind]={...stages[kind],state:"failed",detail:error.message};this.setTaskStep?.(task,kind,label,error.message,"failed");
			} finally { task.saving=false; }
		}
		let failed=Object.entries(stages).filter(([,stage])=>stage.state==="failed");
		task.state=failed.length ? "failed" : "completed";
		task.error=failed.map(([kind,stage])=>`${({outline:"生成大纲",summary:"总结文献",translate:"翻译文献"})[kind]}：${stage.detail}`).join("；");
		task.detail=failed.length ? "全流程已执行，部分步骤失败；重试只处理未完成步骤" : ["全流程整理完成",task.parseWarning].filter(Boolean).join("；");
	},

	async enqueueDocumentTasks(kind, tasks, settings) {
		for (let task of tasks) {
			if (this.parseQueue.some(row => row.kind === kind && row.attachment.id === task.attachment.id && ["queued", "running", "stopping"].includes(row.state))) continue;
			this.parseQueue.push({ ...task, kind, settings: { ...settings }, id: this.parseQueueNextID++, state: "queued",
				title: task.title || task.attachment.getField("title") || task.attachment.attachmentFilename,
				detail: "等待处理", error: "", jobID: null, parsedResult: null });
		}
		if (this.sidebar) this.sidebar.showTask(this.parseQueue.at(-1));
		else this.openParseQueueDialog();
		this.refreshParseQueueDialog();
		await this.processParseQueue();
	},

	async requestDocumentAI(messages, settings, signal, json = false) {
		return this.withAIRequestSlot(settings,signal,()=>this.sendDocumentAI(messages,settings,signal,json));
	},

	withAIRequestSlot(settings, signal, run) {
		signal?.throwIfAborted();
		this.aiRequestPools ||= new Map();
		let key=JSON.stringify([settings.apiBaseURL?.replace(/\/+$/,""),settings.modelID,settings.model]);
		let pool=this.aiRequestPools.get(key);
		if(!pool) { pool={active:0,limit:settings.concurrency||1,waiting:[]};this.aiRequestPools.set(key,pool); }
		let pump=()=>{
			while(pool.active<pool.limit&&pool.waiting.length) {
				let next=pool.waiting.shift();next.signal?.removeEventListener("abort",next.abort);pool.active++;
				Promise.resolve().then(()=>{next.signal?.throwIfAborted();return next.run();}).then(next.resolve,next.reject).finally(()=>{pool.active--;pump();});
			}
			if(!pool.active&&!pool.waiting.length)this.aiRequestPools.delete(key);
		};
		return new Promise((resolve,reject)=>{
			let next={run,resolve,reject,signal};
			next.abort=()=>{pool.waiting.splice(pool.waiting.indexOf(next),1);signal.removeEventListener("abort",next.abort);reject(signal.reason);pump();};
			signal?.addEventListener("abort",next.abort,{once:true});pool.waiting.push(next);pump();
		});
	},

	async sendDocumentAI(messages, settings, signal, json = false) {
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
		let timedOut=false, timeoutMS=1200000;
		let timer = setTimeout(()=>{timedOut=true;controller.abort();},timeoutMS);
		try {
			let response = await fetch(endpoint, { method: "POST", signal: controller.signal,
				headers: { "Content-Type": "application/json", ...(settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {}) }, body: JSON.stringify(payload) });
			if (!response.ok) {
				let error = new Error(`AI 接口请求失败 ${response.status}: ${(await response.text()).slice(0, 500)}`);
				error.status = response.status;
				let retryAfter = response.headers?.get("Retry-After");
				if (retryAfter) error.retryAfterMS = /^\d+(?:\.\d+)?$/.test(retryAfter) ? Number(retryAfter) * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now());
				throw error;
			}
			let data = await response.json();
			let choice = data.choices?.[0];
			if (choice?.finish_reason === "length") throw this.aiOutputLimitError(payload, data);
			let text = choice?.message?.content;
			if (typeof text !== "string" || !text.trim()) throw new Error(data.error?.message || "AI 未返回文本。");
			return text.trim();
		} catch(error) {
			signal?.throwIfAborted();
			let model=[settings.providerName,settings.model].filter(Boolean).join(" / ");
			if(timedOut) {
				let timeout=new Error(`AI 请求超时（${timeoutMS/1000} 秒）：${model}。可在任务队列重试，或缩短输入、降低最大输出长度后重试。`);
				timeout.name="TimeoutError";timeout.timeoutMS=timeoutMS;throw timeout;
			}
			if(error.name==="AbortError")throw new Error(`AI 请求中断：${model}。未收到完整回复，请检查服务连接后在任务队列重试。`);
			throw error;
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
			task.resultAttachment = await this.createDocumentParent(attachment, metadata);
			return;
		}
		let parent = this.parentForDocument(attachment);
		if (!parent) throw new Error("请先执行“建立父条目”。");
		let source = task.explicitSource ? task.source : this.findDocumentMarkdown(attachment);
		if (source?.deleted) throw new Error("选中的 Markdown 已删除，请重新选择文档。");
		if (!source) throw new Error("没有找到与此文档关联的 Markdown，请先执行“识别文档”。");
		task.detail = "读取 Markdown";
		this.refreshParseQueueDialog();
		let { markdown } = await this.readSourceMarkdown(source);
		let text = this.removeLocalImageReferences(markdown);
		if (!text.trim()) throw new Error("Markdown 内容为空。");
		if (task.kind === "metadata") {
			let current = await this.readDocumentMetadata(parent);
			let metadata = await this.extractDocumentMetadata(task, text, current, settings);
			signal.throwIfAborted();
			task.saving = true;
			await Zotero.DB.executeTransaction(async () => {
				this.applyMetadata(parent, metadata);
				await parent.save({ notifierData: { skipRenameFile: true } });
			});
			task.resultAttachment = parent;
		} else {
			let summary = await this.summarizeDocument(text, settings, signal, detail => {
				task.detail = detail; this.refreshParseQueueDialog();
			});
			signal.throwIfAborted();
			task.saving = true;
			task.resultAttachment = await this.saveDocumentSummary(parent, attachment, summary);
		}
	},

	async readDocumentMetadata(parent) {
		await parent.loadAllData();
		let current = {};
		for (let field of this.metadataFields) {
			if (Zotero.ItemFields.isValidForType(field, parent.itemTypeID)) current[field] = parent.getField(field);
		}
		current.creators = parent.getCreatorsJSON();
		return current;
	},

	async extractDocumentMetadata(task, text, current, settings) {
		let completed = 0;
		let chunks = this.splitAIText(text, settings);
		let results = await this.mapAIWork(chunks, settings.concurrency, async chunk => {
			let identified = await this.identify(chunk, task.attachment.attachmentFilename || task.attachment.getField("title"),
				false, current, settings, task.controller.signal);
			task.detail = `识别书目信息 ${++completed}/${chunks.length}`;
			this.refreshParseQueueDialog();
			return identified;
		}, task.controller.signal);
		let metadata = results[0] || current;
		// Earlier publication pages take precedence over citations in later chapters.
		for (let identified of results.slice(1)) {
			for (let [key, value] of Object.entries(identified)) {
				if ((!metadata[key] || (Array.isArray(metadata[key]) && !metadata[key].length)) && value) metadata[key] = value;
			}
		}
		return metadata;
	},

	async createDocumentParent(attachment, metadata, source = null) {
		let linked = this.relatedDocuments(attachment).filter(item => this.isMarkdownResult(item));
		if (source && source.id !== attachment.id && !linked.some(item => item.id === source.id)) linked.push(source);
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

	getMarkerSettings(apiType) {
		let read = name => this.getPref(this.PREF_BRANCH + "marker." + name, true);
		if((apiType || read("apiType"))==="cloud")return {apiType:"cloud",baseURL:String(read("cloud.url")||"https://www.datalab.to/api/v1").trim(),token:String(read("cloud.token")||"").trim(),mode:read("cloud.mode")||"balanced"};
		return {apiType:"local",baseURL:String(read("url") || "").trim(), token:String(read("token") || "").trim().replace(/^Bearer\s+/i, ""),
			mode:read("mode") || "balanced", forceOCR:read("forceOCR") === true};
	},

	async parseWithMarker(attachment, settings, options = {}) {
		if (this.documentExtension(attachment) !== "pdf") throw new Error("Marker 当前仅接收 PDF，请选择 PDF 附件。");
		let config = settings.markerSettings || this.getMarkerSettings(), base = OCRFlowMarker.baseURL(config.baseURL);
		if(config.apiType==="cloud")return this.parseWithDatalab(attachment,settings,options);
		let signal = options.signal, controller = this.createAbortController(), abort = () => controller.abort();
		signal?.throwIfAborted(); signal?.addEventListener("abort", abort, {once:true});
		let headers = config.token ? {Authorization:`Bearer ${config.token}`} : {};
		let request = (path, extra = {}, ownController = controller) => this.withTimeout(() => OCRFlowMarker.request(base + path,
			{headers, signal:ownController.signal, ...extra}), settings.timeoutMS || 1200000, "Marker 请求").catch(error => { if (error.name === "TimeoutError") ownController.abort(); throw error; });
		try {
			let jobID = options.jobID, job, total = 0;
			let readJob = async path => {
				for(let attempt=0;;attempt++) {
					try { return await request(path); }
					catch(error) {
						signal?.throwIfAborted();
						if(!["TypeError","NetworkError"].includes(error.name)&&![502,503,504].includes(error.status))throw error;
						if(attempt===3) { let lost=new Error(`Marker 连接中断，原任务 ${jobID} 已保留；可继续等待以重新连接，无需重新上传。`);lost.name="MarkerConnectionError";throw lost; }
						options.onStatus?.({phase:"Marker · reconnecting",jobID,displayText:`Marker 连接暂时中断，正在重连（${attempt+1}/3）；保留原任务，不重复上传`});
						await this.delayParsePoll(2000*2**attempt,{signal:controller.signal});
					}
				}
			};
			if (jobID) {
				try { job = await readJob(`/v1/parse/jobs/${encodeURIComponent(jobID)}`); }
				catch (error) { if (error.status !== 404) throw error; }
				if (!job || ["failed", "canceled"].includes(job.status)) jobID = null;
			}
			if (!jobID) {
				options.onStatus?.({phase:"读取 Marker PDF", displayText:"读取整份 PDF，准备一次上传"});
				let bytes = await IOUtils.read(await attachment.getFilePath()); signal?.throwIfAborted();
				let {PDFDocument} = this.getPDFLibrary(), source = await PDFDocument.load(this.bytesToBase64(bytes)); total = source.getPageCount(); signal?.throwIfAborted();
				let win = Zotero.getMainWindow(), form = new win.FormData();
				form.append("file", new win.Blob([bytes], {type:"application/pdf"}), attachment.attachmentFilename || "document.pdf");
				for (let [name, value] of Object.entries({output_format:"markdown", paginate_output:"true", force_ocr:String(config.forceOCR), mode:config.mode})) form.append(name, value);
				options.onStatus?.({phase:"提交 Marker 任务",jobID:null,displayText:`正在上传整份 PDF（${total} 页）`,pageProgress:{completed:0,total,unit:"页"}});
				// Collect the task ID even if cancellation is requested during submission, then cancel that exact server job.
				job = await request("/v1/parse/jobs", {method:"POST",body:form}, this.createAbortController());
				jobID = job.job_id;
				if (!jobID) throw new Error("Marker 未返回任务 ID，请检查任务服务是否已更新。");
			}
			let path = `/v1/parse/jobs/${encodeURIComponent(jobID)}`, started = Date.now();
			for (;;) {
				let progress = job.progress?.total > 0 ? job.progress : {completed:0,total,unit:"页"};
				let detail = `${job.detail || job.stage || job.status}；任务 ${jobID}`;
				if (job.status === "queued") detail = `服务端排队中，等待前面的文档处理完成；本文件尚未开始识别${progress.total ? `（${progress.total} 页）` : ""}；任务 ${jobID}`;
				else if (progress.total) detail += `；${progress.completed}/${progress.total} 页`;
				options.onStatus?.({phase:"Marker · " + (job.status === "queued" ? "queued" : job.stage || job.status),displayText:detail,jobID,pageProgress:job.status !== "queued" && progress.total ? progress : null});
				signal?.throwIfAborted();
				if (job.status === "completed") break;
				if (["failed", "canceled"].includes(job.status)) throw new Error(job.error || job.detail || "Marker 任务未完成");
				if (settings.localJobTimeoutMS > 0 && Date.now() - started >= settings.localJobTimeoutMS) {
					let error = new Error(`Marker 等待达到上限；任务 ${jobID} 仍保留在服务端，可继续等待。`);error.name="MarkerJobWaitTimeout";throw error;
				}
				await this.delayParsePoll(settings.pollIntervalMS || 1000, {signal:controller.signal});
				job = await readJob(path);
			}
			let response = await readJob(path + "/result"); signal?.throwIfAborted();
			if (typeof response.output !== "string") throw new Error("Marker 未返回完整 Markdown。");
			let result = {rawMarkdownText:response.output, markdownText:response.output.replace(/^\{(\d+)\}-{48}[ \t]*$/gm, (_m, page) => `<!-- 第 ${Number(page) + 1} 页 -->`),
				embeddedImages:[], rawFiles:[{name:"response.json",text:JSON.stringify(response)}], recognition:{source:"marker"}};
			for (let [name, encoded] of Object.entries(response.images || {})) {
				let binary = atob(encoded);result.embeddedImages.push({marker:`docflow-image://img-${result.embeddedImages.length + 1}`,entryName:name,fileName:this.fileNameFromPath(name),mimeType:this.guessMimeType(name),bytes:Uint8Array.from(binary,ch=>ch.charCodeAt(0))});
			}
			this.normalizeResultImages(result);
			result.document = OCRFlowDocument.fromMarkdown(result.markdownText,"marker",text=>this.splitTranslationBlocks(text));
			let pages = job.progress?.total || total;
			for (let page=1;page<=pages;page++) if (!result.document.pages.some(row=>row.page===page)) result.document.pages.push({page,printed:null});
			result.document.pages.sort((a,b)=>a.page-b.page);result.markdownText=OCRFlowDocument.render(result.document);
			if (!result.markdownText.trim()) throw new Error("Marker 未识别到可保存的正文或图片。");
			return result;
		} catch (error) { controller.abort(); throw error; }
		finally { signal?.removeEventListener("abort",abort); }
	},

	async parseAttachmentWithMineru(attachment, settings, options = {}) {
		let ext = this.documentExtension(attachment);
		let image = ["png", "jpg", "jpeg"].includes(ext);
		if (settings.parserService === "marker") return this.parseWithMarker(attachment, settings, options);
		if (ext !== "pdf" && !image) settings.outputFormat = "md";
		if (["txt", "md", "markdown", "csv"].includes(ext)) {
			let bytes = await IOUtils.read(await attachment.getFilePath());
			return { markdownText: new TextDecoder("utf-8").decode(bytes), embeddedImages: [] };
		}
		if ((!image && ext !== "pdf") || settings.parserService === "markitdown") {
			return this.parseWithMarkItDown(attachment, settings, options);
		}
		if (settings.parserService === "ai") return this.parseWithVision(attachment, settings.llmSettings, options);
		if (["paddle-cloud", "paddle-local"].includes(settings.parserService)) return this.parseWithPaddle(attachment, settings, options);
		if (settings.apiMode !== "local-v1" && !settings.apiToken) throw new Error("请先填写 MinerU 官方 API Token，或选择本地 MinerU、MarkItDown、AI OCR。");
		if (!image) return this.parseWithMineru(attachment, settings, options);
		let bytes = await IOUtils.read(await attachment.getFilePath());
		let pdf = await this.getPDFLibrary().PDFDocument.create();
		let imageData = this.bytesToBase64(bytes);
		let embedded = ext === "png" ? await pdf.embedPng(imageData) : await pdf.embedJpg(imageData);
		let page = pdf.addPage();
		page.setSize(embedded.width, embedded.height);
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
			options.onStatus?.({ phase: "AI 视觉 OCR", displayText: `已识别 ${pages.filter(Boolean).length}/${total} 页`, pageProgress: {completed:pages.filter(Boolean).length, total, unit:"页"} });
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
