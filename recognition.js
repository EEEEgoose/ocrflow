var ocrflowText = typeof ocrflowText === "function" ? ocrflowText : value => String(value ?? "");
// MinerU shared batch lifecycle. A document keeps its own cancellation and pieces.
Object.assign(DocFlow, {

	acquireCloudDocument(context) {
		context.signal?.throwIfAborted();
		if((this.cloudDocumentCount||0)>=5)this.reportParseStatus(context,{phase:"等待识别名额"});
		return new Promise((resolve,reject)=>{
			let entry={resolve,reject,signal:context.signal};
			entry.abort=()=>{entry.canceled=true;reject(context.signal.reason);};
			context.signal?.addEventListener("abort",entry.abort,{once:true});
			(this.cloudDocumentWaiting ||= []).push(entry);this.pumpCloudDocuments();
		});
	},

	pumpCloudDocuments() {
		this.cloudDocumentCount ||= 0;
		while(this.cloudDocumentCount<5&&this.cloudDocumentWaiting?.length) {
			let entry=this.cloudDocumentWaiting.shift();entry.signal?.removeEventListener("abort",entry.abort);
			if(entry.canceled)continue;
			this.cloudDocumentCount++;entry.resolve();
		}
	},

	async parseCloudDocument(fileBytes, fileName, attachmentID, settings, context = {}) {
		await this.acquireCloudDocument(context);
		try {
		let work = context.cloudState ||= {}, parts = work.parts;
		if (!parts) {
			let pdf = null;
			if (/\.pdf$/i.test(fileName)) {
				let prepared=await this.loadPDFForParsing(fileBytes,context);pdf=prepared.pdf;fileBytes=prepared.bytes;
			}
			work.totalPages = pdf?.getPageCount() || 0;
			work.dir = PathUtils.join(PathUtils.tempDir, "ocrflow-cloud-" + this.makeDataID(attachmentID));
			await IOUtils.makeDirectory(work.dir, {createAncestors:true});
			parts = [];
			let add = async (start, end, bytes) => {
				context.signal?.throwIfAborted();
				if (bytes.byteLength > 200000000) {
					if (!pdf || end - start <= 1) throw Error("文件或单页超过 200 MB，无法自动拆分，请减小文件后重试。");
					let middle = start + Math.floor((end - start) / 2);
					await split(start, middle); await split(middle, end); return;
				}
				let index = parts.length, path = PathUtils.join(work.dir, "part-" + index);
				await IOUtils.write(path, bytes);
				parts.push({index, start, end, path, dataID:this.makeDataID(attachmentID) + "." + index,
					name:pdf && (start || end !== work.totalPages) ? fileName.replace(/\.pdf$/i, "") + `-pages-${start + 1}-${end}.pdf` : fileName,
					state:"queued", completed:0});
			};
			let split = async (start, end) => {
				let part = await this.getPDFLibrary().PDFDocument.create();
				for (let page of await part.copyPages(pdf, pdf.getPageIndices().slice(start,end))) part.addPage(page);
				await add(start, end, await part.save());
			};
			this.reportParseStatus(context, {phase:"准备文档切片"});
			if (!pdf || work.totalPages <= 200 && fileBytes.byteLength <= 200000000) await add(0, work.totalPages, fileBytes);
			else for (let start = 0; start < work.totalPages; start += 200) await split(start, Math.min(start+200,work.totalPages));
			work.parts = parts;
		}
		let progress = () => {
			let total=work.totalPages||parts.reduce((sum,part)=>sum+(part.serviceTotal||0),0);
			let completed = parts.reduce((sum, part) => sum + (part.state === "done" ? part.end-part.start || part.serviceTotal || 0 : part.completed || 0), 0);
			this.reportParseStatus(context, {jobID:[...new Set(parts.map(p=>p.batchID).filter(Boolean))].join(", "),
				phase:`切片 ${parts.filter(p=>p.state==="done").length}/${parts.length} 已完成`,
				parts:parts.map(p=>({name:p.name,start:p.start+1,end:p.end,state:p.state,completed:p.state==="done" ? p.end-p.start||p.serviceTotal||0 : p.completed||0,total:p.end-p.start||p.serviceTotal||0})),
				pageProgress:total ? {completed,total,unit:/\.(png|jpe?g|jp2|webp|gif|bmp)$/i.test(fileName)?"张":"页"} : null});
		};
		let waiting = parts.map(part => part.result ? Promise.resolve(part.result) : this.queueCloudPart(part, settings, context, progress));
		let settled = await Promise.allSettled(waiting);
		context.signal?.throwIfAborted();
		let failures = settled.filter(row=>row.status === "rejected");
		if (failures.length) throw Error(`${failures.length} 个切片未完成，可重试：${failures[0].reason.message}`);
		let result = this.mergeCloudParts(parts, work.totalPages);
		if(!/\.pdf$/i.test(fileName)) {
			let slides=/\.pptx?$/i.test(fileName);
			if(result.document)result.document.pageUnit=slides?"slide":"source";
			result.markdownText=result.markdownText.replace(/<!--ocrflow-page:(\d+)([^>]*?)-->/g,(_m,n,suffix)=>slides?`<!--ocrflow-slide:${n}${suffix}-->`:"");
		}
		await IOUtils.remove(work.dir, {recursive:true,ignoreAbsent:true});
		delete work.parts;
		return result;
		} finally {this.cloudDocumentCount--;this.pumpCloudDocuments();}
	},

	mergeCloudParts(parts, totalPages) {
		let images=[], documents=[], rawFiles=[], markdown=[], rawMarkdown=[], outlinePages=Array(totalPages).fill(""), outlineHeadings=[];
		for (let part of parts) {
			// Never mutate cached piece results: a retry must apply offsets exactly once.
			let result = part.result, markers=new Map();
			for (let image of result.embeddedImages || []) {
				let id="img-"+(images.length+1), marker="docflow-image://"+id;
				markers.set(image.marker, marker); images.push({...image,id,marker});
			}
			let rewrite = text => String(text || "").replace(/docflow-image:\/\/img-\d+/g, marker=>markers.get(marker)||marker);
			let document = result.document ? JSON.parse(JSON.stringify(result.document)) : null;
			if (document) {
				for (let page of document.pages) page.page += part.start;
				for (let page of document.layout || []) {
					page.page += part.start;
					for (let region of page.regions) region.text=rewrite(region.text);
				}
				for (let block of document.blocks) {
					for (let fragment of block.fragments) fragment.page += part.start;
					block.text=rewrite(block.text); block.rawText=rewrite(block.rawText);
				}
				documents.push(document);
			}
			let text=rewrite(result.markdownText);
			if (part.start) text=text.replace(/<!--ocrflow-page:(\d+)(.*?)-->/g, (_m,n,suffix)=>`<!--ocrflow-page:${Number(n)+part.start}${suffix}-->`);
			markdown.push(text);rawMarkdown.push(result.rawMarkdownText||result.markdownText||"");
			rawFiles.push(...(result.rawFiles||[]).map(file=>({...file,name:`part-${part.index+1}-${this.fileNameFromPath(file.name)}`})));
			for (let [i,text] of (result.outlinePages||[]).entries()) outlinePages[part.start+i]=text;
			outlineHeadings.push(...(result.outlineHeadings||[]).map(h=>({...h,page:h.page+part.start})));
		}
		let document=null, markdownText=markdown.join("\n\n");
		if (documents.length === parts.length && typeof OCRFlowDocument !== "undefined") {
			document=OCRFlowDocument.create("mineru");
			document.layout=documents.flatMap(doc=>doc.layout||[]);
			for (let doc of documents) {
				document.pages.push(...doc.pages);
				for (let block of doc.blocks) OCRFlowDocument.add(document,block.type,block.rawText,block.fragments[0]?.page,block.fragments[0]?.rect,{level:block.level});
			}
			OCRFlowDocument.prepare(document); markdownText=OCRFlowDocument.render(document);
		}
		return {sourceKind:"markdown",markdownText,rawMarkdownText:rawMarkdown.join("\n\n"),embeddedImages:images,
			embeddedImageCount:images.length,document,rawFiles,outlinePages,outlineHeadings};
	},

	queueCloudPart(part, settings, context, progress) {
		context.signal?.throwIfAborted();
		if(!part.uploaded && part.appliedAt && Date.now()-part.appliedAt>86400000){delete part.batchID;delete part.uploadURL;}
		return new Promise((resolve,reject)=>{
			let row={part,settings,context,progress,resolve,reject,settled:false};
			row.finish=(error,result)=>{
				if(row.settled)return; row.settled=true;
				context.signal?.removeEventListener("abort",row.abort);
				error ? reject(error) : resolve(result);
			};
			row.abort=()=>{row.finish(context.signal.reason || new Error("已停止等待，服务端可能继续处理"));if(row.batchRows?.every(r=>r.settled))row.pollController?.abort();};
			context.signal?.addEventListener("abort",row.abort,{once:true});
			(this.cloudPending ||= []).push(row);
			if(!this.cloudSubmitTimer)this.cloudSubmitTimer=setTimeout(()=>{this.cloudSubmitTimer=null;this.submitCloudBatches();},0);
		});
	},

	async submitCloudBatches() {
		let rows=(this.cloudPending||[]).splice(0).filter(row=>!row.settled), groups=new Map();
		for(let row of rows) {
			let s=row.settings,key=JSON.stringify([s.apiBaseURL,s.apiToken,s.modelVersion,s.recognitionLanguage,s.enableFormula,s.enableTable,row.part.batchID||"new"]);
			if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);
		}
		for(let group of groups.values()) {
			// Interleave documents, so one long book cannot monopolize the first batch.
			let byDocument=new Map();
			for(let row of group){let key=row.context.cloudState||row.context;if(!byDocument.has(key))byDocument.set(key,[]);byDocument.get(key).push(row);}
			let ordered=[];while([...byDocument.values()].some(list=>list.length))for(let list of byDocument.values())if(list.length)ordered.push(list.shift());
			for(let i=0;i<ordered.length;i+=50) {
				let batch=ordered.slice(i,i+50);
				try {
					let fresh=batch.filter(row=>!row.part.batchID && !row.settled),s=batch[0].settings;
					if(fresh.length) {
						let html=s.modelVersion==="MinerU-HTML";
						let controller=this.createAbortController(),timer=setTimeout(()=>controller.abort(),s.timeoutMS||1200000);
						for(let row of fresh){row.pollController=controller;row.batchRows=fresh;}
						let response;try{response=await this.requestMineruJSON({url:s.apiBaseURL+"/file-urls/batch",token:s.apiToken,method:"POST",signal:controller.signal,
							body:{model_version:s.modelVersion,...(!html ? {enable_formula:s.enableFormula!==false,enable_table:s.enableTable!==false,...(s.recognitionLanguage?{language:s.recognitionLanguage}:{})}:{}),
								files:fresh.map(row=>({name:row.part.name,data_id:row.part.dataID}))}});}finally{clearTimeout(timer);}
						if(response.code!==0 || !response.data?.batch_id || response.data.file_urls?.length!==fresh.length)throw Error(response.msg||"上传地址数量与文件数量不一致");
						fresh.forEach((row,index)=>Object.assign(row.part,{batchID:response.data.batch_id,uploadURL:response.data.file_urls[index],appliedAt:Date.now(),state:"uploading"}));
					}
					let uploads=this.cloudUploads ||= new WeakMap();
					for(let row of batch) {
						let key=row.context.cloudState||row.context,previous=uploads.get(key)||Promise.resolve();
						let upload=previous.then(async()=>{
							if(row.settled || row.part.uploaded)return;
							row.context.signal?.throwIfAborted();
							let bytes=await IOUtils.read(row.part.path);
							let controller=this.createAbortController(),abort=()=>controller.abort(),timer=setTimeout(abort,row.settings.timeoutMS||1200000);
							row.context.signal?.addEventListener("abort",abort,{once:true});
							try{let response=await fetch(row.part.uploadURL,{method:"PUT",body:bytes,signal:controller.signal});if(!response.ok)throw Error("上传文档失败 "+response.status);}
							finally{clearTimeout(timer);row.context.signal?.removeEventListener("abort",abort);}
							row.part.uploaded=true;row.part.state="pending";row.progress();
						}).catch(error=>{row.part.state="failed";if(!row.part.uploaded){delete row.part.batchID;delete row.part.uploadURL;}row.finish(error);});
						uploads.set(key,upload);
					}
					// Poll once per batch while uploads from other documents continue.
					this.pollCloudRows(batch).catch(error=>batch.forEach(row=>row.finish(error)));
				}catch(error){batch.forEach(row=>row.finish(error));}
			}
		}
	},

	async pollCloudRows(rows) {
		let groups=new Map();for(let row of rows.filter(r=>!r.settled)){if(!groups.has(row.part.batchID))groups.set(row.part.batchID,[]);groups.get(row.part.batchID).push(row);}
		await Promise.all([...groups].map(async([batchID,batch])=>{
			let s=batch[0].settings,start=Date.now();
			let key=s.apiBaseURL+"|"+batchID;this.cloudPollers ||= new Map();
			if(this.cloudPollers.has(key)){let existing=this.cloudPollers.get(key);for(let row of batch){row.batchRows=existing;row.pollController=existing[0].pollController;}existing.push(...batch);return;}
			let controller=this.createAbortController();for(let row of batch){row.batchRows=batch;row.pollController=controller;}
			this.cloudPollers.set(key,batch);
			try {
				while(batch.some(row=>!row.settled)) {
					let waitLimit=s.localJobTimeoutMS ?? s.timeoutMS ?? 7200000;
					if(waitLimit>0 && Date.now()-start >= waitLimit)throw Error("MinerU 等待超时，原批次保留，可重试查询");
					let timer=setTimeout(()=>controller.abort(),s.timeoutMS||1200000),response;
					try{response=await this.requestMineruJSON({url:s.apiBaseURL+"/extract-results/batch/"+encodeURIComponent(batchID),token:s.apiToken,signal:controller.signal});}finally{clearTimeout(timer);}
					if(response.code!==0)throw Error(response.msg||"查询解析状态失败");
					for(let row of batch.filter(r=>!r.settled)) {
						let result=(response.data?.extract_result||[]).find(item=>item.data_id===row.part.dataID);
						if(!result || !row.part.uploaded)continue;
						row.part.state=result.state;row.part.serviceTotal=result.extract_progress?.total_pages||row.part.serviceTotal||0;row.part.completed=Math.min(row.part.end-row.part.start||row.part.serviceTotal,Math.max(0,result.extract_progress?.extracted_pages||0));row.progress();
						if(result.state==="failed"){delete row.part.batchID;row.part.uploaded=false;row.finish(Error(result.err_msg||"MinerU 解析失败"));}
						else if(result.state==="done") {
							try {
								let zip=await this.downloadParseResultZip({zipURL:result.full_zip_url,apiBaseURL:s.apiBaseURL,token:s.apiToken,statusContext:row.context});
								let parsed=await this.extractNoteContentFromMineruZip(zip,row.part.name,{includeImages:true});
								row.context.signal?.throwIfAborted();row.part.result=parsed;row.progress();row.finish(null,parsed);
							}catch(error){row.finish(error);}
						}
					}
					if(batch.some(row=>!row.settled))await new Promise(resolve=>setTimeout(resolve,s.pollIntervalMS||5000));
				}
			}catch(error){batch.forEach(row=>row.finish(error));}
			finally{this.cloudPollers.delete(key);}
		}));
	}
});
