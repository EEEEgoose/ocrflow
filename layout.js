// Visible HTML content is positioned with the source geometry; no page screenshots.
var OCRFlowLayout = {
	fontFamily(name, fallback="serif") {
		name=String(name || "");
		if(/[\x80-\xff]/.test(name) && [...name].every(char=>char.charCodeAt(0)<=255)) {
			try {name=new TextDecoder("utf-8",{fatal:true}).decode(Uint8Array.from(name,char=>char.charCodeAt(0)));} catch(_error) {}
		}
		name=name.replace(/^(?:[A-Z]{6}|B\d+)\+/,"");
		let aliases=/宋体|SimSun|STSong/i.test(name)?'"SimSun","Songti SC","STSong",serif':
			/微软雅黑|Microsoft.*YaHei/i.test(name)?'"Microsoft YaHei","PingFang SC",sans-serif':
			/黑体|SimHei|Heiti/i.test(name)?'"SimHei","Heiti SC","PingFang SC",sans-serif':
			/楷体|KaiTi|Kaiti/i.test(name)?'"KaiTi","Kaiti SC",serif':
			/等线|DengXian/i.test(name)?'"DengXian","PingFang SC",sans-serif':
			/Times/i.test(name)?'"Times New Roman",serif':/Arial|Helvetica/i.test(name)?'Arial,Helvetica,sans-serif':/Serif/i.test(name)?'serif':/Sans/i.test(name)?'sans-serif':fallback;
		return {name,css:name?JSON.stringify(name)+','+aliases:aliases};
	},

	applyTypography(page, text, viewport, fonts) {
		let v=viewport.transform,sx=viewport.width/page.width,sy=viewport.height/page.height;
		for(let region of page.regions)if(region.rect)region.rect=region.rect.map((value,i)=>value*(i%2?sy:sx));
		page.width=viewport.width;page.height=viewport.height;
		let items=text.items.filter(item=>item.str?.trim() && item.transform).map(item=>{
			let t=item.transform,a=v[0]*t[0]+v[2]*t[1],b=v[1]*t[0]+v[3]*t[1],
				c=v[0]*t[2]+v[2]*t[3],d=v[1]*t[2]+v[3]*t[3],x=v[0]*t[4]+v[2]*t[5]+v[4],y=v[1]*t[4]+v[3]*t[5]+v[5];
			let height=Math.hypot(c,d),angle=Math.atan2(b,a),ux=Math.cos(angle),uy=Math.sin(angle),style=text.styles[item.fontName],font=fonts[item.fontName] || {};
			let width=item.width*Math.hypot(v[0],v[1]),ascent=Number.isFinite(style.ascent)?style.ascent:.8;
			let corners=[[x+uy*height*ascent,y-ux*height*ascent],[x+uy*height*ascent+ux*width,y-ux*height*ascent+uy*width]];
			corners.push(...corners.map(([px,py])=>[px-uy*height,py+ux*height]));
			let xs=corners.map(p=>p[0]),ys=corners.map(p=>p[1]),family=this.fontFamily(font.name,style.fontFamily);
			return {text:item.str,dir:item.dir,rect:[Math.min(...xs),Math.min(...ys),Math.max(...xs),Math.max(...ys)],fontSize:Math.round(height*100)/100,
				family:family.css,weight:font.bold || /bold/i.test(family.name)?700:400,italic:!!font.italic || /italic|oblique/i.test(family.name),
				key:item.fontName+'|'+Math.round(height*100),chars:item.str.trim().length,baseline:Math.abs(ux)>Math.abs(uy)?y:x,horizontal:Math.abs(uy)<.001};
		});
		for(let region of page.regions.filter(region=>!region.media && region.rect)) {
			let [x1,y1,x2,y2]=region.rect,matched=items.filter(item=>item.rect[0]<x2 && item.rect[2]>x1 && item.rect[1]<y2 && item.rect[3]>y1);
			let groups=new Map();for(let item of matched){let group=groups.get(item.key) || {item,chars:0};group.chars+=item.chars;groups.set(item.key,group);}
			let main=[...groups.values()].sort((a,b)=>b.chars-a.chars)[0]?.item;
			if(!main)continue;
			Object.assign(region,{fontSize:main.fontSize,fontFamily:main.family,fontWeight:main.weight,italic:main.italic,fontSource:"pdf"});
			if(/table|formula|equation/i.test(region.type || ""))continue;
			let rows=matched.filter(item=>item.horizontal && (item.rect[0]+item.rect[2])/2>=x1 && (item.rect[0]+item.rect[2])/2<=x2 && (item.rect[1]+item.rect[3])/2>=y1 && (item.rect[1]+item.rect[3])/2<=y2);
			let normalized=value=>value.replace(/<\/?(?:sup|sub)\b[^>]*>/gi,'').normalize('NFKC').replace(/\s/g,'');
			// Reuse source line breaks only when doing so preserves every recognized character.
			if(rows.length && normalized(rows.map(item=>item.text).join(''))===normalized(region.text || "")) {
				region.sourceRuns=rows.map(item=>({rect:item.rect,text:item.text,line:true,baseline:item.baseline,dir:item.dir,
					fontSize:item.fontSize,fontFamily:item.family,fontWeight:item.weight,italic:item.italic,fontSource:"pdf",literal:true,type:region.type}));
			} else if(region.line && rows.length) {
				let baselines=rows.filter(item=>item.key===main.key).map(item=>item.baseline).sort((a,b)=>a-b);
				if(baselines.length && baselines.at(-1)-baselines[0]<main.fontSize*.5)region.baseline=baselines[Math.floor(baselines.length/2)];
			}
			if(!region.line && !/table|formula|equation/i.test(region.type || "")) {
				let rows=[...new Set(matched.filter(item=>item.key===main.key).map(item=>Math.round(item.baseline*10)/10))].sort((a,b)=>a-b);
				let gaps=rows.slice(1).map((y,i)=>y-rows[i]).filter(gap=>gap>=main.fontSize*.5).sort((a,b)=>a-b);
				if(gaps.length)region.lineHeight=gaps[Math.floor(gaps.length/2)];
			}
		}
	},

	rect(block) {
		if (Array.isArray(block.bbox)) return block.bbox;
		if (!Array.isArray(block.polygon) || !block.polygon.length) return null;
		let xs=block.polygon.map(point=>point[0]), ys=block.polygon.map(point=>point[1]);
		return [Math.min(...xs),Math.min(...ys),Math.max(...xs),Math.max(...ys)];
	},

	mineru(payload) {
		return (payload.pdf_info || []).map((page,index)=>{
			let regions=[];
			let append=(block,parentRect=null)=>{
				let rect=block.bbox || parentRect, type=block.type || "text";
				if (block.blocks?.length && !block.html) {block.blocks.forEach(child=>append(child,rect));return;}
				let spans=(block.lines || []).flatMap(line=>line.spans || []);
				let html=block.html || spans.map(span=>span.html || span.table_body || "").join("");
				let pictures=[block.image_path || block.img_path,...spans.map(span=>span.image_path || span.img_path)].filter(Boolean);
				if (html) regions.push({rect,type:"table",text:html,fontSize:block.font_size});
				else if (pictures.length && /image|figure|picture/.test(type)) regions.push({rect,type:"image",text:pictures.map(path=>`![](${String(path).replace(/^\//,"")})`).join("\n"),media:true});
				else {
					let lines=(block.lines || []).map(line=>({...line,text:OCRFlowDocument.text({lines:[{spans:(line.spans || []).filter(span=>span.type!=="image")} ]})})).filter(line=>line.text);
					if (lines.length && lines.every(line=>line.bbox && page.page_size?.[0] && line.bbox[3]-line.bbox[1] <= page.page_size[0]*.05)) for(let line of lines) regions.push({rect:line.bbox,type,text:line.text,line:true,fontSize:line.spans?.find(span=>span.font_size)?.font_size || block.font_size});
					else {let text=OCRFlowDocument.text(block);if(text)regions.push({rect,type,text,fontSize:block.font_size});}
				}
				if(block.blocks?.length)block.blocks.filter(child=>/caption|footnote/.test(child.type || "")).forEach(child=>append(child,rect));
			};
			[...(page.preproc_blocks || page.para_blocks || [])].sort((a,b)=>(a.index || 0)-(b.index || 0)).forEach(block=>append(block));
			(page.discarded_blocks || []).forEach(block=>append(block));
			return {page:index+1,size:page.page_size,regions};
		});
	},

	paddle(pages) {
		return pages.map((page,index)=>{
			let data=page.prunedResult || page;
			let regions=(data.parsing_res_list || data.blocks || []).map(block=>{
				let type=block.block_label || block.label, text=block.block_content ?? block.content ?? "";
				if(!text && (block.image_path || block.img_path))text=`![](${block.image_path || block.img_path})`;
				return {rect:block.block_bbox || block.bbox,text,type,media:/^(image|figure|chart|picture)$/.test(type),fontSize:block.font_size};
			}).filter(region=>region.rect && region.text);
			return {page:index+1,size:[data.width,data.height],regions};
		});
	},

	marker(payload,owner) {
		if(typeof payload==="string")payload=JSON.parse(payload);
		return (Array.isArray(payload)?payload:payload?.children || []).map((page,index)=>{
			let bounds=this.rect(page),regions=[];
			let append=block=>{
				if(block.children?.length){block.children.forEach(append);return;}
				let rect=this.rect(block),html=block.html || "",type=block.block_type || "Text";
				let text=owner.stripHTMLToPlainText(html).replace(/&#(x[0-9a-f]+|\d+);/gi,(_m,value)=>String.fromCodePoint(value[0].toLowerCase()==="x"?parseInt(value.slice(1),16):Number(value)));
				if(/table/i.test(type))text=html.match(/<table\b[\s\S]*<\/table>/i)?.[0] || text;
				let pictures=[...html.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["']/gi)].map(match=>`![](${match[1]})`);
				if(pictures.length)text=pictures.join("\n");
				if(rect && text)regions.push({rect:rect.map((n,i)=>n-(bounds?.[i%2] || 0)),text,type,media:!!pictures.length,fontSize:block.font_size});
			};
			(page.children || []).forEach(append);
			return {page:index+1,size:bounds?[bounds[2]-bounds[0],bounds[3]-bounds[1]]:null,regions};
		});
	}
};

Object.assign(DocFlow, {
	async convertDocumentLayout({source,original=null,htmlLayout}) {
		let {filePath,markdown}=await this.readSourceMarkdown(source);
		let root=PathUtils.join(PathUtils.parent(filePath),"_ocrflow"),documentPath=PathUtils.join(root,"document.json");
		let document=await IOUtils.exists(documentPath)?JSON.parse(await IOUtils.readUTF8(documentPath)):null;
		original ||= document?.source ? Zotero.Items.getByLibraryAndKey(document.source.libraryID,document.source.key) : null;
		let parent=this.parentForDocument(source),settings={...this.getOutputSettings("parse"),outputFormat:"html",htmlLayout};
		if(htmlLayout==="original" && !document?.layout?.some(page=>page.regions.some(region=>region.rect)) && !document?.blocks?.some(block=>block.fragments.some(fragment=>fragment.rect)))
			throw new Error("此全文缺少页面位置数据，无法转为原文布局。请重新识别以获取布局数据。");
		let result=await this.inlineStoredImagesInMarkdownAttachment({markdownText:markdown,markdownPath:filePath});
		result.document=document;this.normalizeResultImages(result);
		let layout=htmlLayout==="original"?this.prepareOriginalLayout(result):null;
		if(layout && original?.isPDFAttachment?.())await this.applyOriginalTypography(original,layout);
		let title=this.sanitizeFileName(`OCRFlow_${htmlLayout==="original"?"原文布局":"MD布局"}_${await this.documentFileStem(parent,original || source)}`);
		let attachment=await this.saveDocumentAttachment({libraryID:source.libraryID,parentItem:parent,title,markdown:result.markdownText,
			images:result.embeddedImages,format:"html",imageMode:settings.imageMode,tag:"#DocFlow-Parse",keepMarkdown:true,layout});
		try {
			if(document) {
				await this.saveDocumentData(attachment,result);
				let target=PathUtils.join(PathUtils.parent(await attachment.getFilePath()),"_ocrflow");
				for(let path of await IOUtils.getChildren(root))if(this.fileNameFromPath(path)!=="document.json")
					await IOUtils.copy(path,PathUtils.join(target,this.fileNameFromPath(path)),{recursive:true});
			}
			await this.linkParseSource(original || source,attachment);
		} catch(error) {await attachment.eraseTx();throw error;}
		return attachment;
	},

	async applyOriginalTypography(attachment,pages) {
		let reader=Zotero.Reader._readers.find(reader=>reader.itemID===attachment.id && !reader._isTabClosed)
			|| await Zotero.Reader.open(attachment.id,undefined,{openInBackground:true});
		if(!reader)throw new Error("请先打开原 PDF，再生成原文布局 HTML 以读取真实字号。");
		await reader._initPromise;await reader._internalReader?._primaryView?.initializedPromise;
		let pdf=this.outline.getReaderApp(reader)?.pdfDocument;
		if(!pdf)throw new Error("原 PDF 尚未就绪，无法读取真实字号。");
		for(let output of pages.filter(page=>page.regions.length && page.flow==null)) {
			let page=await pdf.getPage(output.page);page=page.wrappedJSObject || page;
			let text=await page.getTextContent(),fonts={};
			if(text.items.some(item=>item.str?.trim())){
				await page.getOperatorList();
				for(let id of Object.keys(text.styles))if(page.commonObjs.has(id)){
					let font=page.commonObjs.get(id);fonts[id]={name:font.name,bold:font.bold,italic:font.italic};
				}
			}
			let view=reader._internalReader._primaryView._iframeWindow;view=view.wrappedJSObject || view;
			OCRFlowLayout.applyTypography(output,text,page.getViewport(Object.assign(new view.Object(),{scale:1})),fonts);
		}
	},

	prepareOriginalLayout(parsedResult) {
		let doc=parsedResult.document, snapshots=doc?.layout || [], blocks=doc?.blocks || [];
		let numbers=[...new Set([...(doc?.pages || []).map(page=>page.page),...snapshots.map(page=>page.page)])].sort((a,b)=>a-b);
		if(!numbers.length || !snapshots.some(page=>page.regions.length) && !blocks.some(block=>block.fragments[0]?.page))return [{page:1,width:600,height:800,regions:[],flow:parsedResult.markdownText || ""}];
		return numbers.map(number=>{
			let snapshot=snapshots.find(page=>page.page===number),size=snapshot?.size || doc.pages.find(page=>page.page===number)?.size;
			let pageBlocks=blocks.filter(block=>block.fragments[0]?.page===number);
			let regions=(snapshot?.regions || []).map(region=>({...region,line:!!region.line && size?.[0]>0 && region.rect && region.rect[3]-region.rect[1]<=size[0]*.05}));
			if(!regions.length)regions=pageBlocks.filter(block=>block.fragments[0].rect).map(block=>({rect:block.fragments[0].rect,type:block.type,text:block.type==="figure"?block.text:block.rawText,media:block.type==="figure"}));
			let width=Number(size?.[0]),height=Number(size?.[1]);
			let located=width>0 && height>0 && regions.length;
			let flow=!located && pageBlocks.length ? pageBlocks.map(block=>block.type==="figure"?block.text:block.rawText).join("\n\n") : null;
			let extras=located ? pageBlocks.filter(block=>block.type==="figure" && !block.fragments[0].rect && !regions.some(region=>region.text===block.text)).map(block=>block.text).join("\n\n") : "";
			return {page:number,width:width>0?width:600,height:height>0?height:800,regions:located?regions:[],flow,extras};
		});
	},


	async renderOriginalLayout(pages,render) {
		// Measure the font's baseline, never fit or stretch glyphs to a recognition box.
		let baselineRatios=new Map(),baselineRatio=(region,content)=>{
			let key=JSON.stringify([region.fontFamily,region.fontWeight,region.italic,region.fontSize,content]);
			if(baselineRatios.has(key))return baselineRatios.get(key);
			let doc=Zotero.getMainWindow().document,node=doc.createElementNS('http://www.w3.org/1999/xhtml','div'),marker=doc.createElementNS('http://www.w3.org/1999/xhtml','span');
			let size=region.fontSize*4/3;
			node.setAttribute('style','position:absolute;left:-100000px;top:0;display:inline-block;white-space:pre;margin:0;padding:0;border:0;font-size:'+size+'px;line-height:'+size+'px;font-family:'+(region.fontFamily || family)+';font-weight:'+(region.fontWeight || 400)+';font-style:'+(region.italic?'italic':'normal')+';');
			node.innerHTML=content;
			for(let block of node.querySelectorAll('p,h1,h2,h3,h4,h5,h6,pre'))block.setAttribute('style','margin:0;font:inherit');
			marker.setAttribute('style','display:inline-block;width:0;height:0;margin:0;padding:0;border:0;vertical-align:baseline');(node.querySelector('p') || node).append(marker);doc.documentElement.append(node);
			try {let ratio=(marker.getBoundingClientRect().top-node.getBoundingClientRect().top)/size;baselineRatios.set(key,ratio);return ratio;} finally {node.remove();}
		};
		const family='"Times New Roman","Songti SC","STSong",serif';
		const contentRules='p,h1,h2,h3,h4,h5,h6,pre{margin:0;font:inherit}table{width:100%;table-layout:fixed;border-collapse:collapse;line-height:1.2}td,th{border:1px solid currentColor;padding:.15em .25em;overflow-wrap:anywhere}img{display:block;max-width:100%;height:auto}math{max-width:100%}';
		let scopedRules=scope=>contentRules.replace(/(^|})([^{}]+){/g,(_m,end,selectors)=>end+selectors.split(',').map(selector=>scope+' '+selector).join(',')+'{');
		let body=pages.map(page=>{
			let regionHTML=page.regions.flatMap(region=>region.sourceRuns || [region]).map(region=>{
				let [x1,y1,x2,y2]=region.rect || [],w=x2-x1,h=y2-y1;
				if(![x1,y1,x2,y2].every(Number.isFinite) || w<=0 || h<=0)return "";
				let line=region.line && !/formula|equation/i.test(region.type || "");
				let text=region.text || "",heading=/title|heading|sectionheader/i.test(region.type || ""),vertical=region.type==="vertical_text";
				if(/formula|equation/i.test(region.type || "") && !/^\s*\$\$/.test(text))text='$$\n'+text.replace(/^\$(.*)\$$/s,"$1")+'\n$$';
				let font=Number(region.fontSize)>0?Number(region.fontSize):/footnote|caption|header|footer|number/i.test(region.type || "")?9:heading?18:12;
				let content=region.literal?this.escapeHTML(text):render(text),media=region.media || /<img\b/i.test(content) && !this.stripHTMLToPlainText(content);
				if(Number.isFinite(region.baseline))y1=region.baseline-font*baselineRatio(region,content);
				let style='left:'+x1/page.width*100+'%;top:'+y1/page.height*100+'%;width:'+w/page.width*100+'%;height:'+h/page.height*100+'%;font-size:'+(font/page.width*100)+'cqw;';
				if(region.fontFamily)style+='font-family:'+region.fontFamily+';font-weight:'+region.fontWeight+';font-style:'+(region.italic?'italic':'normal')+';';
				if(region.lineHeight || line)style+='line-height:'+((line?font:region.lineHeight)/page.width*100)+'cqw;';
				let classes='ocr-region'+(line?' ocr-line':'')+(heading?' ocr-heading':'')+(media?' ocr-media':'')+(vertical?' ocr-vertical':'');
				return '<div class="'+classes+'" dir="'+(region.dir==='rtl'?'rtl':region.dir==='ltr'?'ltr':'auto')+'" data-type="'+this.escapeHTML(region.type || "text")+'" data-font-source="'+(region.fontSource || 'default')+'"'+(Number.isFinite(region.baseline)?' data-baseline="'+region.baseline+'"':'')+' style="'+this.escapeHTML(style)+'"><div class="ocr-content">'+content+'</div></div>';
			}).join("");
			let label=this.escapeHTML(ocrflowText("原文第 {0} 页").replace("{0}",page.page));
			let flow=page.flow!==null && page.flow!==undefined;
			return '<section class="ocr-page'+(flow?' ocr-flow':'')+'" aria-label="'+label+'" data-page="'+page.page+'" style="width:'+page.width*4/3+'px;'+(!flow?'aspect-ratio:'+page.width+'/'+page.height:'')+'">'+(flow?'<p class="ocr-layout-note">'+this.escapeHTML(ocrflowText("本页未提供完整位置数据，按阅读顺序显示。"))+'</p><div class="ocr-flow-content" dir="auto">'+render(page.flow)+'</div>':regionHTML)+'</section>'+(page.extras?'<section class="ocr-extra">'+render(page.extras)+'</section>':'');
		}).join("");
		return {body,style:'body{margin:0;padding:16px;background:#e8e8e8;color:#222;width:max-content;min-width:calc(100% - 32px)}.ocr-page{position:relative;container-type:inline-size;margin:0 auto 16px;background:white;overflow:hidden;font-family:'+family+'}.ocr-region{position:absolute;line-height:1.45;user-select:text}.ocr-content{overflow-wrap:anywhere}'+scopedRules('.ocr-content')+'.ocr-line .ocr-content{position:absolute;left:0;top:0;white-space:pre;width:max-content;overflow-wrap:normal}.ocr-heading{font-weight:700}.ocr-media .ocr-content{height:100%;width:100%}.ocr-media img{width:100%;height:100%;object-fit:contain}.ocr-vertical .ocr-content{writing-mode:vertical-rl;height:100%}.ocr-flow{max-width:100%;padding:24px;box-sizing:border-box}.ocr-flow-content{font:16px/1.7 '+family+';overflow-wrap:anywhere}.ocr-flow-content img,.ocr-extra img{max-width:100%;height:auto}.ocr-layout-note{font:12px/1.5 system-ui;color:#666}.ocr-extra{max-width:800px;margin:auto;background:white;padding:16px}@media print{body{padding:0;background:white}.ocr-page{margin:0;break-after:page;break-inside:avoid}.ocr-page:last-child{break-after:auto}}',script:''};
	}
});
