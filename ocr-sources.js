// Shared by the preferences pane and task execution so disabled choices cannot be bypassed.
var OCRFlowSources = {
	choices(providers) {
		return [
			{ value: "marker-cloud", label: "Marker（在线 API）" },
			{ value: "marker-local", label: "Marker（自部署 API）" },
			{ value: "mineru-local", label: "MinerU（自部署 API）" }, { value: "mineru-cloud", label: "MinerU（在线 API）" },
			{ value: "paddle-cloud", label: "PaddleOCR（在线 API）" }, { value: "paddle-local", label: "PaddleOCR（自部署 API）" },
			...providers.flatMap(provider => [1, 2].filter(slot => provider[slot === 1 ? "llmModel" : "llmModel2"]?.trim()).map(slot => ({
				value: `ai:${provider.id}:${slot}`, label: `${provider.llmProviderName || "服务商"} · ${provider[slot === 1 ? "llmModel" : "llmModel2"]}`
			})))
		].map(choice => ({...choice, label: !choice.value.startsWith("ai:") && typeof OCRFlowL10n !== "undefined" ? OCRFlowL10n.text(choice.label) : choice.label}));
	},
	identity(value, providers) {
		if (value === "marker" || /^marker-/.test(value)) return "marker";
		if (/^mineru-/.test(value)) return "mineru";
		if (/^paddle-/.test(value)) return "paddleocr";
		if (!value.startsWith("ai:")) return "";
		let modelID = value.slice(3), split = modelID.lastIndexOf(":"), slot = modelID.slice(split + 1);
		let provider = providers.find(p => p.id === modelID.slice(0, split));
		let model = provider?.[slot === "2" ? "llmModel2" : "llmModel"]?.trim().toLowerCase();
		if (!model || !["1", "2"].includes(slot)) return "";
		if (/mineru/.test(model)) return "mineru";
		if (/paddleocr/.test(model)) return "paddleocr";
		if (/marker|surya/.test(model)) return "marker";
		return "ai:" + model;
	},
	valid(a, b, providers) {
		let first = this.identity(a, providers), second = this.identity(b, providers);
		return !!first && !!second && first !== second;
	}
};
