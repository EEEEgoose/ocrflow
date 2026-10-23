var ocrflowText = typeof ocrflowText === "function" ? ocrflowText : value => String(value ?? "");
DocFlow = {
	id: null,
	version: null,
	rootURI: null,
	initialized: false,
	menuRegistered: false,
	popupListeners: new WeakMap(),
	parseQueue: [],
	parseQueueViews: new Set(),
	parseQueueRunning: false,
	parseQueueWindow: null,
	parseQueueNextID: 1,
	parseQueueStopped: false,
	outline: null,
	
	PREF_BRANCH: "extensions.docflow.",
	getPref(key,global=true){return this.config ? this.config.get(key,global) : Zotero.Prefs.get(key,global);},
	setPref(key,value,global=true){if(!this.config)return Zotero.Prefs.set(key,value,global);this.config.set(key,value,global);this.config.schedule();},
	ROOT_MENU_ID: "docflow-menu",
	CONTEXT_MENU_ID: "docflow-parse-pdf",
	SUMMARY_MENU_ID: "docflow-ai-summary",
	TRANSLATE_MENU_ID: "docflow-ai-translate",
	
	init({ id, version, rootURI }) {
		if (this.initialized) return;
		this.id = id;
		this.version = version;
		this.rootURI = rootURI;
		this.initialized = true;
	},
	
	log(msg) {
		Zotero.debug("Zotero MinerU: " + msg);
	},

	getMenuIconURL(name = "ocr") {
		return (this.rootURI || "") + `menu-icons/${name}.svg`;
	},

	supportsMenuManager() {
		return !!Zotero.MenuManager?.registerMenu;
	},

	runContextMenuCommand(definition, { window, selectedItems }) {
		definition.run({ window, selectedItems }).catch((e) => {
			this.log(`${definition.id} command failed: ${e}`);
			Zotero.logError(e);
			this.showAlert(window, "OCRFlow", `${definition.errorPrefix}: ${e.message || e}`);
		});
	},

	registerMenuForZotero8() {
		if (!this.supportsMenuManager() || this.menuRegistered) return false;
		try {
			let iconURL = this.getMenuIconURL();
			let menuDefinitions = this.getContextMenuDefinitions();
			let makeMenu = definition => ({
				menuType: definition.children ? "submenu" : "menuitem",
				label: ocrflowText(definition.label), l10nID: definition.l10nID,
				icon: this.getMenuIconURL(definition.icon),
				onShowing: (_event, context) => {
					if (typeof context?.setEnabled === "function") {
						let selectedItems = Array.isArray(context?.items) ? context.items : [];
						context.setEnabled(definition.getTasks(selectedItems).length > 0);
					}
				},
				...(definition.children ? { menus: definition.children.map(makeMenu) } : {
					onCommand: (_event, context) => {
						let window = context?.menuElem?.ownerGlobal || Zotero.getMainWindows?.()?.[0] || null;
						let selectedItems = Array.isArray(context?.items) ? context.items : null;
						this.runContextMenuCommand(definition, { window, selectedItems });
					}
				})
			});
			Zotero.MenuManager.registerMenu({
				menuID: this.ROOT_MENU_ID,
				pluginID: this.id,
				target: "main/library/item",
				menus: [
					{
						menuType: "submenu",
						label: "OCRFlow",
						l10nID: "docflow-menu-root",
						icon: iconURL,
						iconURL,
						image: iconURL,
						menus: menuDefinitions.flatMap((definition, index) => [
							...(index && definition.group !== menuDefinitions[index - 1].group ? [{menuType:"separator"}] : []), makeMenu(definition)
						])
					}
				]
			});
			this.menuRegistered = true;
			return true;
		}
		catch (e) {
			this.log(`Failed to register menu via MenuManager: ${e}`);
			Zotero.logError(e);
			return false;
		}
	},
	
	addToWindow(window) {
		window.DocFlow = this;
		this.sidebar?.mount(window);
		window.MozXULElement?.insertFTLIfNeeded?.("docflow.ftl");
		if (this.menuRegistered) {
			return;
		}
		let doc = window.document;
		let popup = doc.getElementById("zotero-itemmenu")
			|| doc.getElementById("item-tree-context-menu")
			|| doc.getElementById("zotero-item-tree-menu");
		if (!popup) {
			this.log("Item context menu not found in this window");
			return;
		}
		if (doc.getElementById(this.ROOT_MENU_ID)) return;
		let iconURL = this.getMenuIconURL();
		let menuDefinitions = this.getContextMenuDefinitions();
		
		let rootMenu = doc.createXULElement("menu");
		rootMenu.id = this.ROOT_MENU_ID;
		rootMenu.setAttribute("label", "OCRFlow");
		rootMenu.setAttribute("class", "menu-iconic");
		rootMenu.setAttribute("image", iconURL);
		rootMenu.style.listStyleImage = `url("${iconURL}")`;
		let subPopup = doc.createXULElement("menupopup");
		rootMenu.appendChild(subPopup);
		let menuItems = [];
		let appendMenu = (definition, popup) => {
			let menuitem = doc.createXULElement(definition.children ? "menu" : "menuitem");
			menuitem.id = definition.id;
			menuitem.setAttribute("label", ocrflowText(definition.label));
			menuitem.setAttribute("class", definition.children ? "menu-iconic" : "menuitem-iconic");
			let itemIcon = this.getMenuIconURL(definition.icon);
			menuitem.setAttribute("image", itemIcon);
			menuitem.style.listStyleImage = `url("${itemIcon}")`;
			if (definition.children) {
				let childPopup = doc.createXULElement("menupopup");
				menuitem.appendChild(childPopup);
				for (let child of definition.children) appendMenu(child, childPopup);
			} else {
				menuitem.addEventListener("command", () => {
					this.runContextMenuCommand(definition, { window, selectedItems: null });
				});
			}
			popup.appendChild(menuitem);
			menuItems.push({ definition, menuitem });
		};
		for (let [index, definition] of menuDefinitions.entries()) {
			if (index && definition.group !== menuDefinitions[index - 1].group) subPopup.appendChild(doc.createXULElement("menuseparator"));
			appendMenu(definition, subPopup);
		}
		popup.appendChild(rootMenu);

		let onPopupShowing = () => {
			let selectedItems = window.ZoteroPane?.getSelectedItems?.() || [];
			let hasEnabledChild = false;
			for (let { definition, menuitem } of menuItems) {
				let hasTasks = definition.getTasks(selectedItems).length > 0;
				menuitem.disabled = !hasTasks;
				hasEnabledChild ||= hasTasks;
			}
			rootMenu.disabled = !hasEnabledChild;
		};
		popup.addEventListener("popupshowing", onPopupShowing);
		this.popupListeners.set(window, { popup, onPopupShowing });
	},
	
	addToAllWindows() {
		let windows = Zotero.getMainWindows();
		if (this.supportsMenuManager() && this.registerMenuForZotero8()) {
			for (let win of windows) {
				if (!win.ZoteroPane) continue;
				this.addToWindow(win);
			}
			return;
		}
		for (let win of windows) {
			if (!win.ZoteroPane) continue;
			this.addToWindow(win);
		}
	},
	
	removeFromWindow(window) {
		this.sidebar?.unmount(window);
		if (window.DocFlow === this) {
			try {
				delete window.DocFlow;
			}
			catch (_e) {}
		}
		let doc = window.document;
		doc.getElementById(this.ROOT_MENU_ID)?.remove();
		doc.getElementById(this.CONTEXT_MENU_ID)?.remove();
		doc.getElementById(this.SUMMARY_MENU_ID)?.remove();
		doc.getElementById(this.TRANSLATE_MENU_ID)?.remove();
		let listenerData = this.popupListeners.get(window);
		if (listenerData) {
			listenerData.popup.removeEventListener("popupshowing", listenerData.onPopupShowing);
			this.popupListeners.delete(window);
		}
	},
	
	removeFromAllWindows() {
		if (this.supportsMenuManager() && this.menuRegistered) {
			try {
				Zotero.MenuManager.unregisterMenu(this.ROOT_MENU_ID);
			}
			catch (e) {
				this.log(`Failed to unregister menu: ${e}`);
				Zotero.logError(e);
			}
			this.menuRegistered = false;
		}
		let windows = Zotero.getMainWindows();
		for (let win of windows) {
			if (!win.ZoteroPane) continue;
			this.removeFromWindow(win);
		}
	},
	
	getSettings(apiMode = this.getPref(this.PREF_BRANCH + "apiMode", true) || "cloud", capture = true) {
		let profile = apiMode === "local-v1" ? "local" : "cloud";
		let readAPIPref = name => {
			let value = this.getPref(this.PREF_BRANCH + profile + "." + name, true);
			return value === undefined || value === null
				? this.getPref(this.PREF_BRANCH + name, true) : value;
		};
		let apiBaseURL = (readAPIPref("apiBaseURL") || "").trim();
		apiBaseURL = apiBaseURL.replace(/\/+$/, "");
		if (!apiBaseURL) {
			apiBaseURL = apiMode === "local-v1" ? "http://127.0.0.1:8000" : "https://mineru.net/api/v4";
		}
		
		let timeoutSec = parseInt(
			readAPIPref("timeoutSec"),
			10
		);
		if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) {
			timeoutSec = 1200;
		}
		let localJobTimeoutSec = parseInt(
			this.getPref(this.PREF_BRANCH + "localJobTimeoutSec", true), 10
		);
		if (!Number.isFinite(localJobTimeoutSec) || localJobTimeoutSec < 0) {
			localJobTimeoutSec = 7200;
		}
		
		let pollIntervalSec = parseInt(
			readAPIPref("pollIntervalSec"),
			10
		);
		if (!Number.isFinite(pollIntervalSec) || pollIntervalSec <= 0) {
			pollIntervalSec = 5;
		}
		
		let modelVersion = (readAPIPref("modelVersion") || "pipeline").trim();
		if (apiMode === "local-v1") {
			modelVersion = { pipeline: "basic", vlm: "advanced" }[modelVersion] || modelVersion;
			if (!["flash", "basic", "standard", "advanced"].includes(modelVersion)) modelVersion = "basic";
		} else if (!["pipeline", "vlm"].includes(modelVersion)) {
			modelVersion = "pipeline";
		}
		
		let apiToken = (readAPIPref("apiToken") || "").trim();
		if (!apiToken && this.getPref(this.PREF_BRANCH + profile + ".apiToken", true) === undefined) {
			apiToken = (this.getPref(this.PREF_BRANCH + "apiKey", true) || "").trim();
		}
		apiToken = apiToken.replace(/^Bearer\s+/i, "");
		
		let settings = {
			apiBaseURL,
			apiMode,
			apiToken,
			modelVersion,
			cloudLanguage: this.getPref(this.PREF_BRANCH + "cloudLanguage", true) || "auto",
			pollIntervalMS: pollIntervalSec * 1000,
			timeoutMS: timeoutSec * 1000,
			localJobTimeoutMS: localJobTimeoutSec * 1000,
			...this.getOutputSettings("parse"),
			parseLinkSourcePDF: this.getPref(this.PREF_BRANCH + "parseLinkSourcePDF", true) !== false,
			parserService: (() => {
				let service = this.getPref(this.PREF_BRANCH + "parserService", true) || "mineru";
				return service === "paddle" ? "paddle-" + (this.getPref(this.PREF_BRANCH + "paddleMode", true) || "cloud") : service;
			})(),
			markitdownBaseURL: (this.getPref(this.PREF_BRANCH + "markitdownBaseURL", true) || "").trim().replace(/\/+$/, ""),
			collationEnabled: this.getPref(this.PREF_BRANCH + "collationEnabled", true) === true,
			collationAIEnabled: this.getPref(this.PREF_BRANCH + "collationAIEnabled", true) === true,
			collationA: this.getPref(this.PREF_BRANCH + "collationA", true) || "mineru-cloud",
			collationB: this.getPref(this.PREF_BRANCH + "collationB", true) || "",
			llmSettings: this.getLLMSettings("ocr")
		};
		if (capture && this.captureOCRSettings) this.captureOCRSettings(settings);
		return settings;
	},
	

	parentHasAttachmentWithTag(parentItem, tagName) {
		if (!parentItem) return false
		let attachmentIDs = parentItem.getAttachments()
		for (let attachmentID of attachmentIDs) {
			let attachmentItem = Zotero.Items.get(attachmentID)
			if (!attachmentItem) continue
			let tags = attachmentItem.getTags()
			if (tags.some((t) => t.tag === tagName)) return true
		}
		return false
	},

	isMineruParseMarkdownAttachment(item) {
		if (!item?.isAttachment?.()) return false
		let tags = item.getTags?.() || []
		if (!tags.some((t) => t.tag === "#DocFlow-Parse")) return false
		let contentType = String(item.attachmentContentType || item.getField?.("contentType") || "").toLowerCase()
		if (["text/markdown", "text/html"].includes(contentType)) return true
		let title = String(item.getField?.("title") || "").trim()
		return /\.(md|markdown|html?)$/i.test(title)
	},


	showAlert(window, title, message) {
		if (window) {
			Zotero.alert(window, ocrflowText(title), ocrflowText(message));
			return;
		}
		this.log(`${title}: ${message}`);
	},

	showConfirm(window, title, message) {
		try {
			if (typeof Services !== "undefined" && Services.prompt?.confirm) {
				return Services.prompt.confirm(window || null, ocrflowText(title), ocrflowText(message));
			}
		}
		catch (e) {
			Zotero.logError(e);
		}
		if (window?.confirm) {
			return window.confirm(ocrflowText(message));
		}
		this.log(`${title}: ${message}`);
		return false;
	},

	openParseQueueDialog() { return this.openPreferences("tasks"); },

	openPreferences(section = "services") {
		this.requestedPreferencesSection = section;
		let pane = Zotero.PreferencePanes.pluginPanes.find(pane => pane.pluginID === this.id);
		let win = Zotero.Utilities.Internal.openPreferences(pane.id);
		let show = async () => {
			await win.Zotero_Preferences.waitForFirstPaneLoad();
			await win.Zotero_Preferences.navigateToPane(pane.id);
			let panel = win.Zotero_Preferences.getScope(pane.id).DocFlowPreferences;
			panel.showSection(section);
			this.requestedPreferencesSection = null;
		};
		if (win.document.readyState === "complete") show().catch(error => Zotero.logError(error));
		else win.addEventListener("load", () => show().catch(error => Zotero.logError(error)), { once: true });
	},

	refreshParseQueueDialog() {
		this.sidebar?.refresh();
		for (let view of this.parseQueueViews) {
			try { view.render(); }
			catch (error) {
				this.parseQueueViews.delete(view);
				Zotero.logError(error);
			}
		}
		if (this.parseQueueWindow && !this.parseQueueWindow.closed) {
			this.parseQueueWindow.DocFlowTaskQueue?.render();
		}
	},

	async retryParseQueueTasks(ids) {
		for (let task of this.parseQueue) {
			if (!ids.includes(task.id) || !["failed", "wait_expired", "canceled", "waiting"].includes(task.state)) continue;
			let parserService = task.settings.parserService;
			task.settings = task.kind === "organize" ? this.getOrganizeSettings(task.jobID ? task.settings.apiMode : undefined) : task.kind === "translate" ? this.getTranslationSettings()
				: task.kind === "title" ? this.getTitleTranslationSettings({service:task.settings.service,targetLang:task.settings.targetLang,overwrite:task.settings.overwrite,modelID:task.settings.modelID})
				: ["outline", "parent", "metadata", "summary"].includes(task.kind) ? this.getLLMSettings(task.kind) : this.getSettings(task.settings.apiMode);
			if (task.kind === "parse" && parserService) task.settings.parserService = parserService;
			if (task.kind === "organize" && task.jobID) task.settings.parserService = parserService;
			task.state = "queued";
			task.detail = task.jobID ? "等待继续查询原任务" : "等待重试";
			task.error = "";
		}
		this.refreshParseQueueDialog();
		await this.processParseQueue();
	},

	canClearParseQueueTask(task) {
		return ["completed", "failed", "canceled", "waiting"].includes(task.state) && !task.active && !task.saving && !task.cancelFailed;
	},

	clearParseQueueTasks() {
		this.parseQueue = this.parseQueue.filter(task => !this.canClearParseQueueTask(task));
		this.refreshParseQueueDialog();
	},

	createAbortController() {
		let mainWindow = Zotero.getMainWindow();
		return new mainWindow.AbortController();
	},

	async cancelParseQueueTask(id) {
		let task = this.parseQueue.find(row => row.id === id);
		if (!task || task.saving || (!["queued", "running", "wait_expired"].includes(task.state) && !task.cancelFailed)) return;
		task.cancelRequested = true;
		task.state = "stopping";
		task.detail = "正在终止任务";
		task.controller?.abort();
		this.refreshParseQueueDialog();
		// The worker collects a job ID from any submission already in flight.
		if (!task.active) await this.finishParseQueueCancellation(task);
	},

	async finishParseQueueCancellation(task, error) {
		let settings = task.cancelSettings || task.settings;
		let jobID = task.cancelSettings ? task.cancelJobID : task.jobID;
		task.cancelFailed = false;
		task.error = "";
		let detail = task.kind === "translate" ? "已终止翻译；可重新处理剩余段落，已发送的 AI 请求可能继续在服务端运行"
			: task.kind === "outline" ? "已终止大纲任务；已发送的 LLM 请求可能继续在服务端运行"
			: settings.apiMode === "cloud" ? "客户端已终止；已提交的云端任务可能继续运行" : "已终止，未提交新的解析任务";
		if (!task.started && !jobID) detail = "已终止，任务尚未开始处理";
		if (settings.parserService === "marker" && (settings.markerSettings||this.getMarkerSettings()).apiType==="cloud") {
			detail=jobID?`已停止本地等待；Datalab 云端任务可能继续处理。任务 ${jobID} 保留，可重新处理以继续查询。`:"已停止等待 Datalab；提交中尚未返回任务 ID 时无法确认云端接收状态";
		}
		else if (settings.parserService === "marker" && jobID) {
			let config = settings.markerSettings || this.getMarkerSettings(), controller = this.createAbortController();
			let timer = setTimeout(() => controller.abort(), 30000);
			try {
				let job = await OCRFlowMarker.request(OCRFlowMarker.baseURL(config.baseURL) + `/v1/parse/jobs/${encodeURIComponent(jobID)}`, {method:"DELETE",signal:controller.signal,headers:config.token ? {Authorization:`Bearer ${config.token}`} : {}});
				if (!["canceled","completed","failed"].includes(job.status)) throw new Error("Marker 未确认任务终止");
				detail = job.status === "canceled" ? "Marker 服务端任务已终止" : `Marker 任务已结束（${job.status}），已停止后续处理`;
			} catch (error) { task.cancelFailed=true;task.error=error.message;detail="Marker 取消未确认，可重试终止"; }
			finally { clearTimeout(timer); }
		}
		if (settings.parserService === "marker" && !jobID && ["提交 Marker 任务","提交 Datalab 任务"].includes(task.phase)) {
			task.cancelFailed=true;task.error="提交请求未返回任务 ID，无法确认服务端是否已接收文件";
			detail="Marker 取消未确认：未收到任务 ID，请检查服务端任务";
		}
		if (settings.apiMode === "local-v1" && !jobID && task.phase === "提交解析任务" && error && error.name !== "AbortError") {
			detail = "客户端已终止；提交请求未返回任务 ID，无法确认服务端任务状态";
			task.error = error.message || String(error);
		}
		if (task.kind !== "outline" && settings.parserService !== "marker" && settings.apiMode === "local-v1" && jobID) {
			let controller = this.createAbortController();
			let timeout = setTimeout(() => controller.abort(), 30000);
			let url = `${settings.apiBaseURL}/v1/parse/jobs/${encodeURIComponent(jobID)}`;
			try {
				let result = await this.requestMineruJSON({url, token: settings.apiToken, method: "DELETE", signal: controller.signal});
				if (result.status !== "canceled") throw new Error("服务端未确认取消任务");
				detail = "服务端已接受取消；当前推理与资源清理结束后释放资源";
			}
			catch (error) {
				if (error.status === 404) detail = "服务端任务已不存在，客户端已终止";
				else {
					try {
						if (error.status !== 409) throw error;
						let job = await this.requestMineruJSON({url, token: settings.apiToken, signal: controller.signal});
						if (!["completed", "partial", "failed", "canceled"].includes(job.status)) throw error;
						detail = `服务端任务已结束（${job.status}），客户端已终止后续处理`;
					}
					catch (cancelError) {
						task.cancelFailed = true;
						task.error = cancelError.message || String(cancelError);
						detail = "客户端已终止；未能确认服务端取消，可重试终止";
					}
				}
			}
			finally { clearTimeout(timeout); }
		}
		task.state = "canceled";
		task.detail = detail;
		task.parsedResult = null;
		this.refreshParseQueueDialog();
	},

	async delayParsePoll(ms, statusContext) {
		let signal = statusContext?.signal;
		if (!signal) return await Zotero.Promise.delay(ms);
		signal.throwIfAborted();
		await new Promise((resolve, reject) => {
			let timeout = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
			let abort = () => { clearTimeout(timeout); reject(signal.reason); };
			signal.addEventListener("abort", abort, {once: true});
		});
	},

	async processParseQueue() {
		if (this.parseQueueStopped) return;
		this.parseQueueWork ||= new Set();
		this.dispatchParseQueue();
		if (this.parseQueueRunning) return;
		this.parseQueueRunning = true;
		try {
			while(this.parseQueueWork.size)await Promise.race(this.parseQueueWork);
		}
		finally {
			this.parseQueueRunning = false;
			this.refreshParseQueueDialog();
		}
	},

	parseQueueLane(task) {
		let s=task.settings||{};
		if(task.kind==="title")return JSON.stringify(["title",s.service,s.service==="ai" ? s.aiSettings.apiBaseURL : s.service==="deepl" ? s.deeplPlan : s.deeplxEndpoint,s.aiSettings?.modelID,s.aiSettings?.model]);
		let reader=s.collationEnabled ? s.readerA||s : s;
		let ext=this.documentExtension?.(task.attachment);
		if(["parse","organize"].includes(task.kind)&&reader.parserService!=="marker"&&ext&&!["pdf","png","jpg","jpeg","txt","md","markdown","csv"].includes(ext))reader={...reader,parserService:"markitdown"};
		let ai=reader.parserService==="ai" ? reader.llmSettings||{} : s;
		let endpoint=reader.parserService==="marker" ? reader.markerSettings?.baseURL : reader.parserService?.startsWith("paddle-") ? reader.paddleSettings?.baseURL : reader.parserService==="markitdown" ? reader.markitdownBaseURL : ai.apiBaseURL;
		let models=task.kind==="organize" ? [s.metadataSettings,s.outlineSettings,s.summarySettings,s.translationSettings].map(row=>[row?.apiBaseURL,row?.modelID,row?.model]) : [];
		return JSON.stringify([task.kind,reader.parserService||"ai",endpoint?.replace(/\/+$/,""),ai.modelID,ai.model,reader.apiMode,reader.modelVersion||reader.markerSettings?.mode,models]);
	},

	parseQueueDocument(task) {
		let item=task.attachment;
		return item ? this.parentForDocument?.(item)?.id || task.parentItem?.id || item.id : null;
	},

	dispatchParseQueue() {
		if(this.parseQueueStopped)return;
		for(let task of this.parseQueue) {
			if(task.state!=="queued"||task.active)continue;
			let active=this.parseQueue.filter(row=>row.active), document=this.parseQueueDocument(task), lane=this.parseQueueLane(task);
			if(document!=null&&active.some(row=>this.parseQueueDocument(row)===document))continue;
			let limit=["parent","metadata","summary","translate","outline","title"].includes(task.kind) ? task.settings.concurrency||1 : 1;
			if(active.filter(row=>this.parseQueueLane(row)===lane).length>=limit)continue;
			let work=this.processParseQueueTask(task).finally(()=>{
				this.parseQueueWork.delete(work);this.dispatchParseQueue();
			});
			this.parseQueueWork.add(work);
		}
	},

	async processParseQueueTask(task) {
		task.started = true;
		task.cancelRequested = false;
		task.cancelFailed = false;
		task.controller = null;
		task.active = true;
		task.saving = false;
		task.state = "running";
		task.detail = "准备处理";
		try {
			task.controller = this.createAbortController();
			this.initializeTaskSteps?.(task);
			this.refreshParseQueueDialog();
			if (task.kind === "organize") {
				await this.runOrganizeTask(task);
				return;
			}
			if (task.kind === "title") {
				task.detail = await this.runTitleTranslation(task);
				task.state = "completed";
				return;
			}
			if (task.kind === "translate") {
				task.detail = await this.runTranslationTask(task);
				task.state = "completed";
				task.translation = null;
				return;
			}
			if (["parent", "metadata", "summary"].includes(task.kind)) {
				await this.runDocumentTask(task);
				task.state = "completed";
				task.detail = "已完成";
				return;
			}
			if (task.kind === "outline") {
				if (task.parsedResult) { task.saving = true; this.refreshParseQueueDialog(); await this.outline.save(task.attachment, task.parsedResult); }
				else await this.outline.generate(task.attachment, {
					settings: task.settings, force: task.force,
					signal: task.controller.signal,
					onReady: data => { task.controller.signal.throwIfAborted(); task.parsedResult = data; task.saving = true; this.refreshParseQueueDialog(); },
					onStatus: text => { if (!task.cancelRequested) task.detail = text; this.refreshParseQueueDialog(); }
				});
				task.state = "completed";
				task.detail = "阅读器大纲已生成并保存";
				task.resultAttachment = task.attachment;
				task.parsedResult = null;
				this.refreshParseQueueDialog();
				return;
			}
			if (await this.runParseTask(task)) task.state = "completed";
		}
		catch (error) {
			if (task.cancelRequested) await this.finishParseQueueCancellation(task, error);
			else {
				task.state = ["MineruJobWaitTimeout","MarkerJobWaitTimeout","MarkerConnectionError"].includes(error.name) ? "wait_expired" : "failed";
				task.detail = error.name === "MarkerConnectionError" ? "连接中断，原任务保留；可继续等待以重新连接" : task.state === "wait_expired" ? "服务端任务仍可能运行，可继续等待" : "处理失败，可重试";
				task.error = error.message || String(error);
				if (task.state !== "wait_expired") Zotero.logError(error);
			}
		}
		finally {
			task.active = false; task.saving = false; task.controller = null;
			this.finishTaskSteps?.(task);
			this.refreshParseQueueDialog();
		}
		this.refreshParseQueueDialog();
	},

	async runParseTask(task) {
		if (!task.parsedResult) {
			task.displaySettings = task.settings.collationEnabled && ["pdf", "png", "jpg", "jpeg"].includes(this.documentExtension(task.attachment)) ? task.settings.readerA || task.settings : task.settings;
			task.cancelSettings = task.displaySettings;
			task.cancelJobID = task.jobID;
			this.setTaskStep?.(task, "extract", "识别全文");
			task.progress = null;
			task.parsedResult = await this.parseAttachmentWithMineru(task.attachment, task.settings, {
				jobID: task.jobID,
				signal: task.controller.signal,
				onStatus: status => {
					task.phase = status.phase || task.phase;
					if ("jobID" in status) task.cancelJobID = task.jobID = status.jobID;
					if ("pageProgress" in status) task.progress = status.pageProgress;
					this.setTaskStep?.(task, "extract", "识别文档", status.displayText || status.phase);
					if (!task.cancelRequested) task.detail = status.displayText || status.phase || "处理中";
					this.refreshParseQueueDialog();
				}
			});
		}
		this.setTaskStep?.(task, "structure", "整理文档结构", "恢复脚注、图注与来源，保留原始数据");
		if (this.finalizeDocument) this.finalizeDocument(task.parsedResult, task.settings.parserService);
		this.setTaskStep?.(task, "structure", "整理文档结构", "结构与来源已整理", "completed");
		if (task.settings.collationEnabled && this.prepareCollation) await this.prepareCollation(task);
		task.controller.signal.throwIfAborted();
		if (this.parseQueueStopped) return;
		task.saving = true;
		task.detail = "保存解析附件";
		this.setTaskStep?.(task, "save", "保存结果", task.detail);
		this.refreshParseQueueDialog();
		if (this.documentExtension && !["pdf", "png", "jpg", "jpeg"].includes(this.documentExtension(task.attachment))) task.settings.outputFormat = "md";
		let saved = task.ocrBaseSaved || await this.saveResultAsMarkdownAttachment({
			attachment: task.attachment, parentItem: task.attachment.parentItemID ? Zotero.Items.get(task.attachment.parentItemID) : task.parentItem,
			parsedResult: task.parsedResult, settings: task.settings
		});
		if(task.settings.collationAIEnabled&&this.saveAutomaticCollation) {
			task.ocrBaseSaved=saved;
			saved=await this.saveAutomaticCollation(task,saved);
		}
		task.resultAttachment = saved?.attachment;
		task.hasChangesReport = !!task.parsedResult.document;
		task.collationStatus = task.parsedResult.collation?.status;
		task.collationAIStatus = task.parsedResult.collation?.ai?.status;
		task.collationFindings = task.parsedResult.collation?.findings?.filter(finding=>finding.status==="pending").length || 0;
		task.collationAutoApplied = task.parsedResult.collation?.ai?.applied || 0;
		task.collationMissing = task.parsedResult.collation?.missingPages?.length || 0;
		this.setTaskStep?.(task, "save", "保存结果", "全文与来源资料已保存", "completed");
		task.detail = [task.parsedResult.warning, saved?.warning].filter(Boolean).join("；") || "解析附件已保存";
		if (this.outline && task.attachment.isPDFAttachment?.()) {
			try {
				await this.outline.storeSource(task.attachment, task.parsedResult);
				if (task.kind!=="organize" && this.getPref(this.PREF_BRANCH + "autoOutline", true) !== false) this.outline.enqueue(task.attachment);
			}
			catch (error) {
				task.detail += `；大纲资料保存失败：${error.message || error}`;
			}
		}
		task.parsedResult = null;
		task.ocrBaseSaved = null;
		return saved;
	},

	reportParseStatus(statusContext, updates = {}) {
		if (!statusContext) return;
		Object.assign(statusContext, updates);
		if (typeof statusContext.onStatus === "function") statusContext.onStatus({
			phase: statusContext.phase || "",
			mineruState: statusContext.mineruState || "",
			progress: statusContext.progress ?? null,
			pageProgress: statusContext.pageProgress || (statusContext.cloudProgress?.total_pages > 0 ? {completed:statusContext.cloudProgress.extracted_pages || 0, total:statusContext.cloudProgress.total_pages, unit:"页"} : null),
			jobID: statusContext.jobID || null,
			displayText: this.describeParseStatus(statusContext)
		});
		statusContext.signal?.throwIfAborted();
	},

	describeParseStatus(statusContext) {
		if (!statusContext) return "";
		let phase = (statusContext.phase || "").trim();
		let mineruState = (statusContext.mineruState || "").trim();
		let pages = statusContext.cloudProgress;
		let pageText = mineruState === "running" && Number.isInteger(pages?.extracted_pages) && pages.total_pages > 0
			? `，已处理 ${pages.extracted_pages}/${pages.total_pages} 页` : "";
		if (statusContext.cloudPartLabel) phase = `${statusContext.cloudPartLabel}：${phase}`;
		if (phase && mineruState) {
			return `${phase}，MinerU 状态: ${mineruState}${pageText}`;
		}
		if (phase) {
			return phase;
		}
		if (mineruState) {
			return `MinerU 状态: ${mineruState}${pageText}`;
		}
		return "";
	},

	wrapErrorWithParseStatus(error, statusContext) {
		if (error instanceof Error && error.message.includes("当前状态:")) {
			return error;
		}
		let baseMessage = error instanceof Error ? error.message : String(error);
		let statusText = this.describeParseStatus(statusContext);
		if (!statusText) {
			return error instanceof Error ? error : new Error(baseMessage);
		}
		let wrapped = new Error(`${baseMessage}（当前状态: ${statusText}）`);
		wrapped.name = error.name || "Error";
		wrapped.cause = error;
		return wrapped;
	},

	normalizeCloudLanguage(value) {
		let normalized = String(value || "").trim().toLowerCase().replace(/_/g, "-");
		const packs = {
			ch: "zh|zho|chi|chinese|中文|汉语|简体中文|简体",
			ch_server: "ch-server",
			chinese_cht: "zh-tw|zh-hk|zh-mo|zh-hant|traditional chinese|繁体中文|繁體中文|繁体|繁體",
			en: "eng|english|英语|英文",
			japan: "ja|jpn|japanese|日语|日文",
			korean: "ko|kor|korean|韩语|韩文|朝鲜语",
			arabic: "ar|ara|arabic|阿拉伯语|阿拉伯文|fa|fas|per|persian|波斯语|ug|uig|uyghur|维吾尔语|ur|urd|urdu|乌尔都语|ps|pus|pashto|ku|kur|kurdish|sd|snd|sindhi|bal|balochi",
			latin: "fr|fra|fre|french|法语|法文|de|deu|ger|german|德语|德文|es|spa|spanish|西班牙语|pt|por|portuguese|葡萄牙语|it|ita|italian|意大利语|vi|vie|vietnamese|越南语|tr|tur|turkish|土耳其语|nl|nld|dut|dutch|荷兰语|pl|pol|polish|波兰语|af|az|bs|cs|cy|da|et|ga|hr|hu|id|is|la|lt|lv|mi|ms|mt|no|oc|pi|ro|sr-latn|sr-latin|sk|sl|sq|sv|sw|swahili|斯瓦希里语|tl|uz|fi|eu|gl|lb|rm|ca|qu",
			cyrillic: "bg|bul|bulgarian|保加利亚语|mn|mon|mongolian|蒙古语|sr|sr-cyrl|serbian|塞尔维亚语|kk|ky|tg|mk|tt|cv|ba|udm|kv|os|bua|xal|tyv|sah|kaa",
			east_slavic: "ru|rus|russian|俄语|俄文|uk|ukr|ukrainian|乌克兰语|be|bel|belarusian|白俄罗斯语",
			devanagari: "hi|hin|hindi|印地语|mr|mar|marathi|ne|nep|nepali|尼泊尔语|bh|bih|mai|ang|bho|mah|sck|new|gom|sa|san|sanskrit|梵语|bgc",
			ta: "tam|tamil|泰米尔语", te: "tel|telugu|泰卢固语",
			ka: "kn|kan|kannada|卡纳达语", el: "ell|gre|greek|希腊语", th: "tha|thai|泰语"
		};
		if (normalized.startsWith("zh-hant-")) return "chinese_cht";
		for (let candidate of [normalized, normalized.split("-")[0]]) {
			for (let [pack, aliases] of Object.entries(packs)) {
				if (candidate === pack.replace(/_/g, "-") || aliases.split("|").includes(candidate)) return pack;
			}
		}
		return null;
	},

	cloudRecognitionLanguage(attachment, selected = "auto") {
		let parentID = attachment.parentItemID || attachment.parentID;
		let value = selected === "auto" ? (parentID ? Zotero.Items.get(parentID)?.getField("language") : "") : selected;
		return this.normalizeCloudLanguage(value);
	},

	async parseAttachmentWithMineru(attachment, settings, options = {}) {
		let statusContext = {
			phase: "准备解析",
			mineruState: "",
			progress: 5,
			jobID: options.jobID || null,
			signal: options.signal,
			onStatus: options.onStatus
		};
		this.reportParseStatus(statusContext);

		try {
			if (settings.apiMode === "local-v1" && options.jobID) {
				this.reportParseStatus(statusContext, { phase: "查询原任务", jobID: options.jobID });
				let job;
				try {
					job = await this.requestMineruJSON({
						url: `${settings.apiBaseURL}/v1/parse/jobs/${encodeURIComponent(options.jobID)}`, token: settings.apiToken, signal: statusContext.signal
					});
				}
				catch (error) {
					if (error.status !== 404) throw error;
				}
				if (job && !["failed", "canceled"].includes(job.status)) {
					let fileName = this.fileNameFromPath(attachment.getFilePath() || "document.pdf");
					return await this.waitForLocalV1Job(job, options.jobID, fileName, settings, statusContext);
				}
			}
			this.reportParseStatus(statusContext, {
				phase: "读取本地 PDF",
				progress: 10
			});
			let filePath = attachment.getFilePath();
			if (!filePath) {
				throw new Error("附件文件不存在或尚未下载到本地");
			}
			
			let fileBytes = await IOUtils.read(filePath);
			let fileName = this.fileNameFromPath(filePath);
			if (settings.apiMode === "local-v1") {
				return await this.parseAttachmentWithLocalV1(fileBytes, fileName, settings, statusContext);
			}

			return await this.parseAttachmentWithCloud(fileBytes, fileName, attachment.id,
				{ ...settings, recognitionLanguage: this.cloudRecognitionLanguage(attachment, settings.cloudLanguage) }, statusContext);
		}
		catch (e) {
			throw this.wrapErrorWithParseStatus(e, statusContext);
		}
	},

	getPDFLibrary() {
		if (!this.pdfLibrary) {
			let scope = { Uint8Array, ArrayBuffer, setTimeout };
			Services.scriptloader.loadSubScript(this.rootURI + "vendor/pdf-lib/pdf-lib.min.js", scope);
			this.pdfLibrary = scope.PDFLib;
		}
		return this.pdfLibrary;
	},

	async parseAttachmentWithCloud(fileBytes, fileName, attachmentID, settings, statusContext) {
		this.reportParseStatus(statusContext, { phase: "检查 PDF 页数", progress: 10 });
		let { PDFDocument } = this.getPDFLibrary();
		// Pass a primitive string across script scopes instead of a foreign typed array.
		let source = await PDFDocument.load(this.bytesToBase64(fileBytes));
		let pageCount = source.getPageCount();
		if (pageCount <= 200) {
			let result = await this.parseCloudPDFPart(fileBytes, fileName, attachmentID, settings, statusContext);
			result.outlinePages = Array.from({ length: pageCount }, (_, i) => result.outlinePages?.[i] || "");
			return result;
		}
		let totalParts = Math.ceil(pageCount / 199);
		let markdownParts = [], embeddedImages = [], documents = [], rawFiles = [];
		let outlinePages = Array(pageCount).fill(""), outlineHeadings = [];
		for (let start = 0; start < pageCount; start += 199) {
			let end = Math.min(start + 199, pageCount);
			let partNumber = Math.floor(start / 199) + 1;
			this.reportParseStatus(statusContext, {
				cloudPartLabel: `第 ${partNumber}/${totalParts} 段（第 ${start + 1}～${end} 页）`,
				phase: "拆分 PDF", mineruState: "", progress: 10
			});
			let part = await PDFDocument.create();
			let indices = source.getPageIndices().slice(start, end);
			for (let page of await part.copyPages(source, indices)) part.addPage(page);
			let partBytes = await part.save();
			let partName = `${fileName.replace(/\.pdf$/i, "")}-pages-${start + 1}-${end}.pdf`;
			let result = await this.parseCloudPDFPart(partBytes, partName, attachmentID, settings, statusContext);
			if (result.document) {
				for (let page of result.document.pages) page.page += start;
				for (let block of result.document.blocks) for (let fragment of block.fragments) fragment.page += start;
				documents.push(result.document);
			}
			rawFiles.push(...(result.rawFiles || []).map(file => ({ ...file, name: `part-${partNumber}-${this.fileNameFromPath(file.name)}` })));
			for (let i = 0; i < (result.outlinePages || []).length; i++) outlinePages[start + i] = result.outlinePages[i];
			for (let heading of result.outlineHeadings || []) outlineHeadings.push({ ...heading, page: heading.page + start });
			let markers = new Map();
			for (let image of result.embeddedImages || []) {
				let id = `img-${embeddedImages.length + 1}`;
				let marker = `docflow-image://${id}`;
				markers.set(image.marker, marker);
				embeddedImages.push({ ...image, id, marker });
			}
			if (result.document) for (let block of result.document.blocks) {
				block.text = block.text.replace(/docflow-image:\/\/img-\d+/g, marker => markers.get(marker) || marker);
				block.rawText = block.rawText.replace(/docflow-image:\/\/img-\d+/g, marker => markers.get(marker) || marker);
			}
			markdownParts.push(result.markdownText.replace(/docflow-image:\/\/img-\d+/g, marker => markers.get(marker) || marker));
		}
		let markdownText = markdownParts.join("\n\n");
		let document = null;
		if (documents.length && typeof OCRFlowDocument !== "undefined") {
			document = OCRFlowDocument.create("mineru");
			for (let part of documents) {
				document.pages.push(...part.pages);
				for (let block of part.blocks) {
					// Rebuild note numbering and cross-part joins from the retained raw blocks.
					OCRFlowDocument.add(document, block.type, block.rawText, block.fragments[0].page, block.fragments[0].rect, { level: block.level });
				}
			}
			OCRFlowDocument.prepare(document);
			markdownText = OCRFlowDocument.render(document);
		}
		this.reportParseStatus(statusContext, { cloudPartLabel: "", phase: "合并分段结果", mineruState: "", progress: 95 });
		let rendered = await this.markdownToHTML(markdownText);
		return {
			sourceKind: "markdown", markdownText, rawMarkdownText: markdownText,
			contentHTML: rendered.html, embeddedImages, embeddedImageCount: embeddedImages.length,
			outlinePages, outlineHeadings, document, rawFiles
		};
	},

	async parseCloudPDFPart(fileBytes, fileName, attachmentID, settings, statusContext) {
		let dataID = this.makeDataID(attachmentID);
		let uploadPayload = {
			model_version: settings.modelVersion,
			...(settings.recognitionLanguage ? { language: settings.recognitionLanguage } : {}),
			files: [
				{
					name: fileName,
					data_id: dataID
				}
			]
		};

		this.reportParseStatus(statusContext, {
			phase: "申请上传地址",
			progress: 20
		});
		let applyUploadResult = await this.requestMineruJSON({
			url: `${settings.apiBaseURL}/file-urls/batch`,
			token: settings.apiToken,
			method: "POST",
			body: uploadPayload, signal: statusContext?.signal
		});
		if (applyUploadResult.code !== 0) {
			throw new Error(`申请上传地址失败: ${applyUploadResult.msg || "unknown error"}`);
		}

		let batchID = applyUploadResult?.data?.batch_id;
		let uploadURL = applyUploadResult?.data?.file_urls?.[0];
		if (!batchID || !uploadURL) {
			throw new Error("官方 API 未返回 batch_id 或 upload_url");
		}

		this.reportParseStatus(statusContext, {
			phase: "上传 PDF",
			progress: 35
		});
		let uploadResponse = await fetch(uploadURL, {
			method: "PUT",
			body: fileBytes, signal: statusContext?.signal
		});
		if (!uploadResponse.ok) {
			let errText = await uploadResponse.text();
			throw new Error(`上传 PDF 失败 ${uploadResponse.status}: ${errText.slice(0, 300)}`);
		}

		this.reportParseStatus(statusContext, {
			phase: "等待 MinerU 解析",
			progress: 55
		});
		let result = await this.pollMineruExtractResult({
			apiBaseURL: settings.apiBaseURL,
			token: settings.apiToken,
			batchID,
			dataID,
			timeoutMS: settings.timeoutMS,
			pollIntervalMS: settings.pollIntervalMS,
			statusContext
		});

		let zipURL = result?.full_zip_url;
		if (!zipURL) {
			throw new Error("解析已完成，但未返回 full_zip_url");
		}

		this.reportParseStatus(statusContext, {
			phase: "下载解析结果",
			progress: 75
		});
		let zipBytes = await this.downloadParseResultZip({
			zipURL,
			apiBaseURL: settings.apiBaseURL,
			token: settings.apiToken,
			statusContext
		});

		this.reportParseStatus(statusContext, {
			phase: "提取 Markdown",
			progress: 90
		});
		let parsedResult = await this.extractNoteContentFromMineruZip(zipBytes, fileName);
		this.reportParseStatus(statusContext, {
			phase: "提取完成",
			progress: 95
		});
		return parsedResult;
	},

	describeLocalJobProgress(job, elapsedMS) {
		let parts = [];
		let pages = job.files?.[0]?.page_progress;
		if (pages) {
			let stages = { preparing: "准备文档", processing: "页面处理", postprocessing: "整理结构", exporting: "生成结果", completed: "任务完成", failed: "任务失败" };
			parts.push(stages[pages.stage] || pages.stage);
			if (Number.isInteger(pages.total) && pages.total > 0) {
				parts.push(`已处理 ${pages.completed}/${pages.total} 页，剩余 ${pages.total - pages.completed} 页`);
			}
		}
		if (job.progress && job.progress.total > 0) {
			parts.push(`已完成 ${job.progress.completed}/${job.progress.total} 个文件，失败 ${job.progress.failed} 个`);
		}
		let seconds = Math.floor(elapsedMS / 1000);
		let hours = Math.floor(seconds / 3600);
		let minutes = Math.floor(seconds % 3600 / 60);
		parts.push(`已等待 ${hours ? hours + " 小时 " : ""}${minutes} 分 ${seconds % 60} 秒`);
		return parts.join("，");
	},

	async parseAttachmentWithLocalV1(fileBytes, fileName, settings, statusContext) {
		let baseURL = settings.apiBaseURL;
		let token = settings.apiToken;
		this.reportParseStatus(statusContext, { phase: "创建上传", progress: 20, jobID: null });
		let upload = await this.requestMineruJSON({
			url: `${baseURL}/v1/uploads`, token, method: "POST",
			body: { filename: fileName, bytes: fileBytes.byteLength, mime_type: "application/pdf", purpose: "parse" }, signal: statusContext?.signal
		});
		let fileID = upload.file?.id;
		if (upload.status === "pending") {
			let uploadURL = new URL(upload.upload_url, baseURL).toString();
			let headers = new Headers(upload.upload_headers || {});
			if (token && new URL(uploadURL).origin === new URL(baseURL).origin) {
				headers.set("Authorization", `Bearer ${token}`);
			}
			this.reportParseStatus(statusContext, { phase: "上传 PDF", progress: 35 });
			let response = await fetch(uploadURL, {
				method: upload.upload_method || "PUT", headers, body: fileBytes, signal: statusContext?.signal
			});
			if (!response.ok) throw new Error(`上传 PDF 失败 ${response.status}`);
			let completed = await this.requestMineruJSON({
				url: `${baseURL}/v1/uploads/${encodeURIComponent(upload.id)}/complete`, token, method: "POST", signal: statusContext?.signal
			});
			fileID = completed.file?.id;
		}
		if (!fileID) throw new Error("MinerU 未返回文件 ID");

		this.reportParseStatus(statusContext, { phase: "提交解析任务", progress: 55 });
		// Await the submission response so termination can cancel the returned job ID.
		let job = await this.requestMineruJSON({
			url: `${baseURL}/v1/parse/jobs`, token, method: "POST",
			body: {
				files: [{ source: { type: "file_id", file_id: fileID } }],
				tier: settings.modelVersion, output_formats: ["zip"]
			}
		});
		let jobID = job.job_id;
		if (!jobID) throw new Error("MinerU 未返回任务 ID");
		this.setPref(this.PREF_BRANCH + "lastLocalJobID", jobID, true);
		return await this.waitForLocalV1Job(job, jobID, fileName, settings, statusContext);
	},

	async waitForLocalV1Job(job, jobID, fileName, settings, statusContext) {
		let baseURL = settings.apiBaseURL;
		let token = settings.apiToken;
		this.reportParseStatus(statusContext, { jobID });
		let pollIntervalMS = Math.min(10000, Math.max(5000, settings.pollIntervalMS));
		let started = Date.now();
		this.reportParseStatus(statusContext, {
			phase: `任务 ID: ${jobID}，${this.describeLocalJobProgress(job, 0)}`, mineruState: job.status, pageProgress: job.files?.[0]?.page_progress || (job.progress ? {...job.progress, unit:"个文件"} : null)
		});
		while (!["completed", "partial", "failed", "canceled"].includes(job.status)) {
			if (this.parseQueueStopped) {
				let error = new Error(`客户端已停止等待，任务 ID: ${jobID}。服务端任务未被取消。`);
				error.name = "MineruJobWaitTimeout";
				throw error;
			}
			if (settings.localJobTimeoutMS > 0 && Date.now() - started >= settings.localJobTimeoutMS) {
				let error = new Error(`客户端已达到 ${settings.localJobTimeoutMS / 1000} 秒等待上限，任务 ID: ${jobID}，最后状态: ${job.status}。服务端任务未被取消，仍可能在运行。`);
				error.name = "MineruJobWaitTimeout";
				throw error;
			}
			await this.delayParsePoll(pollIntervalMS, statusContext);
			job = await this.requestMineruJSON({
				url: `${baseURL}/v1/parse/jobs/${encodeURIComponent(jobID)}`, token, signal: statusContext?.signal
			});
			this.reportParseStatus(statusContext, {
				phase: `任务 ID: ${jobID}，${this.describeLocalJobProgress(job, Date.now() - started)}`,
				mineruState: job.status, pageProgress: job.files?.[0]?.page_progress || (job.progress ? {...job.progress, unit:"个文件"} : null)
			});
		}
		let result = job.files?.[0];
		if (result?.status !== "completed") {
			throw new Error(result?.error?.message || job.error?.message || `MinerU 解析结束：${job.status}，任务 ID: ${jobID}`);
		}
		let outputID = result.output_files?.zip?.file_id;
		if (!outputID) throw new Error("MinerU 未返回 ZIP 结果");
		this.reportParseStatus(statusContext, { phase: "下载解析结果", progress: 75 });
		let headers = token ? { Authorization: `Bearer ${token}` } : {};
		let response = await fetch(`${baseURL}/v1/files/${encodeURIComponent(outputID)}/content`, { headers, signal: statusContext?.signal });
		if (!response.ok) throw new Error(`下载解析结果失败 ${response.status}`);
		let zipBytes = new Uint8Array(await response.arrayBuffer());
		this.reportParseStatus(statusContext, { phase: "提取 Markdown", progress: 90 });
		let parsedResult = await this.extractNoteContentFromMineruZip(zipBytes, fileName);
		this.reportParseStatus(statusContext, { phase: "提取完成", progress: 95 });
		return parsedResult;
	},
	
	makeDataID(attachmentID) {
		let suffix = Math.random().toString(36).slice(2, 10);
		return `zotero-${attachmentID}-${suffix}`;
	},

	normalizeDownloadURL(downloadURL, apiBaseURL) {
		let raw = (downloadURL || "").toString().trim();
		if (!raw) {
			throw new Error("下载链接为空");
		}
		if (raw.startsWith("//")) {
			raw = `https:${raw}`;
		}
		let normalized;
		try {
			normalized = new URL(raw, `${apiBaseURL}/`);
		}
		catch (_e) {
			throw new Error(`下载链接格式非法: ${raw.slice(0, 200)}`);
		}
		if (!["http:", "https:"].includes(normalized.protocol)) {
			throw new Error(`下载链接协议不支持: ${normalized.protocol}`);
		}
		return normalized.toString();
	},

	maskURLForError(rawURL) {
		try {
			let parsed = new URL(rawURL);
			return `${parsed.origin}${parsed.pathname}`;
		}
		catch (_e) {
			return (rawURL || "").toString().slice(0, 200);
		}
	},

	async fetchZipWithOptions({ url, token, withAuth, signal }) {
		let headers = new Headers();
		if (withAuth && token) {
			headers.set("Authorization", `Bearer ${token}`);
		}
		return await fetch(url, {
			method: "GET",
			headers, signal
		});
	},

	async downloadParseResultZip({ zipURL, apiBaseURL, token, statusContext = null }) {
		let normalizedURL = this.normalizeDownloadURL(zipURL, apiBaseURL);
		let candidates = [];
		let addCandidate = (url, withAuth, label) => {
			let key = `${url}|${withAuth ? "auth" : "anon"}`;
			if (candidates.some((item) => item.key === key)) return;
			candidates.push({
				key,
				url,
				withAuth,
				label
			});
		};

		addCandidate(normalizedURL, false, "直连下载");
		addCandidate(normalizedURL, true, "直连下载（Bearer）");
		if (normalizedURL.startsWith("http://")) {
			let httpsURL = `https://${normalizedURL.slice("http://".length)}`;
			addCandidate(httpsURL, false, "HTTPS 回退");
			addCandidate(httpsURL, true, "HTTPS 回退（Bearer）");
		}

		let failures = [];
		for (let i = 0; i < candidates.length; i++) {
			let attempt = candidates[i];
			this.reportParseStatus(statusContext, {
				phase: `下载解析结果（${attempt.label}，${i + 1}/${candidates.length}）`,
				progress: 75
			});
			try {
				let response = await this.fetchZipWithOptions({
					url: attempt.url,
					token,
					withAuth: attempt.withAuth, signal: statusContext?.signal
				});
				if (!response.ok) {
					let errText = await response.text();
					failures.push(`${attempt.label}: HTTP ${response.status}`);
					if (i < candidates.length - 1) {
						continue;
					}
					throw new Error(`下载解析结果失败 ${response.status}: ${errText.slice(0, 300)}`);
				}
				return new Uint8Array(await response.arrayBuffer());
			}
			catch (e) {
				if (statusContext?.signal?.aborted) throw e;
				let message = e?.message || String(e);
				failures.push(`${attempt.label}: ${message}`);
				if (i < candidates.length - 1) {
					continue;
				}
			}
		}

		let urlHint = this.maskURLForError(normalizedURL);
		let reason = failures.length ? failures[failures.length - 1] : "unknown";
		throw new Error(`下载解析结果网络失败 (${urlHint})：${reason}`);
	},
		
	async requestMineruJSON({ url, token, method = "GET", body = null, signal }) {
		let headers = new Headers({
			"Accept": "application/json"
		});
		if (token) headers.set("Authorization", `Bearer ${token}`);
		let requestOptions = {
			method,
			headers, signal
		};
		if (body !== null) {
			headers.set("Content-Type", "application/json");
			requestOptions.body = JSON.stringify(body);
		}
		
		let response = await fetch(url, requestOptions);
		let responseText = await response.text();
		if (!response.ok) {
			let error = new Error(`MinerU API 请求失败 ${response.status}: ${responseText.slice(0, 500)}`);
			error.status = response.status;
			throw error;
		}
		
		try {
			return JSON.parse(responseText);
		}
		catch (_e) {
			throw new Error(`MinerU API 返回的 JSON 无法解析: ${responseText.slice(0, 500)}`);
		}
	},
	
	async pollMineruExtractResult({ apiBaseURL, token, batchID, dataID, timeoutMS, pollIntervalMS, statusContext = null }) {
		let startTime = Date.now();
		let lastState = "";
		while (Date.now() - startTime < timeoutMS) {
			let statusResult = await this.requestMineruJSON({
				url: `${apiBaseURL}/extract-results/batch/${encodeURIComponent(batchID)}`,
				token, signal: statusContext?.signal
			});
			if (statusResult.code !== 0) {
				throw new Error(`查询解析状态失败: ${statusResult.msg || "unknown error"}`);
			}
			
			let extractResults = statusResult?.data?.extract_result || [];
			let result = extractResults.find((x) => x?.data_id === dataID) || extractResults[0];
			if (result?.state) {
				lastState = result.state;
				this.reportParseStatus(statusContext, {
					mineruState: lastState, cloudProgress: result.extract_progress || null
				});
			}
			
			if (result?.state === "done") {
				return result;
			}
			if (result?.state === "failed") {
				throw new Error(result.err_msg || "MinerU 解析失败");
			}
			
			await this.delayParsePoll(pollIntervalMS, statusContext);
		}
		throw new Error(`MinerU 解析超时，最后状态: ${lastState || "unknown"}`);
	},
	
	async extractNoteContentFromMineruZip(zipBytes, originalFileName, options = {}) {
		let includeImages = options.includeImages !== false;
		let tempDir = PathUtils.join(PathUtils.tempDir, `docflow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
		let zipPath = PathUtils.join(tempDir, "result.zip");
		
		await IOUtils.makeDirectory(tempDir, { createAncestors: true });
		await IOUtils.write(zipPath, zipBytes);
		
		let zipReader = Components.classes["@mozilla.org/libjar/zip-reader;1"]
			.createInstance(Components.interfaces.nsIZipReader);
		try {
			zipReader.open(this.pathToNSIFile(zipPath));
			let markdownEntryName = this.pickMarkdownEntry(zipReader, originalFileName);
			if (!markdownEntryName) {
				throw new Error("结果 ZIP 中没有找到 Markdown 文件");
			}

			let markdownBytes = await this.readZipEntryBytes(zipReader, tempDir, markdownEntryName);
			let markdownText = new TextDecoder("utf-8").decode(markdownBytes);
			let rawFiles = [{ name: markdownEntryName, text: markdownText }], document = null;
			if (typeof OCRFlowDocument !== "undefined") {
				let entries = Array.from(this.buildArchiveEntryMap(zipReader).values()), layout = null, blockList = {};
				for (let entry of entries.filter(name => /\.json$/i.test(name))) {
					let text = new TextDecoder("utf-8").decode(await this.readZipEntryBytes(zipReader, tempDir, entry));
					rawFiles.push({ name: entry, text });
					if (/block_list\.json$/i.test(entry)) blockList = JSON.parse(text);
					if (!layout && /(?:layout\.json|_middle\.json|middle_json\.json)$/i.test(entry)) {
						let payload = JSON.parse(text);
						if (payload.pdf_info?.length) layout = payload;
					}
				}
				if (layout) document = OCRFlowDocument.fromMineru(layout, 0, blockList);
				if (document) markdownText = OCRFlowDocument.render(document);
			}
			let outlineData = { pages: [], headings: [] };
			if (this.outline) {
				let entries = Array.from(this.buildArchiveEntryMap(zipReader).values());
				let entry = entries.find(name => name.endsWith("structured_content.json"))
					|| entries.find(name => name.endsWith("content_list.json"))
					|| entries.find(name => name.endsWith("middle_json.json"));
				if (entry) {
					let bytes = await this.readZipEntryBytes(zipReader, tempDir, entry);
					outlineData = this.outline.parseMineruDocument(JSON.parse(new TextDecoder("utf-8").decode(bytes)));
				}
			}
			let inlinedResult = {
				markdownText,
				embeddedImages: []
			};
			if (document) outlineData = {
				pages: document.pages.map(page => document.blocks.filter(block => block.fragments[0].page === page.page).map(block => block.rawText).join("\n\n")),
				headings: document.blocks.filter(block => block.type === "heading").map(block => ({ title: block.text, level: block.level, page: block.fragments[0].page, summary: "" }))
			};
			if (includeImages) {
				let entryMap = this.buildArchiveEntryMap(zipReader);
				inlinedResult = await this.inlineArchiveImagesInMarkdown({
					markdownText,
					markdownEntryName: markdownEntryName,
					zipReader,
					tempDir,
					entryMap
				});
			}
			let rendered = await this.markdownToHTML(inlinedResult.markdownText);
			if (document) this.normalizeResultImages({ document, markdownText:inlinedResult.markdownText, embeddedImages:inlinedResult.embeddedImages });
			return {
				sourceKind: "markdown",
				rawMarkdownText: markdownText,
				rawMarkdownEntryName: markdownEntryName || "",
				document, rawFiles,
				markdownText: inlinedResult.markdownText,
				contentHTML: rendered.html,
				outlinePages: outlineData.pages,
				outlineHeadings: outlineData.headings,
				embeddedImageCount: inlinedResult.embeddedImages.length,
				embeddedImages: inlinedResult.embeddedImages
			};
		}
		finally {
			try {
				zipReader.close();
			}
			catch (_e) {}
			await IOUtils.remove(zipPath).catch(() => {});
			await IOUtils.remove(tempDir).catch(() => {});
		}
	},

	buildArchiveEntryMap(zipReader) {
		let map = new Map();
		let enumerator = zipReader.findEntries(null);
		while (enumerator.hasMore()) {
			let entryName = enumerator.getNext();
			if (!entryName || entryName.endsWith("/")) continue;
			let normalized = this.normalizeArchivePath(entryName);
			if (!normalized) continue;
			map.set(normalized.toLowerCase(), entryName);
		}
		return map;
	},

	async readZipEntryBytes(zipReader, tempDir, entryName) {
		let safeName = this.fileNameFromPath(entryName).replace(/[^\w.\-]+/g, "_");
		let outputPath = PathUtils.join(
			tempDir,
			`entry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}`
		);
		let outputFile = this.pathToNSIFile(outputPath, true);
		zipReader.extract(entryName, outputFile);
		try {
			return new Uint8Array(await IOUtils.read(outputPath));
		}
		finally {
			await IOUtils.remove(outputPath).catch(() => {});
		}
	},

	async inlineArchiveImagesInMarkdown({ markdownText, markdownEntryName, zipReader, tempDir, entryMap }) {
		let embeddedByEntry = new Map();
		let embeddedImages = [];
		let addEmbedded = (entryName, mimeType, bytes) => {
			let cacheKey = entryName.toLowerCase();
			if (embeddedByEntry.has(cacheKey)) {
				return embeddedByEntry.get(cacheKey);
			}
			let id = `img-${embeddedImages.length + 1}`;
			let marker = `docflow-image://${id}`;
			let dataURI = `data:${mimeType};base64,${this.bytesToBase64(bytes)}`;
			let imageData = {
				id,
				marker,
				entryName,
				fileName: this.fileNameFromPath(entryName),
				mimeType,
				bytes,
				dataURI
			};
			embeddedImages.push(imageData);
			embeddedByEntry.set(cacheKey, imageData);
			return imageData;
		};

		let replacedText = await this.replaceAsync(
			markdownText,
			/!\[([^\]]*)\]\(([^)]+)\)/g,
			async (match) => {
				let alt = match[1] || "";
				let targetInfo = this.parseMarkdownImageTarget(match[2] || "");
				let imageData = await this.resolveArchiveImageReference({
					resourceURL: targetInfo.url,
					markdownEntryName,
					entryMap,
					zipReader,
					tempDir,
					embeddedByEntry,
					addEmbedded
				});
				if (!imageData) return match[0];
				let titlePart = targetInfo.title ? ` "${targetInfo.title}"` : "";
				return `![${alt}](${imageData.marker}${titlePart})`;
			}
		);

		replacedText = await this.replaceAsync(
			replacedText,
			/<img\b([^>]*?)\bsrc=(["'])([^"']+)\2([^>]*)>/gi,
				async (match) => {
					let before = match[1] || "";
					let quote = match[2] || "\"";
					let src = match[3] || "";
					let after = match[4] || "";
					let imageData = await this.resolveArchiveImageReference({
						resourceURL: src,
						markdownEntryName,
					entryMap,
					zipReader,
					tempDir,
					embeddedByEntry,
					addEmbedded
				});
					if (!imageData) return match[0];
					return `<img${before}src=${quote}${imageData.marker}${quote}${after}>`;
				}
			);

		return {
			markdownText: replacedText,
			embeddedImages
		};
	},

	async replaceAsync(text, regex, asyncReplacer) {
		let output = "";
		let lastIndex = 0;
		regex.lastIndex = 0;
		let match;
		while ((match = regex.exec(text)) !== null) {
			output += text.slice(lastIndex, match.index);
			output += await asyncReplacer(match);
			lastIndex = regex.lastIndex;
			if (match[0].length === 0) {
				regex.lastIndex++;
			}
		}
		output += text.slice(lastIndex);
		return output;
	},

	parseMarkdownImageTarget(rawTarget) {
		let target = String(rawTarget || "").trim();
		if (!target) {
			return { url: "", title: "" };
		}
		if (target.startsWith("<")) {
			let closeIndex = target.indexOf(">");
			if (closeIndex > 0) {
				let url = target.slice(1, closeIndex).trim();
				let title = target.slice(closeIndex + 1).trim().replace(/^["']|["']$/g, "");
				return { url, title };
			}
		}
		let firstWhitespace = target.search(/\s/);
		let url = firstWhitespace >= 0 ? target.slice(0, firstWhitespace) : target;
		let title = firstWhitespace >= 0 ? target.slice(firstWhitespace + 1).trim() : "";
		title = title.replace(/^["']|["']$/g, "");
		return { url, title };
	},

	normalizeArchiveReference(resourceURL) {
		let value = String(resourceURL || "").trim();
		if (!value) return "";
		if (value.startsWith("<") && value.endsWith(">")) {
			value = value.slice(1, -1);
		}
		let hashIndex = value.indexOf("#");
		if (hashIndex >= 0) {
			value = value.slice(0, hashIndex);
		}
		let queryIndex = value.indexOf("?");
		if (queryIndex >= 0) {
			value = value.slice(0, queryIndex);
		}
		value = value.replace(/\\/g, "/");
		try {
			value = decodeURIComponent(value);
		}
		catch (_e) {}
		return value.trim();
	},

	resolveArchiveReference(markdownEntryName, resourceURL) {
		let normalizedRef = this.normalizeArchiveReference(resourceURL);
		if (!normalizedRef || this.isExternalResourceURL(normalizedRef)) return "";
		let baseDir = "";
		let slashIndex = markdownEntryName.lastIndexOf("/");
		if (slashIndex >= 0) {
			baseDir = markdownEntryName.slice(0, slashIndex + 1);
		}
		let merged = normalizedRef.startsWith("/")
			? normalizedRef.slice(1)
			: `${baseDir}${normalizedRef}`;
		return this.normalizeArchivePath(merged);
	},

	normalizeArchivePath(pathValue) {
		let parts = String(pathValue || "").replace(/\\/g, "/").split("/");
		let normalizedParts = [];
		for (let part of parts) {
			if (!part || part === ".") continue;
			if (part === "..") {
				if (normalizedParts.length) {
					normalizedParts.pop();
				}
				continue;
			}
			normalizedParts.push(part);
		}
		return normalizedParts.join("/");
	},

	isExternalResourceURL(resourceURL) {
		return /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(resourceURL);
	},

	async resolveArchiveImageReference({
		resourceURL,
		markdownEntryName,
		entryMap,
		zipReader,
		tempDir,
		embeddedByEntry,
		addEmbedded
	}) {
		let normalizedPath = this.resolveArchiveReference(markdownEntryName, resourceURL);
		if (!normalizedPath) return null;
		let entryName = entryMap.get(normalizedPath.toLowerCase());
		if (!entryName) {
			let basename = this.fileNameFromPath(normalizedPath).toLowerCase();
			let matches = [...entryMap.values()].filter(name => this.fileNameFromPath(name).toLowerCase() === basename);
			if (matches.length === 1) entryName = matches[0];
		}
		if (!entryName) return null;
		let mimeType = this.guessMimeType(entryName);
		if (!mimeType.startsWith("image/")) return null;
		let cacheKey = entryName.toLowerCase();
		if (embeddedByEntry.has(cacheKey)) {
			return embeddedByEntry.get(cacheKey);
		}
		let bytes = await this.readZipEntryBytes(zipReader, tempDir, entryName);
		return addEmbedded(entryName, mimeType, bytes);
	},

	guessMimeType(pathValue) {
		let lower = String(pathValue || "").toLowerCase();
		if (lower.endsWith(".png")) return "image/png";
		if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
		if (lower.endsWith(".gif")) return "image/gif";
		if (lower.endsWith(".webp")) return "image/webp";
		if (lower.endsWith(".bmp")) return "image/bmp";
		if (lower.endsWith(".svg")) return "image/svg+xml";
		if (lower.endsWith(".tif") || lower.endsWith(".tiff")) return "image/tiff";
		return "application/octet-stream";
	},

	bytesToBase64(bytes) {
		let binary = "";
		let chunkSize = 0x8000;
		for (let i = 0; i < bytes.length; i += chunkSize) {
			let chunk = bytes.subarray(i, i + chunkSize);
			binary += String.fromCharCode.apply(null, chunk);
		}
		if (typeof btoa !== "function") {
			throw new Error("当前环境不支持 btoa，无法内嵌图片资源");
		}
		return btoa(binary);
	},

	async markdownToHTML(markdownText) {
		let markdown = String(markdownText || "");
		let fallbackHTML = this.convertMarkdownToBasicHTML(markdown);
		let convertedHTML = await this.convertMarkdownWithZoteroEngines(markdown);
		if (convertedHTML && this.looksLikeHTML(convertedHTML)) {
			if (!this.containsLikelyUnparsedMathOrTables(convertedHTML)) {
				return {
					html: convertedHTML,
					usedMarkdownEngine: true
				};
			}
			this.log("Markdown engine output still contains raw math/table markdown; using built-in parser fallback");
			return {
				html: fallbackHTML,
				usedMarkdownEngine: false
			};
		}
		return {
			html: fallbackHTML,
			usedMarkdownEngine: false
		};
	},

	looksLikeHTML(value) {
		return /<[^>]+>/.test(String(value || ""));
	},

	containsLikelyUnparsedMathOrTables(value) {
		let text = String(value || "");
		if (!text) return false;
		// Better Notes-style math output no longer contains raw "$...$" text.
		if (/\$\$[\s\S]*?\$\$/.test(text)) return true;
		if (/(^|[^$])\$[^$\n]+\$([^$]|$)/.test(text)) return true;
		// A markdown table often appears as multiple <p>|...|</p> lines when unparsed.
		if (/<p>\s*\|[^<\n]+\|\s*<\/p>/i.test(text)) return true;
		return false;
	},

	async convertMarkdownWithZoteroEngines(markdownText) {
		let candidates = [
			{ scope: Zotero?.EditorInstanceUtilities, fnName: "md2html" },
			{ scope: Zotero?.EditorInstanceUtilities, fnName: "markdownToHTML" },
			{ scope: Zotero?.EditorInstanceUtilities, fnName: "markdown2html" },
			{ scope: Zotero?.Utilities?.Internal, fnName: "md2html" },
			{ scope: Zotero?.Utilities, fnName: "markdownToHTML" }
		];
		for (let candidate of candidates) {
			let fn = candidate?.scope?.[candidate.fnName];
			if (typeof fn !== "function") continue;
			try {
				let result = fn.call(candidate.scope, markdownText);
				if (result && typeof result.then === "function") {
					result = await result;
				}
				let normalizedHTML = this.normalizeConvertedHTML(result);
				if (normalizedHTML) {
					return normalizedHTML;
				}
			}
			catch (e) {
				this.log(`Markdown converter ${candidate.fnName} failed: ${e}`);
			}
		}
		return "";
	},

	normalizeConvertedHTML(value) {
		if (!value) return "";
		if (typeof value === "string") {
			return value.trim();
		}
		if (typeof value?.html === "string") {
			return value.html.trim();
		}
		if (typeof value?.content === "string") {
			return value.content.trim();
		}
		if (typeof value?.result === "string") {
			return value.result.trim();
		}
		return "";
	},

	convertMarkdownToBasicHTML(markdownText) {
		let text = String(markdownText || "").replace(/\r\n?/g, "\n");
		let lines = text.split("\n");
		let htmlParts = [];
		let paragraph = [];
		let listType = "";
		let inCodeBlock = false;
		let codeBlockLines = [];
		let codeLanguage = "";
		let flushParagraph = () => {
			if (!paragraph.length) return;
			let paragraphHTML = paragraph
				.map((line) => this.renderInlineMarkdown(line))
				.join("<br/>");
			htmlParts.push(`<p>${paragraphHTML}</p>`);
			paragraph = [];
		};
		let closeList = () => {
			if (!listType) return;
			htmlParts.push(listType === "ol" ? "</ol>" : "</ul>");
			listType = "";
		};
		let flushCodeBlock = () => {
			if (!inCodeBlock) return;
			let classAttr = codeLanguage
				? ` class="language-${this.escapeHTML(codeLanguage)}"`
				: "";
			let codeHTML = this.escapeHTML(codeBlockLines.join("\n"));
			htmlParts.push(`<pre><code${classAttr}>${codeHTML}</code></pre>`);
			inCodeBlock = false;
			codeBlockLines = [];
			codeLanguage = "";
		};

		for (let i = 0; i < lines.length; i++) {
			let rawLine = lines[i];
			let line = rawLine || "";
			let trimmed = line.trim();
			let fenceMatch = trimmed.match(/^```([\w-]+)?\s*$/);
			if (fenceMatch) {
				flushParagraph();
				closeList();
				if (inCodeBlock) {
					flushCodeBlock();
				}
				else {
					inCodeBlock = true;
					codeLanguage = fenceMatch[1] || "";
				}
				continue;
			}
			if (inCodeBlock) {
				codeBlockLines.push(line);
				continue;
			}

			if (!trimmed) {
				flushParagraph();
				closeList();
				continue;
			}

			let displayMathResult = this.parseDisplayMathBlock(lines, i);
			if (displayMathResult) {
				flushParagraph();
				closeList();
				htmlParts.push(displayMathResult.html);
				i = displayMathResult.nextIndex;
				continue;
			}

			let htmlTableResult = this.parseHTMLTableBlock(lines, i);
			if (htmlTableResult) {
				flushParagraph();
				closeList();
				htmlParts.push(htmlTableResult.html);
				i = htmlTableResult.nextIndex;
				continue;
			}

			let tableResult = this.parseMarkdownTableBlock(lines, i);
			if (tableResult) {
				flushParagraph();
				closeList();
				htmlParts.push(tableResult.html);
				i = tableResult.nextIndex;
				continue;
			}

			let headingMatch = line.match(/^\s*(#{1,6})\s+(.+)$/);
			if (headingMatch) {
				flushParagraph();
				closeList();
				let level = headingMatch[1].length;
				let titleText = this.renderInlineMarkdown(headingMatch[2].trim());
				htmlParts.push(`<h${level}>${titleText}</h${level}>`);
				continue;
			}

			if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
				flushParagraph();
				closeList();
				htmlParts.push("<hr/>");
				continue;
			}

			let orderedMatch = line.match(/^\s*(\d+)\.\s+(.+)$/);
			if (orderedMatch) {
				flushParagraph();
				if (listType && listType !== "ol") {
					closeList();
				}
				if (!listType) {
					htmlParts.push("<ol>");
					listType = "ol";
				}
				htmlParts.push(`<li>${this.renderInlineMarkdown(orderedMatch[2])}</li>`);
				continue;
			}

			let unorderedMatch = line.match(/^\s*[-*+]\s+(.+)$/);
			if (unorderedMatch) {
				flushParagraph();
				if (listType && listType !== "ul") {
					closeList();
				}
				if (!listType) {
					htmlParts.push("<ul>");
					listType = "ul";
				}
				htmlParts.push(`<li>${this.renderInlineMarkdown(unorderedMatch[1])}</li>`);
				continue;
			}

			let blockquoteMatch = line.match(/^\s*>\s?(.*)$/);
			if (blockquoteMatch) {
				flushParagraph();
				closeList();
				let blockquoteHTML = this.renderInlineMarkdown(blockquoteMatch[1] || "");
				htmlParts.push(`<blockquote><p>${blockquoteHTML}</p></blockquote>`);
				continue;
			}

			paragraph.push(line);
		}

		flushCodeBlock();
		flushParagraph();
		closeList();
		return htmlParts.join("");
	},

	parseDisplayMathBlock(lines, startIndex) {
		if (/^\s*\\\[/.test(lines[startIndex] || "")) {
			let normalizedLines = lines.slice();
			normalizedLines[startIndex] = normalizedLines[startIndex].replace(/\\\[/, () => "$$");
			for (let i = startIndex; i < normalizedLines.length; i++) {
				if (normalizedLines[i].includes("\\]")) {
					normalizedLines[i] = normalizedLines[i].replace(/\\\]/, () => "$$");
					break;
				}
			}
			return this.parseDisplayMathBlock(normalizedLines, startIndex);
		}
		let startLine = String(lines[startIndex] || "");
		let trimmed = startLine.trim();
		if (!trimmed.startsWith("$$")) return null;
		let normalized = trimmed.replace(/\s+/g, " ");

		if (/^\$\$\s*$/.test(normalized)) {
			let mathLines = [];
			for (let i = startIndex + 1; i < lines.length; i++) {
				let current = String(lines[i] || "");
				if (/^\s*\$\$\s*$/.test(current.trim())) {
					return {
						html: this.renderDisplayMathHTML(mathLines.join("\n")),
						nextIndex: i
					};
				}
				mathLines.push(current);
			}
			return null;
		}

		let singleLine = startLine.match(/^\s*\$\$(.*?)\$\$\s*$/);
		if (singleLine) {
			return {
				html: this.renderDisplayMathHTML(singleLine[1] || ""),
				nextIndex: startIndex
			};
		}

		let firstLine = startLine.replace(/^\s*\$\$\s?/, "");
		let mathLines = [firstLine];
		for (let i = startIndex + 1; i < lines.length; i++) {
			let current = String(lines[i] || "");
			let closeMatch = current.match(/^(.*)\$\$\s*$/);
			if (closeMatch) {
				mathLines.push(closeMatch[1] || "");
				return {
					html: this.renderDisplayMathHTML(mathLines.join("\n")),
					nextIndex: i
				};
			}
			mathLines.push(current);
		}
		return null;
	},

	renderDisplayMathHTML(tex) {
		let normalized = String(tex || "").replace(/^\n+|\n+$/g, "");
		return `<pre class="math">$$${this.escapeHTML(normalized)}$$</pre>`;
	},

	parseHTMLTableBlock(lines, startIndex) {
		let firstLine = String(lines[startIndex] || "");
		let trimmed = firstLine.trim();
		if (!/^<table\b/i.test(trimmed)) return null;

		let endIndex = startIndex;
		let foundClose = /<\/table>\s*$/i.test(trimmed);
		while (!foundClose && endIndex + 1 < lines.length) {
			endIndex++;
			let current = String(lines[endIndex] || "").trim();
			if (/<\/table>/i.test(current)) {
				foundClose = true;
				break;
			}
		}
		if (!foundClose) return null;

		let rawTableHTML = lines.slice(startIndex, endIndex + 1).join("\n");
		return {
			html: this.normalizeHTMLTableForNote(rawTableHTML),
			nextIndex: endIndex
		};
	},

	normalizeHTMLTableForNote(rawTableHTML) {
		let raw = String(rawTableHTML || "").trim();
		if (!raw) return "";
		try {
			if (typeof DOMParser !== "function") {
				return raw;
			}
			let doc = new DOMParser().parseFromString(`<body>${raw}</body>`, "text/html");
			let table = doc.querySelector("table");
			if (!table) {
				return raw;
			}
			table.querySelectorAll("script, style").forEach((node) => node.remove());
			this.convertMathMarkersInsideTable(table, doc);
			return table.outerHTML || raw;
		}
		catch (e) {
			this.log(`Normalize HTML table failed: ${e}`);
			return raw;
		}
	},

	convertMathMarkersInsideTable(tableElement, doc) {
		if (!tableElement || !doc) return;
		let skipTags = new Set(["CODE", "PRE", "SCRIPT", "STYLE", "MATH"]);
		let walk = (node) => {
			if (!node) return;
			if (node.nodeType === 1) {
				let tagName = String(node.tagName || "").toUpperCase();
				if (skipTags.has(tagName)) return;
				let className = String(node.getAttribute?.("class") || "");
				if (/\bmath\b/.test(className)) return;
				let children = Array.from(node.childNodes || []);
				for (let child of children) {
					walk(child);
				}
				return;
			}
			if (node.nodeType !== 3) return;
			let text = String(node.nodeValue || "");
			if (!text.includes("$")) return;
			let segments = this.splitMathTextSegments(text);
			if (!segments || !segments.some((x) => x.type !== "text")) return;
			let fragment = doc.createDocumentFragment();
			for (let segment of segments) {
				if (segment.type === "text") {
					fragment.appendChild(doc.createTextNode(segment.value));
					continue;
				}
				if (segment.type === "inline") {
					let span = doc.createElement("span");
					span.setAttribute("class", "math");
					span.textContent = `$${segment.value}$`;
					fragment.appendChild(span);
					continue;
				}
				if (segment.type === "display") {
					let pre = doc.createElement("pre");
					pre.setAttribute("class", "math");
					pre.textContent = `$$${segment.value}$$`;
					fragment.appendChild(pre);
					continue;
				}
			}
			node.parentNode?.replaceChild(fragment, node);
		};

		let cells = tableElement.querySelectorAll("td, th");
		for (let cell of cells) {
			walk(cell);
		}
	},

	splitMathTextSegments(text) {
		let value = String(text || "");
		let segments = [];
		let buffer = "";
		let i = 0;
		let flushBuffer = () => {
			if (!buffer) return;
			segments.push({
				type: "text",
				value: buffer
			});
			buffer = "";
		};

		while (i < value.length) {
			let ch = value[i];
			if (ch === "\\") {
				buffer += value.slice(i, Math.min(i + 2, value.length));
				i += 2;
				continue;
			}
			if (ch !== "$") {
				buffer += ch;
				i++;
				continue;
			}

			let isDisplay = value[i + 1] === "$";
			if (isDisplay) {
				let end = i + 2;
				let found = false;
				while (end < value.length - 1) {
					if (value[end] === "\\") {
						end += 2;
						continue;
					}
					if (value[end] === "$" && value[end + 1] === "$") {
						found = true;
						break;
					}
					end++;
				}
				if (!found) {
					buffer += "$$";
					i += 2;
					continue;
				}
				let tex = value.slice(i + 2, end);
				if (!tex.trim()) {
					buffer += "$$";
					i += 2;
					continue;
				}
				flushBuffer();
				segments.push({
					type: "display",
					value: tex
				});
				i = end + 2;
				continue;
			}

			let end = i + 1;
			let found = false;
			while (end < value.length) {
				if (value[end] === "\\") {
					end += 2;
					continue;
				}
				if (value[end] === "\n") break;
				if (value[end] === "$") {
					if (value[end + 1] === "$") {
						end += 2;
						continue;
					}
					found = true;
					break;
				}
				end++;
			}
			if (!found) {
				buffer += "$";
				i++;
				continue;
			}
			let tex = value.slice(i + 1, end);
			if (!tex.trim()) {
				buffer += "$$";
				i = end + 1;
				continue;
			}
			flushBuffer();
			segments.push({
				type: "inline",
				value: tex
			});
			i = end + 1;
		}

		flushBuffer();
		return segments;
	},

	parseMarkdownTableBlock(lines, startIndex) {
		let headerLine = String(lines[startIndex] || "");
		let delimiterLine = String(lines[startIndex + 1] || "");
		if (!this.isMarkdownTableHeaderLine(headerLine)) return null;
		if (!this.isMarkdownTableDelimiterLine(delimiterLine)) return null;

		let headerCells = this.splitMarkdownTableRow(headerLine);
		if (!headerCells.length) return null;

		let delimiterCells = this.splitMarkdownTableRow(delimiterLine);
		let columnCount = Math.max(headerCells.length, delimiterCells.length);
		if (!columnCount) return null;

		let alignments = this.buildMarkdownTableAlignments(delimiterCells, columnCount);
		let bodyRows = [];
		let endIndex = startIndex + 1;

		for (let i = startIndex + 2; i < lines.length; i++) {
			let row = String(lines[i] || "");
			let trimmed = row.trim();
			if (!trimmed) break;
			if (!row.includes("|")) break;
			if (/^\s*```/.test(row)) break;
			if (/^\s*(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+)/.test(row)) break;
			let cells = this.splitMarkdownTableRow(row);
			if (!cells.length) break;
			bodyRows.push(cells);
			endIndex = i;
		}

		return {
			html: this.renderMarkdownTableHTML({
				headerCells,
				alignments,
				bodyRows,
				columnCount
			}),
			nextIndex: endIndex
		};
	},

	isMarkdownTableHeaderLine(line) {
		let row = String(line || "");
		if (!row.includes("|")) return false;
		let cells = this.splitMarkdownTableRow(row);
		return cells.length >= 2;
	},

	isMarkdownTableDelimiterLine(line) {
		let row = String(line || "");
		let cells = this.splitMarkdownTableRow(row);
		if (!cells.length) return false;
		return cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, "")));
	},

	splitMarkdownTableRow(row) {
		let value = String(row || "").trim();
		if (!value.includes("|")) return [];
		if (value.startsWith("|")) value = value.slice(1);
		if (value.endsWith("|")) value = value.slice(0, -1);
		return value.split("|").map((cell) => cell.trim());
	},

	buildMarkdownTableAlignments(delimiterCells, columnCount) {
		let alignments = [];
		for (let i = 0; i < columnCount; i++) {
			let raw = String(delimiterCells[i] || "").replace(/\s+/g, "");
			if (/^:-+:$/.test(raw)) {
				alignments.push("center");
			}
			else if (/^-+:$/.test(raw)) {
				alignments.push("right");
			}
			else if (/^:-+$/.test(raw)) {
				alignments.push("left");
			}
			else {
				alignments.push("");
			}
		}
		return alignments;
	},

	renderMarkdownTableHTML({ headerCells, alignments, bodyRows, columnCount }) {
		let normalizedHeader = [];
		for (let i = 0; i < columnCount; i++) {
			normalizedHeader.push(headerCells[i] || "");
		}

		let thead = "<thead><tr>" + normalizedHeader.map((cell, idx) => {
			let align = alignments[idx] ? ` style="text-align: ${alignments[idx]};"` : "";
			return `<th${align}>${this.renderInlineMarkdown(cell)}</th>`;
		}).join("") + "</tr></thead>";

		let tbody = "";
		if (bodyRows.length) {
			let bodyHTML = bodyRows.map((row) => {
				let normalizedRow = [];
				for (let i = 0; i < columnCount; i++) {
					normalizedRow.push(row[i] || "");
				}
				return "<tr>" + normalizedRow.map((cell, idx) => {
					let align = alignments[idx] ? ` style="text-align: ${alignments[idx]};"` : "";
					return `<td${align}>${this.renderInlineMarkdown(cell)}</td>`;
				}).join("") + "</tr>";
			}).join("");
			tbody = `<tbody>${bodyHTML}</tbody>`;
		}
		return `<table>${thead}${tbody}</table>`;
	},

	renderInlineMarkdown(text) {
		let value = String(text || "");
		let codeTokens = [];
		value = value.replace(/`([^`]+)`/g, (_m, codeText) => {
			let token = `@@C${codeTokens.length}@@`;
			codeTokens.push(`<code>${this.escapeHTML(codeText)}</code>`);
			return token;
		});
		let mathTokens = [];
		value = this.replaceInlineMathWithTokens(value, mathTokens);
		value = this.normalizeEquationNumbers(value);
		// Preserve only basic formatting tags; never carry source attributes into output.
		let formattingTokens = [];
		value = value.replace(/(?:\\?<|&lt;)(\/?)(sup|sub|br|b|i|strong|em|u|s)(?=[\s/>&\\])(?:\s+[^<>]*?)?\s*\/?(?:\\?>|&gt;)/gi, (_match, closing, name) => {
			let token = `@@F${formattingTokens.length}@@`;
			name = name.toLowerCase();
			formattingTokens.push(name === "br" ? "<br>" : `<${closing}${name}>`);
			return token;
		});

		let escaped = this.escapeHTML(value);
		let imageTokens = [];
		escaped = escaped.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt, target) => {
			let token = `@@I${imageTokens.length}@@`;
			let targetInfo = this.parseMarkdownImageTarget(target);
			let src = this.escapeHTML(targetInfo.url || "");
			let altText = this.escapeHTML(alt || "");
			let titleAttr = targetInfo.title
				? ` title="${this.escapeHTML(targetInfo.title)}"`
				: "";
			imageTokens.push(`<img src="${src}" alt="${altText}"${titleAttr} />`);
			return token;
		});

		escaped = escaped.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, target) => {
			let info = this.parseMarkdownImageTarget(target);
			let href = this.escapeHTML(info.url || "");
			let titleAttr = info.title
				? ` title="${this.escapeHTML(info.title)}"`
				: "";
			return `<a href="${href}"${titleAttr}>${label}</a>`;
		});
		escaped = escaped
			.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
			.replace(/__([^_]+)__/g, "<strong>$1</strong>");

		escaped = escaped.replace(/@@I(\d+)@@/g, (_m, idx) => imageTokens[Number(idx)] || "");
		escaped = escaped.replace(/@@M(\d+)@@/g, (_m, idx) => mathTokens[Number(idx)] || "");
		escaped = escaped.replace(/@@C(\d+)@@/g, (_m, idx) => codeTokens[Number(idx)] || "");
		escaped = escaped.replace(/@@F(\d+)@@/g, (_m, idx) => formattingTokens[Number(idx)] || "");
		return escaped;
	},

	replaceInlineMathWithTokens(text, mathTokens) {
		let value = String(text || "");
		value = value.replace(/\\\(([\s\S]*?)\\\)/g, (_match, tex) => {
			let token = `@@M${mathTokens.length}@@`;
			mathTokens.push(`<span class="math">$${this.escapeHTML(tex)}$</span>`);
			return token;
		});
		let output = "";
		let i = 0;
		while (i < value.length) {
			let ch = value[i];
			if (ch === "\\") {
				output += value.slice(i, Math.min(i + 2, value.length));
				i += 2;
				continue;
			}
			if (ch !== "$" || value[i + 1] === "$") {
				output += ch;
				i++;
				continue;
			}
			let end = i + 1;
			let found = false;
			while (end < value.length) {
				let current = value[end];
				if (current === "\\") {
					end += 2;
					continue;
				}
				if (current === "\n") {
					break;
				}
				if (current === "$") {
					if (value[end + 1] === "$") {
						end += 2;
						continue;
					}
					found = true;
					break;
				}
				end++;
			}
			if (!found) {
				output += ch;
				i++;
				continue;
			}
			let tex = value.slice(i + 1, end);
			if (!tex.trim()) {
				output += "$$";
				i = end + 1;
				continue;
			}
			let token = `@@M${mathTokens.length}@@`;
			mathTokens.push(`<span class="math">$${this.escapeHTML(tex)}$</span>`);
			output += token;
			i = end + 1;
		}
		return output;
	},
	
	pathToNSIFile(path, createIfMissing = false) {
		let file = Components.classes["@mozilla.org/file/local;1"]
			.createInstance(Components.interfaces.nsIFile);
		file.initWithPath(path);
		if (createIfMissing && !file.exists()) {
			file.create(Components.interfaces.nsIFile.NORMAL_FILE_TYPE, 0o600);
		}
		return file;
	},
	
	pickMarkdownEntry(zipReader, originalFileName) {
		let entries = [];
		let enumerator = zipReader.findEntries(null);
		while (enumerator.hasMore()) {
			let name = enumerator.getNext();
			if (name.toLowerCase().endsWith(".md")) {
				entries.push(name);
			}
		}
		if (!entries.length) return null;
		
		let baseName = originalFileName.replace(/\.[^.]+$/, "");
		let exact = entries.find((name) => name === `${baseName}.md` || name.endsWith(`/${baseName}.md`));
		if (exact) return exact;
		
		let nonLayout = entries.find((name) => !name.endsWith("_layout.md"));
		if (nonLayout) return nonLayout;
		
		return entries[0];
	},


	stripHTMLToPlainText(html) {
		return String(html || "")
			.replace(/<script[\s\S]*?<\/script>/gi, " ")
			.replace(/<style[\s\S]*?<\/style>/gi, " ")
			.replace(/<[^>]+>/g, " ")
			.replace(/&nbsp;/gi, " ")
			.replace(/&amp;/gi, "&")
			.replace(/&lt;/gi, "<")
			.replace(/&gt;/gi, ">")
			.replace(/&quot;/gi, "\"")
			.replace(/&#39;/gi, "'")
			.replace(/\s+/g, " ")
			.trim();
	},

	ensureNoteTitleInHTML(contentHTML, noteTitle) {
		let title = String(noteTitle || "").trim();
		let html = String(contentHTML || "").trim();
		if (!title) {
			return html || "<p></p>";
		}
		let plain = this.stripHTMLToPlainText(html).toLowerCase();
		let normalizedTitle = title.toLowerCase();
		if (plain.startsWith(normalizedTitle)) {
			return html || "<p></p>";
		}
		let titleParagraph = `<p><strong>${this.escapeHTML(title)}</strong></p>`;
		if (!html) return titleParagraph;
		return `${titleParagraph}\n${html}`;
	},


	rewriteImagePathsForStorage(rawMarkdownText, embeddedImages) {
		if (!Array.isArray(embeddedImages) || !embeddedImages.length) {
			return { markdownText: rawMarkdownText, imageFileMap: new Map() }
		}

		// Build mapping: normalized original path → unique filename for images/ dir
		let usedNames = new Map()
		let pathToStorageName = new Map()
		let imageFileMap = new Map() // storageName → image object

		for (let image of embeddedImages) {
			let baseName = image.fileName || this.fileNameFromPath(image.entryName) || `image-${image.id}.png`
			let nameKey = baseName.toLowerCase()
			if (usedNames.has(nameKey)) {
				let count = usedNames.get(nameKey) + 1
				usedNames.set(nameKey, count)
				let dotIdx = baseName.lastIndexOf(".")
				if (dotIdx > 0) {
					baseName = baseName.slice(0, dotIdx) + `_${count}` + baseName.slice(dotIdx)
				} else {
					baseName = baseName + `_${count}`
				}
			} else {
				usedNames.set(nameKey, 1)
			}
			let storageName = `images/${baseName}`

			// Map all possible path references to this image
			let entryName = image.entryName || ""
			let normalized = this.normalizeArchivePath(entryName)
			if (normalized) pathToStorageName.set(normalized.toLowerCase(), storageName)
			pathToStorageName.set(entryName.toLowerCase(), storageName)
			let justFile = this.fileNameFromPath(entryName)
			if (justFile && !pathToStorageName.has(justFile.toLowerCase())) {
				pathToStorageName.set(justFile.toLowerCase(), storageName)
			}
			imageFileMap.set(baseName, image)
		}

		// Replace markdown image references: ![alt](path)
		let result = rawMarkdownText.replace(
			/!\[([^\]]*)\]\(([^)]+)\)/g,
			(match, alt, rawTarget) => {
				let targetInfo = this.parseMarkdownImageTarget(rawTarget)
				let url = (targetInfo?.url || rawTarget || "").trim()
				if (/^(https?:|\/\/|#|data:)/i.test(url)) return match
				let normalized = this.normalizeArchivePath(url)
				let lookup = (normalized || url).toLowerCase()
				let storageName = pathToStorageName.get(lookup)
				if (!storageName) {
					let justFile = this.fileNameFromPath(url)
					storageName = pathToStorageName.get((justFile || "").toLowerCase())
				}
				if (!storageName) return match
				let titlePart = targetInfo?.title ? ` "${targetInfo.title}"` : ""
				return `![${alt}](${storageName}${titlePart})`
			}
		)

		// Replace HTML image references: <img src="path">
		result = result.replace(
			/<img\b([^>]*?)\bsrc=(["'])([^"']+)\2([^>]*)>/gi,
			(match, before, quote, src, after) => {
				if (/^(https?:|\/\/|#|data:)/i.test(src)) return match
				let normalized = this.normalizeArchivePath(src)
				let lookup = (normalized || src).toLowerCase()
				let storageName = pathToStorageName.get(lookup)
				if (!storageName) {
					let justFile = this.fileNameFromPath(src)
					storageName = pathToStorageName.get((justFile || "").toLowerCase())
				}
				if (!storageName) return match
				return `<img${before}src=${quote}${storageName}${quote}${after}>`
			}
		)

		return { markdownText: result, imageFileMap }
	},

	removeLocalImageReferences(markdownText) {
		let result = String(markdownText || "").replace(
			/!\[([^\]]*)\]\(([^)]+)\)/g,
			(match, _alt, rawTarget) => {
				let targetInfo = this.parseMarkdownImageTarget(rawTarget)
				let url = (targetInfo?.url || rawTarget || "").trim()
				if (/^(https?:|\/\/|#)/i.test(url)) return match
				return ""
			}
		)

		result = result.replace(
			/<img\b([^>]*?)\bsrc=(["'])([^"']+)\2([^>]*)>/gi,
			(match, _before, _quote, src) => {
				if (/^(https?:|\/\/|#)/i.test(src)) return match
				return ""
			}
		)

		return result.replace(/\n{3,}/g, "\n\n")
	},

	sanitizeFileName(name) {
		return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/\s+/g, " ").trim()
	},

	rewriteTranslationImageLinksToSourceStorage(markdownText, sourceAttachment) {
		let sourceKey = sourceAttachment?.key
		if (!sourceKey) return markdownText

		let rewriteURL = (url) => {
			let cleanURL = String(url || "").trim()
			if (!cleanURL) return cleanURL
			if (/^(https?:|\/\/|#|data:|attachments:)/i.test(cleanURL)) return cleanURL
			if (cleanURL.startsWith(`../${sourceKey}/`)) return cleanURL

			let normalized = cleanURL
				.replace(/\\/g, "/")
				.replace(/^\.\/+/, "")
				.replace(/^\/+/, "")
			if (!normalized || normalized.startsWith("../")) return cleanURL

			return `../${sourceKey}/${normalized}`
		}

		let result = String(markdownText || "").replace(
			/!\[([^\]]*)\]\(([^)]+)\)/g,
			(match, alt, rawTarget) => {
				let targetInfo = this.parseMarkdownImageTarget(rawTarget)
				let url = rewriteURL(targetInfo?.url || rawTarget)
				if (url === (targetInfo?.url || rawTarget)) return match
				let titlePart = targetInfo?.title ? ` "${targetInfo.title}"` : ""
				return `![${alt}](${url}${titlePart})`
			}
		)

		result = result.replace(
			/<img\b([^>]*?)\bsrc=(["'])([^"']+)\2([^>]*)>/gi,
			(match, before, quote, src, after) => {
				let rewritten = rewriteURL(src)
				if (rewritten === src) return match
				return `<img${before}src=${quote}${rewritten}${quote}${after}>`
			}
		)

		return result
	},

	async saveResultAsMarkdownAttachment({ attachment, parentItem, parsedResult, settings, titleSuffix="" }) {
		let sourceTitle = attachment.getField("title");
		this.normalizeResultImages?.(parsedResult);
		try {
			await parentItem?.loadDataType?.("creators");
			let authors = (parentItem?.getCreatorsJSON?.() || []).filter(creator => creator.creatorType === "author").map(creator => {
				if (creator.name) return creator.name.trim();
				let firstName = (creator.firstName || "").trim();
				let lastName = (creator.lastName || "").trim();
				return /^[\u3400-\u9fff]+$/.test(firstName + lastName) ? lastName + firstName : [firstName, lastName].filter(Boolean).join(" ");
			}).filter(Boolean).join("、") || "未知作者";
			let bookTitle = String(parentItem?.getField?.("title") || "").trim();
			if (!bookTitle) {
				let filePath = await attachment.getFilePath();
				bookTitle = filePath ? this.fileStemFromPath(filePath) : String(attachment.getField("title") || "PDF").replace(/\.pdf$/i, "").trim();
			}
			let title = this.sanitizeFileName(`OCRFlow_${authors}_${bookTitle || "文档"}${titleSuffix}`);
			let imported = await this.saveDocumentAttachment({
				libraryID: attachment.libraryID, parentItem,
				title,
				markdown: parsedResult.markdownText,
				images: parsedResult.embeddedImages || [],
				format: settings.outputFormat, imageMode: settings.imageMode, tag: "#DocFlow-Parse", keepMarkdown: true
			});
			if (parsedResult.document && this.saveDocumentData) {
				parsedResult.document.source = { libraryID: attachment.libraryID, key: attachment.key };
				try { await this.saveDocumentData(imported, parsedResult); }
				catch (error) { await imported.eraseTx(); throw error; }
			}
			if (parentItem) {
				parentItem.addTag("#DocFlow-Parsed", 0);
				await parentItem.saveTx({notifierData: {skipRenameFile: true}});
			}
			let warning = null;
			if (settings.parseLinkSourcePDF !== false) {
				try {
					await this.linkParseSource(attachment, imported);
				} catch (error) {
					Zotero.logError(error);
					warning = "解析附件已保存，但关联失败";
				}
			}
			return { attachment: imported, warning };
		} finally {
			if (attachment.getField("title") !== sourceTitle) {
				attachment.setField("title", sourceTitle);
				await attachment.saveTx({notifierData: {skipRenameFile: true}});
			}
		}
	},

	async linkParseSource(source, parsed) {
		try {
			await Zotero.DB.executeTransaction(async () => {
				if (source.addRelatedItem(parsed)) await source.save({notifierData: {skipRenameFile: true}});
				if (parsed.addRelatedItem(source)) await parsed.save({notifierData: {skipRenameFile: true}});
			});
		} catch (error) {
			// Discard in-memory relation changes after the database rollback as well.
			for (let item of [source, parsed]) {
				try { await item.reload(["relations"], true); }
				catch (reloadError) { Zotero.logError(reloadError); }
			}
			throw error;
		}
	},


	resolveStoredAttachmentImagePath(markdownPath, resourceURL) {
		let normalizedRef = this.normalizeArchiveReference(resourceURL)
		if (!normalizedRef || this.isExternalResourceURL(normalizedRef)) return ""
		if (normalizedRef.startsWith("/")) return ""
		let normalizedMarkdownPath = String(markdownPath || "").replace(/\\/g, "/")
		let slashIndex = normalizedMarkdownPath.lastIndexOf("/")
		if (slashIndex < 0) return ""
		let merged = `${normalizedMarkdownPath.slice(0, slashIndex + 1)}${normalizedRef}`
		let normalizedPath = this.normalizeArchivePath(merged)
		if (/^[A-Za-z]:\//.test(normalizedPath) || normalizedPath.startsWith("//")) {
			return normalizedPath.replace(/\//g, "\\")
		}
		return normalizedMarkdownPath.startsWith("/") ? "/" + normalizedPath : normalizedPath
	},

	async inlineStoredImagesInMarkdownAttachment({ markdownText, markdownPath, signal, onImage }) {
		let embeddedByPath = new Map()
		let embeddedImages = []
		let addEmbedded = (imagePath, mimeType, bytes) => {
			let cacheKey = imagePath.startsWith("data:") ? imagePath : imagePath.toLowerCase()
			if (embeddedByPath.has(cacheKey)) {
				return embeddedByPath.get(cacheKey)
			}
			let id = `img-${embeddedImages.length + 1}`
			let marker = `docflow-image://${id}`
			let dataURI = `data:${mimeType};base64,${this.bytesToBase64(bytes)}`
			let imageData = {
				id,
				marker,
				entryName: imagePath,
				fileName: imagePath.startsWith("data:") ? `image-${embeddedImages.length + 1}.${this.guessImageExtension(mimeType)}` : this.fileNameFromPath(imagePath),
				mimeType,
				bytes,
				dataURI
			}
			embeddedImages.push(imageData)
			onImage?.(embeddedImages.length);
			embeddedByPath.set(cacheKey, imageData)
			return imageData
		}
		let resolveImage = async (resourceURL) => {
			signal?.throwIfAborted();
			if (/^data:image\//i.test(resourceURL)) {
				let match = resourceURL.match(/^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i);
				if (!match) throw new Error("不支持的内嵌图片格式");
				let binary = atob(match[2].replace(/\s/g, ""));
				return addEmbedded(resourceURL, match[1], Uint8Array.from(binary, ch => ch.charCodeAt(0)));
			}
			let imagePath = this.resolveStoredAttachmentImagePath(markdownPath, resourceURL)
			if (!imagePath) return null
			let cacheKey = imagePath.toLowerCase()
			if (embeddedByPath.has(cacheKey)) {
				return embeddedByPath.get(cacheKey)
			}
			let mimeType = this.guessMimeType(imagePath)
			if (!mimeType.startsWith("image/")) return null
			try {
				let bytes = await IOUtils.read(imagePath)
				signal?.throwIfAborted();
				return addEmbedded(imagePath, mimeType, bytes)
			}
			catch (e) {
				throw new Error(`图片读取失败：${imagePath} (${e.message || e})`)
			}
		}

		// Protect data URLs independently of Markdown/HTML image syntax.
		let protectedText = await this.replaceAsync(
			markdownText,
			/data:image\/[\w.+-]+;base64,[A-Za-z0-9+/=]+/gi,
			async (match) => (await resolveImage(match[0])).marker
		);
		let replacedText = await this.replaceAsync(
			protectedText,
			/!\[([^\]]*)\]\(([^)]+)\)/g,
			async (match) => {
				let alt = match[1] || ""
				let targetInfo = this.parseMarkdownImageTarget(match[2] || "")
				let imageData = await resolveImage(targetInfo.url)
				if (!imageData) return match[0]
				let titlePart = targetInfo.title ? ` "${targetInfo.title}"` : ""
				return `![${alt}](${imageData.marker}${titlePart})`
			}
		)

		replacedText = await this.replaceAsync(
			replacedText,
			/<img\b([^>]*?)\bsrc=(["'])([^"']+)\2([^>]*)>/gi,
			async (match) => {
				let before = match[1] || ""
				let quote = match[2] || "\""
				let src = match[3] || ""
				let after = match[4] || ""
				let imageData = await resolveImage(src)
				if (!imageData) return match[0]
				return `<img${before}src=${quote}${imageData.marker}${quote}${after}>`
			}
		)

		return {
			markdownText: replacedText,
			embeddedImages
		}
	},


	async withTimeout(taskFactory, timeoutMS, label = "任务") {
		let timeoutID = null;
		let timeoutPromise = new Promise((_, reject) => {
			timeoutID = setTimeout(() => {
				let error = new Error(`${label}超时（${Math.ceil(timeoutMS / 1000)}秒）`);
				error.name = "TimeoutError";
				error.code = "ETIMEDOUT";
				error.timeoutMS = timeoutMS;
				reject(error);
			}, timeoutMS);
		});
		try {
			return await Promise.race([
				Promise.resolve().then(taskFactory),
				timeoutPromise
			]);
		}
		finally {
			if (timeoutID !== null) {
				clearTimeout(timeoutID);
			}
		}
	},

	isTimeoutError(error) {
		return !!(error && (error.name === "TimeoutError" || error.code === "ETIMEDOUT"));
	},

	formatUserFacingError(error, fallbackMessage = "执行失败") {
		let message = error?.message || String(error || fallbackMessage)
		if (!message) return fallbackMessage
		if (this.isTimeoutError(error)) {
			return `${message}。可尝试减小“翻译并发请求数”或“翻译分段字符数”后重试。`
		}
		return message
	},

	buildChunkFailureMessage(failure) {
		let chunkLabel = `第 ${failure.chunkIndex + 1}/${failure.totalChunks} 段`
		let attemptsLabel = failure.attempts > 1 ? `（已尝试 ${failure.attempts} 次）` : ""
		return `${chunkLabel}${attemptsLabel}: ${this.formatUserFacingError(failure.error, "翻译失败")}`
	},

	buildFailedChunkSummary(failures, limit = 10) {
		return failures
			.slice(0, limit)
			.map((failure) => this.buildChunkFailureMessage(failure))
			.join("\n")
	},

	confirmRetryFailedChunks(window, { title, failures, autoRetryCount, completed = 0, total = failures.length }) {
		let prompt = Services.prompt;
		let flags = prompt.BUTTON_POS_0 * prompt.BUTTON_TITLE_IS_STRING |
			prompt.BUTTON_POS_1 * prompt.BUTTON_TITLE_IS_STRING;
		if (completed) flags |= prompt.BUTTON_POS_2 * prompt.BUTTON_TITLE_IS_STRING;
		let result = prompt.confirmEx(window || null, "AI 翻译部分失败",
			`${title}\n已完成 ${completed}/${total} 段，失败 ${failures.length} 段（已自动重试 ${autoRetryCount} 次）。\n\n${this.buildFailedChunkSummary(failures, 8)}`,
			flags, "重试失败段落", "放弃", completed ? "保存已完成译文" : null, null, {});
		return result === 0 ? "retry" : result === 2 && completed ? "save" : "discard";
	},


	guessImageExtension(mimeType, fileName = "") {
		let mime = String(mimeType || "").toLowerCase();
		if (mime === "image/png") return "png";
		if (mime === "image/jpeg") return "jpg";
		if (mime === "image/gif") return "gif";
		if (mime === "image/webp") return "webp";
		if (mime === "image/bmp") return "bmp";
		if (mime === "image/svg+xml") return "svg";
		if (mime === "image/tiff") return "tif";
		let name = this.fileNameFromPath(fileName);
		let dotIndex = name.lastIndexOf(".");
		if (dotIndex > 0 && dotIndex < name.length - 1) {
			return name.slice(dotIndex + 1).toLowerCase();
		}
		return "png";
	},

	escapeRegExp(value) {
		return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	},
		
	fileNameFromPath(path) {
		if (!path) return "file.pdf";
		let normalized = path.replace(/\\/g, "/");
		let index = normalized.lastIndexOf("/");
		return index >= 0 ? normalized.slice(index + 1) : normalized;
	},

	fileStemFromPath(path) {
		let fileName = this.fileNameFromPath(path || "");
		return String(fileName || "").replace(/\.[^.]+$/, "").trim();
	},

	getItemFileStem(item, fallback = "file") {
		let stem = this.fileStemFromPath(item?.getFilePath?.() || "");
		if (stem) return stem;
		let title = String(item?.getField?.("title") || "").trim().replace(/\.[^.]+$/, "");
		return title || fallback;
	},
	
	escapeHTML(input) {
		return String(input || "")
			.replaceAll("&", "&amp;")
			.replaceAll("<", "&lt;")
			.replaceAll(">", "&gt;")
			.replaceAll('"', "&quot;")
			.replaceAll("'", "&#39;");
	},
	
	async main() {
		this.log(`Loaded v${this.version}`);
	},


	getOutputSettings(prefix) {
		let read = name => this.getPref(this.PREF_BRANCH + prefix + name, true);
		let outputFormat = (prefix === "parse" ? read("GenerateHTML") === true : read("OutputFormat") === "html") ? "html" : "md";
		return {
			outputFormat,
			imageMode: prefix === "translate" ? (outputFormat === "html" ? "inline" : "folder") : (read("ImageMode") === "inline" ? "inline" : "folder"),
			translationMode: outputFormat === "html" && read("Mode") === "bilingual" ? "bilingual" : "translation"
		};
	},

	async readSourceMarkdown(attachment) {
		let filePath = await attachment.getFilePath();
		if (!filePath) throw new Error("全文附件文件不存在，请先在 Zotero 中下载或重新定位附件。");
		if (/\.html?$/i.test(filePath)) {
			filePath = filePath.replace(/\.html?$/i, ".md");
			if (!await IOUtils.exists(filePath)) {
				let candidates = (await IOUtils.getChildren(PathUtils.parent(filePath))).filter(path => /\.(md|markdown)$/i.test(path));
				if (candidates.length > 1) throw new Error("附件目录中有多个 Markdown，无法确定原文。请直接选择对应的 Markdown 附件。");
				if (candidates.length === 1) filePath = candidates[0];
				else throw new Error("OCR HTML 缺少配套的原始 Markdown，无法继续处理。请恢复附件目录中的配套 MD 文件，或选择原始文档重新执行“识别文档”。");
			}
		}
		if (!/\.(md|markdown)$/i.test(filePath)) throw new Error("请选择 Markdown 或 OCR 生成的 HTML 全文附件。");
		let bytes;
		try { bytes = await IOUtils.read(filePath); }
		catch (e) { throw new Error(`无法读取原始 Markdown：${filePath}。请确认附件已下载完整且 Markdown 文件仍在附件目录中。`); }
		let markdown = new TextDecoder("utf-8").decode(bytes);
		this.log(`Source Markdown: ${filePath}; characters: ${markdown.length}`);
		return { filePath, markdown };
	},

	decodeDocumentMarkdown(content, path = "") {
		if (!/\.html?$/i.test(path)) return content;
		let match = content.match(/<script type="application\/json" id="mineru-source">([\s\S]*?)<\/script>/);
		if (!match) throw new Error("HTML 附件缺少 MinerU 源文本，请重新解析");
		let source = JSON.parse(match[1]);
		if (typeof source.markdown !== "string") throw new Error("HTML 源文本无效");
		return source.markdown;
	},

	splitTranslationBlocks(text) {
		// Blank lines delimit prose, but never break fenced code or display math.
		let blocks = [], current = [], fence = null, math = false;
		let flush = () => { if (current.join("\n").trim()) blocks.push(current.join("\n")); current = []; };
		for (let line of text.replace(/\r\n?/g, "\n").split("\n")) {
			let marker = line.match(/^\s*(\x60{3,}|~{3,})/);
			if (marker && !math) {
				if (!fence) fence = marker[1];
				else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
				current.push(line);
				continue;
			}
			if (!fence) {
				let count = (line.match(/\$\$/g) || []).length;
				if (count % 2) math = !math;
				if (/^\s*\\\[\s*$/.test(line)) math = true;
				if (/^\s*\\\]\s*$/.test(line)) math = false;
			}
			if (!line.trim() && !fence && !math) flush();
			else current.push(line);
		}
		flush();
		return blocks;
	},

	normalizeEquationNumbers(text) {
		// Observed PDF/OCR corruption of parenthesized equation numbers only.
		let label = String.raw`ð\s*(?:\\?<|&lt;)sup(?:\\?>|&gt;)\s*(\d+)\s*(?:\\?<|&lt;)/sup(?:\\?>|&gt;)\s*Þ`;
		return String(text || "")
			.replace(new RegExp(String.raw`\\tag\s*\{\s*` + label + String.raw`\s*\}`, "g"), (_match, number) => `\\tag{${number}}`)
			.replace(new RegExp("^\\s*" + label + "\\s*$", "gm"), (_match, number) => `(${number})`);
	},

	renderDocumentBody(markdown) {
		let imageTokens = [];
		let token = (src, alt = "") => {
			if (!/^(images\/|data:image\/|https?:\/\/)/i.test(src)) throw new Error("不支持的图片引用：" + src.slice(0, 100));
			let key = "MINERUIMAGETOKEN" + imageTokens.length + "END";
			imageTokens.push({ key, html: '<img src="' + this.escapeHTML(src) + '" alt="' + this.escapeHTML(alt) + '">' });
			return key;
		};
		let source = markdown.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt, target) => token(this.parseMarkdownImageTarget(target).url, alt));
		source = source.replace(/<img\b[^>]*\bsrc=(["'])([^"']+)\1[^>]*>/gi, (_m, _q, src) => token(src));
		let html = this.convertMarkdownToBasicHTML(source);
		for (let image of imageTokens) html = html.split(image.key).join(image.html);
		return this.renderHTMLMath(html);
	},

	renderHTMLMath(html) {
		return html.replace(/<(span|pre) class="math">([\s\S]*?)<\/\1>/g, (_match, tag, encoded) => {
			if (!this.mathRenderer) {
				let scope = {};
				Services.scriptloader.loadSubScript(this.rootURI + "vendor/katex/katex.min.js", scope);
				this.mathRenderer = scope.katex;
			}
			let displayMode = tag === "pre";
			let tex = encoded.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
			tex = displayMode ? tex.slice(2, -2) : tex.slice(1, -1);
			tex = this.normalizeEquationNumbers(tex);
			let rendered = this.mathRenderer.renderToString(tex, { output: "mathml", displayMode, throwOnError: false, trust: false, maxExpand: 1000, maxSize: 20, strict: "ignore" });
			return displayMode ? '<div style="overflow-x:auto;margin:1em 0;padding:0.3em 0">' + rendered + '</div>' : rendered;
		});
	},

	async saveDocumentAttachment({ libraryID, parentItem, title, markdown, images = [], format = "md", imageMode = "folder", tag, pairs = null, keepMarkdown = false, notice = "" }) {
		if (format === "md") imageMode = "folder";
		let fileMap = new Map();
		let replaceImages = (text, mode = imageMode) => {
			let result = String(text || "");
			for (let [index, image] of images.entries()) {
				if (!image.bytes?.length) throw new Error("图片数据缺失：" + image.fileName);
				let name = "image-" + (index + 1) + "." + this.guessImageExtension(image.mimeType, image.fileName);
				let url = mode === "inline"
					? "data:" + image.mimeType + ";base64," + this.bytesToBase64(image.bytes)
					: "images/" + name;
				let markerPattern = new RegExp(this.escapeRegExp(image.marker) + "(?![0-9])", "g");
				if (markerPattern.test(result)) {
					markerPattern.lastIndex = 0;
					result = result.replace(markerPattern, () => url);
					if (mode !== "inline") fileMap.set(name, image.bytes);
				}
			}
			let validate = url => {
				if (!/^(images\/image-\d+\.[a-z0-9]+|data:image\/|https?:\/\/)/i.test(url)) throw new Error("图片未能读取：" + url.slice(0, 120));
				if (url.startsWith("images/") && !fileMap.has(url.slice(7))) throw new Error("图片数据缺失：" + url);
			};
			for (let match of result.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) validate(this.parseMarkdownImageTarget(match[1]).url);
			for (let match of result.matchAll(/<img\b[^>]*\bsrc=(["'])([^"']+)\1/gi)) validate(match[2]);
			return result;
		};
		let companionMarkdown = keepMarkdown && format === "html" ? replaceImages(markdown, "folder") : null;
		let source = replaceImages(markdown);
		let content = notice ? `> ${notice}\n\n${source}` : source;
		if (format === "html") {
			let counts = { source: new Map(), target: new Map(), document: new Map() };
			let render = (text, namespace) => this.renderFootnotes ? this.renderFootnotes(text, namespace, counts[namespace]) : this.renderDocumentBody(text);
			let body = pairs
				? '<div class="bilingual"><div class="column-label">原文</div><div class="column-label">译文</div>' + pairs.map(pair =>
					'<section data-block="' + this.escapeHTML(pair.id) + '" class="pair"><div>' + (pair.pages?.length ? '<small>PDF 第 ' + this.escapeHTML(pair.pages.join("、")) + ' 页</small>' : pair.page ? '<small>PDF 第 ' + pair.page + ' 页</small>' : '') + render(replaceImages(pair.source), "source") +
					'</div><div>' + render(replaceImages(pair.translated), "target") + '</div></section>').join("") + '</div>'
				: render(source, "document");
			let metadata = JSON.stringify({ markdown: source }).replace(/</g, "\\u003c");
			content = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
				'<title>' + this.escapeHTML(title) + '</title><style>body{font:16px/1.7 system-ui,sans-serif;max-width:1200px;margin:32px auto;padding:0 24px;color:#222}img{max-width:100%;height:auto}table{border-collapse:collapse;display:block;overflow:auto}td,th{border:1px solid #bbb;padding:6px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f5f5f5;padding:12px}.bilingual,.pair{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:20px}.pair{grid-column:1/-1;border-top:1px solid #ddd;padding:12px 0}.pair>div{min-width:0;overflow-wrap:anywhere}.column-label{font-weight:bold}</style></head><body>' +
				(notice ? '<p role="status">' + this.escapeHTML(notice) + '</p>' : '') + body + '<script type="application/json" id="mineru-source">' + metadata + '</script></body></html>';
		}
		let tempDir = PathUtils.join(PathUtils.tempDir, "docflow-output-" + Date.now() + "-" + Math.random().toString(36).slice(2));
		await IOUtils.makeDirectory(tempDir, { createAncestors: true });
		let imported = null;
		try {
			let path = PathUtils.join(tempDir, this.sanitizeFileName(title) + (format === "html" ? ".html" : ".md"));
			await IOUtils.writeUTF8(path, content);
			imported = await Zotero.Attachments.importFromFile({ file: path, libraryID, parentItemID: parentItem?.id,
				title, contentType: format === "html" ? "text/html" : "text/markdown", charset: "utf-8",
				saveOptions: {notifierData: {skipRenameFile: true}} });
			if (companionMarkdown !== null) {
				await IOUtils.writeUTF8((await imported.getFilePath()).replace(/\.html?$/i, ".md"), companionMarkdown);
			}
			if (fileMap.size) {
				let dir = PathUtils.join(PathUtils.parent(await imported.getFilePath()), "images");
				await IOUtils.makeDirectory(dir, { createAncestors: true });
				for (let [name, bytes] of fileMap) await IOUtils.write(PathUtils.join(dir, name), bytes);
			}
			imported.addTag(tag, 0);
			await imported.saveTx({notifierData: {skipRenameFile: true}});
			return imported;
		} catch (error) {
			if (imported) await imported.eraseTx().catch(e => this.log("清理未完成附件失败：" + e));
			throw error;
		} finally {
			await IOUtils.remove(tempDir, { recursive: true }).catch(() => {});
		}
	},

	aiOutputLimitError(payload, result) {
		let limit = payload.max_completion_tokens || payload.max_tokens;
		let usage = result.usage;
		let details = [limit ? `输出上限 ${limit} tokens` : "达到服务端输出上限"];
		if (usage?.completion_tokens) details.push(`已用 ${usage.completion_tokens} tokens`);
		if (usage?.completion_tokens_details?.reasoning_tokens) details.push(`其中推理 ${usage.completion_tokens_details.reasoning_tokens} tokens`);
		return new Error(`AI 输出被截断（${details.join("，")}）。请提高所选模型的“最大输出长度”；若“工作模型配置”中该工作的请求参数 JSON 已指定 max_tokens 或 max_completion_tokens，则需提高该参数，或缩短提示词要求的输出；确认模型支持该上限、上下文足够，保存后在队列中重试。`);
	},

	getLLMSettings(kind, selectedModel) {
		let apiBaseURL = (this.getPref(this.PREF_BRANCH + "llmApiBaseURL", true) || "").trim();
		apiBaseURL = apiBaseURL.replace(/\/+$/, "");
		let apiKey = (this.getPref(this.PREF_BRANCH + "llmApiKey", true) || "").trim();
		apiKey = apiKey.replace(/^Bearer\s+/i, "");
		let model = (this.getPref(this.PREF_BRANCH + "llmModel", true) || "").trim();
		let summaryLanguage = (this.getPref(this.PREF_BRANCH + "summaryLanguage", true) || "中文").trim();
		let summaryPrompt = (this.getPref(this.PREF_BRANCH + "summaryPrompt", true) || "").trim();
		let summaryRequestJSON = (this.getPref(this.PREF_BRANCH + "summaryRequestJSON", true) || "").trim();
		let translateLanguage = (this.getPref(this.PREF_BRANCH + "translateLanguage", true) || "中文").trim();
		let translateChunkSize = this.getPref(this.PREF_BRANCH + "translateChunkSize", true);
		if (!Number.isFinite(translateChunkSize) || translateChunkSize < 5000) translateChunkSize = 20000;
		let translateConcurrency = parseInt(this.getPref(this.PREF_BRANCH + "translateConcurrency", true), 10);
		if (!Number.isFinite(translateConcurrency) || translateConcurrency < 1) translateConcurrency = 3;
		if (translateConcurrency > 8) translateConcurrency = 8;
		let translateRetryCount = parseInt(this.getPref(this.PREF_BRANCH + "translateRetryCount", true), 10);
		if (!Number.isFinite(translateRetryCount) || translateRetryCount < 1) translateRetryCount = 2;
		if (translateRetryCount > 5) translateRetryCount = 5;
		let translateRequestJSON = (this.getPref(this.PREF_BRANCH + "translateRequestJSON", true) || "").trim();
		let settings = {
			apiBaseURL,
			apiKey,
			model,
			...this.getOutputSettings("translate"),
			summaryLanguage,
			summaryPrompt,
			summaryRequestJSON,
			translateLanguage,
			translateChunkSize,
			translateConcurrency,
			translateRetryCount,
			translateRequestJSON
		};
		let savedProviders = this.getPref(this.PREF_BRANCH + "llmProviders", true);
		let providers = savedProviders ? JSON.parse(savedProviders) : [];
		let work = JSON.parse(this.getPref(this.PREF_BRANCH + "aiWorkSettings", true) || "{}");
		let index = this.getPref(this.PREF_BRANCH + "llmProviderIndex", true) || 0;
		let selected = work.defaultModel || `${providers[index]?.id || "provider-" + index}:1`;
		let config = kind ? work[kind] || {} : {};
		let modelConcurrency = 1, modelContext = 32768, modelOutput = 0;
		if (config.model && config.model !== "default") selected = config.model;
		if (selectedModel) selected = selectedModel;
		settings.modelID = selected;
		if (providers.length) {
			let split = selected.lastIndexOf(":"), id = selected.slice(0, split), slot = selected.slice(split + 1);
			let provider = providers.find((p, i) => (p.id || "provider-" + i) === id);
			if (!provider || !["1", "2"].includes(slot)) throw new Error("工作使用的服务商配置不存在，请重新选择工作模型。");
			settings.apiBaseURL = (provider.llmApiBaseURL || "").trim().replace(/\/+$/, "");
			settings.apiKey = (provider.llmApiKey || "").trim().replace(/^Bearer\s+/i, "");
			settings.model = (provider[slot === "2" ? "llmModel2" : "llmModel"] || "").trim();
			settings.providerName = provider.llmProviderName || "未命名配置";
			modelConcurrency = Number(provider[slot === "2" ? "llmModel2Concurrency" : "llmModelConcurrency"]) || 1;
			modelContext = Number(provider[slot === "2" ? "llmModel2Context" : "llmModelContext"]) || 32768;
			modelOutput = Number(provider[slot === "2" ? "llmModel2MaxOutput" : "llmModelMaxOutput"]) || 0;
			settings.summaryRequestJSON = provider.summaryRequestJSON || "";
			settings.translateRequestJSON = provider.translateRequestJSON || "";
		}
		if (kind) {
			settings.workKind = kind;
			settings.workPrompt = (config.prompt ?? (kind === "summary" ? summaryPrompt : "")).trim();
			settings.concurrency = modelConcurrency;
			settings.contextWindow = modelContext;
			settings.outputTokens = modelOutput;
			let legacyParams = kind === "summary" ? settings.summaryRequestJSON : kind === "translate" ? settings.translateRequestJSON : "";
			settings.summaryRequestJSON = (config.params ?? legacyParams ?? "").trim();
			if (kind === "translate") {
				settings.translateConcurrency = settings.concurrency;
				settings.translateRequestJSON = settings.summaryRequestJSON;
			}
		}
		return settings;
	},

	parseOptionalJSONObject(rawValue, fieldLabel) {
		let normalized = String(rawValue || "").trim();
		if (!normalized) return {};
		let parsed;
		try {
			parsed = JSON.parse(normalized);
		}
		catch (e) {
			throw new Error(`${fieldLabel} 不是合法 JSON：${e.message || e}`);
		}
		if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
			throw new Error(`${fieldLabel} 必须是 JSON 对象`);
		}
		return parsed;
	},

	mergeRequestPayload(basePayload, extraPayload, reservedKeys = []) {
		let mergedPayload = { ...basePayload };
		if (!extraPayload || typeof extraPayload !== "object") {
			return mergedPayload;
		}
		for (let [key, value] of Object.entries(extraPayload)) {
			if (reservedKeys.includes(key)) {
				throw new Error(`翻译额外 JSON 参数不能覆盖保留字段：${reservedKeys.join(", ")}`);
			}
			mergedPayload[key] = value;
		}
		return mergedPayload;
	},


	collectTranslateTasks(selectedItems) {
		let tasks = []
		let seenParentIDs = new Set()
		// An explicitly selected parse attachment takes priority over its parent selection.
		let selectedSources = new Map()
		for (let item of selectedItems) {
			if (this.isMarkdownResult(item) && item.parentItemID) {
				if (!selectedSources.has(item.parentItemID)) selectedSources.set(item.parentItemID, item)
			}
		}
		for (let item of selectedItems) {
			let parentItem = null
			if (item.isNote()) {
				let pid = item.parentItemID
				parentItem = pid ? Zotero.Items.get(pid) : null
			} else if (item.isRegularItem()) {
				parentItem = item
			} else if (item.isAttachment()) {
				let pid = item.parentItemID
				parentItem = pid ? Zotero.Items.get(pid) : null
			}
			if (!parentItem || !parentItem.isRegularItem()) continue
			if (seenParentIDs.has(parentItem.id)) continue
			seenParentIDs.add(parentItem.id)

			let mineruSource = selectedSources.get(parentItem.id) || null

			// Use the same full-text types as the document sidebar.
			let attachmentIDs = parentItem.getAttachments()
			for (let attachmentID of attachmentIDs) {
				if (mineruSource) break
				let attachmentItem = Zotero.Items.get(attachmentID)
				if (!attachmentItem) continue
				if (this.isMarkdownResult(attachmentItem)) {
					mineruSource = attachmentItem
					break
				}
			}

			if (mineruSource) {
				let hasTranslation = this.parentHasAttachmentWithTag(parentItem, "#DocFlow-Translation")
				if (!hasTranslation) {
					tasks.push({ parentItem, mineruSource })
				}
			}
		}
		return tasks
	},

	getTranslationSettings() {
		let settings = this.getLLMSettings("translate");
		if (!settings.apiBaseURL || !settings.model) throw new Error("请先在 OCRFlow 设置中填写 AI 接口地址和模型；本地免密服务的 Key 可留空。");
		settings.translateRequestParams = this.parseOptionalJSONObject(settings.translateRequestJSON, "翻译额外 JSON 参数");
		return settings;
	},

	async handleTranslateCommand({ window = null, selectedItems = null } = {}) {
		let settings = this.getTranslationSettings();
		let items = selectedItems || window?.ZoteroPane?.getSelectedItems?.() || [];
		let tasks = this.collectTranslateTasks(items).map(task => ({ ...task, attachment: task.mineruSource,
			title: task.parentItem.getField("title") || task.mineruSource.getField("title") }));
		if (!tasks.length) throw new Error("请选择包含可翻译 Markdown 的条目或全文附件；已有完整译文的条目会被跳过。");
		await this.enqueueDocumentTasks("translate", tasks, settings);
	},

	async runTranslationTask(task) {
		if (this.runAlignedTranslationTask) return this.runAlignedTranslationTask(task);
		let settings = task.settings, signal = task.controller.signal;
		let language = settings.translateLanguage || "中文", chunkSize = settings.translateChunkSize || 20000;
		let chunkBudget = settings.workKind ? this.getAIChunkBudget(settings) : undefined;
		if (chunkBudget) chunkSize = Math.min(chunkSize, chunkBudget);
		let concurrency = settings.translateConcurrency || 3, retryCount = settings.translateRetryCount ?? 2;
		let status = text => { signal.throwIfAborted(); task.detail = text; this.refreshParseQueueDialog(); };
		if (!task.translation || task.translation.language !== language || task.translation.chunkSize !== chunkSize || task.translation.chunkBudget !== chunkBudget) {
			status("读取 Markdown");
			let { filePath, markdown } = await this.readSourceMarkdown(task.mineruSource);
			let source = await this.inlineStoredImagesInMarkdownAttachment({ markdownText: markdown, markdownPath: filePath });
			signal.throwIfAborted();
			if (!source.markdownText.trim()) throw new Error("Markdown 内容为空");
			let chunks = this.splitMarkdownIntoChunks(source.markdownText, chunkSize);
			if (settings.workKind) chunks = chunks.flatMap(chunk => this.splitAIText(chunk, settings, chunkSize));
			task.translation = { language, chunkSize, chunkBudget, chunks, parts: Array(chunks.length).fill(null), images: source.embeddedImages };
		}
		let data = task.translation, { chunks, parts } = data;
		let pending = parts.map((part, index) => typeof part === "string" && part.trim() ? null : index).filter(index => index !== null);
		let retryRound = 0, activeConcurrency = Math.min(concurrency, chunks.length);
		while (pending.length && !data.partial) {
			status(`翻译 ${parts.filter(part => typeof part === "string" && part.trim()).length}/${chunks.length} 段，并发 ${activeConcurrency}`);
			let result = await this.translateChunksWithConcurrency({
				chunks, chunkIndexes: pending, concurrency: activeConcurrency, autoRetryCount: retryCount, signal,
				translateChunk: async (chunk, index, total) => {
					let translated = await this.callLLMForTranslation(chunk, language, settings, index + 1, total, signal);
					signal.throwIfAborted(); parts[index] = translated; return translated;
				},
				onProgress: ({ completed, total, failures }) => status(`翻译 ${parts.filter(part => typeof part === "string" && part.trim()).length}/${chunks.length} 段；本轮已处理 ${completed}/${total}，失败 ${failures} 段`)
			});
			signal.throwIfAborted();
			if (!result.failures.length) break;
			status("等待确认：重试失败段落、放弃或保存部分译文");
			let action = this.confirmRetryFailedChunks(this.parseQueueWindow || Zotero.getMainWindow(), {
				title: task.title, failures: result.failures, retryRound: ++retryRound, autoRetryCount: retryCount,
				completed: parts.filter(part => typeof part === "string" && part.trim()).length, total: chunks.length
			});
			signal.throwIfAborted();
			if (action === "save") { data.partial = true; break; }
			if (action !== "retry") throw new Error(this.buildFailedChunkSummary(result.failures, 10) || "部分段落翻译失败");
			pending = result.failures.map(failure => failure.chunkIndex);
		}
		if (!data.partial && parts.some(part => typeof part !== "string" || !part.trim())) throw new Error("仍有未完成段落，无法合成完整译文。");
		if (this.parseQueueStopped) throw new Error("翻译已停止，未保存附件。");
		status("保存翻译附件");
		task.saving = true;
		let completed = parts.filter(part => typeof part === "string" && part.trim()).length;
		let bilingual = settings.outputFormat === "html" && settings.translationMode === "bilingual";
		await this.saveTranslationAsMarkdownAttachment({
			parentItem: task.parentItem, sourceAttachment: task.mineruSource,
			translatedText: chunks.map((source, index) => parts[index] || `> 未翻译\n\n${source}`).join("\n\n"),
			images: data.images, settings, language,
			pairs: bilingual ? chunks.map((source, index) => ({ id: `block-${index + 1}`, source, translated: parts[index] || "**未翻译**" })) : null,
			partial: data.partial ? { completed, total: chunks.length } : null
		});
		return data.partial ? `已保存部分译文 ${completed}/${chunks.length} 段` : "翻译附件已保存";
	},

	splitMarkdownIntoChunks(text, chunkSize) {
		let chunks = [], current = "";
		for (let block of this.splitTranslationBlocks(text)) {
			if (current && current.length + block.length + 2 > chunkSize) {
				chunks.push(current);
				current = "";
			}
			current += (current ? "\n\n" : "") + block;
		}
		if (current) chunks.push(current);
		return chunks;
	},

	async translateChunkWithRetry({ chunkText, chunkIndex, totalChunks, autoRetryCount, translateChunk, signal }) {
		let maxAttempts = Math.max(autoRetryCount || 0, 0) + 1
		let lastError = null
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			signal?.throwIfAborted();
			try {
				let translated = await translateChunk(chunkText, chunkIndex, totalChunks)
				return {
					ok: true,
					chunkIndex,
					totalChunks,
					attempts: attempt,
					translated
				}
			} catch (e) {
				signal?.throwIfAborted();
				lastError = e
				Zotero.logError(e)
			}
		}
		return {
			ok: false,
			chunkIndex,
			totalChunks,
			attempts: maxAttempts,
			error: lastError || new Error("翻译失败")
		}
	},

	async translateChunksWithConcurrency({ chunks, chunkIndexes = null, concurrency, autoRetryCount, translateChunk, onProgress = null, signal }) {
		if (!Array.isArray(chunks) || !chunks.length) {
			return { successes: new Map(), failures: [] }
		}

		let targets = Array.isArray(chunkIndexes) && chunkIndexes.length
			? [...chunkIndexes]
			: chunks.map((_chunk, index) => index)
		let successes = new Map()
		let failures = []
		let nextIndex = 0
		let completed = 0
		let workerCount = Math.min(Math.max(concurrency || 1, 1), targets.length)

		let worker = async () => {
			while (true) {
				signal?.throwIfAborted();
				let currentTargetIndex = nextIndex++
				if (currentTargetIndex >= targets.length) return
				let chunkIndex = targets[currentTargetIndex]
				let result = await this.translateChunkWithRetry({
					chunkText: chunks[chunkIndex],
					chunkIndex,
					totalChunks: chunks.length,
					autoRetryCount,
					translateChunk, signal
				})
				signal?.throwIfAborted();
				if (result.ok) {
					successes.set(chunkIndex, result.translated)
				} else {
					failures.push(result)
				}
				completed++
				if (typeof onProgress === "function") {
					onProgress({
						completed,
						total: targets.length,
						chunkIndex,
						successes: successes.size,
						failures: failures.length
					})
				}
			}
		}

		let results = await Promise.allSettled(Array.from({ length: workerCount }, () => worker()));
		signal?.throwIfAborted();
		for (let result of results) if (result.status === "rejected") throw result.reason;
		failures.sort((a, b) => a.chunkIndex - b.chunkIndex)
		return { successes, failures }
	},

	prepareTranslationText(text) {
		// Keep complete image syntax locally, including reference definitions and legacy markers.
		let pattern = /!\[[^\]]*\]\((?:[^()\n]|\([^()]*\))*\)|!\[[^\]]*\]\[[^\]]*\]|<img\b[^>]*>|^\s{0,3}\[[^\]]+\]:\s*(?:docflow-image:\/\/|data:image\/)[^\n]*|docflow-image:\/\/img-\d+/gim;
		let parts = [], texts = [], cursor = 0;
		let addText = value => {
			if (!value.trim()) { parts.push({ literal: value }); return; }
			let leading = value.match(/^\s*/)[0], trailing = value.match(/\s*$/)[0];
			parts.push({ index: texts.length, leading, trailing });
			texts.push(value.trim());
		};
		for (let match of text.matchAll(pattern)) {
			addText(text.slice(cursor, match.index));
			parts.push({ literal: match[0] });
			cursor = match.index + match[0].length;
		}
		addText(text.slice(cursor));
		return { parts, texts, hasImages: cursor > 0 };
	},

	async callLLMForTranslation(text, language, llmSettings, chunkIndex, totalChunks, signal) {
		signal?.throwIfAborted();
		let prepared = this.prepareTranslationText(text);
		if (!prepared.texts.length) return text;
		let batch = prepared.hasImages;
		let requestText = batch ? JSON.stringify(prepared.texts) : text;
		if (/data:[^\s<>]*;base64,|docflow-image:\/\//i.test(requestText)) {
			throw new Error("图片未能隔离，已阻止发送翻译请求");
		}
		let url = `${llmSettings.apiBaseURL}/chat/completions`

		let chunkHint = totalChunks > 1
			? `\n\nNote: This is part ${chunkIndex} of ${totalChunks}. Translate only this part, maintaining continuity.`
			: ""

		let systemPrompt = OCRFlowPrompts.get("translate", llmSettings.workPrompt, language) + chunkHint;

		if (batch) systemPrompt += "\nThe input is a JSON array of Markdown text fragments. Translate each fragment independently. Return only a JSON array of translated Markdown strings in exactly the same order and count. Do not merge fragments or add image references.";

		let payload = {
			model: llmSettings.model,
			messages: [
				{ role: "system", content: systemPrompt },
				{ role: "user", content: requestText }
			],
			temperature: 0.3
		}
		payload = this.mergeRequestPayload(
			payload,
			llmSettings.translateRequestParams,
			["model", "messages"]
		)

		this.applyAIContextBudget(payload, llmSettings);
		let controller = this.createAbortController();
		let abort = () => controller.abort();
		signal?.addEventListener("abort", abort, { once: true });
		let doFetch = async () => {
			let response = await fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...(llmSettings.apiKey ? { "Authorization": `Bearer ${llmSettings.apiKey}` } : {})
				},
				body: JSON.stringify(payload), signal: controller.signal
			})

			if (!response.ok) {
				let errText = await response.text()
				throw new Error(`LLM API 请求失败 ${response.status}: ${errText.slice(0, 500)}`)
			}

			let result = await response.json()
			if (result?.choices?.[0]?.finish_reason === "length") throw this.aiOutputLimitError(payload, result);
			let content = result?.choices?.[0]?.message?.content
			if (!content || !content.trim()) {
				throw new Error("LLM 返回内容为空")
			}
			if (/data:[^\s<>]*;base64,|docflow-image:\/\//i.test(content)) throw new Error("翻译返回了图片数据或标识，正文不应包含图片");
			if (!batch) return content.trim();
			let translated;
			try { translated = JSON.parse(content.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i, "$1")); }
			catch (e) { throw new Error("翻译文字分片返回格式无效，请重试"); }
			if (!Array.isArray(translated) || translated.length !== prepared.texts.length ||
				translated.some(value => typeof value !== "string" || !value.trim())) {
				throw new Error("翻译文字分片数量或内容无效，请重试");
			}
			return prepared.parts.map(part => part.literal !== undefined ? part.literal :
				part.leading + translated[part.index].trim() + part.trailing).join("");
		}

		try { return await this.withTimeout(doFetch, 180000, "LLM 翻译请求"); }
		catch (error) { controller.abort(); throw error; }
		finally { signal?.removeEventListener("abort", abort); }
	},

	async saveTranslationAsMarkdownAttachment({ parentItem, sourceAttachment, translatedText, language, images, settings, pairs, translationData, partial = null }) {
		let imported = await this.saveDocumentAttachment({
			libraryID: parentItem.libraryID, parentItem,
			title: `${partial ? `[未完成 ${partial.completed}/${partial.total}] ` : ""}Translation (${language}) - ${this.getItemFileStem(sourceAttachment, "document")}`,
			markdown: translatedText, images, pairs,
			format: settings.outputFormat, imageMode: settings.outputFormat === "html" ? "inline" : "folder", tag: partial ? "#DocFlow-Translation-Partial" : "#DocFlow-Translation",
			notice: partial ? `未完成：已翻译 ${partial.completed}/${partial.total} 段；标注“未翻译”的位置保留原文。` : ""
		});
		if (translationData) {
			let root = PathUtils.join(PathUtils.parent(await imported.getFilePath()), "_ocrflow");
			try {
				await IOUtils.makeDirectory(root, { createAncestors: true });
				await IOUtils.writeUTF8(PathUtils.join(root, "translation.json"), JSON.stringify({ sourceKey: sourceAttachment.key, language,
					resources: (images || []).map(image => ({ marker: image.marker, sourceFileName: image.fileName })), pairs: translationData }));
			} catch (error) { await imported.eraseTx(); throw error; }
		}
		return imported;
	}
};
