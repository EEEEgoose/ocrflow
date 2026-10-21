var OCRFlowTaskSidebar = {
	views: new Map(),
	plugin: null,

	init(plugin) { this.plugin = plugin; },

	mount(window) {
		if (this.views.has(window)) return;
		let doc = window.document, host = doc.getElementById("zotero-item-pane"), rail = doc.getElementById("zotero-view-item-sidenav");
		if (!host || !rail) return;
		let make = tag => doc.createElementNS("http://www.w3.org/1999/xhtml", tag);
		let style = doc.createElementNS("http://www.w3.org/1999/xhtml", "link");
		style.rel = "stylesheet"; style.href = "chrome://docflow/content/task-sidebar.css"; doc.documentElement.appendChild(style);
		let button = make("button"); button.id = "ocrflow-sidebar-button"; button.className = "ocrflow-sidebar-button";
		button.type = "button"; button.title = "OCRFlow 任务进度"; button.setAttribute("aria-label", "OCRFlow 任务进度");
		button.setAttribute("aria-controls", "ocrflow-task-sidebar"); button.setAttribute("aria-expanded", "false");
		let icon = make("span"); icon.className = "ocrflow-sidebar-icon"; icon.setAttribute("aria-hidden", "true");
		let badge = make("span"); badge.className = "ocrflow-task-badge"; badge.hidden = true; button.append(icon, badge);
		rail.insertBefore(button, rail.querySelector(".highlight-notes-active")?.previousElementSibling || null);
		let panel = make("section"); panel.id = "ocrflow-task-sidebar"; panel.hidden = true; panel.setAttribute("aria-label", "OCRFlow 任务进度");
		host.insertBefore(panel, doc.getElementById("zotero-item-pane-content"));
		let view = { window, host, rail, panel, button, badge, style, open: false, dismissed: false, taskID: null, expanded: new Set(), collapsed: new Set(), launching: new Set(), fileID: null };
		this.views.set(window, view);
		button.addEventListener("click", event => { event.stopPropagation(); this.toggle(view, !view.open, true); });
		view.onRailClick = event => {
			if (button.contains(event.target)) return;
			if (event.target.closest(".btn")) { view.dismissed = true; this.toggle(view, false, false); }
		};
		rail.addEventListener("click", view.onRailClick, true);
		view.onPointerDown = event => {
			if (event.button === 0 && event.target.closest("button, select, summary")) view.pointerActive = true;
			if (event.button === 0 && event.target.closest("select")) view.selectActive = event.target.closest("select");
		};
		view.onPointerEnd = () => {
			if (!view.pointerActive) return;
			view.pointerTimer = window.setTimeout(() => {
				view.pointerActive = false; view.pointerTimer = null;
				if (view.renderPending) { view.renderPending = false; this.render(view); }
			}, 0);
		};
		panel.addEventListener("pointerdown", view.onPointerDown);
		doc.addEventListener("pointerup", view.onPointerEnd, true);
		doc.addEventListener("pointercancel", view.onPointerEnd, true);
		window.addEventListener("blur", view.onPointerEnd);
		view.onSelectBlur = event => {
			if (event.target !== view.selectActive) return;
			view.selectActive = null;
			view.onPointerEnd();
			if (view.renderPending) this.render(view);
		};
		view.onSelectKey = event => {
			let select = event.target.closest("select");
			if (!select) return;
			if (["Escape", "Tab"].includes(event.key)) view.onSelectBlur({target:select});
			else if (["ArrowUp", "ArrowDown", " ", "Enter", "F4"].includes(event.key)) view.selectActive = select;
		};
		panel.addEventListener("focusout", view.onSelectBlur);
		panel.addEventListener("keydown", view.onSelectKey);
		view.observer = new window.MutationObserver(() => { this.followSelection(view); this.render(view); });
		view.observer.observe(doc.getElementById("zotero-item-pane-content"), { childList: true, subtree: true, characterData: true });
		this.render(view);
	},

	toggle(view, open, manual = false) {
		view.open = open;
		view.panel.hidden = !open;
		if (manual) view.dismissed = !open;
		view.host.classList.toggle("ocrflow-sidebar-open", open);
		view.button.setAttribute("aria-expanded", String(open));
		if (open) { this.followSelection(view); view.host.collapsed = false; }
		else if (manual) view.host.collapsed = true;
		this.render(view);
	},

	documentContext(view) {
		let selected = view.window.ZoteroPane.getSelectedItems();
		if (selected.length !== 1) return { key:"", item:null, files:[], file:null, source:null, parent:null };
		let plugin = this.plugin, item = selected[0], parent = plugin.parentForDocument(item);
		let explicit = plugin.isMarkdownResult(item) ? item : null;
		let files = explicit ? plugin.relatedDocuments(item).filter(doc => plugin.collectSourceFiles([doc]).length)
			: plugin.collectSourceFiles([item.isNote?.() ? parent || item : item]);
		if (explicit && !files.length && parent) { let originals = plugin.collectSourceFiles([parent]).filter(doc => !plugin.isMarkdownResult(doc)); if (originals.length === 1) files = originals; }
		let file = files.find(file => file.id === view.fileID) || files[0] || null;
		view.fileID = file?.id || null;
		let source = explicit || (file ? plugin.findDocumentMarkdown(file) : null);
		if (!source && !files.length && parent) source = parent.getAttachments().map(id => Zotero.Items.get(id)).filter(doc => plugin.isMarkdownResult(doc)).at(-1) || null;
		return { key:`${item.id}:${file?.id || source?.id || ""}`, item, files, file, source, parent,
			title:(parent || item).getField("title") || file?.attachmentFilename || "未命名文献" };
	},

	documentTasks(context) {
		if (!context.item) return [];
		let ids = new Set([context.file?.id, context.source?.id, !context.files.length ? context.item.id : null].filter(Boolean));
		return this.plugin.parseQueue.filter(task => [task.attachment.id, task.source?.id, task.mineruSource?.id, task.resultAttachment?.id].some(id => ids.has(id)));
	},

	async loadSourceActions(view, source) {
		let state = {id:source.id, review:false, changes:false}; view.sourceActions = state;
		try {
			let path = await source.getFilePath();
			if (path) {
				let root = PathUtils.join(PathUtils.parent(path), "_ocrflow");
				[state.review, state.changes] = await Promise.all([IOUtils.exists(PathUtils.join(root, "collation.json")), IOUtils.exists(PathUtils.join(root, "changes.html"))]);
			}
		} catch (error) { Zotero.logError(error); }
		if (this.views.get(view.window) === view && view.sourceActions === state) this.render(view);
	},

	async openReview(view, source) {
		if (view.reviewOpening) return;
		view.reviewOpening = true; this.render(view);
		try { await this.plugin.openCollationReview({selectedItems:[source]}); }
		finally { view.reviewOpening = false; this.render(view); }
	},

	actionUnavailableReason(context, kind, busy = false) {
		if (!context.item) return "请先选择一篇文献或文件附件。";
		if (context.item.isNote?.() && !context.parent) return "独立笔记暂不支持文献处理，请选择文献条目或文件附件。";
		if (busy) return "当前文件已有任务，请在下方查看进度或终止后重试。";
		if (["metadata", "summary", "translate"].includes(kind)) {
			if (!context.parent) return "请先通过“一键整理”建立父条目，再进行总结、翻译或信息补全。";
			if (!context.source) return "请先提取全文，再进行总结、翻译或信息补全。";
		} else if (kind === "parent") {
			if (context.parent) return "此文献已有父条目，无需重复建立。";
			if (!context.file) return "未关联原文件，可通过“一键整理”根据全文建立父条目。";
		} else if (kind === "outline") {
			if (!context.file?.isPDFAttachment?.()) return "生成阅读大纲需要关联的原始 PDF，请选择 PDF 附件。";
		} else if (kind === "organize" ? !(context.file || context.source) : !context.file) {
			return context.source ? "未关联原文件，无法重新 OCR；可直接使用已有全文进行整理。" : "此条目没有可处理的文件，请先在 Zotero 中添加或下载附件。";
		}
		return "";
	},

	canPerform(context, kind, busy = false) {
		return !this.actionUnavailableReason(context, kind, busy);
	},

	async performDocumentAction(view, kind) {
		let context = this.documentContext(view), plugin = this.plugin;
		let busy = this.documentTasks(context).some(task => ["queued", "running", "stopping"].includes(task.state)) || view.launching.has(context.key);
		if (!this.canPerform(context, kind, busy)) {
			view.error = {key:context.key, message:this.actionUnavailableReason(context, kind, busy)};
			this.render(view); return;
		}
		view.launching.add(context.key); view.error = null; this.render(view);
		try {
			let target = ["summary", "metadata", "translate"].includes(kind) || (kind === "organize" && plugin.isMarkdownResult(context.item)) ? context.source : context.file || context.source;
			let options = {window:view.window, selectedItems:[target]};
			if (kind === "organize") await plugin.handleOrganizeCommand(options);
			else if (kind === "ocr") await plugin.handleParseCommand(options);
			else if (kind === "translate") await plugin.handleTranslateCommand(options);
			else if (kind === "outline") await plugin.outline.enqueueSelected([target]);
			else await plugin.handleDocumentCommand(kind, options);
		} finally { view.launching.delete(context.key); this.render(view); }
	},

	stepState(task, step) {
		if (task.decision && step.state === "running") return "waiting";
		if (step.state === "running" && ["failed", "canceled", "wait_expired", "waiting", "stopping"].includes(task.state)) return task.state;
		if (step.state === "pending" && ["failed", "canceled", "completed"].includes(task.state)) return "not_run";
		return step.state;
	},

	followSelection(view) {
		let key = view.window.ZoteroPane.getSelectedItems().map(item => item.id).join(",");
		if (view.selectionKey === key) return;
		view.selectionKey = key; view.fileID = null; view.error = null; view.selectActive = null;
		let tasks = this.documentTasks(this.documentContext(view));
		view.taskID = (tasks.find(task => ["running", "stopping", "queued"].includes(task.state)) || tasks.at(-1))?.id || null;
	},

	showTask(task) {
		for (let view of this.views.values()) {
			view.taskID = task?.id || view.taskID;
			if (!view.dismissed) this.toggle(view, true);
			else this.render(view);
		}
	},

	refresh() { for (let view of this.views.values()) this.render(view); },


	render(view) {
		// Keep the pressed control alive until pointerup has dispatched its click.
		if (view.pointerActive || view.selectActive?.isConnected) { view.renderPending = true; return; }
		view.renderPending = false;
		let plugin = this.plugin, tasks = plugin.parseQueue;
		let active = tasks.filter(task => ["queued", "running", "stopping"].includes(task.state));
		view.badge.textContent = String(active.length); view.badge.hidden = !active.length;
		view.button.title = active.length ? `OCRFlow · ${active.length} 项任务进行中` : "OCRFlow 文献操作";
		if (!view.open) return;
		let context = this.documentContext(view), relatedTasks = this.documentTasks(context), doc = view.window.document;
		if (context.source && view.sourceActions?.id !== context.source.id) this.loadSourceActions(view, context.source);
		if (!context.source) view.sourceActions = null;
		let task = relatedTasks.find(task => task.id === view.taskID) || relatedTasks.find(task => ["running", "stopping", "queued"].includes(task.state)) || relatedTasks.at(-1);
		view.taskID = task?.id || null;
		let make = (tag, text, className) => {
			let node = doc.createElementNS("http://www.w3.org/1999/xhtml", tag);
			if (text !== undefined) node.textContent = text;
			if (className) node.className = className;
			return node;
		};
		let action = (text, callback, disabled = false) => {
			let button = make("button", text); button.type = "button"; button.disabled = disabled;
			button.addEventListener("click", () => Promise.resolve().then(callback).catch(error => {
				Zotero.logError(error); view.error = {key:context.key, message:error.message || String(error)}; this.render(view);
				view.panel.querySelector('[role="alert"]')?.scrollIntoView({block:"nearest"});
			})); return button;
		};
		let iconButton = (label, icon, callback, disabled = false, className = "") => {
			let button = action(label, callback, disabled), image = make("img");
			image.src = `chrome://docflow/content/menu-icons/${icon}.svg`; image.alt = ""; image.className = "of-action-icon";
			button.replaceChildren(image, make("span", label, "of-action-label")); button.className = className; return button;
		};
		let scrollTop = view.panel.scrollTop, focused = doc.activeElement;
		let focusKey = view.panel.contains(focused) ? focused?.getAttribute("data-focus-key") : null;
		let header = make("header"); header.append(make("strong", "OCRFlow"), action("收起", () => this.toggle(view, false, true)));
		let content = make("div", undefined, "of-content");
		if (context.item) {
			content.append(make("p", "当前选中文献", "of-caption"), make("h3", context.title));
			content.appendChild(make("p", context.item.isNote?.() ? context.parent ? "已选中子笔记 · 以下操作针对所属文献，不处理当前笔记正文。" : "独立笔记暂不支持文献处理，请选择文献条目或文件附件。" : context.parent ? "已有父条目" : "独立文件附件", "of-muted"));
			let fileRow = make("div", undefined, "of-file");
			if (context.files.length > 1) {
				let files = make("select"); files.setAttribute("aria-label", "选择本次操作的原文件"); files.setAttribute("data-focus-key", "source-file");
				for (let file of context.files) files.appendChild(Object.assign(make("option", file.getField("title") || file.attachmentFilename), {value:String(file.id)}));
				files.value = String(context.file.id);
				files.addEventListener("change", () => { view.selectActive = null; view.fileID = Number(files.value); view.taskID = null; view.error = null; this.render(view); });
				fileRow.appendChild(files);
			} else fileRow.appendChild(make("span", context.file?.attachmentFilename || context.file?.getField("title") || "未关联原文件"));
			if (context.file) fileRow.appendChild(action("打开", () => view.window.ZoteroPane.viewAttachment(context.file.id)));
			content.appendChild(fileRow);
			let sourceRow = make("div", undefined, "of-source"); sourceRow.appendChild(make("span", context.source ? "✓ 已有全文" : "暂无全文", "of-muted"));
			if (context.source) sourceRow.appendChild(action("查看全文", () => view.window.ZoteroPane.viewAttachment(context.source.id)));
			content.appendChild(sourceRow);
			let section = make("div", undefined, "of-section-title"); section.append(make("span", "文献操作"), action("服务与模型设置", () => plugin.openPreferences("services")));
			content.appendChild(section);
			let operationError = view.error?.key === context.key ? view.error.message : task?.state === "failed" ? task.error || task.detail : "";
			if (operationError) { let error = make("p", operationError, "of-error"); error.setAttribute("role", "alert"); content.appendChild(error); }
			if (view.launching.has(context.key) && !relatedTasks.some(task => ["queued", "running", "stopping"].includes(task.state))) {
				let launching = make("p", "正在创建任务…", "of-muted"); launching.setAttribute("role", "status"); content.appendChild(launching);
			}
			let busy = relatedTasks.some(task => ["queued", "running", "stopping"].includes(task.state)) || view.launching.has(context.key);
			let primary = iconButton("一键整理", "organize", () => this.performDocumentAction(view, "organize"), !this.canPerform(context, "organize", busy), "of-primary");
			primary.title = this.actionUnavailableReason(context, "organize", busy);
			primary.appendChild(make("small", context.source ? "复用现有全文 · 补全缺失信息" : "提取全文 · 建立条目 · 补全信息")); content.appendChild(primary);
			let operations = make("div", undefined, "of-document-actions");
			for (let [kind, label, icon] of [["ocr", "提取全文 / OCR", "ocr"], ["metadata", "补全书目信息", "metadata"], ["summary", "总结文献", "summary"], ["translate", "翻译文献", "translate"], ["outline", "生成阅读大纲", "outline"]]) {
				let button = iconButton(label, icon, () => this.performDocumentAction(view, kind), !this.canPerform(context, kind, busy));
				button.title = this.actionUnavailableReason(context, kind, busy) || (kind === "ocr" && context.source ? "将重新识别关联原文件，保留已有全文。" : "");
				button.setAttribute("data-focus-key", kind); operations.appendChild(button);
			}
			content.appendChild(operations);
			if (!(context.item.isNote?.() && !context.parent)) {
				if (!context.file && !context.source) content.appendChild(make("p", this.actionUnavailableReason(context, "organize"), "of-muted"));
				else if (busy) content.appendChild(make("p", relatedTasks.some(task => task.decision) ? "翻译已暂停，请在下方查看失败原因并选择重试或终止。" : "当前任务执行中，完成后可继续操作。", "of-muted"));
				else {
					if (!context.source || !context.parent) content.appendChild(make("p", this.actionUnavailableReason(context, "summary"), "of-muted"));
					if (context.source) content.appendChild(make("p", context.file ? "已使用现有全文；点击“提取全文 / OCR”将重新识别原文件，保留已有全文。" : this.actionUnavailableReason(context, "ocr"), "of-muted"));
				}
			}
			let more = make("details", undefined, "of-more"); more.open = !!view.moreOpen;
			more.appendChild(make("summary", "更多操作"));
			let moreActions = make("div", undefined, "of-actions");
			moreActions.append(action("建立父条目", () => this.performDocumentAction(view, "parent"), !this.canPerform(context, "parent", busy)),
				action(view.reviewOpening ? "正在打开校勘…" : "审阅 OCR 校勘", () => this.openReview(view, context.source), view.reviewOpening || !view.sourceActions?.review),
				action("查看整理差异", () => plugin.openChangesReport({selectedItems:[context.source]}), !view.sourceActions?.changes));
			more.appendChild(moreActions); more.querySelector("summary").addEventListener("click", () => { view.moreOpen = !more.open; });
			content.appendChild(more);
		} else content.append(make("h3", "请选择一篇文献"), make("p", "选择文献条目或文件附件后，在这里进行全文提取、总结、翻译与校勘。", "of-muted"));

		content.appendChild(make("p", "当前文献任务", "of-section-title"));
		if (relatedTasks.length > 1) {
			let selector = make("select"); selector.setAttribute("aria-label", "选择当前文献的任务"); selector.setAttribute("data-focus-key", "task-selector");
			for (let row of relatedTasks) selector.appendChild(Object.assign(make("option", `${({parse:"提取全文",organize:"一键整理",summary:"总结",translate:"翻译",outline:"大纲",metadata:"书目信息",parent:"建立父条目"})[row.kind]} · ${this.stateLabel(row)}`), {value:String(row.id)}));
			selector.value = String(task.id); selector.addEventListener("change", () => { view.selectActive = null; view.taskID = Number(selector.value); this.render(view); }); content.appendChild(selector);
		}
		if (!task) content.appendChild(make("p", "暂无任务。点击上方操作后，在这里查看执行步骤。", "of-muted"));
		else {
			content.appendChild(make("p", this.stateLabel(task), "of-status"));
			let tool = detail => {
				let box = make("div", undefined, "of-tool"); box.append(make("span", this.serviceLabel(task), "of-muted"), make("p", detail || task.detail || "等待处理"));
				if (task.progress?.total > 0) {
					box.appendChild(make("p", `${["failed", "canceled"].includes(task.state) ? "最后回报进度：" : ""}${task.progress.completed} / ${task.progress.total} ${task.progress.unit || "页"}`, "of-muted"));
					if (task.state === "running" && !task.decision) { let progress = make("progress"); progress.max = task.progress.total; progress.value = task.progress.completed; progress.setAttribute("aria-label", "实际任务进度"); box.appendChild(progress); }
				}
				if (task.error) box.appendChild(make("p", task.error, "of-error"));
				let jobID = task.cancelSettings ? task.cancelJobID : task.jobID;
				if (jobID) { let info = make("details"); info.append(make("summary", "任务信息"), make("p", `任务 ID：${jobID}`, "of-muted")); box.appendChild(info); }
				return box;
			};
			let timeline = make("ol", undefined, "of-timeline");
			let current = task.steps?.find(step => step.state === "running") || [...(task.steps || [])].reverse().find(step => ["failed", "canceled", "wait_expired", "waiting"].includes(step.state));
			for (let step of task.steps || []) {
				let state = this.stepState(task, step), item = make("li", undefined, "of-step"); item.dataset.state = state;
				item.appendChild(make("span", ({completed:"✓",running:"●",failed:"!",canceled:"Ⅱ",pending:"○",not_run:"○",skipped:"—"})[state] || "○", "of-step-mark"));
				let details = make("details"), key = `${task.id}:${step.id}`;
				details.open = view.expanded.has(key) || (!view.collapsed.has(key) && step === current);
				let summary = make("summary"); summary.append(make("span", step.label, "of-step-label"), make("small", ({completed:"已完成",running:"执行中",failed:"失败",canceled:"已终止",pending:"待执行",not_run:"未执行",skipped:"已复用",stopping:"终止中",waiting:"待补充",wait_expired:"等待已结束"})[state], "of-step-state"));
				details.appendChild(summary);
				details.appendChild(step === current ? tool(["running", "stopping", "canceled", "wait_expired", "waiting"].includes(task.state) ? task.detail : task.state === "failed" ? task.error || task.detail : step.detail || task.detail) : make("p", state === "not_run" ? "前序处理已结束，此步骤未执行。" : step.detail || "等待前序步骤完成。", "of-step-detail"));
				summary.addEventListener("click", () => { if (!details.open) {view.expanded.add(key);view.collapsed.delete(key);} else {view.expanded.delete(key);view.collapsed.add(key);} });
				item.appendChild(details); timeline.appendChild(item);
			}
			content.appendChild(timeline);
			if (!current) content.appendChild(tool());
			let actions = make("div", undefined, "of-actions");
			if (task.decision) {
				let options = task.decision.options;
				let error = make("p", plugin.buildFailedChunkSummary(options.failures || [], 5), "of-error"); error.setAttribute("role", "alert"); content.appendChild(error);
				content.appendChild(make("p", "可修改服务、模型或请求参数并保存，再重试失败段落；已完成译段会保留。", "of-muted"));
				let canSave = (options.savable ?? options.completed ?? 0) > 0;
				if (!canSave) content.appendChild(make("p", "尚无完整译段，暂不能保存部分译文。", "of-muted"));
				for (let [label, value] of [["重试失败段落", "retry"], ["保存部分译文", "save"], ["放弃剩余翻译", "discard"]]) actions.appendChild(action(label, () => plugin.resolveTaskDecision(task, value), value === "save" && !canSave));
				actions.appendChild(action("服务与模型设置", () => plugin.openPreferences("work")));
			}
			else if (["failed", "canceled", "wait_expired", "waiting"].includes(task.state)) actions.appendChild(action(task.state === "waiting" ? "继续整理" : task.state === "wait_expired" ? "继续等待" : "重新处理", () => plugin.retryParseQueueTasks([task.id])));
			if (["queued", "running", "wait_expired"].includes(task.state) || task.cancelFailed) actions.appendChild(action(task.cancelFailed ? "重试终止" : "终止任务", () => plugin.cancelParseQueueTask(task.id), !!task.saving));
			if (task.resultAttachment) {
				actions.appendChild(action("查看结果", () => view.window.ZoteroPane.viewItems([task.resultAttachment])));
				if (task.collationStatus) actions.appendChild(action(view.reviewOpening ? "正在打开校勘…" : "审阅 OCR 校勘", () => this.openReview(view, task.resultAttachment), view.reviewOpening));
				if (task.hasChangesReport) actions.appendChild(action("整理差异报告", () => plugin.openChangesReport({selectedItems:[task.resultAttachment]})));
			}
			content.appendChild(actions);
		}
		let footer = make("footer"); footer.append(action("全部任务队列", () => plugin.openParseQueueDialog()), make("small", `${active.length} 项进行中`, "of-muted"));
		view.panel.replaceChildren(header, content, footer); view.panel.scrollTop = scrollTop;
		if (focusKey) [...view.panel.querySelectorAll("[data-focus-key]")].find(node => node.getAttribute("data-focus-key") === focusKey)?.focus({preventScroll:true});
	},

	stateLabel(task) {
		if (task.decision) return "等待处理失败译段";
		if (task.state === "completed" && task.partial) return "已保存部分译文";
		if (task.state === "completed" && ["failed", "partial"].includes(task.collationAIStatus)) return "底稿已保存 · AI 辅助校勘未全部完成";
		if (task.state === "completed" && task.collationStatus === "failed") return "底稿已保存 · 对照识别未完成";
		if (task.state === "completed" && (task.collationFindings > 0 || task.collationMissing > 0)) return `已保存 · ${task.collationFindings} 组分歧，缺失 ${task.collationMissing || 0} 页待审阅`;
		return ({queued:"排队中",running:"正在执行",stopping:"正在终止",completed:"已完成",failed:"需要处理",canceled:"已终止",wait_expired:"等待已结束",waiting:"待补充"})[task.state] || task.state;
	},

	serviceLabel(task) {
		let settings = task.displaySettings || task.settings;
		if (settings.parserService === "ai" || (!settings.parserService && settings.model) || !["parse", "organize"].includes(task.kind)) {
			let model = settings.llmSettings || settings;
			return [model.providerName, model.model].filter(Boolean).join(" · ") || "AI 工作";
		}
		return ({"paddle-cloud":"PaddleOCR · 官方 API","paddle-local":"PaddleOCR · 自部署 API",markitdown:"MarkItDown"})[settings.parserService] || (settings.apiMode === "local-v1" ? "MinerU · 本地服务" : "MinerU · 官方云端");
	},

	unmount(window) {
		let view = this.views.get(window); if (!view) return;
		view.observer.disconnect(); view.rail.removeEventListener("click", view.onRailClick, true);
		view.panel.removeEventListener("pointerdown", view.onPointerDown);
		view.panel.removeEventListener("focusout", view.onSelectBlur);
		view.panel.removeEventListener("keydown", view.onSelectKey);
		window.document.removeEventListener("pointerup", view.onPointerEnd, true);
		window.document.removeEventListener("pointercancel", view.onPointerEnd, true);
		window.removeEventListener("blur", view.onPointerEnd);
		if (view.pointerTimer) window.clearTimeout(view.pointerTimer);
		view.host.classList.remove("ocrflow-sidebar-open");
		view.panel.remove(); view.button.remove(); view.style.remove(); this.views.delete(window);
	},

	shutdown() {
		for (let window of this.views.keys()) this.unmount(window);
		for (let task of this.plugin.parseQueue) if (task.decision) this.plugin.resolveTaskDecision(task, "discard");
	}
};

Object.assign(DocFlow, {
	initializeTaskSteps(task) {
		if (!task.steps) {
			let labels = ["parse", "organize"].includes(task.kind)
				? [["extract", "识别全文"], ["structure", "整理文档结构"], ...(task.settings.collationEnabled ? [["compare", "对照识别 B"]] : []), ...(task.settings.collationEnabled && task.settings.collationAIEnabled ? [["ai-review", "AI 辅助校勘"]] : []), ["save", "保存结果"], ...(task.kind === "organize" ? [["metadata", "补充书目信息"]] : [])]
				: [["work", ({translate:"逐段翻译",summary:"生成学术总结",metadata:"补充书目信息",parent:"建立父条目",outline:"生成阅读器大纲"})[task.kind] || "处理文档"], ["save", "保存结果"]];
			labels.unshift(["read", "确认文献与来源"]);
			task.steps = labels.map(([id, label]) => ({id, label, state:"pending", detail:"等待执行"}));
		}
		for (let step of task.steps) if (["failed", "canceled", "wait_expired", "waiting"].includes(step.state)) step.state = "pending";
		this.setTaskStep(task, "read", "确认文献与来源", task.title || "已确认处理对象", "completed");
		if (!["parse", "organize"].includes(task.kind)) this.setTaskStep(task, "work", task.steps.find(step => step.id === "work").label, "准备处理");
	},

	finishTaskSteps(task) {
		for (let step of task.steps || []) {
			if (step.state === "running") step.state = task.state;
			if (task.state === "completed" && step.state === "pending") {
				step.state = step.id === "save" ? "completed" : "skipped";
				step.detail = step.id === "save" ? "结果已保存" : "使用已有结果，此步骤无需再次执行";
			}
		}
	},

	setTaskStep(task, id, label, detail = "", state = "running") {
		task.steps ||= [];
		let step = task.steps.find(step => step.id === id);
		if (!step) { step = {id, label}; task.steps.push(step); }
		if (state === "running") for (let other of task.steps) if (other !== step && other.state === "running") other.state = "completed";
		Object.assign(step, {state, detail});
		this.refreshParseQueueDialog();
	},

	requestTaskDecision(task, options) {
		if (!this.sidebar?.views.size) return Promise.resolve(this.confirmRetryFailedChunks(this.parseQueueWindow || Zotero.getMainWindow(), options));
		task.detail = `翻译已暂停：已完成 ${options.completed || 0}/${options.total || 0} 段，${options.failures?.length || 0} 段失败，等待处理。`;
		return new Promise((resolve, reject) => {
			let signal = task.controller.signal;
			let abort = () => { task.decision = null; signal.removeEventListener("abort", abort); reject(signal.reason || new Error("已终止")); this.refreshParseQueueDialog(); };
			signal.throwIfAborted();
			task.decision = {options, resolve:value => { task.decision = null; signal.removeEventListener("abort", abort); resolve(value); this.refreshParseQueueDialog(); }};
			signal.addEventListener("abort", abort, {once:true});
			this.refreshParseQueueDialog();
		});
	},

	resolveTaskDecision(task, value) {
		if (!task.decision) return;
		if (value === "save" && !(task.decision.options.savable ?? task.decision.options.completed)) throw new Error("尚无完整译段，无法保存部分译文。请重试失败段落或终止任务。");
		if (value === "retry" && task.kind === "translate") {
			let settings = this.getTranslationSettings();
			if (settings.translateLanguage !== task.settings.translateLanguage) throw new Error("翻译语言已改变，请先终止当前任务，再重新翻译，避免混合不同语言的译文。");
			task.settings = settings;
		}
		task.decision.resolve(value);
	}
});
