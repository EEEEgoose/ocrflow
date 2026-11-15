var OCRFlowTaskRecovery = {
	fields: ["id", "kind", "title", "state", "detail", "error", "settings", "attachment", "parentItem", "source", "mineruSource",
		"explicitSource", "resultAttachment", "jobID", "cancelJobID", "cancelSettings", "displaySettings", "parsedResult", "translation",
		"partial", "force", "outlineRunID", "organizeSourceID", "metadataSourceID", "metadataCompleted", "renameCompleted", "organizeResults", "parseWarning",
		"cloudState", "cloudStateB", "paddleState", "paddleStateB", "localTaskState", "localTaskStateB", "secondJobID", "ocrBaseSaved", "aiCorrectedResult", "waitingForSource", "requiredParseID", "needsRecognition",
		"steps", "phase", "progress", "parts", "cancelFailed", "cancelRequested", "titleTranslation", "titleTranslationPending", "summaryResult", "metadataResult", "parentMetadata", "hasChangesReport", "collationStatus",
		"collationAIStatus", "collationAutoApplied", "collationFindings", "collationMissing", "stage", "submitJobID"],
	// Stage names are persisted: never rename one, only add new names.
	stages: ["submitting", "submitted", "processing", "saving", "saved", "uploading", "rejected"],
	secretFields: ["apiToken", "apiKey", "token", "deeplApiKey", "deeplxToken", "llmApiKey"],
	secretPrefs: ["apiToken", "apiKey", "cloud.apiToken", "local.apiToken", "llmApiKey", "marker.token", "marker.cloud.token", "paddle.cloud.token", "paddle.local.token", "deeplApiKey", "deeplxToken"],
	version: 3,
	serial: Promise.resolve(),

	async init(owner) {
		this.owner = owner;
		this.directory = PathUtils.join(Zotero.DataDirectory.dir, "ocrflow-tasks");
		this.path = PathUtils.join(this.directory, "queue.enc");
		this.indexPath = PathUtils.join(this.directory, "index.json");
		this.tasksDirectory = PathUtils.join(this.directory, "tasks");
		this.stored = new Map(); this.caches = new Map(); this.storedIndex = null;
		await this.restore();
	},

	taskDirectory(id) { return PathUtils.join(this.tasksDirectory, String(id)); },
	cacheFor(id) {
		if (!this.caches.has(id)) this.caches.set(id, {text:new Map(), binary:new WeakMap()});
		return this.caches.get(id);
	},

	// Only reads the key of a legacy encrypted record; new records are not encrypted.
	async storageKey() {
		if (!this.keyPromise) this.keyPromise = (async () => {
			let username = Zotero.DataDirectory.dir;
			let login = Services.logins.findLogins("chrome://docflow", null, "OCRFlow Task Recovery").find(login => login.username === username);
			if (!login) throw Error("任务恢复密钥不可用，请保留恢复记录并检查本机安全凭据。");
			return this.owner.config.crypto.subtle.importKey("raw", this.bytes(login.password), "AES-GCM", false, ["encrypt", "decrypt"]);
		})();
		try { return await this.keyPromise; }
		catch (error) { this.keyPromise = null; throw error; }
	},

	base64(bytes) {
		let chunks = [];
		for (let start = 0; start < bytes.length; start += 8192) chunks.push(String.fromCharCode(...bytes.subarray(start, start + 8192)));
		return btoa(chunks.join(""));
	},
	bytes(text) {
		let length = text.length * 3 / 4 - (text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0);
		let bytes = new Uint8Array(length), offset = 0;
		for (let start = 0; start < text.length; start += 32768) {
			let chunk = atob(text.slice(start, start + 32768));
			for (let index = 0; index < chunk.length; index++) bytes[offset++] = chunk.charCodeAt(index);
		}
		return bytes;
	},

	// Secrets are saved as the name of the configuration entry that holds them and read again on restore.
	readSecretPref(name) {
		let value = this.owner.getPref(this.owner.PREF_BRANCH + name, true);
		return typeof value === "string" ? value.trim() : "";
	},
	providers() {
		try { let providers = JSON.parse(this.readSecretPref("llmProviders") || "[]"); return Array.isArray(providers) ? providers : []; }
		catch (_error) { return []; }
	},
	secretSlots() {
		let slots = new Map(), add = (slot, value) => {
			value = typeof value === "string" ? value.trim() : "";
			if (!value) return;
			if (!slots.has(value)) slots.set(value, {slot});
			let bare = value.replace(/^Bearer\s+/i, "");
			if (bare !== value && !slots.has(bare)) slots.set(bare, {slot, bare:true});
		};
		for (let name of this.secretPrefs) add("pref:" + name, this.readSecretPref(name));
		for (let [index, provider] of this.providers().entries()) add("provider:" + (provider?.id || "provider-" + index), provider?.llmApiKey);
		return slots;
	},
	secretValue(reference) {
		let slot = typeof reference?.slot === "string" ? reference.slot : "", value = "";
		if (slot.startsWith("pref:") && this.secretPrefs.includes(slot.slice(5))) value = this.readSecretPref(slot.slice(5));
		else if (slot.startsWith("provider:")) {
			let provider = this.providers().find((provider, index) => (provider?.id || "provider-" + index) === slot.slice(9));
			value = typeof provider?.llmApiKey === "string" ? provider.llmApiKey.trim() : "";
		}
		return reference?.bare ? value.replace(/^Bearer\s+/i, "") : value;
	},

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

	encode(value, resources = null, cache = null, secrets = null) {
		let store = this;
		return JSON.stringify(value, function(name, entry) {
			// Zotero.Item.toJSON runs before the replacer; read the original holder value.
			let original = this[name];
			if (original?.libraryID && original.key && typeof original.getField === "function") return {$ocrflowItem:{libraryID:original.libraryID, key:original.key}};
			if (secrets && store.secretFields.includes(name) && typeof original === "string" && original.trim()) return {$ocrflowSecret:secrets().get(original.trim()) || null};
			if (resources && typeof original === "string" && original.length >= 65536) {
				let path = cache.text.get(original);
				if (!path) cache.text.set(original, path = "files/" + store.owner.makeDataID("text") + ".txt");
				resources.set(path, {text:original});
				return {$ocrflowText:path};
			}
			if (resources && (original instanceof ArrayBuffer || ArrayBuffer.isView(original))) {
				let path = cache.binary.get(original);
				if (!path) cache.binary.set(original, path = "files/" + store.owner.makeDataID("binary") + ".bin");
				resources.set(path, {bytes:original instanceof ArrayBuffer ? new Uint8Array(original) : new Uint8Array(original.buffer, original.byteOffset, original.byteLength)});
				return {$ocrflowFile:path};
			}
			if (entry instanceof ArrayBuffer) return {$ocrflowBytes:store.base64(new Uint8Array(entry))};
			if (ArrayBuffer.isView(entry)) return {$ocrflowBytes:store.base64(new Uint8Array(entry.buffer, entry.byteOffset, entry.byteLength))};
			return entry;
		});
	},

	async decode(text, base, cache) {
		let references = [], fileReferences = [], items = new Map(), store = this;
		let value = JSON.parse(text, function(name, entry) {
			if (entry?.$ocrflowItem) { references.push({parent:this, name, item:entry.$ocrflowItem}); return null; }
			if (entry?.$ocrflowFile) { fileReferences.push({parent:this, name, path:entry.$ocrflowFile}); return null; }
			if (entry?.$ocrflowText) { fileReferences.push({parent:this, name, path:entry.$ocrflowText, text:true}); return null; }
			if (entry && Object.hasOwn(entry, "$ocrflowSecret")) return store.secretValue(entry.$ocrflowSecret);
			if (entry?.$ocrflowBytes !== undefined) return store.bytes(entry.$ocrflowBytes);
			return entry;
		});
		for (let reference of fileReferences) {
			let parts = String(reference.path).split("/");
			if (parts.some(part => !part || part === "." || part === "..")) throw Error("任务恢复记录格式无法识别。");
			let path = PathUtils.join(base, ...parts);
			if (reference.text) {
				let text = await IOUtils.readUTF8(path);
				reference.parent[reference.name] = text;
				cache?.text.set(text, reference.path);
				continue;
			}
			let bytes = await IOUtils.read(path);
			reference.parent[reference.name] = bytes;
			cache?.binary.set(bytes, reference.path);
		}
		await Promise.all(references.map(async reference => {
			let {libraryID, key} = reference.item, identity = libraryID + ":" + key;
			if (!items.has(identity)) items.set(identity, (async () => {
				let item = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, key);
				if (item) await item.loadAllData();
				return item || null;
			})());
			reference.parent[reference.name] = await items.get(identity);
		}));
		return value;
	},

	async restoreTask(task, items = new Map()) {
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
		for (let name of ["attachment", "parentItem", "source", "mineruSource", "resultAttachment"]) {
			if (task[name]) task[name] = await restoreItem(task[name]);
		}
		if (task.ocrBaseSaved?.attachment) task.ocrBaseSaved.attachment = await restoreItem(task.ocrBaseSaved.attachment);
		for (let kind of Object.keys(task.organizeResults || {})) task.organizeResults[kind] = await restoreItem(task.organizeResults[kind]);
		for (let stage of Object.values(task.organizeStages || {})) if (stage.task) await this.restoreTask(stage.task, items);
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
					await IOUtils.write(destination, part.bytes, {tmpPath:destination + ".tmp"});
					part.path = destination; delete part.bytes; relocated = true;
				}
				if (part.result || !part.path || part.path.startsWith(this.directory + "/") || part.path.startsWith(this.directory + "\\")) continue;
				if (!await IOUtils.exists(part.path)) continue;
				await IOUtils.makeDirectory(directory, {createAncestors:true});
				if (!await IOUtils.exists(destination)) {
					await IOUtils.copy(part.path, destination + ".tmp");
					await IOUtils.move(destination + ".tmp", destination);
				}
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
		let message = error?.message || error?.name || String(error ?? "未知错误");
		this.error = (reading ? "任务恢复记录读取失败：" : "任务恢复记录保存失败：") + message;
		Zotero.logError(error);
		this.owner.refreshParseQueueDialog();
	},

	async writeFile(path, value) {
		await IOUtils.makeDirectory(PathUtils.parent(path), {createAncestors:true});
		if (typeof value === "string") await IOUtils.writeUTF8(path, value, {tmpPath:path + ".tmp"});
		else await IOUtils.write(path, value, {tmpPath:path + ".tmp"});
	},

	// Each task is saved in its own directory and rewritten only when its record changes.
	flush() {
		if (this.closed) return Promise.resolve();
		clearTimeout(this.timer); this.timer = null;
		this.serial = this.serial.catch(() => {}).then(async () => {
			if (!this.loaded || this.owner.config.state !== "unlocked") return;
			let queue = this.owner.parseQueue;
			if (!queue.length && !this.stored.size && !this.legacy && !await IOUtils.exists(this.indexPath)) return;
			let slots, secrets = () => slots ||= this.secretSlots(), ids = new Set();
			for (let task of queue) {
				ids.add(task.id);
				await this.preserveTaskFiles(task);
				let cache = this.cacheFor(task.id), resources = new Map();
				let text = this.encode({format:"ocrflow-task", schema:this.version, task:this.pack(task)}, resources, cache, secrets);
				if (this.stored.get(task.id) === text) continue;
				let directory = this.taskDirectory(task.id);
				for (let [name, resource] of resources) {
					let path = PathUtils.join(directory, ...name.split("/"));
					if (!await IOUtils.exists(path)) await this.writeFile(path, resource.text ?? resource.bytes);
				}
				await this.writeFile(PathUtils.join(directory, "task.json"), text);
				this.stored.set(task.id, text);
				let files = PathUtils.join(directory, "files");
				if (await IOUtils.exists(files)) {
					let retained = new Set([...resources.keys()].map(name => PathUtils.join(directory, ...name.split("/"))));
					for (let path of await IOUtils.getChildren(files)) if (!retained.has(path)) await IOUtils.remove(path, {ignoreAbsent:true});
				}
				for (let [value, path] of cache.text) if (!resources.has(path)) cache.text.delete(value);
			}
			for (let id of [...this.stored.keys()]) if (!ids.has(id)) {
				await IOUtils.remove(this.taskDirectory(id), {recursive:true, ignoreAbsent:true});
				this.stored.delete(id); this.caches.delete(id);
			}
			let index = JSON.stringify({format:"ocrflow-tasks", version:this.version, nextID:this.owner.parseQueueNextID, order:queue.map(task => task.id)});
			if (index !== this.storedIndex) { await this.writeFile(this.indexPath, index); this.storedIndex = index; }
			if (this.legacy) {
				await IOUtils.remove(this.path, {ignoreAbsent:true});
				await IOUtils.remove(PathUtils.join(this.directory, "resources"), {recursive:true, ignoreAbsent:true});
				this.legacy = false;
			}
			let retained = new Set(queue.filter(task => task.state !== "completed").flatMap(task =>
				["cloudState", "cloudStateB", "paddleState", "paddleStateB"].map(name => task[name]?.dir).filter(Boolean)));
			for (let path of await IOUtils.getChildren(this.directory)) {
				let name = path.split(/[/\\]/).at(-1);
				if ((name.startsWith("ocrflow-cloud-") || /^task-\d+-(?:cloudState|paddleState)B?$/.test(name)) && !retained.has(path)) await IOUtils.remove(path, {recursive:true,ignoreAbsent:true});
			}
			let previous = this.error;
			this.error = this.damaged ? `${this.damaged} 个任务的恢复记录无法读取，已移至恢复目录的 damaged 文件夹。` : null;
			if (previous !== this.error) this.owner.refreshParseQueueDialog();
		});
		return this.serial.catch(error => { this.fail(error); throw error; });
	},

	restore() {
		if (this.loaded) return Promise.resolve();
		if (this.restoring) return this.restoring;
		this.restoring = this.read().finally(() => { this.restoring = null; });
		return this.restoring;
	},

	async readCurrent() {
		let index = {order:[]}, records = new Map(), damaged = 0;
		if (await IOUtils.exists(this.indexPath)) {
			try { index = JSON.parse(await IOUtils.readUTF8(this.indexPath)); }
			catch (error) { Zotero.logError(error); index = {order:[]}; }
			if (index?.format !== "ocrflow-tasks") index = {order:[]};
			if (index.version > this.version) throw Error("任务恢复记录由更新版本的 OCRFlow 创建，请升级插件后恢复。");
		}
		if (await IOUtils.exists(this.tasksDirectory)) for (let path of await IOUtils.getChildren(this.tasksDirectory)) {
			let name = path.split(/[/\\]/).at(-1), id = Number(name);
			if (!/^\d+$/.test(name) || !Number.isSafeInteger(id) || id < 1) continue;
			try {
				let cache = {text:new Map(), binary:new WeakMap()};
				let envelope = await this.decode(await IOUtils.readUTF8(PathUtils.join(path, "task.json")), path, cache);
				if (envelope?.format !== "ocrflow-task" || !(envelope.schema <= this.version) || envelope.task?.id !== id) throw Error("任务恢复记录格式无法识别。");
				await this.restoreTask(envelope.task);
				records.set(id, envelope.task); this.caches.set(id, cache); this.stored.set(id, null);
			} catch (error) {
				Zotero.logError(error); damaged++;
				let target = PathUtils.join(this.directory, "damaged", name + "-" + Date.now());
				await IOUtils.makeDirectory(PathUtils.parent(target), {createAncestors:true});
				await IOUtils.move(path, target);
			}
		}
		let order = (Array.isArray(index.order) ? index.order : []).filter(id => records.has(id));
		let tasks = [...new Set(order)].map(id => records.get(id));
		tasks.push(...[...records.keys()].filter(id => !order.includes(id)).sort((a, b) => a - b).map(id => records.get(id)));
		return {tasks, nextID:Number.isSafeInteger(index.nextID) ? index.nextID : 1, damaged};
	},

	async readLegacy() {
		let envelope = JSON.parse(await IOUtils.readUTF8(this.path));
		if (envelope.format !== "ocrflow-tasks" || ![1, 2].includes(envelope.version)) throw Error("任务恢复记录格式无法识别。");
		let iv = this.bytes(envelope.iv), encrypted = this.bytes(envelope.data);
		envelope = null;
		let data = await this.owner.config.crypto.subtle.decrypt({name:"AES-GCM", iv}, await this.storageKey(), encrypted);
		encrypted = null;
		let text = new TextDecoder().decode(data);
		data = null;
		let snapshot = await this.decode(text, this.directory, null), items = new Map();
		text = null;
		for (let task of snapshot.tasks) await this.restoreTask(task, items);
		return snapshot;
	},

	// Give colliding tasks new IDs and keep dependencies inside the added group pointing at them.
	merge(existing, added, nextID) {
		let ids = new Set(existing.map(task => task.id)), reassigned = new Map();
		nextID = Math.max(nextID, ...existing.map(task => task.id + 1), ...added.map(task => task.id + 1));
		for (let task of added) {
			let previousID = task.id;
			if (ids.has(task.id)) task.id = nextID++;
			ids.add(task.id); reassigned.set(previousID, task.id);
		}
		for (let task of added) if (reassigned.has(task.requiredParseID)) task.requiredParseID = reassigned.get(task.requiredParseID);
		return nextID;
	},

	resumeState(task) {
		let jobID = Object.hasOwn(task, "cancelJobID") ? task.cancelJobID : task.jobID;
		let stages = [task, ...Object.values(task.organizeStages || {}).map(stage => stage.task).filter(Boolean)];
		if (stages.some(row => row.stage !== undefined && !this.stages.includes(row.stage))) return "任务恢复记录来自其他版本，请确认后继续";
		if (stages.some(row => row.stage === "saving")) return "上次保存结果未确认，请检查条目附件后重试";
		let submitting = task.stage === undefined ? /^(提交 Marker 任务|提交 Datalab 任务|提交解析任务)/.test(task.phase || "") : ["submitting", "uploading"].includes(task.stage);
		if (!jobID && submitting || [task.paddleState, task.paddleStateB].some(work => work?.parts?.some(part => part.submitting && !part.jobID))) return "上次提交结果未确认，请核对服务端任务后重试";
		return null;
	},

	async read() {
		try {
			let legacy = await IOUtils.exists(this.path);
			let current = await IOUtils.exists(this.indexPath) || await IOUtils.exists(this.tasksDirectory);
			this.pendingUnlock = (legacy || current) && this.owner.config.state !== "unlocked";
			if (this.owner.config.state !== "unlocked") {
				this.owner.refreshParseQueueDialog();
				return;
			}
			this.stored = new Map(); this.caches = new Map(); this.storedIndex = null; this.damaged = 0;
			let restored = [], nextID = 1;
			if (current) ({tasks:restored, nextID, damaged:this.damaged} = await this.readCurrent());
			if (legacy) {
				let snapshot = await this.readLegacy();
				nextID = this.merge(restored, snapshot.tasks, Math.max(nextID, snapshot.nextID || 1));
				restored.push(...snapshot.tasks);
			}
			for (let task of restored) {
				let uncertain;
				if (!task.attachment || task.attachment.deleted) { task.state = "failed"; task.error = "恢复任务的来源条目已删除，请重新选择文献。"; }
				else if (task.waitingDecision) { task.state = "waiting"; task.recoveryDecision = true; task.detail = "任务进度已恢复，请确认后继续"; }
				else if (task.cancelRequested || task.state === "stopping") task.state = "canceled";
				else if (["running", "queued", "waiting_dependency"].includes(task.state)) {
					uncertain = this.resumeState(task);
					task.state = uncertain ? "waiting" : "queued";
					task.detail = uncertain || "任务进度已恢复，等待继续";
				}
				delete task.waitingDecision;
			}
			let pending = this.owner.parseQueue;
			nextID = this.merge(restored, pending, Math.max(this.owner.parseQueueNextID, nextID));
			this.owner.parseQueue = [...restored, ...pending];
			this.owner.parseQueueNextID = nextID;
			this.legacy = legacy;
			this.loaded = true; this.pendingUnlock = false;
			this.error = this.damaged ? `${this.damaged} 个任务的恢复记录无法读取，已移至恢复目录的 damaged 文件夹。` : null;
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
