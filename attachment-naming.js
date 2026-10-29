Object.assign(DocFlow, {
	async documentFileStem(parent, original = null) {
		await parent?.loadDataType?.("creators");
		let authors=(parent?.getCreatorsJSON?.()||[]).filter(c=>c.creatorType === "author");
		let author=(authors[0]?.lastName||authors[0]?.name||"未知作者").trim()+(authors.length>1?"等":"");
		let year=String(parent?.getField?.("date")||"").match(/\b\d{4}\b/)?.[0]||"年份不详";
		let title=String(parent?.getField?.("title")||"").trim();
		if(!title){let path=await original?.getFilePath?.();title=path ? this.fileStemFromPath(path) : original?.getField?.("title")||"文档";}
		title=title.replace(/\.(?:pdf|epub|docx?|pptx?|xlsx?|html?|md)$/i,"");
		return this.sanitizeFileName(`${author}_${year}_${title}`);
	},

	async renameDocumentAttachments(parent) {
		let stem=await this.documentFileStem(parent);
		for(let id of parent.getAttachments()) {
			let item=Zotero.Items.get(id);if(!item?.isAttachment?.()||item.deleted||item.isLinkedURLAttachment?.())continue;
			let ext=this.documentExtension(item),tags=item.getTags().map(t=>t.tag),parsed=tags.includes("#DocFlow-Parse"),translated=tags.some(t=>t.startsWith("#DocFlow-Translation"));
			if(!parsed&&!translated&&tags.some(t=>t.startsWith("#DocFlow-")))continue;
			// A saved web snapshot is a directory of interdependent resources, not a standalone file.
			if(["html","htm"].includes(ext)&&!parsed&&!translated)continue;
			let oldPath=await item.getFilePath();if(!oldPath)continue;
			let suffix=item.getField("title").match(/ · (?:AI 校勘|校勘)[\s\S]*$/)?.[0]||"";
			if(translated&&tags.includes("#DocFlow-Translation-Partial"))suffix+=" · 未完成";
			let layoutPrefix=parsed && ["html","htm"].includes(ext) ? item.getField("title").match(/^OCRFlow_((?:原文布局|MD布局)_)/)?.[1] || "" : "";
			let name=(translated?"翻译OCRFlow_":parsed?"OCRFlow_":"")+layoutPrefix+stem+suffix;
			if(item.renameAttachmentFile) {
				let renamed=await item.renameAttachmentFile(this.sanitizeFileName(name)+"."+ext,false,true);
				if(renamed===false||renamed===-1||renamed===-2)throw Error("附件重命名失败："+item.attachmentFilename);
				let newPath=await item.getFilePath();
				if(parsed&&/\.html?$/i.test(oldPath)) {
					let oldMD=oldPath.replace(/\.html?$/i,".md"),newMD=newPath.replace(/\.html?$/i,".md");
					if(oldMD!==newMD&&await IOUtils.exists(oldMD))await IOUtils.move(oldMD,newMD,{noOverwrite:true});
				}
			}
			item.setField("title",name);await item.saveTx({notifierData:{skipRenameFile:true}});
		}
	},

	isWebSnapshot(item) {
		return ["html","htm"].includes(this.documentExtension(item)) && !item.getTags?.().some(t=>t.tag.startsWith("#DocFlow-"));
	}
});
