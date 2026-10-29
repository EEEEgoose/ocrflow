var ocrflowText = typeof ocrflowText === "function" ? ocrflowText : value => String(value ?? "");
var OCRFlowTaskSidebar = {
	views: new Map(),
	plugin: null,

	init(plugin) {
		this.plugin = plugin;
		this.tabObserver = Zotero.Notifier?.registerObserver({notify:(action) => {
			if (["select", "load", "close"].includes(action)) for (let view of this.views.values()) {
				this.place(view); this.followSelection(view); this.render(view);
			}
		}}, ["tab"], plugin.id+"-sidebar", 30);
	},

	showUpdateNotice(version) {
		let read=name=>Zotero.Prefs.get(this.plugin.PREF_BRANCH+name,true);
		return read("noticeClosedVersion")!==version && String(read("noticeMutedMajor")||"")!==version.split(".")[0];
	},

	dismissUpdateNotice(version, major = false) {
		Zotero.Prefs.set(this.plugin.PREF_BRANCH+(major?"noticeMutedMajor":"noticeClosedVersion"),major?version.split(".")[0]:version,true);
		this.refresh();
	},

	mount(window) {
		if (this.views.has(window)) return;
		let doc = window.document, host = doc.getElementById("zotero-item-pane"), rail = doc.getElementById("zotero-view-item-sidenav");
		if (!host || !rail) return;
		let make = tag => doc.createElementNS("http://www.w3.org/1999/xhtml", tag);
		let style = doc.createElementNS("http://www.w3.org/1999/xhtml", "link");
		style.rel = "stylesheet"; style.href = "chrome://docflow/content/task-sidebar.css?v="+encodeURIComponent(this.plugin.version || ""); doc.documentElement.appendChild(style);
		let button = make("button"); button.id = "ocrflow-sidebar-button"; button.className = "ocrflow-sidebar-button";
		button.type = "button"; button.title = "OCRFlow 任务进度"; button.setAttribute("aria-label", ocrflowText("OCRFlow 任务进度"));
		button.setAttribute("aria-controls", "ocrflow-task-sidebar"); button.setAttribute("aria-expanded", "false");
		let icon = make("span"); icon.className = "ocrflow-sidebar-icon"; icon.setAttribute("aria-hidden", "true");
		let badge = make("span"); badge.className = "ocrflow-task-badge"; badge.hidden = true; button.append(icon, badge);
		rail.insertBefore(button, rail.querySelector(".highlight-notes-active")?.previousElementSibling || null);
		let panel = make("section"); panel.id = "ocrflow-task-sidebar"; panel.hidden = true; panel.setAttribute("aria-label", ocrflowText("OCRFlow 任务进度"));
		host.insertBefore(panel, doc.getElementById("zotero-item-pane-content"));
		let view = { window, host, rail, libraryHost:host, libraryRail:rail, panel, button, badge, style, open: false, dismissed: false, taskID: null, expanded: new Set(), collapsed: new Set(), launching: new Set(), fileID: null };
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
		this.place(view); this.render(view);
	},

	selectedItems(view) {
		let tabs = view.window.Zotero_Tabs;
		if (tabs && tabs.selectedType !== "library") {
			let reader = Zotero.Reader.getByTabID(tabs.selectedID), item = reader && Zotero.Items.get(reader.itemID);
			return item ? [item] : [];
		}
		return view.window.ZoteroPane.getSelectedItems();
	},

	place(view) {
		let win=view.window, doc=win.document, reader=win.Zotero_Tabs && win.Zotero_Tabs.selectedType !== "library";
		let host=reader ? doc.getElementById("zotero-context-pane-inner") : view.libraryHost;
		let rail=reader ? doc.getElementById("zotero-context-pane-sidenav") : view.libraryRail;
		if (!host || !rail) return;
		if (view.host !== host) {
			view.host.classList.remove("ocrflow-sidebar-open"); view.rail.removeEventListener("click",view.onRailClick,true);
			host.insertBefore(view.panel,doc.getElementById(reader ? "zotero-context-pane-deck" : "zotero-item-pane-content"));
			rail.appendChild(view.button); rail.addEventListener("click",view.onRailClick,true);
			view.host=host; view.rail=rail;
		}
		let item=this.selectedItems(view)[0], key=reader ? item?.id : "library";
		if (key !== view.placementKey && reader && item && !view.dismissed && (this.plugin.isMarkdownResult(item) || this.plugin.isTranslationResult(item))) view.open=true;
		view.placementKey=key; view.panel.hidden=!view.open;
		view.host.classList.toggle("ocrflow-sidebar-open",view.open); view.button.setAttribute("aria-expanded",String(view.open));
		if (reader && view.open) win.ZoteroContextPane.collapsed=false;
	},

	async openDocument(view, item) {
		if (["html","htm"].includes(this.plugin.documentExtension(item))) {
			await Zotero.Reader.open(item.id);
			this.place(view); this.toggle(view,true,true);
		} else await view.window.ZoteroPane.viewAttachment(item.id);
	},

	toggle(view, open, manual = false) {
		view.open = open;
		view.panel.hidden = !open;
		if (manual) view.dismissed = !open;
		view.host.classList.toggle("ocrflow-sidebar-open", open);
		view.button.setAttribute("aria-expanded", String(open));
		if (open) { this.followSelection(view); view.host.collapsed = false; }
		else if (manual) view.host.collapsed = true;
		if (view.window.Zotero_Tabs && view.window.Zotero_Tabs.selectedType !== "library") view.window.ZoteroContextPane.collapsed=!open;
		this.render(view);
	},

	documentContext(view) {
		let selected = this.selectedItems(view);
		if (selected.length !== 1) return { key:"", item:null, files:[], file:null, source:null, parent:null };
		let plugin = this.plugin, item = selected[0], parent = plugin.parentForDocument(item);
		let explicit = plugin.isMarkdownResult(item) ? item : plugin.isTranslationResult(item) ?
			plugin.relatedDocuments(item).find(doc => plugin.isMarkdownResult(doc)) || (view.translationContext?.id === item.id ? view.translationContext.source : null) : null;
		if (plugin.isTranslationResult(item) && !explicit && view.translationContext?.id !== item.id) this.loadTranslationContext(view,item);
		if (plugin.isTranslationResult(item) && !explicit) return {key:`${item.id}:translation`,item,files:[],file:null,source:null,translation:item,parent,title:(parent || item).getField("title")};
		let files = explicit ? plugin.relatedDocuments(explicit).filter(doc => plugin.collectSourceFiles([doc]).length)
			: plugin.collectSourceFiles([item.isNote?.() ? parent || item : item]);
		if (explicit && !files.length && parent) { let originals = plugin.collectSourceFiles([parent]).filter(doc => !plugin.isMarkdownResult(doc)); if (originals.length === 1) files = originals; }
		let file = files.find(file => file.id === view.fileID) || files[0] || null;
		view.fileID = file?.id || null;
		let source = explicit || (file ? plugin.findDocumentMarkdown(file) : null);
		if (!source && !files.length && parent) source = parent.getAttachments().map(id => Zotero.Items.get(id)).filter(doc => plugin.isMarkdownResult(doc)).at(-1) || null;
		let translation = source ? plugin.findDocumentTranslation(source) || (view.sourceActions?.id === source.id ? view.sourceActions.translation : null) : null;
		return { key:`${item.id}:${file?.id || source?.id || ""}`, item, files, file, source, translation, parent,
			title:(parent || item).getField("title") || file?.attachmentFilename || "未命名文献" };
	},

	documentTasks(context) {
		if (!context.item) return [];
		let ids = new Set([context.file?.id, context.source?.id, !context.files.length ? context.item.id : null].filter(Boolean));
		return this.plugin.parseQueue.filter(task => (task.kind === "title" && task.attachment.id === context.parent?.id) || [task.attachment.id, task.source?.id, task.mineruSource?.id, task.resultAttachment?.id].some(id => ids.has(id)));
	},

	async loadSourceActions(view, source) {
		let state = {id:source.id, review:false, changes:false, translation:null}; view.sourceActions = state;
		try {
			let path = await source.getFilePath();
			if (path) {
				let root = PathUtils.join(PathUtils.parent(path), "_ocrflow");
				[state.review, state.changes] = await Promise.all([IOUtils.exists(PathUtils.join(root, "collation.json")), IOUtils.exists(PathUtils.join(root, "changes.html"))]);
			}
			let parent=this.plugin.parentForDocument(source);
			for (let id of parent?.getAttachments() || []) {
				let item=Zotero.Items.get(id);
				if (!this.plugin.isTranslationResult(item) || !["html","htm"].includes(this.plugin.documentExtension(item)) || !item.getTags().some(tag=>tag.tag==="#DocFlow-Translation")) continue;
				let path=await item.getFilePath();
				if (!path) continue;
				let file=PathUtils.join(PathUtils.parent(path),"_ocrflow","translation.json");
				if (await IOUtils.exists(file)) {
					let data=JSON.parse(await IOUtils.readUTF8(file));
					if (data.sourceKey===source.key && (!state.translation || item.id>state.translation.id)) state.translation=item;
				}
			}
		} catch (error) { Zotero.logError(error); }
		if (this.views.get(view.window) === view && view.sourceActions === state) this.render(view);
	},

	async loadTranslationContext(view, item) {
		let state={id:item.id,source:null};view.translationContext=state;
		try {
			let path=await item.getFilePath();
			let file=PathUtils.join(PathUtils.parent(path),"_ocrflow","translation.json");
			if (await IOUtils.exists(file)) {
				let data=JSON.parse(await IOUtils.readUTF8(file));
				state.source=Zotero.Items.getByLibraryAndKey(item.libraryID,data.sourceKey);
			}
		} catch(error) {Zotero.logError(error);}
		if (this.views.get(view.window)===view && view.translationContext===state) this.render(view);
	},

	async openReview(view, source) {
		if (view.reviewOpening) return;
		view.reviewOpening = true; this.render(view);
		try { await this.plugin.openCollationReview({selectedItems:[source]}); }
		finally { view.reviewOpening = false; this.render(view); }
	},

	async convertDocumentLayout(view,htmlLayout) {
		let context=this.documentContext(view);
		if(!context.source || view.layoutConverting)return;
		view.layoutConverting=true;view.launching.add(context.key);view.error=null;this.render(view);
		try {
			let item=await this.plugin.convertDocumentLayout({source:context.source,original:context.file,htmlLayout});
			await this.openDocument(view,item);
		} finally {view.layoutConverting=false;view.launching.delete(context.key);this.render(view);}
	},

	actionUnavailableReason(context, kind, busy = false) {
		if (!context.item) return "请先选择一篇文献或文件附件。";
		if (context.item.isNote?.() && !context.parent) return "独立笔记暂不支持文献处理，请选择文献条目或文件附件。";

		if (kind === "title") {
			if (!context.parent) return "请先建立条目，再翻译标题。";
			if (!context.parent.getField("title").trim()) return "当前条目没有标题，请先填写原标题。";
		} else if (["metadata", "summary", "translate"].includes(kind)) {
			if ((!context.parent || !context.source) && this.plugin.hasPendingRecognition?.(context.file || context.item)) return "";
			if (!context.parent) return "请先通过“一键整理”建立父条目，再进行总结、翻译或信息补全。";
			if (!context.source) return "请先识别文档，再进行总结、翻译或信息补全。";
		} else if (kind === "parent") {
			if (context.parent) return "此文献已有父条目，无需重复建立。";
			if (!context.file) return "未关联原文件，可通过“一键整理”根据全文建立父条目。";
		} else if (kind === "outline") {
			if (!context.file?.isPDFAttachment?.()) return "生成大纲需要关联的原始 PDF，请选择 PDF 附件。";
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
		let busy = this.documentTasks(context).some(task => ["queued", "running", "stopping", "waiting_dependency"].includes(task.state)) || view.launching.has(context.key);
		if (!this.canPerform(context, kind, busy)) {
			view.error = {key:context.key, message:this.actionUnavailableReason(context, kind, busy)};
			this.render(view); return;
		}
		view.launching.add(context.key); view.error = null; this.render(view);
		try {
			let target = kind === "title" ? context.parent : ["summary", "metadata", "translate"].includes(kind) || (kind === "organize" && plugin.isMarkdownResult(context.item)) ? context.source || context.file : context.file || context.source;
			let options = {window:view.window, selectedItems:[target], ...(kind === "translate" ? {force:true} : {})};
			let running;
			if (kind === "organize") running=plugin.handleOrganizeCommand(options);
			else if (kind === "ocr") running=plugin.handleParseCommand(options);
			else if (kind === "translate") running=plugin.handleTranslateCommand(options);
			else if (kind === "title") running=plugin.handleTitleTranslation(options);
			else if (kind === "outline") running=plugin.outline.enqueueSelected([target]);
			else running=plugin.handleDocumentCommand(kind, options);
			if(this.documentTasks(context).some(task=>["queued","running","stopping"].includes(task.state))) { view.launching.delete(context.key);this.render(view); }
			await running;
		} finally { view.launching.delete(context.key); this.render(view); }
	},

	stepState(task, step) {
		if (task.decision && step.state === "running") return "waiting";
		if (step.state === "running" && ["failed", "canceled", "wait_expired", "waiting", "stopping"].includes(task.state)) return task.state;
		if (step.state === "pending" && ["failed", "canceled", "completed"].includes(task.state)) return "not_run";
		return step.state;
	},

	followSelection(view) {
		let key = this.selectedItems(view).map(item => item.id).join(",");
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
		let active = tasks.filter(task => ["queued", "running", "stopping", "waiting_dependency"].includes(task.state));
		view.badge.textContent = String(active.length); view.badge.hidden = !active.length;
		view.button.title = ocrflowText(active.length ? `OCRFlow · ${active.length} 项任务进行中` : "OCRFlow 文献操作");
		if (!view.open) return;
		let context = this.documentContext(view), relatedTasks = this.documentTasks(context), doc = view.window.document;
		if (context.source && view.sourceActions?.id !== context.source.id) this.loadSourceActions(view, context.source);
		if (!context.source) view.sourceActions = null;
		let task = relatedTasks.find(task => task.id === view.taskID) || relatedTasks.find(task => ["running", "stopping", "queued"].includes(task.state)) || relatedTasks.at(-1);
		view.taskID = task?.id || null;
		let make = (tag, text, className, content = false) => {
			let node = doc.createElementNS("http://www.w3.org/1999/xhtml", tag);
			if (text !== undefined) node.textContent = content ? text : ocrflowText(text);
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
		let version=plugin.version || "1.5.6";
		let readLocal=name=>Zotero.Prefs?.get(plugin.PREF_BRANCH+name,true),writeLocal=(name,value)=>Zotero.Prefs?.set(plugin.PREF_BRANCH+name,value,true);
		if(!readLocal("noticeBaseline"))writeLocal("noticeBaseline",version);
		if(this.showUpdateNotice(version)) {
			let notice=make("aside",undefined,"of-update-notice");notice.setAttribute("role","status");
			let heading=make("div",undefined,"of-update-heading");
			let icon=doc.createElementNS("http://www.w3.org/2000/svg","svg"),path=doc.createElementNS("http://www.w3.org/2000/svg","path");
			icon.setAttribute("viewBox","0 0 20 20");icon.setAttribute("class","of-update-icon");icon.setAttribute("aria-hidden","true");
			for(let [name,value] of Object.entries({width:17,height:17,fill:"none",stroke:"currentColor","stroke-width":1.5,"stroke-linecap":"round","stroke-linejoin":"round"}))icon.setAttribute(name,String(value));
			path.setAttribute("d","M16.6 8a6.7 6.7 0 0 0-11-3.1L3 7.5m0-4v4h4M3.4 12a6.7 6.7 0 0 0 11 3.1l2.6-2.6m0 4v-4h-4");icon.append(path);
			heading.append(icon,make("strong","本次更新"),make("span",`v${version}`,"of-update-version",true));notice.append(heading);
			let updates=make("ul",undefined,"of-update-list");
			for(let [label,text] of [["HTML 布局","：可选原文布局或 Markdown 布局。"],["侧栏操作","：直接打开已有全文和译文；更多操作支持重新识别、重译全文。"],["阅读侧栏","：打开识别 HTML 和译文时，同步显示 OCRFlow 面板。"],["全文总结","：提示词更新，笔记中注明实际使用模型。"],["PDF 兼容","：支持无需打开密码的加密 PDF，保留原附件。"]]) {
				let item=make("li");item.append(make("strong",label),make("span",text));updates.append(item);
			}notice.append(updates);
			notice.append(make("p","已有自定义提示词和全文翻译格式保持不变。","of-update-note"));
			let buttons=make("div",undefined,"of-update-actions"),close=action("关闭",()=>this.dismissUpdateNotice(version)),mute=action("不再提醒",()=>this.dismissUpdateNotice(version,true));
			close.title=ocrflowText("关闭当前版本的提示，重启后仍有效");mute.title=ocrflowText("不再提醒当前大版本下的更新；升级大版本时仍提醒");
			buttons.append(close,mute);notice.append(buttons);content.append(notice);
		}
		if (context.item) {
			content.append(make("p", "当前选中文献", "of-caption"), make("h3", context.title, undefined, true));
			content.appendChild(make("p", context.item.isNote?.() ? context.parent ? "已选中子笔记 · 以下操作针对所属文献，不处理当前笔记正文。" : "独立笔记暂不支持文献处理，请选择文献条目或文件附件。" : context.parent ? "已有父条目" : "独立文件附件", "of-muted"));
			let fileRow = make("div", undefined, "of-file");
			if (context.files.length > 1) {
				let files = make("select"); files.setAttribute("aria-label", ocrflowText("选择本次操作的原文件")); files.setAttribute("data-focus-key", "source-file");
				for (let file of context.files) files.appendChild(Object.assign(make("option", file.getField("title") || file.attachmentFilename, undefined, true), {value:String(file.id)}));
				files.value = String(context.file.id);
				files.addEventListener("change", () => { view.selectActive = null; view.fileID = Number(files.value); view.taskID = null; view.error = null; this.render(view); });
				fileRow.appendChild(files);
			} else fileRow.appendChild(make("span", context.file?.attachmentFilename || context.file?.getField("title") || ocrflowText("未关联原文件"), undefined, true));
			if (context.file) fileRow.appendChild(action("打开", () => view.window.ZoteroPane.viewAttachment(context.file.id)));
			content.appendChild(fileRow);
			let sourceRow = make("div", undefined, "of-source"); sourceRow.appendChild(make("span", context.source ? "✓ 已有全文" : "暂无全文", "of-muted"));
			if (context.source) sourceRow.appendChild(action("查看全文", () => this.openDocument(view,context.source)));
			content.appendChild(sourceRow);
			let section = make("div", undefined, "of-section-title"); section.append(make("span", "文献操作"), action("服务与模型设置", () => plugin.openPreferences("services")));
			content.appendChild(section);
			let operationError = view.error?.key === context.key ? view.error.message : task?.state === "failed" ? task.error || task.detail : "";
			if (operationError) { let error = make("p", operationError, "of-error"); error.setAttribute("role", "alert"); content.appendChild(error); }
			if (view.launching.has(context.key) && !relatedTasks.some(task => ["queued", "running", "stopping", "waiting_dependency"].includes(task.state))) {
				let launching = make("p", "正在创建任务…", "of-muted"); launching.setAttribute("role", "status"); content.appendChild(launching);
			}
			let busy = relatedTasks.some(task => ["queued", "running", "stopping", "waiting_dependency"].includes(task.state)) || view.launching.has(context.key);
			let primary = iconButton("一键整理", "organize", () => this.performDocumentAction(view, "organize"), !this.canPerform(context, "organize", busy), "of-primary");
			primary.title = ocrflowText(this.actionUnavailableReason(context, "organize", busy));
			primary.appendChild(make("small", "识别、建条、补全、总结、翻译、大纲")); content.appendChild(primary);
			let operations = make("div", undefined, "of-document-actions");
			for (let [kind, label, icon] of [["ocr", "识别文档", "ocr"], ["metadata", "补全条目", "metadata"], ["summary", "总结文献", "summary"], ["translate", "翻译文献", "translate"], ["outline", "生成大纲", "outline"], ["title", "翻译标题", "translate"]]) {
				let existing=kind==="ocr" ? context.source : kind==="translate" ? context.translation : null;
				if (existing) label=kind==="ocr" ? ["html","htm"].includes(plugin.documentExtension(existing)) ? "打开HTML" : "打开全文" : "打开译文";
				let button = iconButton(label, icon, () => existing ? this.openDocument(view,existing) : this.performDocumentAction(view, kind), !existing && !this.canPerform(context, kind, busy));
				button.title = ocrflowText(existing ? label : this.actionUnavailableReason(context, kind, busy));
				button.setAttribute("data-focus-key", kind); operations.appendChild(button);
			}
			content.appendChild(operations);
			if (!(context.item.isNote?.() && !context.parent)) {
				if (!context.file && !context.source) content.appendChild(make("p", this.actionUnavailableReason(context, "organize"), "of-muted"));
				else if (busy) content.appendChild(make("p", relatedTasks.some(task => task.decision) ? "翻译已暂停，请在下方查看失败原因并选择重试或终止。" : "当前任务执行中，其他操作可加入队列。", "of-muted"));
				else {
					if (!context.source || !context.parent) content.appendChild(make("p", this.actionUnavailableReason(context, "summary"), "of-muted"));
					if (context.source) content.appendChild(make("p", context.file ? "已使用现有全文；可在“更多操作”中重新识别或重译。" : this.actionUnavailableReason(context, "ocr"), "of-muted"));
				}
			}
			let more = make("details", undefined, "of-more"); more.open = !!view.moreOpen;
			more.appendChild(make("summary", "更多操作"));
			let moreActions = make("div", undefined, "of-actions");
			moreActions.append(action("重新识别",()=>this.performDocumentAction(view,"ocr"),!this.canPerform(context,"ocr",busy)),action("重译全文",()=>this.performDocumentAction(view,"translate"),!this.canPerform(context,"translate",busy)));
			moreActions.append(action("转为原文布局",()=>this.convertDocumentLayout(view,"original"),!context.source || busy || view.layoutConverting),action("转为MD布局",()=>this.convertDocumentLayout(view,"markdown"),!context.source || busy || view.layoutConverting));
			moreActions.append(action("建立条目", () => this.performDocumentAction(view, "parent"), !this.canPerform(context, "parent", busy)),
				action(view.reviewOpening ? "正在打开校勘…" : "审阅 OCR 校勘", () => this.openReview(view, context.source), view.reviewOpening || !view.sourceActions?.review),
				action("查看整理差异", () => plugin.openChangesReport({selectedItems:[context.source]}), !view.sourceActions?.changes));
			more.appendChild(moreActions); more.querySelector("summary").addEventListener("click", () => { view.moreOpen = !more.open; });
			content.appendChild(more);
		} else content.append(make("h3", "请选择一篇文献"), make("p", "选择文献条目或文件附件后，在这里进行全文提取、总结、翻译与校勘。", "of-muted"));

		content.appendChild(make("p", "当前文献任务", "of-section-title"));
		if (relatedTasks.length > 1) {
			let selector = make("select"); selector.setAttribute("aria-label", ocrflowText("选择当前文献的任务")); selector.setAttribute("data-focus-key", "task-selector");
			for (let row of relatedTasks) selector.appendChild(Object.assign(make("option", `${ocrflowText(({parse:"识别文档",organize:"一键整理",summary:"总结",title:"翻译标题",translate:"翻译",outline:"大纲",metadata:"书目信息",parent:"建立条目"})[row.kind])} · ${ocrflowText(this.stateLabel(row))}`), {value:String(row.id)}));
			selector.value = String(task.id); selector.addEventListener("change", () => { view.selectActive = null; view.taskID = Number(selector.value); this.render(view); }); content.appendChild(selector);
		}
		if (!task) content.appendChild(make("p", "暂无任务。点击上方操作后，在这里查看执行步骤。", "of-muted"));
		else {
			content.appendChild(make("p", this.stateLabel(task), "of-status"));
			let tool = detail => {
				let box = make("div", undefined, "of-tool"); box.append(make("span", this.serviceLabel(task), "of-muted", true), make("p", detail || task.detail || "等待处理"));
				if (task.progress?.total > 0) {
					box.appendChild(make("p", `${["failed", "canceled"].includes(task.state) ? "最后回报进度：" : ""}${task.progress.completed} / ${task.progress.total} ${ocrflowText(task.progress.unit || "页")}`, "of-muted"));
					if (task.state === "running" && !task.decision) { let progress = make("progress"); progress.max = task.progress.total; progress.value = task.progress.completed; progress.setAttribute("aria-label", ocrflowText("实际任务进度")); box.appendChild(progress); }
				}
				if (task.error) box.appendChild(make("p", task.error, "of-error"));
				let jobID = task.cancelSettings ? task.cancelJobID : task.jobID;
				if (jobID) {
					let info = make("details"), key=`${task.id}:job`, summary=make("summary","任务信息");
					info.open=view.expanded.has(key);summary.setAttribute("data-focus-key",key);
					summary.addEventListener("click",event=>{event.preventDefault();event.stopPropagation();info.open=!info.open;if(info.open)view.expanded.add(key);else view.expanded.delete(key);});
					info.append(summary, make("p", `任务 ID：${jobID}`, "of-muted"));
					for(let part of task.parts||[]) {
						let label=({queued:"待提交",uploading:"上传中",pending:"服务端排队中",running:"正在解析",converting:"正在转换",done:"已完成",failed:"失败"})[part.state]||part.state;
						info.append(make("p",(part.end?`${part.start}–${part.end}`:part.name)+" · "+ocrflowText(label)+(part.total?` · ${part.completed}/${part.total}`:""),"of-muted",true));
					}box.appendChild(info);
				}
				return box;
			};
			let timeline = make("ol", undefined, "of-timeline");
			let current = task.steps?.find(step => step.state === "running") || [...(task.steps || [])].reverse().find(step => ["failed", "canceled", "wait_expired", "waiting"].includes(step.state));
			for (let step of task.steps || []) {
				let state = this.stepState(task, step), item = make("li", undefined, "of-step"); item.dataset.state = state;
				item.appendChild(make("span", ({completed:"✓",running:"●",failed:"!",canceled:"Ⅱ",pending:"○",not_run:"○",skipped:"—"})[state] || "○", "of-step-mark"));
				let details = make("details"), key = `${task.id}:${step.id}`;
				details.open = view.expanded.has(key) || (!view.collapsed.has(key) && step === current);
				let summary = make("summary"); summary.append(make("span", step.label, "of-step-label"), make("small", state==="running"&&task.phase==="Marker · queued" ? "排队中" : ({completed:"已完成",running:"执行中",failed:"失败",canceled:"已终止",pending:"待执行",not_run:"未执行",skipped:"已复用",stopping:"终止中",waiting:"待补充",wait_expired:"等待已结束"})[state], "of-step-state"));
				details.appendChild(summary);
				details.appendChild(step === current ? tool(["running", "stopping", "canceled", "wait_expired", "waiting"].includes(task.state) ? task.detail : task.state === "failed" ? task.error || task.detail : step.detail || task.detail) : make("p", state === "not_run" ? "前序处理已结束，此步骤未执行。" : step.detail || "等待前序步骤完成。", "of-step-detail", step.id === "read"));
				summary.addEventListener("click", () => { if (!details.open) {view.expanded.add(key);view.collapsed.delete(key);} else {view.expanded.delete(key);view.collapsed.add(key);} });
				item.appendChild(details); timeline.appendChild(item);
			}
			content.appendChild(timeline);
			if (!current) content.appendChild(tool());
			let actions = make("div", undefined, "of-actions");
			if(task.needsRecognition)actions.appendChild(action("识别后继续生成大纲",()=>plugin.recognizeThenOutline(task)));
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
			if (["queued", "running", "wait_expired"].includes(task.state) || task.cancelFailed) actions.appendChild(action(task.cancelFailed ? "重试终止" : ((task.cancelSettings||task.settings).parserService==="marker" && (task.cancelSettings||task.settings).markerSettings?.apiType==="cloud") ? "停止等待" : "终止任务", () => plugin.cancelParseQueueTask(task.id), !!task.saving));
			if (task.resultAttachment) {
				actions.appendChild(action("查看结果", () => task.resultAttachment.isAttachment?.() ? this.openDocument(view,task.resultAttachment) : view.window.ZoteroPane.viewItems([task.resultAttachment])));
				if (task.collationStatus) actions.appendChild(action(view.reviewOpening ? "正在打开校勘…" : "审阅 OCR 校勘", () => this.openReview(view, task.resultAttachment), view.reviewOpening));
				if (task.hasChangesReport) actions.appendChild(action("整理差异报告", () => plugin.openChangesReport({selectedItems:[task.resultAttachment]})));
			}
			for (let [kind,label] of [["summary","查看总结"],["translate","查看译文"]]) {
				let result=task.organizeResults?.[kind];
				if(result)actions.appendChild(action(label,()=>result.isAttachment?.() ? this.openDocument(view,result) : view.window.ZoteroPane.viewItems([result])));
			}
			content.appendChild(actions);
		}
		let footer = make("footer"); footer.append(action("全部任务队列", () => plugin.openParseQueueDialog()), make("small", `${active.length} 项进行中`, "of-muted"));
		view.panel.replaceChildren(header, content, footer); view.panel.scrollTop = scrollTop;
		if (focusKey) [...view.panel.querySelectorAll("[data-focus-key]")].find(node => node.getAttribute("data-focus-key") === focusKey)?.focus({preventScroll:true});
	},

	stateLabel(task) {
		if(task.state==="running"&&task.phase==="Marker · queued")return "Marker 服务端排队中";
		if (task.decision) return "等待处理失败译段";
		if (task.state === "completed" && task.partial) return "已保存部分译文";
		if (task.state === "completed" && ["failed", "partial"].includes(task.collationAIStatus)) return "底稿已保存 · AI 辅助校勘未全部完成";
		if (task.state === "completed" && task.collationStatus === "failed") return "底稿已保存 · 对照识别未完成";
		if (task.state === "completed" && task.collationAutoApplied) return `已保存 · AI 已应用 ${task.collationAutoApplied} 组；${task.collationFindings||0} 组待核对`;
		if (task.state === "completed" && (task.collationFindings > 0 || task.collationMissing > 0)) return `已保存 · ${task.collationFindings} 组分歧，缺失 ${task.collationMissing || 0} 页待审阅`;
		return ({queued:"排队中",running:"正在执行",stopping:"正在终止",completed:"已完成",failed:"需要处理",canceled:"已终止",wait_expired:"等待已结束",waiting_dependency:"等待前置条件",waiting:"待补充"})[task.state] || task.state;
	},

	serviceLabel(task) {
		let settings = task.displaySettings || task.settings;
		if(task.kind==="title" || settings.service && settings.targetLang)return `${this.plugin.titleTranslationServiceLabel(settings)} → ${settings.targetLang}`;
		if(settings.parserService==="marker"&&settings.markerSettings?.apiType==="cloud")return ocrflowText("Marker · 在线 API");
		if (settings.parserService === "ai" || (!settings.parserService && settings.model) || !["parse", "organize"].includes(task.kind)) {
			let model = settings.llmSettings || settings;
			return [model.providerName, model.model].filter(Boolean).join(" · ") || ocrflowText("AI 工作");
		}
		return ocrflowText(({marker:"Marker · 自部署 API","paddle-cloud":"PaddleOCR · 在线 API","paddle-local":"PaddleOCR · 自部署 API",markitdown:"MarkItDown · 自部署 API"})[settings.parserService] || (settings.apiMode === "local-v1" ? "MinerU · 自部署 API" : "MinerU · 在线 API"));
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
		if (this.tabObserver) Zotero.Notifier.unregisterObserver(this.tabObserver);
		for (let window of this.views.keys()) this.unmount(window);
		for (let task of this.plugin.parseQueue) if (task.decision) this.plugin.resolveTaskDecision(task, "discard");
	}
};

Object.assign(DocFlow, {
	initializeTaskSteps(task) {
		if (!task.steps) {
			let labels = task.kind === "organize" ? [["extract","识别文档"],["parent","建立条目"],["metadata","补全条目"],["title","翻译标题"],["summary","总结文献"],["translate","翻译文献"],["outline","生成大纲"]] : task.kind === "parse"
				? [["extract", "识别文档"], ["structure", "整理文档结构"], ...(task.settings.collationEnabled ? [["compare", "对照识别 B"]] : []), ...(task.settings.collationEnabled && task.settings.collationAIEnabled ? [["ai-review", "AI 辅助校勘"]] : []), ["save", "保存结果"], ...(task.kind === "organize" ? [["metadata", "补全条目"]] : [])]
				: [["work", ({title:"翻译标题",translate:"逐段翻译",summary:"生成学术总结",metadata:"补全条目",parent:"建立条目",outline:"生成大纲"})[task.kind] || "处理文档"], ["save", "保存结果"]];
			if(task.kind!=="organize")labels.unshift(["read", "确认文献与来源"]);
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
		if (task.parentTask) return this.setTaskStep(task.parentTask,task.organizeStage,({title:"翻译标题",summary:"总结文献",translate:"翻译文献"})[task.organizeStage],detail,state==="completed" ? "running" : state);
		if (task.kind === "organize" && ["read","structure","compare","ai-review","save"].includes(id)) {
			detail=label+"："+detail;state=state==="completed"&&id!=="save" ? "running" : state;id="extract";label="识别文档";
		}
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
			let clear=()=>{task.decision=null;if(task.parentTask)task.parentTask.decision=null;};
			let abort = () => { clear(); signal.removeEventListener("abort", abort); reject(signal.reason || new Error("已终止")); this.refreshParseQueueDialog(); };
			signal.throwIfAborted();
			task.decision = {options, task, resolve:value => { clear(); signal.removeEventListener("abort", abort); resolve(value); this.refreshParseQueueDialog(); }};
			if(task.parentTask)task.parentTask.decision=task.decision;
			signal.addEventListener("abort", abort, {once:true});
			this.refreshParseQueueDialog();
		});
	},

	resolveTaskDecision(task, value) {
		if (!task.decision) return;
		task=task.decision.task||task;
		if (value === "save" && !(task.decision.options.savable ?? task.decision.options.completed)) throw new Error("尚无完整译段，无法保存部分译文。请重试失败段落或终止任务。");
		if (value === "retry" && task.kind === "translate") {
			let settings = this.getTranslationSettings();
			if (settings.translateLanguage !== task.settings.translateLanguage) throw new Error("翻译语言已改变，请先终止当前任务，再重新翻译，避免混合不同语言的译文。");
			task.settings = settings;
			let displayed=task.parentTask||task;displayed.displaySettings=settings;displayed.cancelSettings=settings;
		}
		task.decision.resolve(value);
	}
});
