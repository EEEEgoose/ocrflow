// Official API: PaddleOCR SDK /api/v2/ocr/jobs. Self-hosted: full /layout-parsing pipeline.
Object.assign(DocFlow, {
	getPaddleSettings(mode) {
		let read = key => String(this.getPref(this.PREF_BRANCH + `paddle.${mode}.${key}`, true) || "").trim();
		return { mode, baseURL: (read("url") || (mode === "cloud" ? "https://paddleocr.aistudio-app.com/api/v2/ocr" : "")).replace(/\/+$/, ""),
			token: read("token").replace(/^Bearer\s+/i, ""), model: read("model") || "PaddleOCR-VL-1.6" };
	},

	async paddleRequest(url, options, signal, timeout = 120000, json = true) {
		let controller = this.createAbortController(), abort = () => controller.abort();
		signal?.throwIfAborted();
		signal?.addEventListener("abort", abort, { once: true });
		try {
			return await this.withTimeout(async () => {
				let response = await fetch(url, { ...options, signal: controller.signal });
				if (!response.ok) throw new Error(`PaddleOCR HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
				if (!json) return response;
				let data = await response.json();
				if ((data.code !== undefined && ![0, "0", 200, "200"].includes(data.code)) || data.errorCode) throw new Error(data.msg || data.errorMsg || "PaddleOCR 请求失败");
				return data;
			}, timeout, "PaddleOCR 请求");
		} catch (error) { controller.abort(); throw error; }
		finally { signal?.removeEventListener("abort", abort); }
	},

	acquirePaddleDocument(mode, config, limit, options) {
		let signal = options.signal;
		signal?.throwIfAborted();
		this.paddleDocumentPools ||= new Map();
		let key = JSON.stringify([mode, config.baseURL.replace(/\/layout-parsing\/?$/, "").replace(/\/+$/, "")]);
		let pool = this.paddleDocumentPools.get(key);
		if (!pool) { pool = {active:0, waiting:[]}; this.paddleDocumentPools.set(key, pool); }
		let pump = () => {
			while (pool.waiting.length && pool.active < pool.waiting[0].limit) {
				let entry = pool.waiting.shift();
				entry.signal?.removeEventListener("abort", entry.abort); pool.active++;
				entry.resolve(() => { pool.active--; pump(); });
			}
			if (!pool.active && !pool.waiting.length) this.paddleDocumentPools.delete(key);
		};
		return new Promise((resolve, reject) => {
			let entry = {resolve, reject, signal, limit};
			entry.abort = () => {
				pool.waiting.splice(pool.waiting.indexOf(entry), 1);
				reject(signal.reason); pump();
			};
			signal?.addEventListener("abort", entry.abort, {once:true});
			pool.waiting.push(entry);
			if (pool.active >= limit) options.onStatus?.({phase:"等待识别名额"});
			pump();
		});
	},

	async parseWithPaddle(attachment, settings, options = {}) {
		let mode = settings.parserService === "paddle-local" ? "local" : "cloud";
		let config = settings.paddleSettings || settings.paddleProfiles?.[mode] || this.getPaddleSettings(mode), signal = options.signal;
		if (!config.baseURL || (mode === "cloud" && !config.token)) throw new Error("请先填写 PaddleOCR 服务地址与官方访问令牌；自部署免密服务可留空令牌。");
		let release = await this.acquirePaddleDocument(mode, config, settings.paddleConcurrency || 2, options);
		try {
		options.onStatus?.({phase:"PaddleOCR 准备文档"});
		let work = options.paddleState ||= {};
		let bytes = mode === "cloud" && work.parts ? null : await IOUtils.read(await attachment.getFilePath());
		let headers = config.token ? { Authorization: `Bearer ${config.token}` } : {};
		let rawFiles = [], pages = [];
		if (mode === "local") {
			options.onStatus?.({ phase: "PaddleOCR 自部署解析" });
			let response = await this.paddleRequest(config.baseURL.replace(/\/layout-parsing$/, "") + "/layout-parsing", {
				method: "POST", headers: { ...headers, "Content-Type": "application/json" },
				body: JSON.stringify({ file: this.bytesToBase64(bytes), fileType: this.documentExtension(attachment) === "pdf" ? 0 : 1 })
			}, signal, settings.timeoutMS);
			rawFiles.push({ name: "response.json", text: JSON.stringify(response) });
			pages = response.result?.layoutParsingResults || [];
		} else {
			// Split real PDF uploads into 100-page parts; the image path remains a single upload.
			let parts = work.parts;
			if (!parts) {
			parts = [{ bytes, name: attachment.attachmentFilename || "document.pdf", count: 1 }];
			if (this.documentExtension(attachment) === "pdf") {
				let prepared=await this.loadPDFForParsing(bytes,options), pdf=prepared.pdf;
				bytes=prepared.bytes;parts[0].bytes=bytes;
				parts[0].count = pdf.getPageCount();
				if (pdf.getPageCount() > 100 || bytes.length > 45 * 1024 * 1024) {
					parts = [];
					let split = async (start, end) => {
						signal?.throwIfAborted();
						let part = await this.getPDFLibrary().PDFDocument.create();
						for (let page of await part.copyPages(pdf, pdf.getPageIndices().slice(start, end))) part.addPage(page);
						let bytes = await part.save();
						if (bytes.length > 45 * 1024 * 1024) {
							if (end - start === 1) throw new Error(`PDF 第 ${start + 1} 页超过 PaddleOCR 官方上传限制，请改用自部署服务或压缩原文件。`);
							let middle = Math.floor((start + end) / 2); await split(start, middle); await split(middle, end); return;
						}
						parts.push({ bytes, name: `pages-${start + 1}.pdf`, count: end - start });
					};
					for (let start = 0; start < pdf.getPageCount(); start += 100) await split(start, Math.min(start + 100, pdf.getPageCount()));
				}
			}
			work.parts = parts;
			await options.checkpoint?.();
			}
			for (let [index, part] of parts.entries()) {
				signal?.throwIfAborted();
				if (part.pages) { pages.push(...part.pages); rawFiles.push({name:`part-${index + 1}.jsonl`, text:part.rawText}); continue; }
				let jobID = part.jobID;
				if (!jobID) {
				let win = Zotero.getMainWindow(), form = new win.FormData();
				form.append("model", config.model);
				form.append("optionalPayload", JSON.stringify({ useDocOrientationClassify: false, useDocUnwarping: false }));
				form.append("file", new win.Blob([part.bytes || await IOUtils.read(part.path)]), part.name);
				part.submitting = true; await options.checkpoint?.();
				let upload = await this.paddleRequest(config.baseURL + "/jobs", { method: "POST", headers, body: form }, signal, settings.timeoutMS);
				jobID = upload.data?.jobId;
				if (!jobID) throw new Error("PaddleOCR 未返回 jobId");
				part.jobID = jobID; part.submitting = false;
				options.onStatus?.({phase:"PaddleOCR 等待云端处理", jobID}); await options.checkpoint?.();
				}
				let deadline = Date.now() + (settings.localJobTimeoutMS || 7200000), job;
				do {
					signal?.throwIfAborted();
					job = (await this.paddleRequest(`${config.baseURL}/jobs/${encodeURIComponent(jobID)}`, { headers }, signal)).data;
					options.onStatus?.({ phase: `PaddleOCR 第 ${index + 1}/${parts.length} 批：${job?.state || "等待"}`, jobID });
					if (job?.state === "failed") { part.jobID = null; part.submitting = false; await options.checkpoint?.(); throw new Error(job.errorMsg || "PaddleOCR 任务失败"); }
					if (job?.state === "done") break;
					if (Date.now() > deadline) throw new Error("PaddleOCR 等待超时，请重试");
					await this.delayParsePoll(settings.pollIntervalMS || 5000, { signal });
				} while (true);
				let url = job.resultUrl?.jsonUrl;
				if (!url) throw new Error("PaddleOCR 未返回结果地址");
				let response = await this.paddleRequest(url, {}, signal, settings.timeoutMS, false);
				let text = await response.text(), batch = [];
				rawFiles.push({ name: `part-${index + 1}.jsonl`, text });
				for (let line of text.split(/\r?\n/).filter(line => line.trim())) batch.push(...(JSON.parse(line).result?.layoutParsingResults || []));
				if (batch.length !== part.count) throw new Error(`PaddleOCR 结果页数不完整：提交 ${part.count} 页，返回 ${batch.length} 页`);
				part.pages = batch; part.rawText = text; await options.checkpoint?.();
				pages.push(...batch);
			}
		}
		if (!pages.length) throw new Error("PaddleOCR 没有返回文档页面");
		let images = [], document = OCRFlowDocument.fromPaddle(pages);
		document.recognition = { source: `paddle-${mode}`, model: config.model };
		for (let page of pages) for (let [name, resource] of Object.entries(page.markdown?.images || {})) {
			let imageBytes;
			if (/^https?:\/\//.test(resource)) {
				let response = await this.paddleRequest(resource, {}, signal, settings.timeoutMS, false);
				imageBytes = new Uint8Array(await response.arrayBuffer());
			} else imageBytes = Uint8Array.from(atob(resource.replace(/^data:[^,]+,/, "")), c => c.charCodeAt(0));
			let marker = `docflow-image://img-${images.length + 1}`;
			images.push({ marker, fileName: name, mimeType: this.guessMimeType(name), bytes: imageBytes });
			for (let block of document.blocks) if (block.fragments[0].page === pages.indexOf(page) + 1) block.text = block.text.split(name).join(marker);
		}
		let markdownText = OCRFlowDocument.render(document);
		if (work.dir) await IOUtils.remove(work.dir, {recursive:true,ignoreAbsent:true});
		return { markdownText, rawFiles, document, embeddedImages: images, outlinePages: pages.map(page => page.markdown?.text || ""),
			warning: document.warnings.length ? `${document.warnings.length} 项结构待复核（见差异报告）` : "" };
		} finally { release(); }
	}
});
