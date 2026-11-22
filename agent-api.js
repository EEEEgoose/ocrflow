// Local MCP endpoint on Zotero's HTTP server, so AI agents can run OCRFlow actions.
Object.assign(DocFlow, {
	AGENT_PATH: "/ocrflow/mcp",
	// 2026-07-28 clients send the version with every request; older clients use the initialize handshake.
	AGENT_MODERN_PROTOCOL: "2026-07-28",
	AGENT_PROTOCOLS: ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"],
	AGENT_VERSION_KEY: "io.modelcontextprotocol/protocolVersion",

	registerAgentEndpoint() {
		let owner = this, codes = Zotero.Server.responseCodes;
		// Zotero's status table lacks these; without them the status line reads "undefined".
		codes[202] ||= "Accepted"; codes[401] ||= "Unauthorized"; codes[405] ||= "Method Not Allowed";
		let Endpoint = function () {};
		Endpoint.prototype = { supportedMethods: ["GET", "POST", "DELETE"], supportedDataTypes: ["application/json"],
			init: request => owner.handleAgentRequest(request) };
		Zotero.Server.Endpoints[this.AGENT_PATH] = Endpoint;
	},

	unregisterAgentEndpoint() {
		delete Zotero.Server.Endpoints[this.AGENT_PATH];
	},

	agentActionIDs() {
		return { organize: "docflow-organize", parse: this.CONTEXT_MENU_ID, create_parent: "docflow-create-parent", fill_metadata: "docflow-fill-metadata",
			summarize: this.SUMMARY_MENU_ID, translate: this.TRANSLATE_MENU_ID, translate_title: "docflow-translate-title", outline: "docflow-generate-outline" };
	},

	agentServices() {
		return this.getOCRMenuDefinitions().map(definition => definition.id.slice("docflow-ocr-".length));
	},

	async handleAgentRequest({ method, headers, data }) {
		let text = (status, body) => [status, "text/plain; charset=utf-8", body];
		let enabled, token;
		try {
			enabled = this.getPref(this.PREF_BRANCH + "agentEnabled", true);
			token = this.getPref(this.PREF_BRANCH + "agentToken", true);
		} catch (error) { return text(503, error.message); }
		if (!enabled || !token) return text(403, "OCRFlow Agent 接入未启用。");
		if (headers.authorization !== `Bearer ${token}`) return text(401, "访问令牌无效。");
		if (method !== "POST") return [405, { "Content-Type": "text/plain; charset=utf-8", Allow: "POST" }, "仅支持 POST。"];
		if (!data || typeof data !== "object") return text(400, "请求内容必须是 JSON-RPC 消息。");
		if (!Array.isArray(data) && (data.method === "server/discover" || data.params?._meta?.[this.AGENT_VERSION_KEY] !== undefined)) {
			let [status, body] = await this.handleModernAgentMessage(data, headers);
			return body ? [status, "application/json; charset=utf-8", JSON.stringify(body)] : status;
		}
		let replies = Array.isArray(data) ? (await Promise.all(data.map(message => this.handleAgentMessage(message)))).filter(Boolean) : await this.handleAgentMessage(data);
		return replies && (!Array.isArray(replies) || replies.length) ? [200, "application/json; charset=utf-8", JSON.stringify(replies)] : 202;
	},

	async handleAgentMessage(message) {
		// Notifications and client responses carry no reply.
		if (message?.id === undefined || message.id === null || typeof message.method !== "string") return null;
		let reply = result => ({ jsonrpc: "2.0", id: message.id, result });
		if (message.method === "initialize") {
			let requested = message.params?.protocolVersion;
			return reply({ protocolVersion: this.AGENT_PROTOCOLS.includes(requested) ? requested : this.AGENT_PROTOCOLS[0],
				capabilities: { tools: {} }, serverInfo: this.agentServerInfo() });
		}
		if (message.method === "ping") return reply({});
		if (message.method === "tools/list") return reply({ tools: this.agentTools() });
		if (message.method === "tools/call") return reply(await this.callAgentTool(message.params?.name, message.params?.arguments || {}));
		return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } };
	},

	agentServerInfo() {
		return { name: "OCRFlow", version: this.version };
	},

	// Stateless protocol: returns [HTTP status, JSON-RPC body or null].
	async handleModernAgentMessage(message, headers) {
		let version = message.params?._meta?.[this.AGENT_VERSION_KEY];
		let error = (status, code, text, data) => [status, { jsonrpc: "2.0", ...(message.id == null ? {} : { id: message.id }),
			error: { code, message: text, ...(data ? { data } : {}) } }];
		if (version === undefined) return error(400, -32602, "Missing protocol version");
		if (version !== this.AGENT_MODERN_PROTOCOL) return error(400, -32022, "Unsupported protocol version",
			{ supported: [this.AGENT_MODERN_PROTOCOL, ...this.AGENT_PROTOCOLS], requested: version });
		if (headers["mcp-protocol-version"] && headers["mcp-protocol-version"] !== version) return error(400, -32020, "Header mismatch");
		if (message.id === undefined || message.id === null) return [202, null];
		let result = body => [200, { jsonrpc: "2.0", id: message.id,
			result: { resultType: "complete", ...body, _meta: { "io.modelcontextprotocol/serverInfo": this.agentServerInfo() } } }];
		let cache = { ttlMs: 3600000, cacheScope: "public" };
		if (message.method === "server/discover") return result({ supportedVersions: [this.AGENT_MODERN_PROTOCOL], capabilities: { tools: {} }, ...cache });
		if (message.method === "tools/list") return result({ tools: this.agentTools(), ...cache });
		if (message.method === "tools/call") return result(await this.callAgentTool(message.params?.name, message.params?.arguments || {}));
		return error(404, -32601, `Method not found: ${message.method}`);
	},

	agentTools() {
		let item = { type: "string", description: "Zotero 条目 key（如 ABCD1234）或数字 ID，可以是父条目或附件" };
		let libraryID = { type: "integer", description: "条目 key 所在的文库 ID，默认个人文库" };
		return [
			{ name: "ocrflow_run", description: "对 Zotero 条目执行 OCRFlow 操作。任务进入 OCRFlow 队列后立即返回任务 ID，用 ocrflow_tasks 查看进度。操作会调用已配置的识别或 AI 服务（可能产生费用），并把结果写入文库；create_parent、fill_metadata、organize 会修改条目信息。",
				inputSchema: { type: "object", required: ["action", "items"], properties: {
					action: { type: "string", enum: Object.keys(this.agentActionIDs()), description: "organize 一键整理；parse 识别文档；create_parent 为独立文件建立父条目；fill_metadata 补全条目信息；summarize 总结；translate 翻译全文；translate_title 翻译标题；outline 生成 PDF 大纲" },
					items: { type: "array", minItems: 1, items: item },
					libraryID,
					service: { type: "string", enum: this.agentServices(), description: "仅用于 parse：识别服务；省略时使用设置中的默认服务" },
					dryRun: { type: "boolean", description: "为 true 时只返回会生成的任务数，不执行" } } } },
			{ name: "ocrflow_tasks", description: "查看 OCRFlow 任务队列。attachment 是任务处理的文件附件 key，parent 是它的父条目 key（传入父条目时任务落在其下的附件上）。state 取值：queued、waiting、waiting_dependency、running、stopping、completed、failed、canceled、wait_expired。",
				inputSchema: { type: "object", properties: { ids: { type: "array", items: { type: "integer" }, description: "只返回这些任务；省略时返回全部" } } } },
			{ name: "ocrflow_cancel", description: "终止排队或运行中的 OCRFlow 任务。",
				inputSchema: { type: "object", required: ["id"], properties: { id: { type: "integer" } } } },
			{ name: "ocrflow_get_result", description: "读取文献的 OCRFlow 结果：markdown 为识别全文，translation 为译文，summary 为总结笔记（HTML）。返回的 resultItem 是结果本身（Markdown 附件、译文附件或笔记）的 key，attachment 和 parent 是原文件与父条目的 key。全文较长时用 offset 和 limit 分段读取。",
				inputSchema: { type: "object", required: ["item"], properties: { item, libraryID,
					kind: { type: "string", enum: ["markdown", "translation", "summary"], description: "默认 markdown" },
					offset: { type: "integer", minimum: 0, description: "起始字符位置，默认 0" },
					limit: { type: "integer", minimum: 1, description: "最多返回的字符数，默认 50000" } } } }
		];
	},

	async callAgentTool(name, args) {
		try {
			let run = { ocrflow_run: () => this.runAgentAction(args), ocrflow_tasks: () => this.listAgentTasks(args),
				ocrflow_cancel: () => this.cancelAgentTask(args), ocrflow_get_result: () => this.readAgentResult(args) }[name];
			if (!run) throw new Error(`未知工具：${name}`);
			return { content: [{ type: "text", text: JSON.stringify(await run(), null, 2) }] };
		} catch (error) {
			return { content: [{ type: "text", text: error?.message || String(error) }], isError: true };
		}
	},

	agentItems(keys, libraryID = Zotero.Libraries.userLibraryID) {
		if (!Array.isArray(keys) || !keys.length) throw new Error("请提供至少一个条目 key。");
		return keys.map(key => {
			let item = /^\d+$/.test(String(key)) ? Zotero.Items.get(Number(key)) : Zotero.Items.getByLibraryAndKey(libraryID, String(key));
			if (!item || item.deleted) throw new Error(`找不到条目：${key}`);
			return item;
		});
	},

	agentTask(task) {
		return { id: task.id, kind: task.kind, state: task.state, title: task.title, detail: task.detail, error: task.error || "",
			progress: task.progress ?? null, attachment: task.attachment?.key, parent: this.parentForDocument(task.attachment)?.key ?? null, libraryID: task.attachment?.libraryID };
	},

	async runAgentAction({ action, items, libraryID, service, dryRun }) {
		let definition = this.getContextMenuDefinitions().find(row => row.id === this.agentActionIDs()[action]);
		if (!definition) throw new Error(`未知操作：${action}`);
		if (service) {
			if (action !== "parse") throw new Error("只有 parse 操作可以指定识别服务。");
			definition = definition.children.find(row => row.id === `docflow-ocr-${service}`);
			if (!definition) throw new Error(`未知的识别服务：${service}`);
		}
		let selectedItems = this.agentItems(items, libraryID);
		if (dryRun) return { action, tasks: definition.getTasks(selectedItems).length };
		let firstID = this.parseQueueNextID;
		// run() resolves only after the whole queue drains; return as soon as the tasks are queued.
		let running = definition.run({ window: null, selectedItems });
		running.catch(error => Zotero.logError(error));
		await Promise.race([running, new Promise(resolve => setTimeout(resolve, 0))]);
		let tasks = this.parseQueue.filter(task => task.id >= firstID).map(task => this.agentTask(task));
		return tasks.length ? { action, tasks } : { action, tasks, message: "没有新建任务：相同任务已在队列中，或已有任务被重新排队。用 ocrflow_tasks 查看。" };
	},

	listAgentTasks({ ids } = {}) {
		let wanted = Array.isArray(ids) && ids.length ? new Set(ids) : null;
		return { tasks: this.parseQueue.filter(task => !wanted || wanted.has(task.id)).map(task => this.agentTask(task)) };
	},

	async cancelAgentTask({ id }) {
		let task = this.parseQueue.find(row => row.id === id);
		if (!task) throw new Error(`找不到任务：${id}`);
		await this.cancelParseQueueTask(id);
		return this.agentTask(task);
	},

	async readAgentResult({ item, kind = "markdown", libraryID, offset = 0, limit = 50000 }) {
		if (!["markdown", "translation", "summary"].includes(kind)) throw new Error("kind 只能是 markdown、translation 或 summary。");
		let tasks = this.collectDocumentTasks(this.agentItems([item], libraryID));
		if (tasks.length !== 1) throw new Error(tasks.length ? "该条目下有多个文档，请改用附件 key。" : "没有找到文档附件。");
		let { attachment, source, parentItem } = tasks[0], result, text;
		if (kind === "summary") {
			result = parentItem?.getNotes().map(id => Zotero.Items.get(id)).find(note => note && !note.deleted &&
				note.hasTag("#DocFlow-Summary") && (note.relatedItems || []).includes(attachment.key));
			if (!result) throw new Error("还没有总结。");
			text = result.getNote();
		} else {
			result = kind === "translation" ? source && this.findDocumentTranslation(source) : source;
			if (!result) throw new Error(kind === "translation" ? "还没有译文。" : "还没有识别结果，请先执行 parse。");
			text = (await this.readSourceMarkdown(result)).markdown;
		}
		return { resultItem: result.key, attachment: attachment.key, parent: parentItem?.key ?? null, kind, total: text.length, offset, text: text.slice(offset, offset + limit) };
	}
});
