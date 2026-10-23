var ocrflowText = typeof ocrflowText === "function" ? ocrflowText : value => String(value ?? "");
var OCRFlowCollationDialog = {
	plugin: window.arguments[0].plugin, review: window.arguments[0].review, index: 0, loadedPage: null,
	$(id) { return document.getElementById(id); },
	init() {
		if (typeof OCRFlowL10n !== "undefined") OCRFlowL10n.localize(document.documentElement);
		this.$("previous").onclick = () => { this.index = Math.max(0, this.index - 1); this.show(); };
		this.$("next").onclick = () => { this.index = Math.min((this.review.collation.findings || []).length - 1, this.index + 1); this.show(); };
		this.$("use-b").onclick = () => { let input = this.$("edits").querySelector("textarea"), suggestion = this.plugin.collationSuggestion(this.current()); if (input && suggestion !== null) input.value = suggestion; };
		this.$("confirm").onclick = () => this.confirm();
		this.$("retry-image").onclick = () => this.loadImage(this.current());
		this.$("save").onclick = async () => {
			if (this.controller) { this.$("status").textContent = ocrflowText("请等待当前复核结束后再保存。"); return; }
			this.$("save").disabled = true;
			try { await this.plugin.saveCollationReview(this.review); this.$("status").textContent = ocrflowText("校勘新版本已保存"); }
			catch (error) { this.$("status").textContent = ocrflowText(error.message); this.$("save").disabled = false; }
		};
		this.$("retry").onclick = async () => {
			if (this.controller) return;
			this.$("retry").disabled = true;
			this.controller = this.plugin.createAbortController();
			try { await this.plugin.retryCollationReview(this.review, this.controller.signal); this.index = 0; await this.show(); }
			catch (error) { this.$("status").textContent = ocrflowText(error.message); }
			finally { this.$("retry").disabled = false; this.controller = null; }
		};
		this.$("ai-retry").onclick = async () => {
			if (this.controller) return;
			this.controller = this.plugin.createAbortController(); this.$("ai-retry").disabled = true;
			this.$("ai-status").textContent = ocrflowText("AI 正在复核分歧与原图…");
			let drafts=[...this.$("edits").querySelectorAll("textarea")].filter(input=>input.value!==input.dataset.before).map(input=>({id:input.dataset.id,text:input.value}));
			try {
				let result=await this.plugin.retryCollationAIReview(this.review,this.controller.signal);
				if(result?.applied) {
					await this.show();
					for(let draft of drafts){let input=[...this.$("edits").querySelectorAll("textarea")].find(row=>row.dataset.id===draft.id);if(input)input.value=draft.text;}
					this.$("checked").checked=false;
				} else this.showAI();
			}
			catch (error) { this.$("ai-status").textContent = ocrflowText("AI 复核失败：" + error.message); }
			finally { this.$("ai-retry").disabled = false; this.controller = null; }
		};
		this.$("use-ai").onclick = () => {
			let finding = this.current(), edits = this.plugin.collationAISuggestion(this.review, finding);
			if (!edits || finding.status !== "pending") return;
			for (let edit of edits) { let input = [...this.$("edits").querySelectorAll("textarea")].find(input => input.dataset.id === edit.id); if (input) input.value = edit.after; }
			this.$("checked").checked = false;
			this.$("reason").value = ocrflowText("AI 建议依据：") + finding.ai.reason;
		};
		window.addEventListener("unload", () => this.controller?.abort());
		this.show();
	},
	showAI() {
		let finding = this.current(), ai = finding?.ai, summary = this.review.collation.ai;
		this.$("ai-retry").hidden = !this.plugin.isCollationAIEnabled() || this.review.collation.status !== "ready";
		this.$("ai-status").textContent = ocrflowText(summary ? `本轮 AI 辅助校勘：${summary.model || ""} · ${summary.total ? ocrflowText(`${summary.completed}/${summary.total} 组完成`) : ocrflowText("无待复核分歧")}${summary.failed ? ocrflowText(`，${summary.failed} 组可重试`) : ""}` : "尚未进行 AI 辅助校勘");
		this.$("ai-advice").textContent = ai?.status === "suggested" ?
			`${ocrflowText(({a:"建议保留 A",b:"建议参考 B",uncertain:"原图依据不足，请人工确认"})[ai.verdict])}\n${ocrflowText("依据：")}${ai.reason}\n${ai.edits.map(edit => `${edit.id}：${edit.text}`).join("\n")}` : ai?.error ? ocrflowText("AI 复核未完成：") + ocrflowText(ai.error) : ocrflowText("暂无本项 AI 建议");
		this.$("use-ai").disabled = !finding || finding.status !== "pending" || !this.plugin.collationAISuggestion(this.review, finding);
	},
	current() { return this.review.collation.findings?.[this.index]; },
	async show() {
		let finding = this.current(), collation = this.review.collation;
		this.$("retry").hidden = collation.status !== "failed" && !collation.missingPages?.length;
		this.$("edits").replaceChildren(); this.$("checked").checked = false; this.loadedPage = null;
		this.$("image").removeAttribute("src");
		this.$("image-status").textContent = ocrflowText("没有待查看的原图");
		this.$("retry-image").hidden = true;
		let editable=finding&&(finding.status==="pending"||finding.confirmedBy==="ai");
		this.$("confirm").disabled = !editable;
		this.$("use-b").disabled = !finding || finding.status !== "pending" || finding.blockIDs.length !== 1 || /!\[|<img\b/i.test(finding.a + finding.b) || this.plugin.collationSuggestion(finding) === null;
		this.$("use-b").title = ocrflowText("采用文字时保留底稿脚注。图片或脚注数量不同的文本块请手动核对修改。");
		this.$("status").textContent = ocrflowText(collation.status === "failed" ? "对照识别未完成：" + collation.error :
			`已比较 ${collation.comparedPages} 页；缺失 ${collation.missingPages.length} 页。${finding ? ocrflowText(`第 ${this.index + 1}/${collation.findings.length} 项 · PDF 第 ${finding.page} 页 · ${ocrflowText(finding.status === "pending" ? "待核对" : finding.confirmedBy==="ai" ? "AI 已采用，可人工修正" : "已确认")}`) : ocrflowText("没有识别分歧")}`);
		this.$("reader-b").textContent = finding?.b || "";
		this.showAI();
		if (!finding) return;
		this.$("reason").value = finding.reason || `PDF 第 ${finding.page} 页原图`;
		for (let id of finding.blockIDs) {
			let block = this.review.document.blocks.find(block => block.id === id), label = document.createElement("label"), input = document.createElement("textarea");
			label.textContent = `${id} · ${block.type}`; input.value = block.text; input.dir = "auto"; input.dataset.id = id; input.dataset.before = block.text;
			input.disabled = !editable; label.appendChild(input); this.$("edits").appendChild(label);
		}
		await this.loadImage(finding);
	},
	async loadImage(finding) {
		if (!finding) return;
		this.loadedPage = null;
		this.$("image-status").textContent = ocrflowText(`正在加载第 ${finding.page} 页原图…`);
		this.$("retry-image").hidden = true;
		try {
			let cached = this.pageImage;
			let image = cached?.page === finding.page ? cached.url : await this.plugin.withTimeout(() => this.plugin.collationPageImage(this.review.original, finding.page), 30000, "原图加载");
			if (this.current() !== finding) return;
			this.pageImage = {page:finding.page, url:image};
			this.$("image").src = image; this.loadedPage = finding.page;
			this.$("image-status").textContent = ocrflowText(`第 ${finding.page} 页原图`);
		} catch (error) {
			if (this.current() !== finding) return;
			this.$("image-status").textContent = ocrflowText("原图加载失败：" + error.message + "。可先在 Zotero 中打开原始文件，再重试原图。");
			this.$("retry-image").hidden = false;
		}
	},
	confirm() {
		let finding = this.current();
		if (!this.$("checked").checked || this.loadedPage !== finding?.page) { this.$("status").textContent = ocrflowText("请先查看并确认原图"); return; }
		let edits = [...this.$("edits").querySelectorAll("textarea")].map(input => ({ id: input.dataset.id, before: input.dataset.before, after: input.value }));
		try {
			this.plugin.applyCollationDecision(this.review, finding, edits, this.$("reason").value.trim());
			this.show();
		} catch (error) { this.$("status").textContent = ocrflowText(error.message); }
	}
};
window.addEventListener("load", () => OCRFlowCollationDialog.init());
