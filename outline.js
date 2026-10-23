var ocrflowText = typeof ocrflowText === "function" ? ocrflowText : value => String(value ?? "");
/* Reader outline interactions adapted from DrinkTea905/zotero-paper-outline.
 * Copyright (c) 2026 独钓寒江雪, MIT; see vendor/paper-outline/LICENSE.
 */
var DocFlowOutline = {
	owner: null,
	cache: new Map(),
	readers: new Map(),
	readerListener: null,

	init(owner) { this.owner = owner; },
	key(attachment) { return `${attachment.libraryID}-${attachment.key}`; },
	path(attachment) { return PathUtils.join(Zotero.DataDirectory.dir, "mineru-for-zotero-outlines", this.key(attachment) + ".json"); },

	async load(attachment) {
		let key = this.key(attachment);
		if (!this.cache.has(key)) {
			let data = { pages: [], headings: [], outline: [] };
			if (await IOUtils.exists(this.path(attachment))) data = JSON.parse(await IOUtils.readUTF8(this.path(attachment)));
			data.pages = data.pages.map(page => this.blockText(page));
			this.cache.set(key, data);
		}
		return this.cache.get(key);
	},

	async save(attachment, data) {
		this.cache.set(this.key(attachment), data);
		await IOUtils.makeDirectory(PathUtils.parent(this.path(attachment)), { createAncestors: true, ignoreExisting: true });
		await IOUtils.writeUTF8(this.path(attachment), JSON.stringify(data));
		this.refreshReaders(attachment);
	},

	blockText(block) {
		if (typeof block === "string") return block;
		if (!block) return "";
		if (Array.isArray(block)) return block.map(value => this.blockText(value)).filter(Boolean).join("\n");
		for (let key of ["text", "content", "latex", "html"]) {
			if (typeof block[key] === "string") return block[key];
		}
		for (let key of ["content", "lines", "spans", "blocks", "para_blocks", "children"]) {
			if (block[key]) return this.blockText(block[key]);
		}
		return "";
	},

	parseMineruDocument(document) {
		let pages = [], headings = [];
		let add = (block, index) => {
			let text = this.blockText(block).trim();
			if (!text) return;
			pages[index] = (pages[index] ? pages[index] + "\n\n" : "") + text;
			if (["title", "heading"].includes(block.type) || Number(block.text_level) > 0) {
				headings.push({ title: text, level: Number(block.text_level || block.level) || 1, summary: "", page: index + 1 });
			}
		};
		if (Array.isArray(document)) {
			for (let block of document) if (Number.isInteger(block.page_idx)) add(block, block.page_idx);
		}
		else {
			for (let page of document.pages || document.pdf_info || []) {
				let index = Number(page.page_idx);
				if (!Number.isInteger(index)) continue;
				if (pages[index] === undefined) pages[index] = "";
				for (let block of page.blocks || page.para_blocks || []) add(block, index);
			}
		}
		let count = document.metadata?.document?.page_count || pages.length;
		return { pages: Array.from({ length: count }, (_, i) => pages[i] || ""), headings };
	},

	markdownHeadings(markdown) {
		let headings = [], fence = null;
		for (let line of String(markdown || "").split("\n")) {
			let marker = line.match(/^\s*(`{3,}|~{3,})/);
			if (marker) {
				if (!fence) fence = marker[1];
				else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
				continue;
			}
			if (fence) continue;
			let match = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
			if (match) headings.push({ level: match[1].length, title: match[2], summary: "", page: null });
		}
		return headings;
	},

	async storeSource(attachment, result) {
		let data = { pages: (result.outlinePages || []).map(page => this.blockText(page)), headings: result.outlineHeadings || [], outline: [] };
		if (!data.headings.length) data.headings = this.markdownHeadings(result.markdownText);
		this.locatePages(data.headings, data.pages, []);
		await this.save(attachment, data);
	},

	collectPDFs(items) {
		let attachments = new Map();
		let add = item => { if (item?.isPDFAttachment?.()) attachments.set(item.id, item); };
		for (let item of items || []) {
			if (item.isPDFAttachment?.()) { add(item); continue; }
			for (let key of item.relatedItems || []) add(Zotero.Items.getByLibraryAndKey(item.libraryID, key));
			let parent = item.isRegularItem?.() ? item : item.parentItemID ? Zotero.Items.get(item.parentItemID) : null;
			for (let id of parent?.getAttachments?.() || []) add(Zotero.Items.get(id));
		}
		return Array.from(attachments.values());
	},

	enqueue(attachment, force = false) {
		let task = this.owner.parseQueue.find(row => row.kind === "outline" && row.attachment.id === attachment.id && row.state !== "completed");
		if (task) {
			if (["failed", "canceled"].includes(task.state)) {
				task.state = "queued"; task.error = ""; task.force = force; task.settings = this.owner.getLLMSettings("outline");
			}
			return task;
		}
		task = {
			kind: "outline", id: this.owner.parseQueueNextID++, attachment, force,
			settings: this.owner.getLLMSettings("outline"), state: "queued", error: "", jobID: null,
			title: attachment.getField("title") || "PDF", detail: "等待生成大纲"
		};
		this.owner.parseQueue.push(task);
		this.owner.refreshParseQueueDialog();
		return task;
	},

	async enqueueSelected(items) {
		let attachments = this.collectPDFs(items);
		if (!attachments.length) throw new Error("请选择 PDF 或带 PDF 的文献条目。");
		for (let attachment of attachments) this.enqueue(attachment, true);
		if (this.owner.sidebar) this.owner.sidebar.showTask(this.owner.parseQueue.at(-1));
		else this.owner.openParseQueueDialog();
		await this.owner.processParseQueue();
	},

	getReaderApp(reader) {
		let internal = reader?._internalReader;
		for (let view of [internal?._lastView, internal?._primaryView, reader?._lastView, reader?._primaryView]) {
			let window = view?._iframeWindow;
			let raw = window?.wrappedJSObject || window;
			if (raw?.PDFViewerApplication) return raw.PDFViewerApplication;
		}
		return null;
	},

	async embeddedOutline(reader) {
		let document = this.getReaderApp(reader)?.pdfDocument;
		if (!document) return [];
		let raw = await document.getOutline();
		let result = [];
		let walk = async (nodes, level) => {
			for (let node of nodes || []) {
				let dest = typeof node.dest === "string" ? await document.getDestination(node.dest) : node.dest;
				let page = null;
				if (Array.isArray(dest) && dest[0] !== undefined) {
					page = (typeof dest[0] === "number" ? dest[0] : await document.getPageIndex(dest[0])) + 1;
				}
				if (node.title?.trim()) result.push({ title: node.title.trim(), level, page, summary: "" });
				await walk(node.items, level + 1);
			}
		};
		await walk(raw, 1);
		return result;
	},

	locatePages(outline, pages, headings) {
		let normalize = value => String(value || "").replace(/\s+/g, "").toLowerCase();
		let contents = new Set();
		pages.forEach((text, i) => { if (/^\s*(?:目\s*录|目\s*次|contents)\s*$/im.test(text)) contents.add(i); });
		let cursor = 0;
		for (let entry of outline) {
			let key = normalize(entry.title);
			let heading = headings.find(h => normalize(h.title) === key && h.page - 1 >= cursor && !contents.has(h.page - 1));
			let suggested = Number(entry.page) - 1;
			let suggestedMatches = suggested >= cursor && suggested < pages.length && !contents.has(suggested) && normalize(pages[suggested]).includes(key);
			let index = heading ? heading.page - 1 : suggestedMatches ? suggested : pages.findIndex((text, i) => i >= cursor && !contents.has(i) && normalize(text).includes(key));
			if (index < 0 && Number.isInteger(suggested) && suggested >= cursor && suggested < pages.length && !contents.has(suggested)) index = suggested;
			entry.page = index >= 0 ? index + 1 : null;
			if (index >= 0) cursor = index;
		}
	},

	pageChunks(pages, settings) {
		let chunks = [], chunk = "";
		let limit = settings?.workKind ? this.owner.getAIChunkBudget(settings) : 20000;
		let size = value => settings?.workKind ? this.owner.estimateAITokens(value) : value.length;
		for (let [index, text] of pages.entries()) {
			if (!text.trim()) continue;
			let parts = settings?.workKind
				? this.owner.splitAIText(text, { ...settings, contextWindow: settings.contextWindow - 100 }, limit - 100)
				: Array.from({ length: Math.ceil(text.length / 19900) }, (_, i) => text.slice(i * 19900, (i + 1) * 19900));
			for (let part of parts) {
				let block = `\n\n===== PDF 第 ${index + 1} 页 =====\n` + part;
				if (size(chunk + block) > limit && chunk) { chunks.push(chunk); chunk = ""; }
				chunk += block;
			}
		}
		if (chunk) chunks.push(chunk);
		return chunks;
	},

	parseAIOutline(text) {
		let value = String(text).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
		let parsed;
		try { parsed = JSON.parse(value); }
		catch {
			let fragment = value.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
			// Keep unrecognized model-generated escapes as literal text, preserving valid JSON escapes.
			let repaired = (fragment ? fragment[0] : value).replace(/\\(?:u[0-9a-fA-F]{4}|[\s\S])/g,
				escape => /^\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4})$/.test(escape) ? escape : "\\" + escape);
			try { parsed = JSON.parse(repaired); }
			catch (repairError) { throw new Error(`LLM 返回的大纲不是有效 JSON：${repairError.message}`); }
		}
		let outline = Array.isArray(parsed) ? parsed : parsed.outline;
		if (!Array.isArray(outline)) throw new Error("LLM 未返回目录 JSON 数组。");
		return outline.filter(entry => typeof entry.title === "string" && entry.title.trim()).map(entry => ({
			title: entry.title.trim(), label: entry.label || "", level: Math.max(1, Math.min(6, Number(entry.level) || 1)),
			summary: typeof entry.summary === "string" ? entry.summary : "", page: Number(entry.page) || null
		}));
	},

	async generate(attachment, { settings, force = false, onStatus = () => {}, onReady = () => {}, signal } = {}) {
		let data = await this.load(attachment);
		signal?.throwIfAborted();
		if (!force && data.outline.length) { onStatus("已读取缓存大纲"); onReady(data); await this.save(attachment, data); return data.outline; }
		let reader = (Zotero.Reader._readers || []).find(r => r._item?.id === attachment.id);
		let outline = reader ? await this.embeddedOutline(reader) : [];
		signal?.throwIfAborted();
		if (outline.length) onStatus("已读取 PDF 自带书签");
		else if (this.owner.getPref(this.owner.PREF_BRANCH + "outlineUseAI", true) === false) {
			outline = data.headings.map(heading => ({ ...heading }));
			if (!outline.length) throw new Error("未找到书签或识别标题，请先解析 PDF 或启用 LLM 大纲生成。");
		}
		else {
			if (!data.pages.some(page => page.trim())) {
				onStatus("读取 PDF 每页文字");
				let document = reader ? this.getReaderApp(reader)?.pdfDocument : null;
				if (document) {
					let pages = [];
					for (let pageIndex = 0; pageIndex < document.numPages; pageIndex++) {
						signal?.throwIfAborted();
						let pageData = await document.getPageData({pageIndex});
						pageData = pageData.wrappedJSObject || pageData;
						pages.push(pageData.chars.filter(char => !char.ignorable).map(char =>
							char.c + (char.paragraphBreakAfter ? "\n\n" : char.lineBreakAfter ? "\n" : char.spaceAfter ? " " : "")
						).join("").normalize("NFC").trim());
					}
					data.pages = pages;
				}
				else {
					let result = await Zotero.PDFWorker.getFullText(attachment.id, null);
					let pages = (result.text || "").split("\f");
					if (result.totalPages && pages.length !== result.totalPages) {
						throw new Error("PDF 全文页码不能准确对应，请打开 PDF 后生成大纲，或先使用 MinerU 解析。");
					}
					data.pages = pages;
				}
			}
			settings = settings || this.owner.getLLMSettings("outline");
			let chunks = this.pageChunks(data.pages, settings);
			if (!chunks.length) throw new Error("没有可定位页码的文字。扫描 PDF 请重新使用 MinerU 解析后生成大纲。");
			if (!settings.apiBaseURL || !settings.model) throw new Error("请在 MinerU 设置中填写 LLM API 地址和模型，用于生成大纲与章节摘要。");
			let prompt = OCRFlowPrompts.get("outline", settings.workPrompt);
			for (let [index, chunk] of chunks.entries()) {
				signal?.throwIfAborted();
				onStatus(`生成大纲：第 ${index + 1}/${chunks.length} 块`);
				let payload = this.owner.mergeRequestPayload({model: settings.model, messages: [{role: "system", content: prompt}, {role: "user", content: chunk}]},
					this.owner.parseOptionalJSONObject(settings.summaryRequestJSON, "大纲额外 JSON 参数"), ["model", "messages"]);
				this.owner.applyAIContextBudget(payload, settings);
				let result=await this.owner.withAIRequestSlot(settings,signal,async()=>{
					let response = await fetch(`${settings.apiBaseURL}/chat/completions`, {
						method: "POST", headers: {"Content-Type": "application/json", ...(settings.apiKey ? {Authorization: `Bearer ${settings.apiKey}`} : {})},
						body: JSON.stringify(payload), signal
					});
					if (!response.ok) throw new Error(`大纲 LLM 请求失败 ${response.status}: ${(await response.text()).slice(0, 300)}`);
					return response.json();
				});
				if (result.choices?.[0]?.finish_reason === "length") throw this.owner.aiOutputLimitError(payload, result);
				outline.push(...this.parseAIOutline(result.choices?.[0]?.message?.content || ""));
			}
			this.locatePages(outline, data.pages, data.headings);
			let seen = new Set();
			outline = outline.filter(entry => { let key = `${entry.page}:${entry.title}`; if (seen.has(key)) return false; seen.add(key); return true; });
			if (!outline.length) throw new Error("LLM 未返回有效章节目录。");
		}
		signal?.throwIfAborted();
		data.outline = outline;
		onStatus("保存阅读器大纲");
		onReady(data);
		await this.save(attachment, data);
		return outline;
	},

	registerReaders() {
		this.readerListener = event => this.attachReader(event.reader).catch(error => Zotero.logError(error));
		Zotero.Reader.registerEventListener("renderToolbar", this.readerListener, this.owner.id);
		for (let reader of Zotero.Reader._readers || []) this.attachReader(reader).catch(error => Zotero.logError(error));
	},

	async attachReader(reader) {
		if (reader.type !== "pdf" || this.readers.has(reader)) return;
		await reader._initPromise;
		let window = reader._iframeWindow;
		let document = window.document;
		await this.load(reader._item);
		if (this.readers.has(reader)) return;
		let entry = { reader, window, document };
		this.readers.set(reader, entry);
		let ensure = () => {
			let host = document.getElementById("sidebarContent");
			if (!host) return;
			if (!document.getElementById("mineru-reader-outline")) this.renderReader(entry);
			this.syncVisibility(entry);
		};
		entry.observer = new window.MutationObserver(ensure);
		entry.observer.observe(document.body || document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "aria-selected"] });
		entry.onUnload = () => this.removeReader(reader);
		window.addEventListener("unload", entry.onUnload, {once: true});
		let view = reader._internalReader?._lastView || reader._internalReader?._primaryView;
		if (view?.initializedPromise) await view.initializedPromise;
		entry.eventBus = this.getReaderApp(reader)?.eventBus;
		entry.onPage = event => this.highlight(entry, event.pageNumber);
		entry.eventBus?.on("pagechanging", entry.onPage);
		ensure();
	},

	refreshReaders(attachment) {
		for (let entry of this.readers.values()) if (entry.reader._item.id === attachment.id) this.renderReader(entry);
	},

	syncVisibility(entry) {
		let { document } = entry;
		let panel = document.getElementById("mineru-reader-outline");
		let host = document.getElementById("sidebarContent");
		let button = document.getElementById("viewOutline");
		let active = !!button && (button.classList.contains("active") || button.getAttribute("aria-selected") === "true");
		if (panel) panel.style.display = active ? "flex" : "none";
		if (host) host.setAttribute("data-mineru-outline-active", String(active));
	},

	renderReader(entry) {
		let { document, reader } = entry;
		let host = document.getElementById("sidebarContent");
		if (!host) return;
		let make = (tag, text, className) => { let e = document.createElementNS("http://www.w3.org/1999/xhtml", tag); if (text) e.textContent = text; if (className) e.className = className; return e; };
		if (!document.getElementById("mineru-outline-style")) {
			let style = make("style"); style.id = "mineru-outline-style";
			style.textContent = '#sidebarContent[data-mineru-outline-active="true"] > #outlineView,#sidebarContent[data-mineru-outline-active="true"] > #paper-outline-reader{display:none!important} #mineru-reader-outline{box-sizing:border-box;flex-direction:column;gap:8px;padding:10px;width:100%;overflow:auto;font:13px/1.6 system-ui;color:var(--fill-primary,CanvasText);background:var(--material-sidepane,Canvas)} #mineru-reader-outline .mo-row{display:flex;align-items:baseline;gap:4px} #mineru-reader-outline button{font:inherit;color:inherit;background:transparent;border:1px solid var(--fill-quarternary,#bbb);border-radius:5px;cursor:pointer} #mineru-reader-outline .mo-title{border:0;text-align:left;flex:1;overflow-wrap:anywhere;padding:3px} #mineru-reader-outline .mo-title:disabled{cursor:default;opacity:.65} #mineru-reader-outline .mo-active{background:var(--accent-blue,#2e7dd1);color:white;border-radius:5px} #mineru-reader-outline .mo-toggle{width:22px;border:0} #mineru-reader-outline .mo-bar{display:flex;gap:8px;flex-wrap:wrap}';
			(document.head || document.documentElement).appendChild(style);
		}
		let panel = document.getElementById("mineru-reader-outline");
		if (!panel) { panel = make("div"); panel.id = "mineru-reader-outline"; host.appendChild(panel); }
		panel.textContent = "";
		let data = this.cache.get(this.key(reader._item));
		let outline = data?.outline || [];
		let rootLevel = outline.length ? Math.min(...outline.map(section => section.level)) : 1;
		let bar = make("div", null, "mo-bar");
		let generate = make("button", ocrflowText(outline.length ? "重新生成大纲" : "生成大纲"));
		generate.type = "button";
		generate.addEventListener("click", () => { this.enqueue(reader._item, true); this.owner.openParseQueueDialog(); this.owner.processParseQueue().catch(error => Zotero.logError(error)); });
		bar.appendChild(generate);
		let toggle = make("button", ocrflowText("展开 / 收起")); toggle.type = "button";
		toggle.addEventListener("click", () => {
			let collapsed = panel.getAttribute("data-collapsed") !== "true";
			panel.setAttribute("data-collapsed", String(collapsed));
			for (let row of panel.querySelectorAll(".mo-row")) {
				row.style.display = collapsed && Number(row.dataset.level) > rootLevel ? "none" : "flex";
				row.dataset.collapsed = String(collapsed);
				let arrow = row.querySelector(".mo-toggle");
				if (!arrow.disabled) arrow.textContent = collapsed ? "▸" : "▾";
			}
		});
		if (outline.length) bar.appendChild(toggle);
		panel.appendChild(bar);
		if (!outline.length) panel.appendChild(make("p", ocrflowText("生成后可点击标题跳页；进度和重试显示在任务队列中。")));
		for (let [index, section] of outline.entries()) {
			let row = make("div", null, "mo-row");
			row.dataset.level = section.level; row.dataset.page = section.page || "";
			row.style.marginLeft = `${(section.level - rootLevel) * 12}px`;
			let children = outline[index + 1]?.level > section.level;
			let arrow = make("button", children ? "▾" : "", "mo-toggle"); arrow.type = "button"; arrow.disabled = !children;
			arrow.addEventListener("click", () => {
				let collapse = row.dataset.collapsed !== "true"; row.dataset.collapsed = String(collapse); arrow.textContent = collapse ? "▸" : "▾";
				let rows = Array.from(panel.querySelectorAll(".mo-row"));
				for (let j = index + 1; j < rows.length && Number(rows[j].dataset.level) > section.level; j++) {
					rows[j].style.display = collapse ? "none" : "flex";
					if (!collapse) {
						rows[j].dataset.collapsed = "false";
						let nested = rows[j].querySelector(".mo-toggle");
						if (!nested.disabled) nested.textContent = "▾";
					}
				}
			});
			let title = make("button", (section.label || section.title) + (section.page ? ` · ${section.page}` : " · 页码未定位"), "mo-title");
			title.type = "button"; title.disabled = !section.page;
			title.title = section.summary || section.title;
			title.addEventListener("click", () => {
				for (let r of panel.querySelectorAll(".mo-active")) r.classList.remove("mo-active");
				row.classList.add("mo-active");
				Promise.resolve(reader.navigate({pageIndex: section.page - 1})).catch(error => Zotero.logError(error));
			});
			row.append(arrow, title); panel.appendChild(row);
		}
		this.syncVisibility(entry);
		let app = this.getReaderApp(reader);
		this.highlight(entry, app?.pdfViewer?.currentPageNumber || app?.page || 1);
	},

	highlight(entry, page) {
		let panel = entry.document.getElementById("mineru-reader-outline");
		if (!panel) return;
		let active = panel.querySelector(".mo-active");
		if (active && Number(active.dataset.page) === page) return;
		let best = null;
		for (let row of panel.querySelectorAll(".mo-row")) {
			row.classList.remove("mo-active");
			if (Number(row.dataset.page) > 0 && Number(row.dataset.page) <= page) best = row;
		}
		best?.classList.add("mo-active");
	},

	removeReader(reader) {
		let entry = this.readers.get(reader);
		if (!entry) return;
		entry.observer.disconnect();
		entry.eventBus?.off("pagechanging", entry.onPage);
		entry.window.removeEventListener("unload", entry.onUnload);
		entry.document.getElementById("mineru-reader-outline")?.remove();
		entry.document.getElementById("mineru-outline-style")?.remove();
		entry.document.getElementById("sidebarContent")?.removeAttribute("data-mineru-outline-active");
		this.readers.delete(reader);
	},

	shutdown() {
		Zotero.Reader.unregisterEventListener("renderToolbar", this.readerListener);
		for (let reader of Array.from(this.readers.keys())) this.removeReader(reader);
	}
};
