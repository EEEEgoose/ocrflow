var DocFlowPreferences = {
	PREF_BRANCH: "extensions.docflow.",
	initialized: false,
	loadedAPIMode: null,
	API_FIELDS: ["apiBaseURL", "apiToken", "modelVersion", "pollIntervalSec", "timeoutSec"],
	LLM_PROVIDER_LIMIT: 5,
	LLM_PROVIDER_FIELDS: ["llmProviderName", "llmApiBaseURL", "llmApiKey", "llmModel", "llmModel2", "llmModelContext", "llmModelConcurrency", "llmModel2Context", "llmModel2Concurrency"],
	llmProviders: null,
	WORK_KINDS: ["parent", "metadata", "summary", "ocr", "translate"],
	workSettings: {},
	loadedLLMProviderIndex: 0,
	modelTests: {},

	FIELDS: [
		{ id: "docflow-parser-service", pref: "parserService", type: "string", defaultValue: "mineru" },
		{ id: "docflow-markitdown-url", pref: "markitdownBaseURL", type: "string" },
		{ id: "mineru-auto-outline", pref: "autoOutline", type: "bool", defaultValue: false },
		{ id: "mineru-outline-use-ai", pref: "outlineUseAI", type: "bool", defaultValue: true },
		{ id: "mineru-parseLinkSourcePDF", pref: "parseLinkSourcePDF", type: "bool", defaultValue: true },
		{ id: "mineru-parseGenerateHTML", pref: "parseGenerateHTML", type: "bool", defaultValue: true },
		{ id: "mineru-parseImageMode", pref: "parseImageMode", type: "string" },
		{ id: "mineru-translateOutputFormat", pref: "translateOutputFormat", type: "string" },
		{ id: "mineru-translateMode", pref: "translateMode", type: "string" },
		{ id: "mineru-api-base-url", pref: "apiBaseURL", type: "string" },
		{ id: "mineru-api-mode", pref: "apiMode", type: "string" },
		{ id: "mineru-api-token", pref: "apiToken", type: "string" },
		{ id: "mineru-model-version", pref: "modelVersion", type: "string" },
		{ id: "mineru-cloud-language", pref: "cloudLanguage", type: "string", defaultValue: "auto" },
		{ id: "mineru-note-include-images", pref: "noteIncludeImages", type: "bool" },
		{ id: "mineru-poll-interval-sec", pref: "pollIntervalSec", type: "int" },
		{ id: "mineru-timeout-sec", pref: "timeoutSec", type: "int" },
		{ id: "mineru-local-job-timeout-sec", pref: "localJobTimeoutSec", type: "int", defaultValue: 7200 },
		{ id: "mineru-note-title-prefix", pref: "noteTitlePrefix", type: "string" },
		{ id: "mineru-llm-provider-name", pref: "llmProviderName", type: "string", defaultValue: "供应商 1" },
		{ id: "mineru-llm-api-base-url", pref: "llmApiBaseURL", type: "string" },
		{ id: "mineru-llm-api-key", pref: "llmApiKey", type: "string" },
		{ id: "mineru-llm-model", pref: "llmModel", type: "string" },
		{ id: "mineru-llm-model-2", pref: "llmModel2", type: "string" },
		{ id: "ocrflow-model-1-context", pref: "llmModelContext", type: "context" },
		{ id: "ocrflow-model-1-concurrency", pref: "llmModelConcurrency", type: "optional-int", min: 1, max: 8 },
		{ id: "ocrflow-model-2-context", pref: "llmModel2Context", type: "context" },
		{ id: "ocrflow-model-2-concurrency", pref: "llmModel2Concurrency", type: "optional-int", min: 1, max: 8 },
		{ id: "mineru-summary-language", pref: "summaryLanguage", type: "string" },
		{ id: "mineru-summary-prompt", pref: "summaryPrompt", type: "string" },
		{ id: "mineru-summary-request-json", pref: "summaryRequestJSON", type: "string" },
		{ id: "mineru-translate-language", pref: "translateLanguage", type: "string" },
		{ id: "mineru-translate-chunk-size", pref: "translateChunkSize", type: "int" },
		{ id: "mineru-translate-retry-count", pref: "translateRetryCount", type: "int" },
		{ id: "mineru-translate-request-json", pref: "translateRequestJSON", type: "string" }
	],

	$(id) {
		return document.getElementById(id);
	},

	setOutput(message, section = "ai") {
		let output = this.$(`ocrflow-${section}-output`);
		if (!output) return;
		output.textContent = message || "";
		output.hidden = !message;
	},

	setStatus(message, isError = false, section = "all") {
		let status = this.$(section === "all" ? "mineru-status" : `ocrflow-${section}-status`);
		if (!status) return;
		status.textContent = message || "";
		status.setAttribute("data-state", isError ? "error" : message === "有未保存的修改" ? "changed" : "saved");
	},

	sectionForField(name) {
		if (name === "markitdownBaseURL") return "markitdown";
		if (this.API_FIELDS.includes(name) || ["apiMode", "localJobTimeoutSec", "cloudLanguage"].includes(name)) return "mineru";
		if (this.LLM_PROVIDER_FIELDS.includes(name)) return "ai";
		if (["summaryPrompt", "summaryRequestJSON", "translateRequestJSON"].includes(name)) return "work";
		return "all";
	},

	loadAPISettings(apiMode) {
		this.loadedAPIMode = apiMode;
		this.syncParseOptions(apiMode);
		for (let name of [...this.API_FIELDS, "apiMode"]) {
			let field = this.FIELDS.find(field => field.pref === name);
			let value = name === "apiMode" ? apiMode : this.readAPIPref(name, apiMode);
			if (name === "modelVersion") value = this.normalizeModelVersion(value, apiMode);
			this.$(field.id).value = String(value ?? "");
		}
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
				throw new Error(`额外 JSON 参数不能覆盖保留字段：${reservedKeys.join(", ")}`);
			}
			mergedPayload[key] = value;
		}
		return mergedPayload;
	},

	readAPIPref(name, mode = Zotero.Prefs.get(this.PREF_BRANCH + "apiMode", true) || "cloud") {
		let profile = mode === "local-v1" ? "local" : "cloud";
		let value = Zotero.Prefs.get(this.PREF_BRANCH + profile + "." + name, true);
		if (value !== undefined && value !== null) return value;
		let currentMode = Zotero.Prefs.get(this.PREF_BRANCH + "apiMode", true) || "cloud";
		if (mode === currentMode) {
			value = Zotero.Prefs.get(this.PREF_BRANCH + name, true);
			if (name === "apiToken" && !value) value = Zotero.Prefs.get(this.PREF_BRANCH + "apiKey", true);
			if (value !== undefined && value !== null) return value;
		}
		return {
			apiBaseURL: mode === "local-v1" ? "http://127.0.0.1:8000" : "https://mineru.net/api/v4",
			apiToken: "", modelVersion: mode === "local-v1" ? "basic" : "pipeline", pollIntervalSec: 5, timeoutSec: 120
		}[name];
	},

	normalizeModelVersion(value, apiMode) {
		if (apiMode === "local-v1") {
			value = { pipeline: "basic", vlm: "advanced" }[value] || value;
			return ["flash", "basic", "standard", "advanced"].includes(value) ? value : "basic";
		}
		return ["pipeline", "vlm"].includes(value) ? value : "pipeline";
	},

	syncParseOptions(apiMode) {
		let input = this.$("mineru-model-version");
		for (let option of input.querySelectorAll("menuitem")) {
			option.hidden = option.getAttribute("data-api-mode") !== apiMode;
		}
		this.$("mineru-model-version-label").textContent = apiMode === "local-v1" ? "解析档位" : "模型版本";
		this.$("mineru-cloud-language").disabled = apiMode !== "cloud";
		this.$("mineru-cloud-language-help").textContent = apiMode === "cloud"
			? "自动读取父条目语言；为空或无法识别时使用云端默认值。手动选择不会改写条目语言。"
			: "识别语言仅适用于官方云端，本地 V1 不接收该参数。云端选择会保留。";
	},

	switchAPIMode() {
		let input = this.$("mineru-api-mode");
		let nextMode = input.value;
		if (nextMode === this.loadedAPIMode) return;
		if (!this.saveSettings({ silent: true, section: "mineru" })) {
			input.value = this.loadedAPIMode;
			this.setStatus("请先修正连接参数，再切换接口。", true, "mineru");
			return;
		}
		this.loadAPISettings(nextMode);
		Zotero.Prefs.set(this.PREF_BRANCH + "apiMode", nextMode, true);
		this.setStatus("已切换接口", false, "mineru");
	},

	loadLLMProviders() {
		let saved = Zotero.Prefs.get(this.PREF_BRANCH + "llmProviders", true);
		this.llmProviders = saved ? JSON.parse(saved) : [Object.fromEntries(
			[...this.LLM_PROVIDER_FIELDS, "summaryRequestJSON", "translateRequestJSON"].map(name => [name, Zotero.Prefs.get(this.PREF_BRANCH + name, true) || ""])
		)];
		this.loadedLLMProviderIndex = Zotero.Prefs.get(this.PREF_BRANCH + "llmProviderIndex", true) || 0;
		this.llmProviders.forEach((provider, index) => { provider.id ||= "provider-" + index; });
		let savedWork = Zotero.Prefs.get(this.PREF_BRANCH + "aiWorkSettings", true);
		this.workSettings = savedWork ? JSON.parse(savedWork) : {};
		if (!this.workSettings.defaultModel) {
			this.workSettings.defaultModel = this.llmProviders[this.loadedLLMProviderIndex].id + ":1";
			Zotero.Prefs.set(this.PREF_BRANCH + "aiWorkSettings", JSON.stringify(this.workSettings), true);
		}
		this.loadLLMProvider();
		this.loadWorkSettings();
	},

	loadLLMProvider() {
		for (let slot of [1, 2]) this.resetModelTest(slot);
		let provider = this.llmProviders[this.loadedLLMProviderIndex];
		for (let field of this.FIELDS.filter(field => this.LLM_PROVIDER_FIELDS.includes(field.pref))) {
			let value = provider[field.pref] || "";
			this.$(field.id).value = field.type === "context" && value ? this.formatContextTokens(Number(value)) : String(value);
		}
		this.persistLLMProviders();
		this.renderLLMProviders();
	},

	persistLLMProviders() {
		Zotero.Prefs.set(this.PREF_BRANCH + "llmProviders", JSON.stringify(this.llmProviders), true);
		Zotero.Prefs.set(this.PREF_BRANCH + "llmProviderIndex", this.loadedLLMProviderIndex, true);
	},

	saveLLMProvider() {
		this.llmProviders[this.loadedLLMProviderIndex] = { ...this.llmProviders[this.loadedLLMProviderIndex], ...Object.fromEntries(
			this.LLM_PROVIDER_FIELDS.map(name => [name, Zotero.Prefs.get(this.PREF_BRANCH + name, true) || ""])
		) };
		this.persistLLMProviders();
		this.renderLLMProviders();
	},

	renderLLMProviders() {
		for (let index = 0; index < this.LLM_PROVIDER_LIMIT; index++) {
			let button = this.$("mineru-llm-provider-" + index);
			let provider = this.llmProviders[index];
			button.hidden = !provider;
			button.textContent = provider?.llmProviderName || `供应商 ${index + 1}`;
			button.setAttribute("aria-pressed", String(index === this.loadedLLMProviderIndex));
		}
		this.$("mineru-llm-provider-count").textContent = `${this.llmProviders.length}/${this.LLM_PROVIDER_LIMIT}`;
		this.$("mineru-llm-provider-add").disabled = this.llmProviders.length >= this.LLM_PROVIDER_LIMIT;
		this.$("mineru-llm-provider-delete").disabled = this.llmProviders.length === 1;
		this.renderWorkModels();
	},

	switchLLMProvider(index) {
		if (index === this.loadedLLMProviderIndex) return true;
		if (!this.saveSettings({ silent: true, section: "ai" })) {
			this.setStatus("请先修正当前供应商参数，再切换。", true, "ai");
			return false;
		}
		this.loadedLLMProviderIndex = index;
		this.loadLLMProvider();
		this.setStatus("已切换 AI 供应商", false, "ai");
		return true;
	},

	addLLMProvider() {
		if (this.llmProviders.length >= this.LLM_PROVIDER_LIMIT) return false;
		if (!this.saveSettings({ silent: true, section: "ai" })) {
			this.setStatus("请先修正当前供应商参数，再添加。", true, "ai");
			return false;
		}
		let provider = Object.fromEntries(this.LLM_PROVIDER_FIELDS.map(name => [name, ""]));
		provider.llmProviderName = `服务商 ${this.llmProviders.length + 1}`;
		provider.id = "provider-" + Date.now() + "-" + this.llmProviders.length;
		this.llmProviders.push(provider);
		this.loadedLLMProviderIndex = this.llmProviders.length - 1;
		this.loadLLMProvider();
		this.setStatus("已添加供应商，请填写连接信息。", false, "ai");
		return true;
	},

	deleteLLMProvider() {
		if (this.llmProviders.length === 1) return false;
		let id = this.llmProviders[this.loadedLLMProviderIndex].id;
		if (this.isModelInUse(id + ":1") || this.isModelInUse(id + ":2")) {
			this.setStatus("此服务商仍被工作使用，请先更改并保存工作模型配置。", true, "ai"); return false;
		}
		this.llmProviders.splice(this.loadedLLMProviderIndex, 1);
		this.loadedLLMProviderIndex = Math.min(this.loadedLLMProviderIndex, this.llmProviders.length - 1);
		this.loadLLMProvider();
		this.setStatus("已删除当前供应商", false, "ai");
		return true;
	},

	formatContextTokens(tokens) {
		return tokens >= 1048576 ? `${tokens / 1048576}M` : `${tokens / 1024}K`;
	},

	parseContextTokens(value) {
		if (!value.trim()) return "";
		let match = value.trim().match(/^(\d+(?:\.\d+)?|\.\d+)\s*([km])$/i);
		let tokens = match ? Math.round(Number(match[1]) * (match[2].toUpperCase() === "M" ? 1048576 : 1024)) : NaN;
		if (!Number.isSafeInteger(tokens) || tokens < 1024) throw new Error("上下文请输入如 128K、1M 或 1.5M，最小为 1K；留空使用 32K。");
		return tokens;
	},

	modelChoices() {
		return this.llmProviders.flatMap(provider => [1, 2].filter(slot => provider[slot === 1 ? "llmModel" : "llmModel2"]?.trim()).map(slot => ({
			value: provider.id + ":" + slot,
			label: `${provider.llmProviderName || "未命名配置"} + ${provider[slot === 1 ? "llmModel" : "llmModel2"]}`,
			context: Number(provider[slot === 1 ? "llmModelContext" : "llmModel2Context"]) || 32768,
			concurrency: Number(provider[slot === 1 ? "llmModelConcurrency" : "llmModel2Concurrency"]) || 1
		})));
	},

	workFieldID(kind, field) {
		return ({ "summary-prompt": "mineru-summary-prompt", "summary-params": "mineru-summary-request-json",
			"translate-params": "mineru-translate-request-json" })[kind + "-" + field] || `ocrflow-work-${kind}-${field}`;
	},

	loadWorkSettings() {
		for (let kind of this.WORK_KINDS) {
			for (let field of ["prompt", "params"]) {
				let input = this.$(this.workFieldID(kind, field));
				let legacy = ({ "summary-prompt": "summaryPrompt", "summary-params": "summaryRequestJSON", "translate-params": "translateRequestJSON" })[kind + "-" + field];
				let legacyValue = legacy ? Zotero.Prefs.get(this.PREF_BRANCH + legacy, true) || "" : "";
				if (field === "params" && legacy) {
					let selected = this.workSettings[kind]?.model;
					if (!selected || selected === "default") selected = this.workSettings.defaultModel;
					let id = selected.slice(0, selected.lastIndexOf(":"));
					legacyValue = this.llmProviders.find(provider => provider.id === id)?.[legacy] || "";
				}
				input.value = String(this.workSettings[kind]?.[field] ?? legacyValue);
			}
		}
		this.renderWorkModels();
	},

	renderWorkModels() {
		let choices = this.modelChoices();
		for (let kind of ["default", ...this.WORK_KINDS]) {
			let input = this.$("ocrflow-work-" + kind + "-model");
			let value = input.value || (kind === "default" ? this.workSettings.defaultModel : this.workSettings[kind]?.model) || "default";
			input.replaceChildren();
			let options = kind === "default" ? choices : [{ value: "default", label: "跟随默认模型" }, ...choices];
			if (kind === "default" && !options.some(option => option.value === value)) options = [{value, label:"请先填写服务商模型"}, ...options];
			for (let choice of options) {
				let option = document.createElementNS("http://www.w3.org/1999/xhtml", "option");
				option.value = choice.value; option.textContent = choice.label; input.appendChild(option);
			}
			input.value = value;
		}
		this.updateWorkLabels();
	},

	updateWorkLabels() {
		let choices = this.modelChoices(), defaultModel = this.$("ocrflow-work-default-model").value;
		for (let kind of this.WORK_KINDS) {
			let selected = this.$("ocrflow-work-" + kind + "-model").value;
			let choice = choices.find(option => option.value === (selected === "default" ? defaultModel : selected));
			this.$("ocrflow-work-" + kind + "-actual").textContent = choice ? `实际使用：${choice.label} · 并发 ${choice.concurrency} · 上下文 ${this.formatContextTokens(choice.context)}` : "请先填写服务商模型";
		}
	},

	isModelInUse(value) {
		let saved = JSON.parse(Zotero.Prefs.get(this.PREF_BRANCH + "aiWorkSettings", true) || "{}");
		return saved.defaultModel === value || this.$("ocrflow-work-default-model").value === value || this.WORK_KINDS.some(kind =>
			saved[kind]?.model === value || this.$("ocrflow-work-" + kind + "-model").value === value);
	},

	readWorkSettings() {
		let work = { defaultModel: this.$("ocrflow-work-default-model").value };
		for (let kind of this.WORK_KINDS) {
			work[kind] = { ...this.workSettings[kind], model: this.$("ocrflow-work-" + kind + "-model").value };
			for (let field of ["prompt", "params"]) {
				let input = this.$(this.workFieldID(kind, field)), value = input.value.trim();
				if (field === "params") this.mergeRequestPayload({}, this.parseOptionalJSONObject(value, "工作请求参数"), ["model", "messages", "stream", "response_format"]);

				work[kind][field] = value;
			}
		}
		return work;
	},

	loadSettings(apiMode = Zotero.Prefs.get(this.PREF_BRANCH + "apiMode", true) || "cloud") {
		this.loadedAPIMode = apiMode;
		this.syncParseOptions(apiMode);
		for (let field of this.FIELDS) {
			let input = this.$(field.id);
			if (!input) continue;
			let value = field.pref === "apiMode" ? apiMode
				: this.API_FIELDS.includes(field.pref) ? this.readAPIPref(field.pref, apiMode)
				: Zotero.Prefs.get(this.PREF_BRANCH + field.pref, true);
			if (value === undefined || value === null) value = field.defaultValue ?? "";
			if (field.pref === "modelVersion") value = this.normalizeModelVersion(value, apiMode);
			if (field.type === "bool") {
				input.checked = !!value;
			} else {
				input.value = String(value);
			}
		}
		this.loadLLMProviders();
		this.syncTranslationMode();
		let jobIDInput = this.$("mineru-job-id");
		if (jobIDInput) jobIDInput.value = Zotero.Prefs.get(this.PREF_BRANCH + "lastLocalJobID", true) || "";
		this.setStatus("");
	},

	saveSettings({ silent = false, section = "all" } = {}) {
		this.syncTranslationMode();
		let fields = this.FIELDS.filter(field => section === "all" || this.sectionForField(field.pref) === section);
		let apiMode = this.loadedAPIMode || Zotero.Prefs.get(this.PREF_BRANCH + "apiMode", true) || "cloud";
		let profile = apiMode === "local-v1" ? "local" : "cloud";
		let updates = [], work;
		try {
			if (["all", "work"].includes(section)) work = this.readWorkSettings();
			if (["all", "ai"].includes(section)) for (let slot of [1, 2]) {
				let provider = this.llmProviders[this.loadedLLMProviderIndex], name = slot === 1 ? "llmModel" : "llmModel2";
				let input = this.$(slot === 1 ? "mineru-llm-model" : "mineru-llm-model-2");
				if (provider[name] && !input.value.trim() && this.isModelInUse(provider.id + ":" + slot)) throw new Error(`模型 ${slot} 仍被工作使用，请先更改并保存工作模型配置。`);
			}
			for (let field of fields) {
				let input = this.$(field.id);
				if (!input) continue;
				let value = field.pref === "apiMode" ? apiMode : field.type === "bool" ? !!input.checked : input.value.trim();
				if (field.type === "context") value = this.parseContextTokens(value);
				if (field.type === "optional-int" && value) {
					value = Number(value);
					if (!Number.isInteger(value) || value < field.min || (field.max && value > field.max)) {
						throw new Error("模型并发数须为 1–8 的整数，留空使用 1。");
					}
				}
				if (field.type === "int") {
					value = Number(value);
					if (!input.value.trim() || !Number.isInteger(value) || value < (field.pref === "localJobTimeoutSec" ? 0 : 1)) {
						throw new Error("数值须为正整数；任务等待上限可为 0。");
					}
				}
				if (["summaryRequestJSON", "translateRequestJSON"].includes(field.pref)) this.parseOptionalJSONObject(value, field.pref === "summaryRequestJSON" ? "总结额外 JSON 参数" : "翻译额外 JSON 参数");
				if (["apiToken", "llmApiKey"].includes(field.pref)) value = value.replace(/^Bearer\s+/i, "");
				updates.push([this.PREF_BRANCH + (this.API_FIELDS.includes(field.pref) ? profile + "." : "") + field.pref, value]);
			}
		} catch (error) {
			if (!silent) this.setStatus(error.message || String(error), true, section);
			return false;
		}
		for (let [name, value] of updates) Zotero.Prefs.set(name, value, true);
		if (work) { this.workSettings = work; Zotero.Prefs.set(this.PREF_BRANCH + "aiWorkSettings", JSON.stringify(work), true); }
		if (section === "all" || section === "ai") this.saveLLMProvider();
		if (!silent) this.setStatus(section === "all" ? "全部设置已保存" : "已保存", false, section);
		return true;
	},

	syncTranslationMode() {
		let format = this.$("mineru-translateOutputFormat");
		let mode = this.$("mineru-translateMode");
		let bilingual = this.$("mineru-bilingual-option");
		if (!format || !mode) return;
		let enabled = format.value === "html";
		if (bilingual) bilingual.disabled = !enabled;
		mode.disabled = !enabled;
		let images = this.$("mineru-parseImageMode");
		if (images) images.disabled = !this.$("mineru-parseGenerateHTML")?.checked;
	},

	readCurrentSettings(fromInputs = false) {
		let read = name => fromInputs ? this.$(this.FIELDS.find(field => field.pref === name).id).value : this.readAPIPref(name);
		let apiMode = (fromInputs ? this.$("mineru-api-mode").value : Zotero.Prefs.get(this.PREF_BRANCH + "apiMode", true)) || "cloud";
		let apiBaseURL = (read("apiBaseURL") || "").trim();
		if (!apiBaseURL) {
			apiBaseURL = apiMode === "local-v1" ? "http://127.0.0.1:8000" : "https://mineru.net/api/v4";
		}
		apiBaseURL = apiBaseURL.replace(/\/+$/, "");

		let apiToken = (read("apiToken") || "").trim();
		apiToken = apiToken.replace(/^Bearer\s+/i, "");

		let timeoutSec = parseInt(read("timeoutSec"), 10);
		if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) timeoutSec = 120;

		let modelVersion = this.normalizeModelVersion((read("modelVersion") || "").trim(), apiMode);

		return {
			apiBaseURL,
			apiMode,
			apiToken,
			timeoutMS: timeoutSec * 1000,
			modelVersion,
			cloudLanguage: (fromInputs ? this.$("mineru-cloud-language").value : Zotero.Prefs.get(this.PREF_BRANCH + "cloudLanguage", true)) || "auto"
		};
	},

	async queryJobProgress() {
		let output = this.$("mineru-job-progress-output");
		let button = this.$("mineru-job-progress-button");
		let settings = this.readCurrentSettings(true);
		if (settings.apiMode !== "local-v1") {
			output.textContent = "请先选择本地 MinerU 4（V1）接口。";
			return;
		}
		let jobID = this.$("mineru-job-id").value.trim()
			|| Zotero.Prefs.get(this.PREF_BRANCH + "lastLocalJobID", true);
		if (!jobID) {
			output.textContent = "请填写任务 ID，或先提交一个本地解析任务。";
			return;
		}
		let controller = new AbortController();
		let timeoutID = setTimeout(() => controller.abort(), settings.timeoutMS);
		button.disabled = true;
		output.textContent = "正在查询任务进度…";
		try {
			let response = await fetch(`${settings.apiBaseURL}/v1/parse/jobs/${encodeURIComponent(jobID)}`, {
				method: "GET", signal: controller.signal,
				headers: settings.apiToken ? { Authorization: `Bearer ${settings.apiToken}` } : {}
			});
			let text = await response.text();
			if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
			let job = JSON.parse(text);
			let labels = { queued: "排队中", running: "解析中", completed: "已完成", partial: "部分完成", failed: "失败", canceled: "已取消" };
			let lines = [`任务 ID: ${job.job_id}`, `状态: ${labels[job.status] || job.status} (${job.status})`, `档位: ${job.tier}`];
			if (job.progress) {
				lines.push(`已完成文件: ${job.progress.completed}/${job.progress.total}，失败: ${job.progress.failed}`);
			}
			if (job.created_at) lines.push(`提交时间: ${job.created_at}`);
			if (job.started_at) lines.push(`开始时间: ${job.started_at}`);
			if (job.finished_at) lines.push(`结束时间: ${job.finished_at}`);
			let started = Date.parse(job.created_at);
			let ended = job.finished_at ? Date.parse(job.finished_at) : Date.now();
			if (Number.isFinite(started) && Number.isFinite(ended)) {
				lines.push(`已用时: ${Math.floor((ended - started) / 60000)} 分钟`);
			}
			for (let file of job.files || []) {
				lines.push(`${file.name}: ${labels[file.status] || file.status}${file.error?.message ? "，" + file.error.message : ""}`);
				let pages = file.page_progress;
				if (pages) {
					let stages = { preparing: "准备文档", processing: "页面处理", postprocessing: "整理结构", exporting: "生成结果", completed: "任务完成", failed: "任务失败" };
					lines.push(`阶段: ${stages[pages.stage] || pages.stage}`);
					if (Number.isInteger(pages.total) && pages.total > 0) {
						lines.push(`已处理页面: ${pages.completed}/${pages.total}，剩余: ${pages.total - pages.completed}`);
					}
				}
			}
			output.textContent = lines.join("\n");
			return job;
		}
		catch (e) {
			output.textContent = `查询失败: ${e.name === "AbortError" ? "请求超时" : e.message || e}`;
		}
		finally {
			clearTimeout(timeoutID);
			button.disabled = false;
		}
	},

	async testMarkItDownConnection() {
		let base = this.$("docflow-markitdown-url").value.trim().replace(/\/+$/, "");
		if (!base) { this.setStatus("请填写服务地址", true, "markitdown"); return; }
		let button = this.$("ocrflow-markitdown-test");
		let controller = new AbortController();
		let timer = setTimeout(() => controller.abort(), 15000);
		button.disabled = true;
		this.setStatus("正在测试…", false, "markitdown");
		try {
			let result = await OCRFlowMarkItDown.testConnection(base, controller.signal);
			this.setOutput(JSON.stringify(result, null, 2), "markitdown");
			this.setStatus(`连接成功（${result.interface}）`, false, "markitdown");
		} catch (error) {
			this.setStatus(error.name === "AbortError" ? "请求超时" : "连接失败", true, "markitdown");
			this.setOutput(error.message || String(error), "markitdown");
		} finally { clearTimeout(timer); button.disabled = false; }
	},

	async testMineruConnection() {
		let settings = this.readCurrentSettings(true);
		if (settings.apiMode === "cloud" && !settings.apiToken) {
			this.setStatus("测试失败：Token 为空", true, "mineru");
			this.setOutput("请先填写 API Token。", "mineru");
			return;
		}

		let local = settings.apiMode === "local-v1";
		let endpoint = settings.apiBaseURL + (local ? "/v1/health" : "/file-urls/batch");
		let payload = {
			model_version: settings.modelVersion,
			...(!["auto", "server"].includes(settings.cloudLanguage) ? { language: settings.cloudLanguage } : {}),
			files: [
				{
					name: "connectivity-test.pdf",
					data_id: "zotero-connect-test-" + Date.now()
				}
			]
		};

		let button = this.$("ocrflow-mineru-test");
		button.disabled = true;
		let controller = new AbortController();
		let timeoutID = setTimeout(() => controller.abort(), settings.timeoutMS);
		try {
			this.setStatus("正在测试 MinerU 连接...", false, "mineru");
			this.setOutput(`${local ? "GET" : "POST"} ${endpoint}`, "mineru");

			let response = await fetch(endpoint, {
				method: local ? "GET" : "POST",
				headers: {
					"Accept": "application/json",
					...(local ? {} : { "Content-Type": "application/json" }),
					...(settings.apiToken ? { "Authorization": "Bearer " + settings.apiToken } : {})
				},
				...(local ? {} : { body: JSON.stringify(payload) }),
				signal: controller.signal
			});

			let text = await response.text();
			let json = null;
			try {
				json = JSON.parse(text);
			}
			catch (_e) {}

			if (response.status === 401 || response.status === 403) {
				this.setStatus("测试失败：Token 无效或权限不足", true, "mineru");
				this.setOutput(`HTTP ${response.status}\n${text.slice(0, 1200)}`, "mineru");
				return;
			}
			if (!response.ok) {
				this.setStatus(`测试失败：HTTP ${response.status}`, true, "mineru");
				this.setOutput(text.slice(0, 1200), "mineru");
				return;
			}

			if (json && (local || json.code === 0)) {
				this.setStatus(local ? "本地 MinerU 连接成功" : "MinerU 连接成功：Token 可用", false, "mineru");
				if (local) {
					this.setOutput(JSON.stringify(json, null, 2).slice(0, 1200), "mineru");
					return;
				}
				this.setOutput(JSON.stringify({
					endpoint,
					code: json.code,
					msg: json.msg || "",
					batch_id: json?.data?.batch_id || null
				}, null, 2), "mineru");
				return;
			}

			this.setStatus("已连通，但接口返回业务错误", true, "mineru");
			this.setOutput((json ? JSON.stringify(json, null, 2) : text).slice(0, 1200), "mineru");
		}
		catch (e) {
			let msg = e?.name === "AbortError" ? "请求超时" : (e.message || String(e));
			this.setStatus("测试失败：" + msg, true, "mineru");
			this.setOutput(msg, "mineru");
		}
		finally {
			clearTimeout(timeoutID);
			button.disabled = false;
		}
	},

	readLLMSettings(fromInputs = false) {
		let read = name => fromInputs ? this.$(this.FIELDS.find(field => field.pref === name).id).value : (this.llmProviders[this.loadedLLMProviderIndex][name] || "");
		let apiBaseURL = (read("llmApiBaseURL") || "").trim();
		apiBaseURL = apiBaseURL.replace(/\/+$/, "");
		let apiKey = (read("llmApiKey") || "").trim();
		apiKey = apiKey.replace(/^Bearer\s+/i, "");
		let model = (read("llmModel") || "").trim();
		let summaryRequestJSON = (read("summaryRequestJSON") || "").trim();
		let translateRequestJSON = (read("translateRequestJSON") || "").trim();
		return { apiBaseURL, apiKey, model, summaryRequestJSON, translateRequestJSON };
	},

	async sendLLMTestRequest({ endpoint, apiKey, payload, timeoutMS = 30000, signal }) {
		let controller = new AbortController();
		let abort = () => controller.abort();
		if (signal?.aborted) signal.throwIfAborted();
		signal?.addEventListener("abort", abort, { once: true });
		let timeoutID = setTimeout(abort, timeoutMS);
		try {
			let response = await fetch(endpoint, {
				method: "POST",
				headers: {
					"Accept": "application/json",
					"Content-Type": "application/json",
					...(apiKey ? { "Authorization": "Bearer " + apiKey } : {})
				},
				body: JSON.stringify(payload),
				signal: controller.signal
			});

			let text = await response.text();
			let json = null;
			try {
				json = JSON.parse(text);
			}
			catch (_e) {}

			if (response.status === 401 || response.status === 403) {
				throw new Error(`API Key 无效或权限不足（HTTP ${response.status}）`);
			}
			if (!response.ok) {
				throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
			}

			if (!json) throw new Error(`接口返回的不是 JSON（HTTP ${response.status}）：${text.slice(0, 200)}`);
			let choice = json.choices?.[0], error = json.error || choice?.error || (!choice?.message && json.message ? json : null);
			if (error) throw new Error(`API 错误${error.code ? " " + error.code : ""}：${typeof error === "string" ? error : error.message || "服务端未提供说明"}`);
			if (!choice?.message) throw new Error(`接口未返回 Chat Completions 消息（HTTP ${response.status}）。`);
			if (["error", "content_filter"].includes(choice.finish_reason) || choice.message.refusal) throw new Error(choice.message.refusal || `服务端未完成测试回复（${choice.finish_reason}）。`);
			let message = choice.message, reply = typeof message.content === "string" ? message.content.trim() : "";
			let hasReasoning = (typeof message.reasoning === "string" && !!message.reasoning.trim()) ||
				(typeof message.reasoning_content === "string" && !!message.reasoning_content.trim()) ||
				(Array.isArray(message.reasoning_details) && message.reasoning_details.length > 0) ||
				Number(json.usage?.completion_tokens_details?.reasoning_tokens) > 0;
			let notice = choice.finish_reason === "length" ? "测试输出达到上限，尚未验证完整回复" :
				!reply && hasReasoning ? "仅返回推理信息，尚未获得正文回复" : "";
			if (!reply && !notice) throw new Error(`接口返回空正文（HTTP ${response.status}；结束原因：${choice.finish_reason || "未提供"}；输出 tokens：${json.usage?.completion_tokens ?? "未提供"}）。`);
			return {
				model: json.model || payload.model, reply, notice,
				finishReason: choice.finish_reason || null,
				usage: json.usage || null
			};
		}
		catch (e) {
			if (e?.name === "AbortError") {
				if (signal?.aborted) throw e;
				throw new Error(`请求超时（${Math.round(timeoutMS / 1000)}秒）`);
			}
			throw e;
		}
		finally {
			clearTimeout(timeoutID);
			signal?.removeEventListener("abort", abort);
		}
	},

	resetModelTest(slot) {
		this.modelTests[slot]?.abort();
		delete this.modelTests[slot];
		this.setStatus("", false, "model-" + slot);
		this.setOutput("", "model-" + slot);
		this.$(`ocrflow-model-${slot}-test`).disabled = false;
	},

	async testLLMConnection(slot = 1) {
		this.resetModelTest(slot);
		let llm = this.readLLMSettings(true), section = "model-" + slot;
		llm.model = this.$(slot === 2 ? "mineru-llm-model-2" : "mineru-llm-model").value.trim();
		if (!llm.apiBaseURL || !llm.model) {
			this.setStatus("请先填写 API 地址和此模型名称", true, section);
			this.setOutput("本地免密服务的 Key 可留空。", section);
			return;
		}
		let endpoint = llm.apiBaseURL.endsWith("/chat/completions") ? llm.apiBaseURL : llm.apiBaseURL + "/chat/completions";
		let button = this.$(`ocrflow-model-${slot}-test`), controller = new AbortController();
		this.modelTests[slot] = controller;
		button.disabled = true;
		this.setStatus(`正在测试 ${llm.model}…`, false, section);
		this.setOutput("", section);
		try {
			let result = await this.sendLLMTestRequest({ endpoint, apiKey: llm.apiKey, signal: controller.signal, payload: {
				model: llm.model,
				messages: [{ role: "system", content: "Reply with exactly OK." }, { role: "user", content: "Return exactly OK." }],
				max_tokens: 512
			} });
			if (this.modelTests[slot] !== controller) return;
			this.setStatus(result.notice ? `${llm.model} 已连通：${result.notice}` : `${llm.model} 测试成功`, false, section);
			if (result.notice) this.$(`ocrflow-${section}-status`).setAttribute("data-state", "warning");
			this.setOutput(JSON.stringify({ endpoint, model: llm.model, result }, null, 2), section);
		}
		catch (error) {
			if (this.modelTests[slot] !== controller) return;
			this.setStatus(`${llm.model} 测试失败`, true, section);
			this.setOutput(error.message || String(error), section);
		}
		finally {
			if (this.modelTests[slot] === controller) { delete this.modelTests[slot]; button.disabled = false; }
		}
	},

	init() {
		if (this.initialized) return;
		try {
			this.loadSettings();
			for (let index = 0; index < this.LLM_PROVIDER_LIMIT; index++) {
				this.$("mineru-llm-provider-" + index).addEventListener("click", () => this.switchLLMProvider(index));
			}
			this.$("mineru-llm-provider-add").addEventListener("click", () => this.addLLMProvider());
			this.$("mineru-llm-provider-delete").addEventListener("click", () => this.deleteLLMProvider());
			for (let kind of ["default", ...this.WORK_KINDS]) {
				this.$("ocrflow-work-" + kind + "-model").addEventListener("change", () => { this.updateWorkLabels(); this.setStatus("有未保存的修改"); });
			}
			for (let kind of this.WORK_KINDS) for (let field of ["prompt", "params"]) {
				this.$(this.workFieldID(kind, field)).addEventListener("input", () => this.setStatus("有未保存的修改"));
			}
			let saveButton = this.$("mineru-save-button");
			if (saveButton) {
				saveButton.addEventListener("click", () => this.saveSettings());
			}
			this.$("mineru-open-queue-button")?.addEventListener("click", () => {
				Zotero.getMainWindow().DocFlow.openParseQueueDialog();
			});
			this.$("mineru-job-progress-button")?.addEventListener("click", () => {
				this.queryJobProgress().catch(e => {
					Zotero.logError(e);
					this.$("mineru-job-progress-output").textContent = `查询失败: ${e.message || e}`;
				});
			});
			for (let [section, method] of [["markitdown", "testMarkItDownConnection"], ["mineru", "testMineruConnection"]]) {
				this.$(`ocrflow-${section}-save`).addEventListener("click", () => this.saveSettings({ section }));
				this.$(`ocrflow-${section}-test`).addEventListener("click", () => this[method]().catch(error => {
					Zotero.logError(error); this.setStatus(`测试失败：${error.message || error}`, true, section);
				}));
			}
			this.$("ocrflow-ai-save").addEventListener("click", () => this.saveSettings({ section: "ai" }));
			for (let slot of [1, 2]) this.$(`ocrflow-model-${slot}-test`).addEventListener("click", () => this.testLLMConnection(slot));
			for (let field of this.FIELDS) {
				let input = this.$(field.id);
				if (!input) continue;
				if (field.pref === "apiMode") {
					input.addEventListener("command", () => this.switchAPIMode());
					continue;
				}
				let markChanged = () => {
					if (["llmApiBaseURL", "llmApiKey"].includes(field.pref)) for (let slot of [1, 2]) this.resetModelTest(slot);
					if (field.pref === "llmModel" || field.pref === "llmModel2") this.resetModelTest(field.pref === "llmModel" ? 1 : 2);
					this.syncTranslationMode();
					this.setStatus("有未保存的修改", false, this.sectionForField(field.pref));
					if (field.pref === "llmProviderName") this.$("mineru-llm-provider-" + this.loadedLLMProviderIndex).textContent = input.value || "未命名供应商";
				};
				if (input.localName === "menulist") input.addEventListener("command", markChanged);
				else {
					input.addEventListener("change", markChanged);
					input.addEventListener("input", markChanged);
				}
			}
			this.initialized = true;
		}
		catch (e) {
			Zotero.logError(e);
			this.setStatus(`设置页初始化失败: ${e.message || e}`, true);
		}
	}
};

if (typeof window !== "undefined") {
	window.DocFlowPreferences = DocFlowPreferences;
	window.addEventListener("DOMContentLoaded", () => {
		if (document.getElementById("docflow-prefpane")) {
			DocFlowPreferences.init();
		}
	}, { once: true });
}
