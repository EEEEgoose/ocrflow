// Title translation uses bibliographic items directly; OCR results are not required.
Object.assign(DocFlow, {
	getTitleTranslationSettings(overrides = {}) {
		let read = name => this.getPref(this.PREF_BRANCH + name, true);
		let settings = {
			service: read("titleService") || "ai", targetLang: read("titleLanguage") || "ZH",
			overwrite: read("titleOverwrite") === true, deeplPlan: read("deeplPlan") || "free",
			deeplApiKey: read("deeplApiKey") || "", deeplxEndpoint: read("deeplxEndpoint") || "", deeplxToken: read("deeplxToken") || "", ...overrides
		};
		settings.targetLang = settings.targetLang.trim().toUpperCase();
		if (!["ai", "deepl", "deeplx"].includes(settings.service)) throw new Error("请选择有效的标题翻译服务。");
		if (!settings.targetLang) throw new Error("请指定标题翻译的目标语言。");
		if (settings.service === "ai") {
			settings.aiSettings = this.getLLMSettings("title", settings.modelID);
			settings.modelID = settings.aiSettings.modelID;
			settings.concurrency = settings.aiSettings.concurrency;
		}
		return settings;
	},

	collectTitleTasks(items) {
		let parents = new Map();
		for (let item of items) {
			if (!item.isRegularItem?.() && !item.isAttachment?.()) continue;
			let parent = this.parentForDocument(item);
			if (parent?.isRegularItem?.() && !parent.deleted) parents.set(parent.id, { attachment: parent, parentItem: parent });
		}
		return [...parents.values()];
	},

	async handleTitleTranslation({ window = null, selectedItems = null, options } = {}) {
		let items = selectedItems || window?.ZoteroPane?.getSelectedItems?.() || [];
		let tasks = this.collectTitleTasks(items);
		if (!tasks.length) throw new Error("请选择父条目或其附件；独立文件请先建立父条目。");

		await this.enqueueDocumentTasks("title", tasks, this.getTitleTranslationSettings(options));
	},

	titleTranslationServiceLabel(settings) {
		return settings.service === "ai" ? [settings.aiSettings?.providerName, settings.aiSettings?.model].filter(Boolean).join(" + ") || "AI"
			: settings.service === "deepl" ? `DeepL API ${settings.deeplPlan === "pro" ? "Pro" : "Free"}` : "DeepLX";
	},

	async translateTitleText(text, settings, signal) {
		if (settings.service !== "ai") return (await OCRFlowTitleServices.translate(text, settings, signal)).text;
		let ai = this.validateAISettings(settings.aiSettings);
		return this.requestDocumentAI([{ role: "system", content: OCRFlowPrompts.get("title", ai.workPrompt, settings.targetLang) }, { role: "user", content: text }], ai, signal);
	},

	async runTitleTranslation(task) {
		let parent = Zotero.Items.get(task.attachment.id), settings = task.settings, signal = task.controller.signal;
		if (!parent || parent.deleted) throw new Error("父条目已删除。");
		await parent.loadAllData(); signal.throwIfAborted();
		if (!Zotero.ItemFields.isValidForType("shortTitle", parent.itemTypeID)) throw new Error("此条目类型不支持短标题。");
		let source = parent.getField("title").trim();
		if (!source) return "标题为空，已跳过";
		if (parent.getField("shortTitle").trim() && !settings.overwrite) return "已有短标题，已保留；如需替换请勾选覆盖";
		task.detail = `翻译标题 → ${settings.targetLang}`; this.refreshParseQueueDialog();
		let text = await this.translateTitleText(source, settings, signal);
		signal.throwIfAborted();
		if (typeof text !== "string" || !text.trim()) throw new Error("标题翻译返回空值，未修改短标题。");
		if (parent.getField("title").trim() !== source) throw new Error("原题名在翻译期间发生变化，请重试。");
		if (parent.getField("shortTitle").trim() && !settings.overwrite) return "短标题已更新，已保留现有内容";
		task.saving = true;
		this.setTaskStep?.(task, "work", "翻译标题", text.trim(), "completed");
		this.setTaskStep?.(task, "save", "写入短标题", "保留原题名");
		let previous = parent.getField("shortTitle");
		try {
			await Zotero.DB.executeTransaction(async () => {
				parent.setField("shortTitle", text.trim());
				await parent.save({ notifierData: { skipRenameFile: true } });
			});
		} catch (error) { parent.setField("shortTitle", previous); throw error; }
		task.titleTranslation = { source, targetLang: settings.targetLang, service: settings.service, text: text.trim() };
		task.resultAttachment = parent;
		return `已写入短标题（${settings.targetLang}）：${text.trim()}`;
	}
});
