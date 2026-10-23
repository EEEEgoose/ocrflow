var ocrflowText = typeof ocrflowText === "function" ? ocrflowText : value => String(value ?? "");
var DocFlowTaskQueue = {
	plugin: window.arguments?.[0]?.plugin || null,
	rows: new Map(),
	labels: { queued: "排队中", running: "处理中", stopping: "终止中", canceled: "已终止", completed: "已完成", failed: "失败", wait_expired: "等待已结束", waiting: "待补充" },

	init(plugin = window.arguments[0].plugin) {
		if (this.initialized) return;
		this.initialized = true;
		if (typeof OCRFlowL10n !== "undefined") OCRFlowL10n.localize(document.querySelector(".queue-shell"));
		this.plugin = plugin;
		plugin.parseQueueViews.add(this);
		this.owner = document.getElementById("docflow-prefpane") || window;
		this.onUnload = () => this.destroy();
		this.owner.addEventListener("unload", this.onUnload, { once: true });
		document.getElementById("queue-retry-failed").addEventListener("click", () => {
			this.retry(this.plugin.parseQueue.filter(task => task.state === "failed").map(task => task.id));
		});
		document.getElementById("queue-close")?.addEventListener("click", () => window.close());
		document.getElementById("queue-clear").addEventListener("click", () => this.plugin.clearParseQueueTasks());
		this.onCopyKey = event => {
			if (!(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== "c") return;
			let text = window.getSelection()?.toString();
			if (!text) return;
			this.copyText(text, "已复制所选文字");
			event.preventDefault();
		};
		window.addEventListener("keydown", this.onCopyKey);
		this.initScrollbar();
		this.render();
	},

	destroy() {
		this.resizeObserver?.disconnect();
		window.removeEventListener("keydown", this.onCopyKey);
		this.owner.removeEventListener("unload", this.onUnload);
		this.plugin.parseQueueViews.delete(this);
		if (this.plugin.parseQueueWindow === window) this.plugin.parseQueueWindow = null;
		if (window.DocFlowTaskQueue === this) delete window.DocFlowTaskQueue;
	},

	taskText(row) {
		return [`${row.number.textContent}. ${row.title.textContent}`, `${row.mode.textContent}：${row.state.textContent}`,
			row.detail.textContent, row.job.textContent, row.error.textContent].filter(Boolean).join("\n");
	},

	copyText(text, message) {
		if (!text) return;
		try {
			Components.classes["@mozilla.org/widget/clipboardhelper;1"].getService(Components.interfaces.nsIClipboardHelper).copyString(text);
			document.getElementById("queue-copy-status").textContent = ocrflowText(message);
		} catch (error) {
			document.getElementById("queue-copy-status").textContent = ocrflowText(`复制失败：${error.message || error}`);
		}
	},

	initScrollbar() {
		let scroll = document.getElementById("queue-scroll");
		let track = document.getElementById("queue-scrollbar");
		let thumb = document.getElementById("queue-scroll-thumb");
		scroll.addEventListener("scroll", () => this.updateScrollbar());
		track.addEventListener("pointerdown", event => {
			let max = scroll.scrollHeight - scroll.clientHeight;
			if (event.button !== 0 || max <= 0) return;
			let grabOffset = event.target === thumb ? event.clientY - thumb.getBoundingClientRect().top : thumb.offsetHeight / 2;
			let move = pointer => {
				let max = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
				let travel = track.clientHeight - thumb.offsetHeight;
				let top = pointer.clientY - track.getBoundingClientRect().top - track.clientTop - grabOffset;
				scroll.scrollTop = travel > 0 ? Math.max(0, Math.min(travel, top)) / travel * max : 0;
				this.updateScrollbar();
			};
			let stop = () => {
				track.removeEventListener("pointermove", move);
				track.removeEventListener("pointerup", stop);
				track.removeEventListener("pointercancel", stop);
				if (track.hasPointerCapture(event.pointerId)) track.releasePointerCapture(event.pointerId);
			};
			track.setPointerCapture(event.pointerId);
			track.addEventListener("pointermove", move);
			track.addEventListener("pointerup", stop);
			track.addEventListener("pointercancel", stop);
			track.focus();
			move(event);
			event.preventDefault();
		});
		track.addEventListener("keydown", event => {
			let steps = {ArrowUp: -40, ArrowDown: 40, PageUp: -scroll.clientHeight, PageDown: scroll.clientHeight, Home: -scroll.scrollHeight, End: scroll.scrollHeight};
			if (!(event.key in steps)) return;
			scroll.scrollTop = Math.max(0, Math.min(scroll.scrollHeight - scroll.clientHeight, scroll.scrollTop + steps[event.key]));
			this.updateScrollbar();
			event.preventDefault();
		});
		this.resizeObserver = new window.ResizeObserver(() => this.updateScrollbar());
		this.resizeObserver.observe(scroll);
		this.resizeObserver.observe(scroll.querySelector("table"));
	},

	updateScrollbar() {
		let scroll = document.getElementById("queue-scroll");
		let track = document.getElementById("queue-scrollbar");
		let thumb = document.getElementById("queue-scroll-thumb");
		let max = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
		let height = track.clientHeight;
		let thumbHeight = max ? Math.min(height, Math.max(28, height * scroll.clientHeight / scroll.scrollHeight)) : height;
		thumb.style.height = thumbHeight + "px";
		thumb.style.top = (max ? Math.min(scroll.scrollTop, max) / max * (height - thumbHeight) : 0) + "px";
		thumb.hidden = max === 0;
		track.setAttribute("aria-valuemax", String(max));
		track.setAttribute("aria-valuenow", String(Math.round(scroll.scrollTop)));
		track.setAttribute("aria-disabled", String(max === 0));
		track.title = max ? "拖动滚动任务列表" : "当前列表无需滚动";
	},

	retry(ids) {
		this.plugin.retryParseQueueTasks(ids).catch(error => {
			document.getElementById("queue-summary").textContent = ocrflowText(`重试失败: ${error.message || error}`);
		});
	},

	cancel(id) {
		this.plugin.cancelParseQueueTask(id).catch(error => {
			document.getElementById("queue-summary").textContent = ocrflowText(`终止失败: ${error.message || error}`);
		});
	},

	render() {
		// Keep unchanged text nodes so progress updates preserve text selection.
		let setText = (element, value, content = false) => {
			let text = content ? String(value ?? "") : ocrflowText(value);
			if (element.textContent !== text) element.textContent = text;
		};
		let body = document.getElementById("queue-body");
		let taskIDs = new Set(this.plugin.parseQueue.map(task => task.id));
		for (let [id, row] of this.rows) {
			if (!taskIDs.has(id)) { row.element.remove(); this.rows.delete(id); }
		}
		let counts = { queued: 0, running: 0, stopping: 0, canceled: 0, completed: 0, failed: 0, wait_expired: 0, waiting: 0 };
		for (let [index, task] of this.plugin.parseQueue.entries()) {
			counts[task.state]++;
			let row = this.rows.get(task.id);
			if (!row) {
				let make = tag => document.createElementNS("http://www.w3.org/1999/xhtml", tag);
				let tr = make("tr");
				let cells = Array.from({ length: 5 }, () => make("td"));
				for (let cell of cells) tr.appendChild(cell);
				let title = make("div"), mode = make("div"), state = make("span");
				let detail = make("div"), job = make("div"), error = make("div"), retry = make("button"), cancel = make("button"), copy = make("button");
				mode.className = "queue-mode"; state.className = "queue-state";
				detail.className = "queue-detail"; job.className = "queue-job-id"; error.className = "queue-error";
				retry.type = "button";
				retry.addEventListener("click", () => this.retry([task.id]));
				cancel.type = "button";
				cancel.addEventListener("click", () => this.cancel(task.id));
				copy.type = "button";
				copy.textContent = ocrflowText("复制");
				copy.addEventListener("click", () => this.copyText(this.taskText(row), "已复制本条任务"));
				cells[4].className = "queue-row-actions";
				cells[1].append(title, mode); cells[2].append(state); cells[3].append(detail, job, error); cells[4].append(retry, cancel, copy);
				body.appendChild(tr);
				row = { element: tr, number: cells[0], title, mode, state, detail, job, error, retry, cancel, copy };
				this.rows.set(task.id, row);
			}
			setText(row.number, index + 1);
			setText(row.title, task.title, true);
			let mode = task.kind === "title" ? `翻译标题 · ${this.plugin.titleTranslationServiceLabel(task.settings)} → ${task.settings.targetLang}` : ({organize: "一键整理", parent: "建立条目", metadata: "补全条目", summary: "总结文献", outline: "生成大纲", translate: `翻译文献 → ${task.settings.translateLanguage || "中文"}`})[task.kind]
				|| (task.settings.parserService === "marker" ? "Marker" : task.settings.parserService === "ai" ? "AI 视觉 OCR" : task.settings.parserService === "markitdown" ? "MarkItDown" : task.settings.parserService?.startsWith("paddle-") ? (task.settings.parserService === "paddle-local" ? "PaddleOCR 自部署 API" : "PaddleOCR 官方 API") : task.settings.apiMode === "local-v1" ? "本地 MinerU" : "MinerU 官方 API");
			let ai = task.kind === "organize" ? null : task.settings.parserService === "ai" ? task.settings.llmSettings : task.kind !== "parse" ? task.settings : null;
			setText(row.mode, ocrflowText(mode) + (ai?.providerName ? ` · ${ai.providerName} + ${ai.model}` : ""));
			setText(row.state, task.state==="running"&&task.phase==="Marker · queued" ? "服务端排队中" : this.labels[task.state]);
			row.state.dataset.state = task.state;
			setText(row.detail, task.detail);
			setText(row.job, task.jobID ? `任务 ID: ${task.jobID}` : "");
			setText(row.error, task.error);
			setText(row.retry, task.state === "waiting" ? "继续整理" : task.state === "wait_expired" ? "继续等待" : task.state === "canceled" ? "重新处理" : "重试");
			row.retry.disabled = !["failed", "wait_expired", "canceled", "waiting"].includes(task.state);
			setText(row.cancel, task.cancelFailed ? "重试终止" : (task.cancelSettings||task.settings).markerSettings?.apiType==="cloud" ? "停止等待" : "终止");
			row.cancel.disabled = !!task.saving || (!["queued", "running", "wait_expired"].includes(task.state) && !task.cancelFailed);
		}
		setText(document.getElementById("queue-summary"), this.plugin.parseQueue.length
			? Object.entries(counts).map(([state, count]) => `${ocrflowText(this.labels[state])} ${count}`).join("　") : "暂无任务");
		document.getElementById("queue-retry-failed").disabled = counts.failed === 0;
		document.getElementById("queue-clear").disabled = !this.plugin.parseQueue.some(task => this.plugin.canClearParseQueueTask(task));
		this.updateScrollbar();
	}
};

window.DocFlowTaskQueue = DocFlowTaskQueue;
if (window.arguments?.[0]?.plugin) {
	window.addEventListener("DOMContentLoaded", () => DocFlowTaskQueue.init(), { once: true });
}
