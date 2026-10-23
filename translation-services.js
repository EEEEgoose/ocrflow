// Text-only translation adapters shared by workflows and connection tests.
var OCRFlowTitleServices = {
	async translate(text, settings, signal) {
		if (!settings.targetLang?.trim()) throw new Error("请指定标题翻译的目标语言。");
		let endpoint, headers = { "Content-Type": "application/json" }, body;
		if (settings.service === "deepl") {
			let key = (settings.deeplApiKey || "").trim().replace(/^DeepL-Auth-Key\s+/i, "");
			if (!key) throw new Error("请先填写并保存 DeepL API Key。");
			endpoint = settings.deeplPlan === "pro" ? "https://api.deepl.com/v2/translate" : "https://api-free.deepl.com/v2/translate";
			headers.Authorization = "DeepL-Auth-Key " + key;
			body = { text: [text], target_lang: settings.targetLang };
		} else if (settings.service === "deeplx") {
			endpoint = (settings.deeplxEndpoint || "").trim();
			if (!endpoint) throw new Error("请填写并保存 DeepLX /translate 的完整接口地址。");
			let token = (settings.deeplxToken || "").trim().replace(/^Bearer\s+/i, "");
			if (token) headers.Authorization = "Bearer " + token;
			body = { text, source_lang: "auto", target_lang: settings.targetLang };
		} else throw new Error("不支持的标题翻译服务。");
		let controller = new (Zotero.getMainWindow().AbortController)(), abort = () => controller.abort();
		signal?.throwIfAborted();
		signal?.addEventListener("abort", abort, { once: true });
		let timer = setTimeout(abort, 30000);
		try {
			let response = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
			let raw = await response.text(), data;
			try { data = JSON.parse(raw); } catch { throw new Error(`${settings.service} HTTP ${response.status}：${raw.slice(0, 300) || "空响应"}`); }
			if (!response.ok || data.error || (settings.service === "deeplx" && data.code !== 200)) {
				throw new Error(`${settings.service} HTTP ${response.status}：${data.message || data.error?.message || raw.slice(0, 300)}`);
			}
			let result = settings.service === "deepl" ? data.translations?.[0]?.text : data.data;
			if (typeof result !== "string" || !result.trim()) throw new Error("标题翻译服务未返回译文，原短标题已保留。");
			return { text: result.trim(), sourceLanguage: settings.service === "deepl" ? data.translations[0].detected_source_language : data.source_lang };
		} catch (error) {
			if (controller.signal.aborted && !signal?.aborted) throw new Error("标题翻译请求超时（30 秒）。");
			throw error;
		} finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
	}
};
