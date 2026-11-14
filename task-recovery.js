var OCRFlowTaskRecovery = {
	fields: ["id", "kind", "title", "state", "detail", "error", "settings", "attachment", "parentItem", "source", "mineruSource",
		"explicitSource", "resultAttachment", "jobID", "cancelJobID", "cancelSettings", "displaySettings", "parsedResult", "translation",
		"partial", "force", "outlineRunID", "organizeSourceID", "metadataSourceID", "metadataCompleted", "renameCompleted", "organizeResults", "parseWarning",
		"cloudState", "cloudStateB", "paddleState", "paddleStateB", "localTaskState", "localTaskStateB", "secondJobID", "ocrBaseSaved", "aiCorrectedResult", "waitingForSource", "requiredParseID", "needsRecognition",
		"steps", "phase", "progress", "parts", "cancelFailed", "cancelRequested", "titleTranslation", "titleTranslationPending", "summaryResult", "metadataResult", "parentMetadata", "hasChangesReport", "collationStatus",
		"collationAIStatus", "collationAutoApplied", "collationFindings", "collationMissing"],
	serial: Promise.resolve(),

	async init(owner) {
		this.owner = owner;
		this.directory = PathUtils.join(Zotero.DataDirectory.dir, "ocrflow-tasks");
		this.path = PathUtils.join(this.directory, "queue.enc");
		await this.restore();
	},

	async storageKey() {
		if (!this.keyPromise) this.keyPromise = (async () => {
			let username = Zotero.DataDirectory.dir;
			let login = Services.logins.findLogins("chrome://docflow", null, "OCRFlow Task Recovery").find(login => login.username === username);
			let crypto = this.owner.config.crypto;
			if (!login) {
				if (await IOUtils.exists(this.path)) throw Error("任务恢复密钥不可用，请保留恢复记录并检查本机安全凭据。");
				let bytes = crypto.getRandomValues(new Uint8Array(32));
				login = Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(Ci.nsILoginInfo);
				login.init("chrome://docflow", null, "OCRFlow Task Recovery", username, this.base64(bytes), "", "");
				await Services.logins.addLoginAsync(login);
			}
			return crypto.subtle.importKey("raw", this.bytes(login.password), "AES-GCM", false, ["encrypt", "decrypt"]);
		})();
		try { return await this.keyPromise; }
		catch (error) { this.keyPromise = null; throw error; }
	},

	base64(bytes) {
		let chunks = [];
		for (let start = 0; start < bytes.length; start += 8192) chunks.push(String.fromCharCode(...bytes.subarray(start, start + 8192)));
		return btoa(chunks.join(""));
	},
	bytes(text) { return Uint8Array.from(atob(text), character => character.charCodeAt(0)); },

	pack(task) {
		let record = {};
		for (let name of this.fields) if (task[name] !== undefined) record[name] = task[name];
		record.waitingDecision = !!(task.decision || task.recoveryDecision);
		if (task.recoveryPaused && !task.cancelRequested && task.state !== "completed") {
			record.state = "queued"; record.error = "";
		}
		if (task.organizeStages) record.organizeStages = Object.fromEntries(Object.entries(task.organizeStages).map(([kind, stage]) =>
			[kind, {...stage, task:stage.task ? this.pack(stage.task) : undefined}]));
		if (task.state === "completed") for (let name of ["translation", "parsedResult", "organizeStages", "cloudState", "cloudStateB", "paddleState", "ocrBaseSaved", "aiCorrectedResult"]) delete record[name];
		return record;
	},

	encode(value) {
		let store = this;
		return JSON.stringify(value, function(name, entry) {
			// Zotero.Item.toJSON runs before the replacer; read the original holder value.
			let original = this[name];
			if (original?.libraryID && original.key && typeof original.getField === "function") return {$ocrflowItem:{libraryID:original.libraryID, key:original.key}};
			if (entry instanceof ArrayBuffer) return {$ocrflowBytes:store.base64(new Uint8Array(entry))};
			if (ArrayBuffer.isView(entry)) return {$ocrflowBytes:store.base64(new Uint8Array(entry.buffer, entry.byteOffset, entry.byteLength))};
			return entry;
		});
	},

	async decode(text) {
		let references = [], items = new Map(), store = this;
		let snapshot = JSON.parse(text, function(name, entry) {
			if (entry?.$ocrflowItem) { references.push({parent:this, name, item:entry.$ocrflowItem}); return null; }
			if (entry?.$ocrflowBytes !== undefined) return store.bytes(entry.$ocrflowBytes);
			return entry;
		});
		await Promise.all(references.map(async reference => {
			let {libraryID, key} = reference.item, identity = libraryID + ":" + key;
			if (!items.has(identity)) items.set(identity, (async () => {
				let item = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, key);
				if (item) await item.loadAllData();
				return item || null;
			})());
			reference.parent[reference.name] = await items.get(identity);
		}));
		let restoreItem = async entry => {
			if (!entry?.key || !entry.itemType || typeof entry.getField === "function") return entry;
			let identity = "legacy:" + (entry.libraryID || "") + ":" + entry.key;
			if (!items.has(identity)) items.set(identity, (async () => {
				let libraries = entry.libraryID ? [{libraryID:entry.libraryID}] : Zotero.Libraries.getAll();
				let matches = (await Promise.all(libraries.map(library => Zotero.Items.getByLibraryAndKeyAsync(library.libraryID, entry.key)))).filter(Boolean);
				if (matches.length > 1) throw Error(`旧任务条目 ${entry.key} 对应多个文献库，无法确定来源，请重新选择文献。`);
				let item = matches[0] || null;
				if (item) await item.loadAllData();
				return item;
			})());
			return items.get(identity);
		};
		let restoreTask = async task => {
			for (let name of ["attachment", "parentItem", "source", "mineruSource", "resultAttachment"]) {
				if (task[name]) task[name] = await restoreItem(task[name]);
			}
			if (task.ocrBaseSaved?.attachment) task.ocrBaseSaved.attachment = await restoreItem(task.ocrBaseSaved.attachment);
			for (let kind of Object.keys(task.organizeResults || {})) task.organizeResults[kind] = await restoreItem(task.organizeResults[kind]);
			for (let stage of Object.values(task.organizeStages || {})) if (stage.task) await restoreTask(stage.task);
		};
		for (let task of snapshot.tasks) await restoreTask(task);
		return snapshot;
	},

	async preserveTaskFiles(task) {
		for (let name of ["cloudState", "cloudStateB", "paddleState", "paddleStateB"]) {
			let work = task[name];
			if (!work?.parts) continue;
			let directory = PathUtils.join(this.directory, `task-${task.id}-${name}`);
			let relocated = false;
			for (let [index, part] of work.parts.entries()) {
				if (part.pages) { delete part.bytes; continue; }
				let destination = PathUtils.join(directory, "part-" + index);
				if (part.bytes) {
					await IOUtils.makeDirectory(directory, {createAncestors:true});
					await IOUtils.write(destination, part.bytes);
					part.path = destination; delete part.bytes; relocated = true;
				}
				if (part.result || !part.path || part.path.startsWith(this.directory + "/") || part.path.startsWith(this.directory + "\\")) continue;
				if (!await IOUtils.exists(part.path)) continue;
				await IOUtils.makeDirectory(directory, {createAncestors:true});
				if (!await IOUtils.exists(destination)) await IOUtils.copy(part.path, destination);
				part.path = destination; relocated = true;
			}
			if (relocated) work.dir = directory;
		}
	},

	schedule() {
		if (!this.loaded || this.stopping || this.timer || this.owner.config.state !== "unlocked") return;
		this.timer = setTimeout(() => { this.timer = null; this.flush().catch(() => {}); }, 5000);
	},

	fail(error, reading = false) {
		this.error = (reading ? "任务恢复记录读取失败：" : "任务恢复记录保存失败：") + error.message;
		Zotero.logError(error);
		this.owner.refreshParseQueueDialog();
	},

	flush() {
		if (this.closed) return Promise.resolve();
		clearTimeout(this.timer); this.timer = null;
		this.serial = this.serial.catch(() => {}).then(async () => {
			if (!this.loaded || this.owner.config.state !== "unlocked") return;
			if (!this.owner.parseQueue.length && !await IOUtils.exists(this.path)) return;
			for (let task of this.owner.parseQueue) await this.preserveTaskFiles(task);
			let text = this.encode({nextID:this.owner.parseQueueNextID, tasks:this.owner.parseQueue.map(task => this.pack(task))});
			let crypto = this.owner.config.crypto, key = await this.storageKey(), iv = crypto.getRandomValues(new Uint8Array(12));
			let data = await crypto.subtle.encrypt({name:"AES-GCM", iv}, key, new TextEncoder().encode(text));
			await IOUtils.makeDirectory(this.directory, {createAncestors:true});
			await IOUtils.writeUTF8(this.path, JSON.stringify({format:"ocrflow-tasks", version:1, iv:this.base64(iv), data:this.base64(new Uint8Array(data))}), {tmpPath:this.path + ".tmp"});
			let retained = new Set(this.owner.parseQueue.filter(task => task.state !== "completed").flatMap(task =>
				["cloudState", "cloudStateB", "paddleState", "paddleStateB"].map(name => task[name]?.dir).filter(Boolean)));
			for (let path of await IOUtils.getChildren(this.directory)) {
				let name = path.split(/[/\\]/).at(-1);
				if ((name.startsWith("ocrflow-cloud-") || /^task-\d+-(?:cloudState|paddleState)B?$/.test(name)) && !retained.has(path)) await IOUtils.remove(path, {recursive:true,ignoreAbsent:true});
			}
			let hadError = !!this.error; this.error = null;
			if (hadError) this.owner.refreshParseQueueDialog();
		});
		return this.serial.catch(error => { this.fail(error); throw error; });
	},

	restore() {
		if (this.loaded) return Promise.resolve();
		if (this.restoring) return this.restoring;
		this.restoring = this.read().finally(() => { this.restoring = null; });
		return this.restoring;
	},

	async read() {
		let exists = await IOUtils.exists(this.path);
		this.pendingUnlock = exists && this.owner.config.state !== "unlocked";
		if (this.owner.config.state !== "unlocked") {
			this.owner.refreshParseQueueDialog();
			return;
		}
		try {
			if (exists) {
				let envelope = JSON.parse(await IOUtils.readUTF8(this.path));
				if (envelope.format !== "ocrflow-tasks" || envelope.version !== 1) throw Error("任务恢复记录格式无法识别。");
				let data = await this.owner.config.crypto.subtle.decrypt({name:"AES-GCM", iv:this.bytes(envelope.iv)}, await this.storageKey(), this.bytes(envelope.data));
				let snapshot = await this.decode(new TextDecoder().decode(data));
				for (let task of snapshot.tasks) {
					if (!task.attachment || task.attachment.deleted) { task.state = "failed"; task.error = "恢复任务的来源条目已删除，请重新选择文献。"; }
					else if (task.waitingDecision) { task.state = "waiting"; task.recoveryDecision = true; task.detail = "任务进度已恢复，请确认后继续"; }
					else if (task.cancelRequested || task.state === "stopping") task.state = "canceled";
					else if (["running", "queued", "waiting_dependency"].includes(task.state)) {
						let jobID = Object.hasOwn(task, "cancelJobID") ? task.cancelJobID : task.jobID;
						let uncertain = !jobID && /^(提交 Marker 任务|提交 Datalab 任务|提交解析任务)/.test(task.phase || "") ||
							[task.paddleState, task.paddleStateB].some(work => work?.parts?.some(part => part.submitting && !part.jobID));
						task.state = uncertain ? "waiting" : "queued";
						task.detail = uncertain ? "上次提交结果未确认，请核对服务端任务后重试" : "任务进度已恢复，等待继续";
					}
					delete task.waitingDecision;
				}
				let pending = this.owner.parseQueue, ids = new Set(snapshot.tasks.map(task => task.id)), reassigned = new Map();
				let nextID = Math.max(this.owner.parseQueueNextID, snapshot.nextID || 1,
					...snapshot.tasks.map(task => task.id + 1), ...pending.map(task => task.id + 1));
				for (let task of pending) {
					let previousID = task.id;
					if (ids.has(task.id)) task.id = nextID++;
					ids.add(task.id); reassigned.set(previousID, task.id);
				}
				for (let task of pending) if (reassigned.has(task.requiredParseID)) task.requiredParseID = reassigned.get(task.requiredParseID);
				this.owner.parseQueue = [...snapshot.tasks, ...pending];
				this.owner.parseQueueNextID = nextID;
			}
			this.loaded = true; this.pendingUnlock = false; this.error = null;
			this.owner.refreshParseQueueDialog();
			this.owner.processParseQueue().catch(error => this.fail(error));
		} catch (error) { this.fail(error, true); }
	},

	async shutdown() {
		this.stopping = true; this.owner.parseQueueStopped = true; clearTimeout(this.timer);
		let saving = [];
		for (let task of this.owner.parseQueue) {
			if (task.state !== "running" && !task.active) continue;
			task.recoveryPaused = true; task.recoveryDecision = !!task.decision;
			if (task.saving) { if (task.workPromise) saving.push(task.workPromise); continue; }
			let error = Error("插件更新暂停任务"); error.name = "TaskRecoveryPause";
			task.controller?.abort(error);
		}
		await Promise.allSettled(saving);
		let timer;
		try { await Promise.race([Promise.allSettled([...(this.owner.parseQueueWork || [])]), new Promise(resolve => { timer = setTimeout(resolve, 10000); })]); }
		finally { clearTimeout(timer); }
		await this.flush();
		this.closed = true;
	}
};
