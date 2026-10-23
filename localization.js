// Localize UI presentation only. Preferences, prompts, document text, and model identifiers remain unchanged.
var OCRFlowL10n = {
	get language() {
		let locale = typeof Zotero !== "undefined" ? Zotero.locale : "";
		if (!locale && typeof Services !== "undefined") locale = Services.locale?.appLocaleAsBCP47;
		return !locale || /^zh(?:-|$)/i.test(locale) ? "zh-CN" : "en-US";
	},
	text(value) {
		let message = String(value ?? "");
		if (this.language === "zh-CN") return message;
		let catalog = OCRFlowEnglish;
		if (Object.hasOwn(catalog, message)) return catalog[message];
		this.patterns ||= Object.entries(catalog).filter(([key]) => /\{\d+\}/.test(key)).map(([key, translation]) => {
			let indices = [], pattern = "", offset = 0;
			for (let match of key.matchAll(/\{(\d+)\}/g)) {
				pattern += key.slice(offset, match.index).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "([\\s\\S]*?)";
				indices.push(Number(match[1])); offset = match.index + match[0].length;
			}
			pattern += key.slice(offset).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			return { key, translation, indices, regex: new RegExp("^" + pattern + "$") };
		}).sort((a, b) => b.key.replace(/\{\d+\}/g, "").length - a.key.replace(/\{\d+\}/g, "").length);
		for (let row of this.patterns) {
			let match = message.match(row.regex); if (!match) continue;
			let values = {}; row.indices.forEach((index, i) => values[index] = match[i + 1]);
			return row.translation.replace(/\{(\d+)\}/g, (_token, index) => values[index]);
		}
		for (let [key, translation] of Object.entries(catalog)) if (/[：:]\s*$/.test(key) && message.startsWith(key)) return translation + message.slice(key.length);
		return message;
	},
	localize(root) {
		if (!root || this.language === "zh-CN") return;
		let doc = root.nodeType === 9 ? root : root.ownerDocument;
		let walker = doc.createTreeWalker(root, 4), nodes = [];
		while (walker.nextNode()) nodes.push(walker.currentNode);
		for (let node of nodes) {
			if (node.parentElement?.closest("script,style,textarea,pre,code,[data-ocrflow-content]")) continue;
			let source = node.nodeValue, text = source.trim(); if (!text) continue;
			let translated = this.text(text); if (translated !== text) node.nodeValue = source.replace(text, () => translated);
		}
		for (let node of [root, ...root.querySelectorAll("*")]) {
			for (let name of ["label", "title", "placeholder", "aria-label"]) if (node.hasAttribute?.(name)) node.setAttribute(name, this.text(node.getAttribute(name)));
			if (node.localName === "button") node.setAttribute("data-saved-label", this.text(" ✓ 已保存"));
		}
		if (doc.documentElement) doc.documentElement.setAttribute("lang", "en");
	}
};
var ocrflowText = value => OCRFlowL10n.text(value);
