// Shared by the preferences pane and task execution so disabled choices cannot be bypassed.
var OCRFlowSources = {
	choices(providers) {
		return [
			{ value: "mineru-local", label: "MinerU（本地）" }, { value: "mineru-cloud", label: "MinerU（云端）" },
			{ value: "paddle-cloud", label: "PaddleOCR（官方 API）" }, { value: "paddle-local", label: "PaddleOCR（自部署 API）" },
			...providers.flatMap(provider => [1, 2].filter(slot => provider[slot === 1 ? "llmModel" : "llmModel2"]?.trim()).map(slot => ({
				value: `ai:${provider.id}:${slot}`, label: `${provider.llmProviderName || "服务商"} · ${provider[slot === 1 ? "llmModel" : "llmModel2"]}`
			})))
		];
	},
	identity(value, providers) {
		if (/^mineru-/.test(value)) return "mineru";
		if (/^paddle-/.test(value)) return "paddleocr";
		if (!value.startsWith("ai:")) return "";
		let modelID = value.slice(3), split = modelID.lastIndexOf(":"), slot = modelID.slice(split + 1);
		let provider = providers.find(p => p.id === modelID.slice(0, split));
		let model = provider?.[slot === "2" ? "llmModel2" : "llmModel"]?.trim().toLowerCase();
		if (!model || !["1", "2"].includes(slot)) return "";
		if (/mineru/.test(model)) return "mineru";
		if (/paddleocr/.test(model)) return "paddleocr";
		return "ai:" + model;
	},
	valid(a, b, providers) {
		let first = this.identity(a, providers), second = this.identity(b, providers);
		return !!first && !!second && first !== second;
	}
};
