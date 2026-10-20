// Shared by the settings pane and document conversion.
var OCRFlowMarkItDown = {
	async rpc(connection, method, params, id = 2) {
		let response = await fetch(connection.endpoint, {
			method: "POST", signal: connection.signal,
			headers: {
				"Content-Type": "application/json", "Accept": "application/json, text/event-stream",
				...(connection.protocolVersion ? { "MCP-Protocol-Version": connection.protocolVersion } : {}),
				...(connection.sessionID ? { "Mcp-Session-Id": connection.sessionID } : {})
			},
			body: JSON.stringify({ jsonrpc: "2.0", ...(id === null ? {} : { id }), method, ...(params ? { params } : {}) })
		});
		if (!response.ok) {
			let error = new Error(`MarkItDown MCP HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
			error.status = response.status;
			throw error;
		}
		connection.sessionID = response.headers?.get("mcp-session-id") || connection.sessionID;
		if (id === null) return;
		let text = await response.text();
		let payload;
		if (response.headers?.get("content-type")?.includes("text/event-stream")) {
			payload = text.split(/\r?\n\r?\n/).map(event => event.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n"))
				.filter(Boolean).map(data => JSON.parse(data)).find(message => message.id === id);
		} else payload = JSON.parse(text);
		if (!payload) throw new Error("MarkItDown MCP 未返回对应请求的结果。");
		if (payload.error) throw new Error(`MarkItDown MCP: ${payload.error.message || JSON.stringify(payload.error)}`);
		return payload.result;
	},

	async convert(connection, uri) {
		connection.beforeConvert?.();
		let result = await this.rpc(connection, "tools/call", { name: "convert_to_markdown", arguments: { uri } });
		let text = (result.content || []).filter(block => block.type === "text").map(block => block.text).join("\n");
		if (result.isError) throw new Error(`MarkItDown MCP 转换失败：${text.slice(0, 500)}`);
		return text;
	},

	async connect(address, signal) {
		let base = address.trim().replace(/\/+$/, "");
		if (!base) throw new Error("请填写 MarkItDown 服务地址。");
		if (!base.endsWith("/mcp")) {
			let response = await fetch(base + "/health", { signal });
			if (response.ok) return { mode: "rest", endpoint: base, signal, health: await response.json() };
			if (response.status !== 404) throw new Error(`MarkItDown 健康检查 HTTP ${response.status}`);
		}
		let connection = { mode: "mcp", endpoint: base.endsWith("/mcp") ? base + "/" : base + "/mcp/", signal };
		let initialized = await this.rpc(connection, "initialize", {
			protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "OCRFlow", version: "0.2.17" }
		}, 1);
		connection.protocolVersion = initialized.protocolVersion;
		connection.serverInfo = initialized.serverInfo;
		await this.rpc(connection, "notifications/initialized", null, null);
		return connection;
	},

	async testConnection(address, signal) {
		let connection = await this.connect(address, signal);
		if (connection.mode === "rest") return { interface: "HTTP REST", endpoint: connection.endpoint, health: connection.health };
		let result = await this.rpc(connection, "tools/list", {});
		if (!result.tools?.some(tool => tool.name === "convert_to_markdown")) throw new Error("MCP 服务未提供 convert_to_markdown 工具。");
		return { interface: "MCP", endpoint: connection.endpoint, server: connection.serverInfo, protocolVersion: connection.protocolVersion };
	}
};
