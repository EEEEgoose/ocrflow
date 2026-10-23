var ocrflowText = typeof ocrflowText === "function" ? ocrflowText : value => String(value ?? "");
var DocFlowPreferences = {
	PREF_BRANCH: "extensions.docflow.",
	getPref(key,global=true){const plugin=Zotero.getMainWindow?.()?.DocFlow;return plugin?.getPref ? plugin.getPref(key,global) : Zotero.Prefs.get(key,global);},
	setPref(key,value,global=true){const plugin=Zotero.getMainWindow?.()?.DocFlow;return plugin?.setPref ? plugin.setPref(key,value,global) : Zotero.Prefs.set(key,value,global);},
	initialized: false,
	loadedAPIMode: null,
	API_FIELDS: ["apiBaseURL", "apiToken", "modelVersion", "pollIntervalSec", "timeoutSec"],
	LLM_PROVIDER_LIMIT: 5,
	LLM_PROVIDER_FIELDS: ["llmProviderName", "llmApiBaseURL", "llmApiKey", "llmModel", "llmModel2", "llmModelContext", "llmModelConcurrency", "llmModel2Context", "llmModel2Concurrency", "llmModelMaxOutput", "llmModel2MaxOutput"],
	llmProviders: null,
	WORK_KINDS: ["parent", "metadata", "summary", "ocr", "translate", "outline", "title"],
	workSettings: {},
	loadedLLMProviderIndex: 0,
	modelTests: {},

	FIELDS: [
		{ id: "ocrflow-title-service", pref: "titleService", type: "string", defaultValue: "ai" },
		{ id: "ocrflow-title-language", pref: "titleLanguage", type: "string", defaultValue: "ZH" },
		{ id: "ocrflow-title-overwrite", pref: "titleOverwrite", type: "bool", defaultValue: false },
		{ id: "ocrflow-deepl-plan", pref: "deeplPlan", type: "string", defaultValue: "free" },
		{ id: "ocrflow-deepl-key", pref: "deeplApiKey", type: "string", defaultValue: "" },
		{ id: "ocrflow-deeplx-endpoint", pref: "deeplxEndpoint", type: "string", defaultValue: "http://127.0.0.1:1188/translate" },
		{ id: "ocrflow-deeplx-token", pref: "deeplxToken", type: "string", defaultValue: "" },
		{ id:"ocrflow-marker-type", pref:"marker.apiType", type:"string", defaultValue:"local" },
		{ id:"ocrflow-datalab-url", pref:"marker.cloud.url", type:"string", defaultValue:"https://www.datalab.to/api/v1" },
		{ id:"ocrflow-datalab-key", pref:"marker.cloud.token", type:"string", defaultValue:"" },
		{ id:"ocrflow-datalab-mode", pref:"marker.cloud.mode", type:"string", defaultValue:"balanced" },
		{ id:"ocrflow-marker-url", pref:"marker.url", type:"string", defaultValue:"" },
		{ id:"ocrflow-marker-token", pref:"marker.token", type:"string", defaultValue:"" },
		{ id:"ocrflow-marker-mode", pref:"marker.mode", type:"string", defaultValue:"balanced" },
		{ id:"ocrflow-marker-force-ocr", pref:"marker.forceOCR", type:"bool", defaultValue:false },
		...["cloud", "local"].flatMap(mode => ["url", "token", "model"].map(name => ({ id: `ocrflow-paddle-${mode}-${name}`,
			pref: `paddle.${mode}.${name}`, type: "string", defaultValue: name === "model" ? "PaddleOCR-VL-1.6" : name === "url" && mode === "cloud" ? "https://paddleocr.aistudio-app.com/api/v2/ocr" : "" }))),
		{ id: "ocrflow-collation-ai-enabled", pref: "collationAIEnabled", type: "bool", defaultValue: false },
		{ id: "ocrflow-collation-ai-model", pref: "collationAIModel", type: "string", defaultValue: "" },
		{ id: "ocrflow-collation-enabled", pref: "collationEnabled", type: "bool", defaultValue: false },
		{ id: "ocrflow-collation-a", pref: "collationA", type: "string", defaultValue: "mineru-cloud" },
		{ id: "ocrflow-collation-b", pref: "collationB", type: "string" },
		{ id: "ocrflow-paddle-mode", pref: "paddleMode", type: "string", defaultValue: "cloud" },
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
		{ id: "mineru-poll-interval-sec", pref: "pollIntervalSec", type: "int" },
		{ id: "mineru-timeout-sec", pref: "timeoutSec", type: "int" },
		{ id: "mineru-local-job-timeout-sec", pref: "localJobTimeoutSec", type: "int", defaultValue: 7200 },
		{ id: "mineru-llm-provider-name", pref: "llmProviderName", type: "string", defaultValue: "供应商 1" },
		{ id: "mineru-llm-api-base-url", pref: "llmApiBaseURL", type: "string" },
		{ id: "mineru-llm-api-key", pref: "llmApiKey", type: "string" },
		{ id: "mineru-llm-model", pref: "llmModel", type: "string" },
		{ id: "mineru-llm-model-2", pref: "llmModel2", type: "string" },
		{ id: "ocrflow-model-1-context", pref: "llmModelContext", type: "context" },
		{ id: "ocrflow-model-1-max-output", pref: "llmModelMaxOutput", type: "output" },
		{ id: "ocrflow-model-1-concurrency", pref: "llmModelConcurrency", type: "optional-int", min: 1, max: 8 },
		{ id: "ocrflow-model-2-context", pref: "llmModel2Context", type: "context" },
		{ id: "ocrflow-model-2-max-output", pref: "llmModel2MaxOutput", type: "output" },
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

	buttonFeedback(button,state) {
		if(!button)return;
		button.setAttribute("data-result",state);
		button.setAttribute("data-saved-label",ocrflowText(" ✓ 已保存"));
		button.animate?.([{boxShadow:"0 0 0 0 transparent"},{boxShadow:`0 0 0 3px ${state==="error" ? "#d4565680" : "#437cd180"}`},{boxShadow:"0 0 0 0 transparent"}],{duration:450});
	},

	setButtonBusy(button,busy) {
		if(!button)return;
		if(busy) { if(!button.ocrflowIdleLabel)button.ocrflowIdleLabel=button.textContent;button.textContent=ocrflowText(button.id.includes("test") ? "测试中…" : "处理中…"); }
		else if(button.ocrflowIdleLabel)button.textContent=ocrflowText(button.ocrflowIdleLabel);
		button.disabled=busy;button.setAttribute("data-busy",String(busy));button.setAttribute("aria-busy",String(busy));
	},

	setOutput(message, section = "ai") {
		let output = this.$(`ocrflow-${section}-output`);
		if (!output) return;
		output.textContent = message || "";
		output.hidden = !message;
	},

	setStatus(message, isError = false, section = "all") {
		if(/测试|连接|超时/.test(message)&&(isError||/成功/.test(message)))this.buttonFeedback(this.$(`ocrflow-${section}-test`),isError ? "error" : "success");
		if (section !== "all" && message === "有未保存的修改") this.setStatus(message);
		let status = this.$(section === "all" ? "mineru-status" : `ocrflow-${section}-status`);
		if (!status) return;
		status.textContent = ocrflowText(message || "");
		status.setAttribute("data-state", isError ? "error" : message === "有未保存的修改" ? "changed" : "saved");
	},

	sectionForField(name) {
		if (["titleService", "titleLanguage", "titleOverwrite"].includes(name)) return "title";
		if (["deeplPlan", "deeplApiKey"].includes(name)) return "deepl";
		if (["deeplxEndpoint", "deeplxToken"].includes(name)) return "deeplx";
		if (name.startsWith("marker.")) return "marker";
		if (name === "paddleMode" || name.startsWith("paddle.")) return "paddle";
		if (name.startsWith("collation")) return "work";
		if (name === "markitdownBaseURL") return "markitdown";
		if (this.API_FIELDS.includes(name) || ["apiMode", "localJobTimeoutSec", "cloudLanguage"].includes(name)) return "mineru";
		if (this.LLM_PROVIDER_FIELDS.includes(name)) return "ai";
		if (["summaryPrompt", "summaryRequestJSON", "translateRequestJSON", "summaryLanguage", "translateLanguage", "translateChunkSize", "translateRetryCount", "translateOutputFormat", "translateMode", "autoOutline", "outlineUseAI"].includes(name)) return "work";
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

	readAPIPref(name, mode = this.getPref(this.PREF_BRANCH + "apiMode", true) || "cloud") {
		let profile = mode === "local-v1" ? "local" : "cloud";
		let value = this.getPref(this.PREF_BRANCH + profile + "." + name, true);
		if (value !== undefined && value !== null) return value;
		let currentMode = this.getPref(this.PREF_BRANCH + "apiMode", true) || "cloud";
		if (mode === currentMode) {
			value = this.getPref(this.PREF_BRANCH + name, true);
			if (name === "apiToken" && !value) value = this.getPref(this.PREF_BRANCH + "apiKey", true);
			if (value !== undefined && value !== null) return value;
		}
		return {
			apiBaseURL: mode === "local-v1" ? "http://127.0.0.1:8000" : "https://mineru.net/api/v4",
			apiToken: "", modelVersion: mode === "local-v1" ? "basic" : "pipeline", pollIntervalSec: 5, timeoutSec: 1200
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
		this.$("mineru-model-version-label").textContent = ocrflowText(apiMode === "local-v1" ? "解析档位" : "模型版本");
		this.$("mineru-cloud-language").disabled = apiMode !== "cloud";
		this.$("mineru-cloud-language-help").textContent = ocrflowText(apiMode === "cloud"
			? "自动读取父条目语言；为空或无法识别时使用云端默认值。手动选择不会改写条目语言。"
			: "识别语言仅适用于官方云端，本地 V1 不接收该参数。云端选择会保留。");
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
		this.setPref(this.PREF_BRANCH + "apiMode", nextMode, true);
		this.setStatus("已切换接口", false, "mineru");
	},

	loadLLMProviders() {
		let saved = this.getPref(this.PREF_BRANCH + "llmProviders", true);
		this.llmProviders = saved ? JSON.parse(saved) : [Object.fromEntries(
			[...this.LLM_PROVIDER_FIELDS, "summaryRequestJSON", "translateRequestJSON"].map(name => [name, this.getPref(this.PREF_BRANCH + name, true) || ""])
		)];
		this.loadedLLMProviderIndex = this.getPref(this.PREF_BRANCH + "llmProviderIndex", true) || 0;
		this.llmProviders.forEach((provider, index) => { provider.id ||= "provider-" + index; });
		let savedWork = this.getPref(this.PREF_BRANCH + "aiWorkSettings", true);
		this.workSettings = savedWork ? JSON.parse(savedWork) : {};
		if (!this.workSettings.defaultModel) {
			this.workSettings.defaultModel = this.llmProviders[this.loadedLLMProviderIndex].id + ":1";
			if(!this.configStore?.()||this.configStore().state==="unlocked")this.setPref(this.PREF_BRANCH+"aiWorkSettings",JSON.stringify(this.workSettings),true);
		}
		this.loadLLMProvider();
		this.loadWorkSettings();
	},

	loadLLMProvider() {
		for (let slot of [1, 2]) this.resetModelTest(slot);
		let provider = this.llmProviders[this.loadedLLMProviderIndex];
		for (let field of this.FIELDS.filter(field => this.LLM_PROVIDER_FIELDS.includes(field.pref))) {
			let value = provider[field.pref] || "";
			this.$(field.id).value = ["context", "output"].includes(field.type) && value ? this.formatContextTokens(Number(value)) : String(value);
		}
		this.persistLLMProviders();
		this.renderLLMProviders();
	},

	persistLLMProviders() {
		this.setPref(this.PREF_BRANCH + "llmProviders", JSON.stringify(this.llmProviders), true);
		this.setPref(this.PREF_BRANCH + "llmProviderIndex", this.loadedLLMProviderIndex, true);
	},

	saveLLMProvider() {
		this.llmProviders[this.loadedLLMProviderIndex] = { ...this.llmProviders[this.loadedLLMProviderIndex], ...Object.fromEntries(
			this.LLM_PROVIDER_FIELDS.map(name => [name, this.getPref(this.PREF_BRANCH + name, true) || ""])
		) };
		this.persistLLMProviders();
		this.renderLLMProviders();
	},

	renderLLMProviders() {
		for (let index = 0; index < this.LLM_PROVIDER_LIMIT; index++) {
			let button = this.$("mineru-llm-provider-" + index);
			let provider = this.llmProviders[index];
			button.hidden = !provider;
			button.textContent = provider?.llmProviderName || ocrflowText(`供应商 ${index + 1}`);
			button.setAttribute("aria-pressed", String(index === this.loadedLLMProviderIndex));
		}
		this.$("mineru-llm-provider-count").textContent = ocrflowText(`${this.llmProviders.length}/${this.LLM_PROVIDER_LIMIT}`);
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
		return tokens < 1024 ? String(tokens) : tokens >= 1048576 ? `${tokens / 1048576}M` : `${tokens / 1024}K`;
	},

	parseContextTokens(value) {
		if (!value.trim()) return "";
		let match = value.trim().match(/^(\d+(?:\.\d+)?|\.\d+)\s*([km])$/i);
		let tokens = match ? Math.round(Number(match[1]) * (match[2].toUpperCase() === "M" ? 1048576 : 1024)) : NaN;
		if (!Number.isSafeInteger(tokens) || tokens < 1024) throw new Error("上下文请输入如 128K、1M 或 1.5M，最小为 1K；留空使用 32K。");
		return tokens;
	},

	parseOutputTokens(value) {
		if (!value.trim()) return "";
		let match = value.trim().match(/^(\d+(?:\.\d+)?|\.\d+)\s*([km])?$/i);
		let tokens = match ? Number(match[1]) * (match[2]?.toUpperCase() === "M" ? 1048576 : match[2] ? 1024 : 1) : NaN;
		if (!Number.isSafeInteger(tokens) || tokens < 1) throw new Error("最大输出长度请输入正整数 tokens，或 8K、16K 等格式；留空使用工作默认值。");
		return tokens;
	},

	modelChoices() {
		return this.llmProviders.flatMap(provider => [1, 2].filter(slot => provider[slot === 1 ? "llmModel" : "llmModel2"]?.trim()).map(slot => ({
			value: provider.id + ":" + slot,
			label: `${provider.llmProviderName || "未命名配置"} + ${provider[slot === 1 ? "llmModel" : "llmModel2"]}`,
			context: Number(provider[slot === 1 ? "llmModelContext" : "llmModel2Context"]) || 32768,
			concurrency: Number(provider[slot === 1 ? "llmModelConcurrency" : "llmModel2Concurrency"]) || 1,
			output: Number(provider[slot === 1 ? "llmModelMaxOutput" : "llmModel2MaxOutput"]) || 0
		})));
	},

	workFieldID(kind, field) {
		return ({ "summary-prompt": "mineru-summary-prompt", "summary-params": "mineru-summary-request-json",
			"translate-params": "mineru-translate-request-json" })[kind + "-" + field] || `ocrflow-work-${kind}-${field}`;
	},

	loadWorkSettings() {
		for (let kind of this.WORK_KINDS) {
			this.$("ocrflow-work-" + kind + "-default").value = OCRFlowPrompts.defaults[kind];
			for (let field of ["prompt", "params"]) {
				let input = this.$(this.workFieldID(kind, field));
				let legacy = ({ "summary-prompt": "summaryPrompt", "summary-params": "summaryRequestJSON", "translate-params": "translateRequestJSON" })[kind + "-" + field];
				let legacyValue = legacy ? this.getPref(this.PREF_BRANCH + legacy, true) || "" : "";
				if (field === "params" && legacy) {
					let selected = this.workSettings[kind]?.model;
					if (!selected || selected === "default") selected = this.workSettings.defaultModel;
					let id = selected.slice(0, selected.lastIndexOf(":"));
					legacyValue = this.llmProviders.find(provider => provider.id === id)?.[legacy] || "";
				}
				let value = String(this.workSettings[kind]?.[field] ?? legacyValue);
				input.value = field === "prompt" ? value || OCRFlowPrompts.defaults[kind] : value;
			}
		}
		for (let kind of ["parent", "metadata"]) this.$("ocrflow-work-" + kind + "-format").value = OCRFlowPrompts.metadataFormat();
		this.renderWorkModels();
	},

	renderWorkModels() {
		let choices = this.modelChoices();
		for (let kind of ["default", ...this.WORK_KINDS]) {
			let input = this.$("ocrflow-work-" + kind + "-model");
			let value = input.value || (kind === "default" ? this.workSettings.defaultModel : this.workSettings[kind]?.model) || "default";
			input.replaceChildren();
			let options = kind === "default" ? choices : [{ value: "default", label: ocrflowText("跟随默认模型") }, ...choices];
			if (kind === "default" && !options.some(option => option.value === value)) options = [{value, label:ocrflowText("请先填写服务商模型")}, ...options];
			for (let choice of options) {
				let option = document.createElementNS("http://www.w3.org/1999/xhtml", "option");
				option.value = choice.value; option.textContent = choice.value === "default" ? ocrflowText(choice.label) : choice.label; input.appendChild(option);
			}
			input.value = value;
		}
		let reviewModel = this.$("ocrflow-collation-ai-model");
		if (reviewModel) {
			let selected = this.collationModelLoaded ? reviewModel.value : this.getPref(this.PREF_BRANCH + "collationAIModel", true) || reviewModel.value;
			this.collationModelLoaded = true; reviewModel.replaceChildren();
			for (let choice of [{value:"",label:"请选择支持图片的模型"}, ...choices]) {
				let option = document.createElementNS("http://www.w3.org/1999/xhtml", "option"); option.value = choice.value; option.textContent = choice.value === "default" ? ocrflowText(choice.label) : choice.label; reviewModel.appendChild(option);
			}
			reviewModel.value = choices.some(choice => choice.value === selected) ? selected : "";
		}
		this.updateWorkLabels();
		this.renderOCRSources();
	},

	renderOCRSources() {
		if (typeof OCRFlowSources === "undefined") return;
		let a = this.$("ocrflow-collation-a"), b = this.$("ocrflow-collation-b");
		if (!a || !b) return;
		let choices = OCRFlowSources.choices(this.llmProviders || []), first = a.value || (!this.ocrSourcesLoaded && this.getPref(this.PREF_BRANCH + "collationA", true)) || "mineru-cloud", second = b.value || (!this.ocrSourcesLoaded && this.getPref(this.PREF_BRANCH + "collationB", true)) || "";
		if (first === "marker") first = this.getPref(this.PREF_BRANCH + "marker.apiType", true) === "cloud" ? "marker-cloud" : "marker-local";
		if (second === "marker") second = this.getPref(this.PREF_BRANCH + "marker.apiType", true) === "cloud" ? "marker-cloud" : "marker-local";
		this.ocrSourcesLoaded = true;
		for (let [input, selected, other] of [[a, first, ""], [b, second, first]]) {
			input.replaceChildren();
			let empty = document.createElementNS("http://www.w3.org/1999/xhtml", "option"); empty.value = ""; empty.textContent = ocrflowText("请选择识别来源"); input.appendChild(empty);
			for (let choice of choices) {
				if (other && !OCRFlowSources.valid(other, choice.value, this.llmProviders || [])) continue;
				let option = document.createElementNS("http://www.w3.org/1999/xhtml", "option"); option.value = choice.value; option.textContent = choice.value === "default" ? ocrflowText(choice.label) : choice.label; input.appendChild(option);
			}
			input.value = choices.some(choice => choice.value === selected && (!other || OCRFlowSources.valid(other, selected, this.llmProviders || []))) ? selected : "";
		}
		if (second && !OCRFlowSources.valid(a.value, second, this.llmProviders || [])) { b.value = ""; this.setStatus("来源 A 已改变，请重新选择不同的来源 B。", false, "work"); }
	},

	updateWorkLabels() {
		let choices = this.modelChoices(), defaultModel = this.$("ocrflow-work-default-model").value;
		for (let kind of this.WORK_KINDS) {
			let selected = this.$("ocrflow-work-" + kind + "-model").value;
			let choice = choices.find(option => option.value === (selected === "default" ? defaultModel : selected));
			this.$("ocrflow-work-" + kind + "-actual").textContent = ocrflowText(choice ? `实际使用：${choice.label} · 并发 ${choice.concurrency} · 上下文 ${this.formatContextTokens(choice.context)} · 输出 ${choice.output ? this.formatContextTokens(choice.output) : ocrflowText("按工作默认")}` : "请先填写服务商模型");
		}
	},

	isModelInUse(value) {
		let saved = JSON.parse(this.getPref(this.PREF_BRANCH + "aiWorkSettings", true) || "{}");
		return this.$("ocrflow-collation-ai-model")?.value === value || this.getPref(this.PREF_BRANCH + "collationAIModel", true) === value || ["a", "b"].some(slot => this.$("ocrflow-collation-" + slot)?.value === "ai:" + value ||
			this.getPref(this.PREF_BRANCH + "collation" + slot.toUpperCase(), true) === "ai:" + value) ||
			saved.defaultModel === value || this.$("ocrflow-work-default-model").value === value || this.WORK_KINDS.some(kind =>
			saved[kind]?.model === value || this.$("ocrflow-work-" + kind + "-model").value === value);
	},

	readWorkSettings(kinds = this.WORK_KINDS) {
		let work = { ...this.workSettings, defaultModel: this.$("ocrflow-work-default-model").value };
		for (let kind of kinds) {
			work[kind] = { ...this.workSettings[kind], model: this.$("ocrflow-work-" + kind + "-model").value };
			for (let field of ["prompt", "params"]) {
				let input = this.$(this.workFieldID(kind, field)), value = input.value.trim();
				if (field === "params") this.mergeRequestPayload({}, this.parseOptionalJSONObject(value, "工作请求参数"), ["model", "messages", "stream", "response_format"]);

				work[kind][field] = field === "prompt" && value === OCRFlowPrompts.defaults[kind] ? "" : value;
			}
		}
		return work;
	},

	loadSettings(apiMode = this.getPref(this.PREF_BRANCH + "apiMode", true) || "cloud") {
		this.ocrSourcesLoaded=false;this.collationModelLoaded=false;
		this.loadedAPIMode = apiMode;
		this.collationModelLoaded = false; this.ocrSourcesLoaded = false;
		this.syncParseOptions(apiMode);
		for (let field of this.FIELDS) {
			let input = this.$(field.id);
			if (!input) continue;
			let value = field.pref === "apiMode" ? apiMode
				: this.API_FIELDS.includes(field.pref) ? this.readAPIPref(field.pref, apiMode)
				: this.getPref(this.PREF_BRANCH + field.pref, true);
			if (value === undefined || value === null) value = field.defaultValue ?? "";
			if (field.pref === "parserService" && String(value).startsWith("paddle-")) {
				this.$("ocrflow-paddle-mode").value = String(value).slice(7);
				value = "paddle";
			}
			if (field.pref === "modelVersion") value = this.normalizeModelVersion(value, apiMode);
			if (field.type === "bool") {
				input.checked = !!value;
			} else {
				input.value = String(value);
			}
		}
		this.loadLLMProviders();
		this.syncTranslationMode();
		this.syncMarkerMode();this.syncPaddleMode();
		let jobIDInput = this.$("mineru-job-id");
		if (jobIDInput) jobIDInput.value = this.getPref(this.PREF_BRANCH + "lastLocalJobID", true) || "";
		this.setStatus("");
	},

	persistSettings(options={}) {
		const config=Zotero.getMainWindow?.()?.DocFlow?.config;if(!config)return this.saveSettings(options);
		return (async()=>{
			const {silent=false,section="all"}=options,button=this.$(section==="all"?"mineru-save-button":`ocrflow-${section}-save`)||this.$("mineru-save-button");
			try {
				if(!this.saveSettings({silent:true,section})){if(!silent)this.saveSettings({section});return false;}
				this.setButtonBusy(button,true);await config.flush();if(!silent){this.setStatus("已加密保存",false,section);this.buttonFeedback(button,"saved");}return true;
			}catch(error){if(!silent){this.setStatus("保存失败："+error.message,true,section);this.buttonFeedback(button,"error");}return false;}
			finally{this.setButtonBusy(button,false);}
		})();
	},

	saveSettings({ silent = false, section = "all" } = {}) {
		if(Zotero.getMainWindow?.()?.DocFlow?.config?.busy){if(!silent)this.setStatus("配置操作正在进行，请完成后再保存",true,section);return false;}
		let feedbackButton=this.$(section==="all" ? "mineru-save-button" : `ocrflow-${section}-save`)||this.$("mineru-save-button");
		this.syncTranslationMode();
		let fields = this.FIELDS.filter(field => section === "all" || this.sectionForField(field.pref) === section);
		let apiMode = this.loadedAPIMode || this.getPref(this.PREF_BRANCH + "apiMode", true) || "cloud";
		let profile = apiMode === "local-v1" ? "local" : "cloud";
		let updates = [], work;
		try {
			if (["all", "work"].includes(section) && this.$("ocrflow-collation-enabled")?.checked && typeof OCRFlowSources !== "undefined") {
				if (!OCRFlowSources.valid(this.$("ocrflow-collation-a").value, this.$("ocrflow-collation-b").value, this.llmProviders || [])) throw new Error("双引擎须选择不同来源；MinerU 本地/云端、PaddleOCR 官方/自部署分别互斥。");
			}
			if (["all", "work"].includes(section) && this.$("ocrflow-collation-enabled")?.checked && this.$("ocrflow-collation-ai-enabled")?.checked &&
				!this.modelChoices().some(choice => choice.value === this.$("ocrflow-collation-ai-model").value)) throw new Error("请选择支持图片的 AI 校勘模型。");
			if (["all", "work"].includes(section)) work = this.readWorkSettings();
			if (section === "title") work = this.readWorkSettings(["title"]);
			if (["all", "ai"].includes(section)) for (let slot of [1, 2]) {
				let provider = this.llmProviders[this.loadedLLMProviderIndex], name = slot === 1 ? "llmModel" : "llmModel2";
				let input = this.$(slot === 1 ? "mineru-llm-model" : "mineru-llm-model-2");
				if (provider[name] && !input.value.trim() && this.isModelInUse(provider.id + ":" + slot)) throw new Error(`模型 ${slot} 仍被工作使用，请先更改并保存工作模型配置。`);
			}
			for (let field of fields) {
				let input = this.$(field.id);
				if (!input) continue;
				let value = field.pref === "apiMode" ? apiMode : field.type === "bool" ? !!input.checked : input.value.trim();
				if (field.pref === "titleLanguage") { if (!value) throw new Error("请填写标题翻译的目标语言。"); value = value.toUpperCase(); }
				if (field.type === "context") value = this.parseContextTokens(value);
				if (field.type === "output") value = this.parseOutputTokens(value);
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
				if (field.pref === "summaryPrompt" && value === OCRFlowPrompts.defaults.summary) value = "";
				if (["summaryRequestJSON", "translateRequestJSON"].includes(field.pref)) this.parseOptionalJSONObject(value, field.pref === "summaryRequestJSON" ? "总结额外 JSON 参数" : "翻译额外 JSON 参数");
				if (["apiToken", "llmApiKey"].includes(field.pref)) value = value.replace(/^Bearer\s+/i, "");
				updates.push([this.PREF_BRANCH + (this.API_FIELDS.includes(field.pref) ? profile + "." : "") + field.pref, value]);
			}
			if (["all", "ai"].includes(section)) for (let slot of [1, 2]) {
				let contextPref = slot === 1 ? "llmModelContext" : "llmModel2Context";
				let outputPref = slot === 1 ? "llmModelMaxOutput" : "llmModel2MaxOutput";
				let context = updates.find(([name]) => name === this.PREF_BRANCH + contextPref)?.[1] || 32768;
				let output = updates.find(([name]) => name === this.PREF_BRANCH + outputPref)?.[1];
				if (output && output >= context) throw new Error(`模型 ${slot} 的最大输出长度必须小于上下文窗口，需为输入和提示词保留空间。`);
			}

		} catch (error) {
			if(!silent)this.buttonFeedback(feedbackButton,"error");
			if (!silent) this.setStatus(error.message || String(error), true, section);
			return false;
		}
		for (let [name, value] of updates) this.setPref(name, value, true);
		if (work) { this.workSettings = work; this.setPref(this.PREF_BRANCH + "aiWorkSettings", JSON.stringify(work), true); }
		if (section === "all" || section === "ai") this.saveLLMProvider();
		if (!silent) this.setStatus(section === "all" ? "全部设置已保存" : "已保存", false, section);
		if(!silent)this.buttonFeedback(feedbackButton,"saved");
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
		let apiMode = (fromInputs ? this.$("mineru-api-mode").value : this.getPref(this.PREF_BRANCH + "apiMode", true)) || "cloud";
		let apiBaseURL = (read("apiBaseURL") || "").trim();
		if (!apiBaseURL) {
			apiBaseURL = apiMode === "local-v1" ? "http://127.0.0.1:8000" : "https://mineru.net/api/v4";
		}
		apiBaseURL = apiBaseURL.replace(/\/+$/, "");

		let apiToken = (read("apiToken") || "").trim();
		apiToken = apiToken.replace(/^Bearer\s+/i, "");

		let timeoutSec = parseInt(read("timeoutSec"), 10);
		if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) timeoutSec = 1200;

		let modelVersion = this.normalizeModelVersion((read("modelVersion") || "").trim(), apiMode);

		return {
			apiBaseURL,
			apiMode,
			apiToken,
			timeoutMS: timeoutSec * 1000,
			modelVersion,
			cloudLanguage: (fromInputs ? this.$("mineru-cloud-language").value : this.getPref(this.PREF_BRANCH + "cloudLanguage", true)) || "auto"
		};
	},

	async queryJobProgress() {
		let output = this.$("mineru-job-progress-output");
		let button = this.$("mineru-job-progress-button");
		let settings = this.readCurrentSettings(true);
		if (settings.apiMode !== "local-v1") {
			output.textContent = ocrflowText("请先选择本地 MinerU 4（V1）接口。");
			return;
		}
		let jobID = this.$("mineru-job-id").value.trim()
			|| this.getPref(this.PREF_BRANCH + "lastLocalJobID", true);
		if (!jobID) {
			output.textContent = ocrflowText("请填写任务 ID，或先提交一个本地解析任务。");
			return;
		}
		let controller = new AbortController();
		let timeoutID = setTimeout(() => controller.abort(), settings.timeoutMS);
		this.setButtonBusy(button,true);
		output.textContent = ocrflowText("正在查询任务进度…");
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
			output.textContent = ocrflowText(lines.map(line => ocrflowText(line)).join("\n"));
			return job;
		}
		catch (e) {
			output.textContent = ocrflowText(`查询失败: ${e.name === "AbortError" ? "请求超时" : e.message || e}`);
		}
		finally {
			clearTimeout(timeoutID);
			this.setButtonBusy(button,false);
		}
	},

	async testMarkItDownConnection() {
		let base = this.$("docflow-markitdown-url").value.trim().replace(/\/+$/, "");
		if (!base) { this.setStatus("请填写服务地址", true, "markitdown"); return; }
		let button = this.$("ocrflow-markitdown-test");
		let controller = new AbortController();
		let timer = setTimeout(() => controller.abort(), 15000);
		this.setButtonBusy(button,true);
		this.setStatus("正在测试…", false, "markitdown");
		try {
			let result = await OCRFlowMarkItDown.testConnection(base, controller.signal);
			this.setOutput(JSON.stringify(result, null, 2), "markitdown");
			this.setStatus(`连接成功（${result.interface}）`, false, "markitdown");
		} catch (error) {
			this.setStatus(error.name === "AbortError" ? "请求超时" : "连接失败", true, "markitdown");
			this.setOutput(error.message || String(error), "markitdown");
		} finally { clearTimeout(timer); this.setButtonBusy(button,false); }
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
		this.setButtonBusy(button,true);
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
			this.setButtonBusy(button,false);
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
		this.setButtonBusy(this.$(`ocrflow-model-${slot}-test`),false);
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
		this.setButtonBusy(button,true);
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
			if (this.modelTests[slot] === controller) { delete this.modelTests[slot]; this.setButtonBusy(button,false); }
		}
	},

	async testTitleService(service) {
		let button = this.$(`ocrflow-${service}-test`), settings = { service, targetLang: this.$("ocrflow-title-language").value.trim().toUpperCase(),
			deeplPlan: this.$("ocrflow-deepl-plan").value, deeplApiKey: this.$("ocrflow-deepl-key").value,
			deeplxEndpoint: this.$("ocrflow-deeplx-endpoint").value, deeplxToken: this.$("ocrflow-deeplx-token").value };
		this.setButtonBusy(button, true); this.setStatus("正在测试…", false, service);
		try {
			let result = await OCRFlowTitleServices.translate("Hello", settings);
			this.setStatus(`测试成功：${result.text}`, false, service);
		} catch (error) { this.setStatus(`测试失败：${error.message || error}`, true, service); }
		finally { this.setButtonBusy(button, false); }
	},

	async testMarkerConnection() {
		let button = this.$("ocrflow-marker-test"), controller = new AbortController();
		this.setButtonBusy(button,true); this.setStatus("正在测试…", false, "marker");
		let timer = setTimeout(() => controller.abort(), 10000);
		try {
			let cloud=this.$("ocrflow-marker-type").value==="cloud";
			let result = cloud ? await OCRFlowDatalab.testConnection(this.$("ocrflow-datalab-url").value,this.$("ocrflow-datalab-key").value,controller.signal) : await OCRFlowMarker.testConnection(this.$("ocrflow-marker-url").value, this.$("ocrflow-marker-token").value.trim().replace(/^Bearer\s+/i, ""), controller.signal);
			this.setStatus(cloud ? "Datalab 服务已连通，密钥权限待实际请求验证" : "Marker API 连接成功", false, "marker"); this.setOutput(JSON.stringify(result, null, 2), "marker");
		} catch (error) {
			this.setStatus("连接失败", true, "marker"); this.setOutput(error.name === "AbortError" ? "请求超时" : error.message, "marker");
		} finally { clearTimeout(timer); this.setButtonBusy(button,false); }
	},

	showSection(selected) {
		if(selected==="config")this.refreshConfig?.();
		for (let key of ["services", "ai", "work", "collation", "output", "tasks", "config"]) {
			let panel = this.$("ocrflow-panel-" + key);
			if (panel) panel.hidden = key !== selected;
			this.$("ocrflow-tab-" + key)?.setAttribute("aria-pressed", String(key === selected));
		}
		if (selected === "tasks") this.queueView?.render();
	},

	showService(selected) {
		for (let key of ["mineru", "paddle", "marker", "markitdown", "ai"]) {
			let panel = this.$("ocrflow-service-panel-" + key);
			if (panel) panel.hidden = key !== selected;
			this.$("ocrflow-service-tab-" + key)?.setAttribute("aria-pressed", String(key === selected));
		}
	},

	showWork(selected) {
		for (let key of this.WORK_KINDS) {
			this.$("ocrflow-work-" + key).hidden = key !== selected;
			this.$("ocrflow-work-tab-" + key)?.setAttribute("aria-pressed", String(key === selected));
		}
	},

	syncPaddleMode() {
		for (let key of ["cloud", "local"]) {
			let panel = this.$("ocrflow-paddle-" + key + "-fields");
			if (panel) panel.hidden = this.$("ocrflow-paddle-mode").value !== key;
		}
	},
	syncMarkerMode(){const cloud=this.$("ocrflow-marker-type")?.value==="cloud";this.$("ocrflow-marker-local-fields").hidden=cloud;this.$("ocrflow-marker-cloud-fields").hidden=!cloud;},

	initNavigation() {
		if(this.navigationBound)return;this.navigationBound=true;
		for (let key of ["services", "ai", "work", "collation", "output", "tasks", "config"]) this.$("ocrflow-tab-" + key)?.addEventListener("click", () => this.showSection(key));
		for (let key of ["mineru", "paddle", "marker", "markitdown", "ai"]) this.$("ocrflow-service-tab-" + key)?.addEventListener("click", () => this.showService(key));
		for (let key of this.WORK_KINDS) this.$("ocrflow-work-tab-" + key)?.addEventListener("click", () => this.showWork(key));
		this.$("ocrflow-paddle-mode")?.addEventListener("change", () => this.syncPaddleMode());
		this.$("ocrflow-marker-type")?.addEventListener("change",()=>this.syncMarkerMode());
		this.$("ocrflow-go-ai")?.addEventListener("click", () => this.showSection("ai"));
		this.$("ocrflow-go-ocr")?.addEventListener("click", () => { this.showSection("work"); this.showWork("ocr"); });
		this.showService(this.$("docflow-parser-service").value);
		this.showWork("parent");
		this.syncPaddleMode();
		this.syncMarkerMode();
		let plugin = Zotero.getMainWindow?.()?.DocFlow;
		if (plugin && typeof DocFlowTaskQueue !== "undefined") {
			this.queueView = DocFlowTaskQueue;
			this.queueView.init(plugin);
		}
		this.showSection(plugin?.requestedPreferencesSection || "services");
		if (plugin) plugin.requestedPreferencesSection = null;
	},

	init() {
		if (this.initialized) return;
		try {
			if (typeof OCRFlowL10n !== "undefined") OCRFlowL10n.localize(this.$("docflow-prefpane"));
			this.initConfig?.();
			if(this.configStore?.()?.state!==undefined&&this.configStore().state!=="unlocked"){this.initNavigation();this.showSection("config");this.refreshConfig();return;}
			this.loadSettings();
			this.initNavigation();
			this.refreshConfig?.();
			this.$("docflow-prefpane")?.addEventListener("click",event=>{
				let button=event.target.closest?.("button");if(!button||button.disabled)return;
				button.setAttribute("data-result","");
				button.animate?.([{transform:"scale(1)"},{transform:"scale(.97)"},{transform:"scale(1)"}],{duration:200});
			},true);
			for (let index = 0; index < this.LLM_PROVIDER_LIMIT; index++) {
				this.$("mineru-llm-provider-" + index).addEventListener("click", () => this.switchLLMProvider(index));
			}
			this.$("mineru-llm-provider-add").addEventListener("click", () => this.addLLMProvider());
			this.$("mineru-llm-provider-delete").addEventListener("click", () => this.deleteLLMProvider());
			for (let kind of ["default", ...this.WORK_KINDS]) {
				this.$("ocrflow-work-" + kind + "-model").addEventListener("change", () => { this.updateWorkLabels(); this.setStatus("有未保存的修改"); });
			}
			for (let service of ["deepl", "deeplx"]) {
				this.$(`ocrflow-${service}-save`).addEventListener("click", () => this.persistSettings({ section: service }));
				this.$(`ocrflow-${service}-test`).addEventListener("click", () => this.testTitleService(service));
			}
			this.$("ocrflow-title-save").addEventListener("click", () => this.persistSettings({ section: "title" }));
			this.$("ocrflow-work-save").addEventListener("click", () => this.persistSettings({ section: "work" }));
			this.$("ocrflow-paddle-save")?.addEventListener("click", () => this.persistSettings({ section: "paddle" }));
			this.$("ocrflow-collation-a")?.addEventListener("change", () => this.renderOCRSources());
			for (let kind of this.WORK_KINDS) this.$("ocrflow-work-" + kind + "-reset").addEventListener("click", () => {
				this.$(this.workFieldID(kind, "prompt")).value = OCRFlowPrompts.defaults[kind];
				this.setStatus("有未保存的修改", false, "work");
			});
			for (let kind of this.WORK_KINDS) for (let field of ["prompt", "params"]) {
				this.$(this.workFieldID(kind, field)).addEventListener("input", () => this.setStatus("有未保存的修改", false, "work"));
			}
			let saveButton = this.$("mineru-save-button");
			if (saveButton) {
				saveButton.addEventListener("click", () => this.persistSettings());
			}
			this.$("mineru-open-queue-button")?.addEventListener("click", () => {
				Zotero.getMainWindow().DocFlow.openParseQueueDialog();
			});
			this.$("mineru-job-progress-button")?.addEventListener("click", () => {
				this.queryJobProgress().catch(e => {
					Zotero.logError(e);
					this.$("mineru-job-progress-output").textContent = ocrflowText(`查询失败: ${e.message || e}`);
				});
			});
			for (let [section, method] of [["markitdown", "testMarkItDownConnection"], ["mineru", "testMineruConnection"], ["marker", "testMarkerConnection"]]) {
				this.$(`ocrflow-${section}-save`).addEventListener("click", () => this.persistSettings({ section }));
				this.$(`ocrflow-${section}-test`).addEventListener("click", () => this[method]().catch(error => {
					Zotero.logError(error); this.setStatus(`测试失败：${error.message || error}`, true, section);
				}));
			}
			this.$("ocrflow-ai-save").addEventListener("click", () => this.persistSettings({ section: "ai" }));
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
					if (field.pref === "parserService") this.showService(input.value);
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
