// Source fragments survive paragraph joins, corrections and translation.
var OCRFlowDocument = {
	text(block) {
		if (typeof block === "string") return block;
		if (block.text || block.block_content) return block.text || block.block_content;
		let lines = (block.lines || []).map(line => (line.spans || []).map(span => {
			let text = span.content || "";
			if (span.type === "image") return `![](${span.image_path || span.img_path || ""})`;
			if (["inline_equation", "interline_equation"].includes(span.type)) return `$${text}$`;
			return text;
		}).join(""));
		return lines.reduce((text, line) => text + (/[A-Za-z0-9]$/.test(text) && /^[A-Za-z0-9]/.test(line) ? " " : "") + line, "");
	},

	create(engine) { return { engine, pages: [], blocks: [], changes: [], warnings: [] }; },

	add(doc, type, text, page, rect = null, extra = {}) {
		let block = { id: `b${doc.blocks.length + 1}`, type, text: String(text || "").trim(),
			rawText: String(text || ""), fragments: [{ page, rect, sourceBlock: extra.sourceBlock ?? doc.blocks.length }], ...extra };
		doc.blocks.push(block);
		this.change(doc, block, block.rawText, block.text, "块边界空白整理");
		return block;
	},

	fromMineru(payload, offset = 0, blockList = {}) {
		let doc = this.create("mineru");
		doc.layout = OCRFlowLayout.mineru(payload).map(page => ({...page, page:page.page + offset}));
		for (let [index, page] of (payload.pdf_info || []).entries()) {
			let number = offset + index + 1, discarded = page.discarded_blocks || [];
			let printed = discarded.find(block => block.type === "page_number");
			doc.pages.push({ page: number, printed: printed ? this.text(printed).trim() : null, size: page.page_size || null });
			let append = (block, parent = null) => {
				let type = block.type || "text", text = this.text(block);
				let kind = ({ text: "paragraph", title: "heading", page_footnote: "footnote",
					image_caption: "caption", table_caption: "caption", image_footnote: "caption", table_footnote: "caption",
					interline_equation: "formula", equation: "formula", image: "figure" })[type] || type;
				if (kind === "footnote" && /^(收稿日期|作者简介|基金项目|通信作者|作者单位|DOI)/i.test(text.trim())) kind = "metadata";
				if (["image", "table"].includes(type)) {
					let parts = [];
					let media = child => {
						if (child.html) parts.push(child.html);
						for (let line of child.lines || []) for (let span of line.spans || []) {
							if (span.html) parts.push(span.html);
							if (span.image_path || span.img_path) parts.push(`![](${String(span.image_path || span.img_path).replace(/^\//, "")})`);
						}
						for (let nested of child.blocks || []) if (!/caption|footnote/.test(nested.type || "")) media(nested);
					};
					media(block);
					if (!parts.length) {
						let collect = child => [this.text(child), ...(child.blocks || []).filter(nested => !/caption|footnote/.test(nested.type || "")).flatMap(collect)];
						parts.push(...collect(block).filter(Boolean));
					}
					let figure = this.add(doc, kind, parts.join("\n\n"), number, block.bbox, { sourceBlock: block.index });
					for (let child of block.blocks || []) if (/caption|footnote/.test(child.type || "")) append(child, figure.id);
					return;
				}
				if (text) this.add(doc, kind, text, number, block.bbox || null,
					{ level: block.level || 2, parent, sourceBlock: block.index });
			};
			for (let block of [...(page.preproc_blocks || page.para_blocks || [])].sort((a, b) => (a.index || 0) - (b.index || 0))) append(block);
			for (let block of discarded) append(block);
		}
		let positions = new Map();
		for (let [index, blocks] of (blockList.pdfData || []).entries()) for (let block of blocks) positions.set(block.block_position, [offset + index + 1, block.index]);
		for (let connection of blockList.mergeConnections || []) {
			let chain = connection.blocks || [];
			for (let index = 1; index < chain.length; index++) {
				let first = positions.get(chain[index - 1]), next = positions.get(chain[index]);
				if (!first || !next || next[0] <= first[0]) continue;
				let from = doc.blocks.find(b => b.fragments[0].page === first[0] && b.sourceBlock === first[1]);
				let to = doc.blocks.find(b => b.fragments[0].page === next[0] && b.sourceBlock === next[1]);
				if (from?.type === "paragraph" && to?.type === "paragraph") to.continues = from.id;
			}
		}
		return this.prepare(doc);
	},

	fromPaddle(pages) {
		let doc = this.create("paddleocr");
		doc.layout = OCRFlowLayout.paddle(pages);
		for (let [index, page] of pages.entries()) {
			let data = page.prunedResult || page;
			doc.pages.push({ page: index + 1, printed: null, size: [data.width, data.height] });
			let blocks = data.parsing_res_list || (data.blocks || []).map(block => ({ block_label: block.label,
				block_content: block.content, block_bbox: block.bbox, block_id: block.id }));
			for (let block of blocks) {
				let type = ({ text: "paragraph", vertical_text: "paragraph", doc_title: "heading", paragraph_title: "heading",
					image: "figure", figure_title: "caption", table_title: "caption", figure_caption: "caption",
					page_footnote: "footnote", number: "page_number" })[block.block_label] || block.block_label;
				this.add(doc, type, block.block_content, index + 1, block.block_bbox || null, { sourceBlock: block.block_id });
				if (type === "page_number") doc.pages.at(-1).printed = block.block_content;
			}
			if (!blocks.length && page.markdown?.text) this.add(doc, "paragraph", page.markdown.text, index + 1);
			for (let name of Object.keys(page.markdown?.images || {})) if (!doc.blocks.some(block => block.fragments[0].page === index + 1 && (block.text.includes(name) || [...block.text.matchAll(/!\[[^\]]*\]\(([^)]+)\)|<img\b[^>]*\bsrc=["']([^"']+)/gi)].some(match => (match[1] || match[2]).split("/").at(-1) === name.split("/").at(-1))))) {
				this.add(doc, "figure", `![](${name})`, index + 1);
				doc.warnings.push(`第 ${index + 1} 页图片 ${name} 未匹配结构块，单独保留`);
			}
		}
		return this.prepare(doc);
	},

	fromMarkdown(markdown, engine, split) {
		let doc = this.create(engine), page = null;
		for (let text of split(markdown)) {
			text = text.replace(/^<!--(?:ocrflow-page:|\s*第\s*)(\d+)(?:\s*页\s*)?[^>]*-->/, (_m, value) => { page = Number(value); return ""; }).trim();
			if (!text) continue;
			let notes = [];
			if (!/^(?:```|~~~)/.test(text)) text = text.replace(/^\[\^([^\]]+)\]:\s*(.*(?:\n(?: {4}|\t).*)*)/gm, (raw, label, body) => { notes.push({ raw, label, body }); return ""; }).trim();
			let type = /^#{1,6}\s/.test(text) ? "heading" : /^\[\^[^\]]+\]:/.test(text) ? "note-definition" : "paragraph";
			if (/^(?:```|~~~)/.test(text)) type = "code";
			else if (/^(?:\$\$|\\\[)/.test(text)) type = "formula";
			else if (/^(?:\||<table\b)/.test(text)) type = "table";
			else if (/^(?:[-*+]\s|\d+[.)]\s)/.test(text)) type = "list";
			if (text) this.add(doc, type, text, page);
			for (let note of notes) this.add(doc, "footnote", note.body, page, null, { originalLabel: note.label, rawText: note.raw });
			if (page && !doc.pages.some(p => p.page === page)) doc.pages.push({ page, printed: null });
		}
		return this.prepare(doc);
	},

	change(doc, block, before, after, kind) {
		if (before !== after) doc.changes.push({ block: block.id, page: block.fragments[0]?.page, kind, before, after });
	},

	prepare(doc) {
		let nextNote = 0, notes = new Map();
		for (let block of doc.blocks) {
			if (block.type !== "footnote") continue;
			let match = block.text.match(/^\s*([①-⑳]+|\d+[.)、]?|[（(]\d+[）)])\s*/);
			block.noteID = ++nextNote;
			if (block.originalLabel) notes.set(`${block.fragments[0].page}:${block.originalLabel}`, block);
			else if (match) {
				let labels = /^[①-⑳]+$/.test(match[1]) ? [...match[1]] : [match[1].replace(/[().、（）]/g, "")];
				for (let label of labels) notes.set(`${block.fragments[0].page}:${label}`, block);
				block.text = block.text.slice(match[0].length);
			} else doc.warnings.push(`第 ${block.fragments[0].page} 页有未识别注号的注文：${block.id}`);
			this.change(doc, block, block.rawText, `[^${block.noteID}]: ${block.text}`, "恢复注文输出");
		}
		for (let block of doc.blocks) {
			if (["footnote", "header", "footer", "page_number"].includes(block.type)) continue;
			let before = block.text;
			if (["code", "formula"].includes(block.type)) continue;
			block.text = block.text.replace(/`[^`\n]+`|[①-⑳]|<sup>\s*(\d+)\s*<\/sup>|\[\^([^\]]+)\]/g, (mark, number, label) => {
				if (mark.startsWith("`")) return mark;
				let note = notes.get(`${block.fragments[0].page}:${label || number || mark}`);
				if (!note) return mark;
				note.referenced = true;
				return `[^${note.noteID}]`;
			});
			this.change(doc, block, before, block.text, "脚注关联");
		}
		let previous = null;
		for (let block of doc.blocks) {
			if (["header", "footer", "page_number", "footnote"].includes(block.type)) {
				if (block.type !== "footnote") this.change(doc, block, block.text, "", "转存页眉/页脚/页码来源");
				continue;
			}
			if (previous?.type === "paragraph" && block.type === "paragraph" &&
				previous.fragments.at(-1).page + 1 === block.fragments[0].page &&
				(block.continues === previous.id || previous.mergedIDs?.includes(block.continues) || (!/[。！？.!?;；：:]([”’"」』）)]|\[\^\d+\])*$/.test(previous.text) &&
				!/^\s*(?:#{1,6}\s|[-*+]\s|\d+[.)、]\s|[（(]\d+[）)]|[A-Z])/.test(block.text)))) {
				let before = previous.text;
				let seam = `<!--ocrflow-page:${block.fragments[0].page}-->`;
				let space = /[A-Za-z0-9]$/.test(before) && /^[A-Za-z0-9]/.test(block.text) ? " " : "";
				// Ordinary hyphens are retained: their lexical meaning needs the original image.
				previous.text += seam + space + block.text;
				previous.fragments.push(...block.fragments);
				(previous.mergedIDs ||= []).push(block.id);
				block.mergedInto = previous.id;
				this.change(doc, previous, before + "\n\n" + block.text, previous.text, "跨页接段");
			} else previous = block;
		}
		for (let note of doc.blocks.filter(b => b.type === "footnote" && !b.referenced)) doc.warnings.push(`未关联注文：${note.id}（PDF 第 ${note.fragments[0].page} 页）`);
		return doc;
	},

	visible(doc) { return doc.blocks.filter(b => !b.mergedInto && !["header", "footer", "page_number"].includes(b.type)); },
	blockMarkdown(block) {
		if (block.type === "heading" && !/^#/.test(block.text)) return "#".repeat(Math.min(6, Math.max(1, block.level || 2))) + " " + block.text;
		if (block.type === "footnote") return `[^${block.noteID}]: ${block.text.replace(/\n/g, "\n    ")}`;
		if (block.type === "formula" && !/^(?:\$\$|\\\[)/.test(block.text)) return `$$\n${block.text.replace(/^\$(.*)\$$/s, "$1")}\n$$`;
		return block.text;
	},
	render(doc) {
		let body = [], notes = [], page = 0;
		let mark = number => { let printed=doc.pages.find(p=>p.page===number)?.printed;body.push(`<!--ocrflow-page:${number}${printed ? " printed:"+printed : ""}-->`);page=number; };
		for (let block of this.visible(doc)) {
			if (block.type === "footnote") { notes.push(this.blockMarkdown(block)); continue; }
			let start=block.fragments[0]?.page;
			for(let source of doc.pages.filter(p=>p.page>page&&p.page<=start))mark(source.page);
			if(start && start>page)mark(start);
			body.push(this.blockMarkdown(block));
			page=Math.max(page,...block.fragments.map(f=>f.page||0));
		}
		for(let source of doc.pages.filter(p=>p.page>page))mark(source.page);
		let text=[...body, ...notes].join("\n\n");
		if(doc.pageUnit)text=text.replace(/<!--ocrflow-page:(\d+)([^>]*?)-->/g,(_m,n,suffix)=>doc.pageUnit==="slide"?`<!--ocrflow-slide:${n}${suffix}-->`:"");
		return text;
	},

	// A bounded diff keeps the unchanged prefix/suffix as context; nothing is stripped.
	difference(before, after) {
		let start = 0, endA = before.length, endB = after.length;
		while (start < endA && start < endB && before[start] === after[start]) start++;
		while (endA > start && endB > start && before[endA - 1] === after[endB - 1]) { endA--; endB--; }
		return { from: start, before: before.slice(start, endA), after: after.slice(start, endB) };
	},

	compare(a, b) {
		let findings = [], pages = [...new Set(a.blocks.map(block => block.fragments[0]?.page).filter(Boolean))];
		let content = text => text.replace(/\[\^\d+\]/g, "[^]"); // Global render numbering is not an OCR disagreement.
		for (let page of pages) {
			let ours = this.visible(a).filter(block => block.fragments[0]?.page === page);
			let theirs = this.visible(b).filter(block => block.fragments[0]?.page === page);
			if (!b.pages.some(p => p.page === page)) continue;
			if (ours.length === theirs.length && ours.every((block, index) => block.type === theirs[index].type)) {
				for (let [index, block] of ours.entries()) if (content(block.text) !== content(theirs[index].text)) findings.push({
					id: `d${findings.length + 1}`, page, blockIDs: [block.id], a: block.text, b: theirs[index].text,
					difference: this.difference(block.text, theirs[index].text), status: "pending" });
				continue;
			}
			// Page-level disagreements do not claim a one-to-one block correspondence.
			let source = ours.map(block => this.blockMarkdown(block)).join("\n\n"), other = theirs.map(block => this.blockMarkdown(block)).join("\n\n");
			if (content(source) === content(other)) continue;
			findings.push({ id: `d${findings.length + 1}`, page, blockIDs: ours.map(block => block.id),
				a: source, b: other, difference: this.difference(source, other), status: "pending" });
		}
		return { status: "ready", comparedPages: pages.filter(page => b.pages.some(p => p.page === page)).length,
			missingPages: pages.filter(page => !b.pages.some(p => p.page === page)), findings };
	}
};

Object.assign(DocFlow, {
	stripPageDisplay(markdown) {
		return String(markdown||"").replace(/(<!--ocrflow-(?:page|slide):(\d+)[^>]*-->)\s*\n---\s*\n(?:PDF 第 \2 页|幻灯片第 \2 张)\s*\n/g,"$1\n");
	},

	pageDisplayMarkdown(markdown) {
		let seen=new Set();
		return this.stripPageDisplay(markdown).replace(/<!--ocrflow-(page|slide):(\d+)([^>]*?)-->/g,(marker,kind,page)=>{
			if(seen.has(page))return "";seen.add(page);
			return marker+"\n\n---\n"+(kind==="slide"?"幻灯片第 "+page+" 张":"PDF 第 "+page+" 页")+"\n\n";
		});
	},

	normalizeResultImages(result) {
		let images = result.embeddedImages || [];
		let normalize = value => { try { return decodeURIComponent(value).replace(/\\/g, "/").replace(/^(?:\.\/|\/)+/, ""); } catch (_) { return value; } };
		let resolve = url => {
			if (/^(?:docflow-image:\/\/|data:|https?:\/\/)/i.test(url)) return url;
			let target = normalize(url), basename = target.split("/").at(-1);
			let exact = images.filter(image => [image.entryName, image.fileName].filter(Boolean).some(name => normalize(name) === target));
			let matches = exact.length ? exact : images.filter(image => [image.entryName, image.fileName].filter(Boolean).some(name => normalize(name).split("/").at(-1) === basename));
			return matches.length === 1 ? matches[0].marker : url;
		};
		let rewrite = text => String(text || "").replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, target) => {
			let parsed = this.parseMarkdownImageTarget(target), url = resolve(parsed.url);
			return url === parsed.url ? match : `![${alt}](${url}${parsed.title ? ' "' + parsed.title + '"' : ""})`;
		}).replace(/(<img\b[^>]*\bsrc=["'])([^"']+)(["'])/gi, (_match, before, url, after) => before + resolve(url) + after);
		result.markdownText = rewrite(result.markdownText);
		for (let block of result.document?.blocks || []) block.text = rewrite(block.text);
		for (let page of result.document?.layout || []) for (let region of page.regions) region.text = rewrite(region.text);
		return result;
	},

	finalizeDocument(result, engine = "text") {
		result.rawFiles ||= [{ name: "original.md", text: result.rawMarkdownText || result.markdownText }];
		this.normalizeResultImages(result);
		if (!result.document) {
			result.document = OCRFlowDocument.fromMarkdown(result.markdownText, engine, text => this.splitTranslationBlocks(text));
			result.rawFiles ||= [{ name: "original.md", text: result.rawMarkdownText || result.markdownText }];
			result.markdownText = OCRFlowDocument.render(result.document);
		}
		result.rawFiles ||= [{ name: "original.md", text: result.rawMarkdownText || result.markdownText }];
		if (result.recognition) result.document.recognition = result.recognition;
		return result;
	},

	documentReport(doc) {
		let rows = doc.changes.map(change => `<tr><td>${this.escapeHTML(change.kind)}</td><td>${change.page || "—"}</td><td><pre>${this.escapeHTML(change.before)}</pre></td><td><pre>${this.escapeHTML(change.after)}</pre></td></tr>`).join("");
		return `<!doctype html><meta charset="utf-8"><title>OCRFlow 内容差异</title><style>body{font:16px/1.6 system-ui;margin:24px}table{width:100%;border-collapse:collapse}td,th{border:1px solid #ccc;padding:8px;vertical-align:top}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style><h1>整理前后差异</h1><p>${doc.changes.length ? doc.changes.length + " 项变更（含标点与空白）" : "零文字改动"}</p><table><tr><th>处理</th><th>PDF 页</th><th>整理前</th><th>整理后</th></tr>${rows}</table><h2>待复核</h2><pre>${this.escapeHTML(doc.warnings.join("\n"))}</pre>`;
	},

	async saveDocumentData(attachment, result) {
		let root = PathUtils.join(PathUtils.parent(await attachment.getFilePath()), "_ocrflow");
		let write = async (name, text) => {
			let path = PathUtils.join(root, ...name.split("/"));
			await IOUtils.makeDirectory(PathUtils.parent(path), { createAncestors: true });
			await IOUtils.writeUTF8(path, text);
		};
		let images = new Map((result.embeddedImages || []).map((image, index) => [image.marker, "images/image-" + (index + 1) + "." + this.guessImageExtension(image.mimeType, image.fileName)]));
		let document = JSON.stringify(result.document).replace(/docflow-image:\/\/img-\d+/g, marker => images.get(marker) || marker);
		await write("document.json", document);
		await write("changes.json", JSON.stringify(result.document.changes));
		await write("changes.html", this.documentReport(result.document));
		for (let [index, file] of (result.rawFiles || []).entries()) await write(`raw/engine-a/${index}-${this.fileNameFromPath(file.name)}`, file.text);
		if (result.collation) await write("collation.json", JSON.stringify(result.collation, (key, value) => key === "text" && typeof value === "string" ? value.replace(/docflow-image:\/\/img-\d+/g, marker => images.get(marker) || marker) : value));
		if (result.secondReader) {
			await write("engine-b.json", JSON.stringify(result.secondReader.document));
			for (let [index, file] of (result.secondReader.rawFiles || []).entries()) await write(`raw/engine-b/${index}-${this.fileNameFromPath(file.name)}`, file.text);
		}
	},

	renderFootnotes(markdown, namespace = "doc", counts = new Map()) {
		let literals = [];
		let source = markdown.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`/g, value => { literals.push(value); return `OCRFLOWLITERAL${literals.length - 1}END`; });
		let notes = [];
		source = source.replace(/<!--ocrflow-(?:page|slide):[\s\S]*?-->/g, "").replace(/^\[\^([^\]]+)\]:\s*(.*(?:\n(?: {4}|\t).*)*)/gm, (_match, id, text) => { notes.push({ id, text }); return ""; });
		let restore = value => value.replace(/OCRFLOWLITERAL(\d+)END/g, (_m, index) => literals[Number(index)]);
		source = restore(source);
		let token = id => encodeURIComponent(id).replace(/%/g, "_");
		let render = value => this.renderDocumentBody(value);
		let code = [];
		let html = render(source).replace(/<pre\b[^>]*>[\s\S]*?<\/pre>|<code\b[^>]*>[\s\S]*?<\/code>|<math\b[^>]*>[\s\S]*?<\/math>/g, value => { code.push(value); return `OCRFLOWPROTECTED${code.length - 1}END`; });
		let body = html.replace(/\[\^([^\]]+)\]/g, (_match, id) => {
			let count = (counts.get(id) || 0) + 1; counts.set(id, count);
			return `<sup><a id="${namespace}-ref-${token(id)}${count > 1 ? "-" + count : ""}" href="#${namespace}-note-${token(id)}">${this.escapeHTML(id)}</a></sup>`;
		});
		body = body.replace(/OCRFLOWPROTECTED(\d+)END/g, (_m, index) => code[Number(index)]);
		if (notes.length) body += '<section class="footnotes"><hr/><ol>' + notes.map(note => `<li id="${namespace}-note-${token(note.id)}"${/^\d+$/.test(note.id) ? ` value="${note.id}"` : ""}>${render(restore(note.text))} <a href="#${namespace}-ref-${token(note.id)}">↩</a></li>`).join("") + '</ol></section>';
		return body;
	}
});
