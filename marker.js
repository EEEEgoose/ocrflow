// Marker official FastAPI upload endpoint; shared with the settings connection test.
var OCRFlowMarker = {
	baseURL(address) {
		let base = String(address || "").trim().replace(/\/+$/, "").replace(/\/(?:marker\/upload|openapi\.json)$/, "");
		if (!base) throw new Error("请填写 Marker API 服务地址；Streamlit 网页地址不能用于插件调用。");
		return base;
	},

	async request(url, options) {
		let response = await fetch(url, options);
		if (!response.ok) { let error = new Error(`Marker HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`); error.status = response.status; throw error; }
		let text = await response.text();
		if (/^\s*</.test(text)) throw new Error("此地址返回网页而非 Marker API。请使用 marker_server 的地址，不是 marker_gui / Streamlit 网页地址。");
		let data;
		try { data = JSON.parse(text); } catch (_) { throw new Error("Marker API 未返回有效 JSON。"); }
		if (data.success === false) throw new Error("Marker 解析失败：" + (data.error || "服务未返回错误详情"));
		return data;
	},

	// Servers that accept a client-chosen job_id report it in the upload form schema.
	async acceptsJobID(base, headers, signal) {
		let schema = await this.request(base + "/openapi.json", {headers, signal});
		let body = schema.paths?.["/v1/parse/jobs"]?.post?.requestBody?.content?.["multipart/form-data"]?.schema;
		if (body?.$ref) body = schema.components?.schemas?.[body.$ref.split("/").at(-1)];
		return !!body?.properties?.job_id;
	},

	async testConnection(address, token, signal) {
		let base = this.baseURL(address), headers = token ? {Authorization:`Bearer ${token}`} : {};
		let schema = await this.request(base + "/openapi.json", {headers, signal});
		if (!schema.paths?.["/v1/parse/jobs"]?.post) throw new Error("该服务尚未启用 Marker 任务与进度接口，请更新服务端。");
		return {endpoint:base + "/v1/parse/jobs", title:schema.info?.title || "Marker API"};
	}
};
