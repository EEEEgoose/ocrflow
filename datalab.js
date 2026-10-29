// Datalab's hosted Convert API. No Python SDK or account-usage scraping is required.
var OCRFlowDatalab = {
 baseURL(address){const base=String(address||'https://www.datalab.to/api/v1').trim().replace(/\/+$/,'').replace(/\/convert$/,'');if(new URL(base).protocol!=='https:')throw Error('Datalab 在线 API 必须使用 HTTPS 地址');return base;},
 async request(url,options={}){
  const response=await fetch(url,options);
  if(!response.ok){const error=Error(`Datalab HTTP ${response.status}: ${(await response.text()).slice(0,400)}`);error.status=response.status;const retry=response.headers?.get('Retry-After');if(retry&&/^\d+$/.test(retry))error.retryAfterMS=Number(retry)*1000;throw error;}
  const data=await response.json();if(data.success===false)throw Error('Datalab 处理失败：'+(data.error||'未提供错误详情'));return data;
 },
 async testConnection(address,token,signal){
  if(!token.trim())throw Error('请填写 Datalab API Key');const base=this.baseURL(address);
  await this.request(base+'/health',{signal,headers:{'X-API-Key':token.trim()}});
  return {endpoint:base+'/convert',notice:'服务已连通；此测试不提交计费文档，API Key 权限以实际识别请求为准'};
 }
};

OCRFlowDatalab.install=function(owner){Object.assign(owner,{
 async parseWithDatalab(attachment,settings,options={}){
  const config=settings.markerSettings||this.getMarkerSettings(),base=OCRFlowDatalab.baseURL(config.baseURL),signal=options.signal;
  if(!config.token)throw Error('请先填写 Datalab API Key');signal?.throwIfAborted();
  const controller=this.createAbortController(),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});
  let jobID=options.jobID,total=0,job;
  const request=async(path,extra={},ownController=controller)=>{
   const url=new URL(path,base+'/');const headers=url.origin===new URL(base).origin?{'X-API-Key':config.token}:{};
   return this.withTimeout(()=>OCRFlowDatalab.request(url.href,{signal:ownController.signal,headers,...extra}),settings.timeoutMS||1200000,'Datalab 请求').catch(error=>{if(error.name==='TimeoutError')ownController.abort();throw error;});
  };
  const read=async url=>{
   for(let attempt=0;;attempt++)try{return await request(url);}catch(error){
    signal?.throwIfAborted();if(!['TypeError','NetworkError'].includes(error.name)&&![429,502,503,504].includes(error.status))throw error;
    if(attempt===3){const lost=Error(`Datalab 连接中断，任务 ${jobID} 已保留；可继续等待，不要重复上传。`);lost.name='MarkerConnectionError';throw lost;}
    options.onStatus?.({phase:'Datalab · reconnecting',jobID,displayText:`Datalab 连接或限流等待，正在重试 ${attempt+1}/3；保留原任务`});
    await this.delayParsePoll(error.retryAfterMS||2000*2**attempt,{signal:controller.signal});
   }
  };
  try {
   if(jobID){job=await read(base+'/convert/'+encodeURIComponent(jobID));if(['failed','error','canceled'].includes(job.status))jobID=null;}
   if(!jobID) {
    const prepared=await this.loadPDFForParsing(await IOUtils.read(await attachment.getFilePath()),options),bytes=prepared.bytes;total=prepared.pdf.getPageCount();
    const win=Zotero.getMainWindow(),form=new win.FormData();form.append('file',new win.Blob([bytes],{type:'application/pdf'}),attachment.attachmentFilename||'document.pdf');
    for(const [key,value]of Object.entries({output_format:settings.outputFormat==='html'&&settings.htmlLayout!=='markdown'?'markdown,json':'markdown',mode:config.mode,paginate:'true',disable_image_captions:'true'}))form.append(key,value);
    options.onStatus?.({phase:'提交 Datalab 任务',jobID:null,displayText:`正在上传整份 PDF（${total} 页）到 Datalab`,pageProgress:null});
    job=await request(base+'/convert',{method:'POST',body:form},this.createAbortController());jobID=job.request_id;if(!jobID)throw Error('Datalab 未返回任务 ID');
   }
   const check=job.request_check_url||base+'/convert/'+encodeURIComponent(jobID);
   const initial=job;
   if(new URL(check).origin!==new URL(base).origin)throw Error('Datalab 查询地址与配置的 API 服务器不一致');
   const started=Date.now();
   for(;;){
    options.onStatus?.({phase:'Datalab · '+(job.status||'processing'),jobID,displayText:`Datalab ${job.status==='complete'?'处理完成':'云端处理中，等待完整结果'}；任务 ${jobID}`,pageProgress:null});signal?.throwIfAborted();
    if(job.status==='complete')break;if(['failed','error','canceled'].includes(job.status))throw Error(job.error||'Datalab 云端任务失败');
    if(settings.localJobTimeoutMS>0&&Date.now()-started>=settings.localJobTimeoutMS){const error=Error(`Datalab 等待达到上限，原任务 ${jobID} 保留，可继续等待。`);error.name='MarkerJobWaitTimeout';throw error;}
    await this.delayParsePoll(settings.pollIntervalMS||2000,{signal:controller.signal});job=await read(check);
   }
   const completed=job;
   if(job.result_url&&!job.markdown){const url=new URL(job.result_url);if(url.protocol!=='https:')throw Error('Datalab 结果下载地址必须使用 HTTPS');job=await read(url.href);}
   if(typeof job.markdown!=='string'||!job.markdown.trim())throw Error('Datalab 未返回完整 Markdown');
   const result={markdownText:job.markdown.replace(/^\{(\d+)\}-{48}[ \t]*$/gm,(_m,n)=>`<!-- 第 ${Number(n)+1} 页 -->`),rawMarkdownText:job.markdown,rawFiles:[{name:'response.json',text:JSON.stringify(job)},{name:'initial.json',text:JSON.stringify(initial)},{name:'completed.json',text:JSON.stringify(completed)}],embeddedImages:[],recognition:{source:'marker',api:'datalab'}};
   for(const [name,value]of Object.entries(job.images||{})){
    const binary=atob(String(value).replace(/^data:[^,]+;base64,/,''));result.embeddedImages.push({marker:`docflow-image://img-${result.embeddedImages.length+1}`,entryName:name,fileName:this.fileNameFromPath(name),mimeType:this.guessMimeType(name),bytes:Uint8Array.from(binary,ch=>ch.charCodeAt(0))});
   }
   this.normalizeResultImages(result);result.document=OCRFlowDocument.fromMarkdown(result.markdownText,'datalab',text=>this.splitTranslationBlocks(text));
   if(job.json)result.document.layout=OCRFlowLayout.marker(job.json,this);
   for(let page=1;page<=(job.page_count||completed.page_count||total);page++)if(!result.document.pages.some(row=>row.page===page))result.document.pages.push({page,printed:null});
   result.document.pages.sort((a,b)=>a.page-b.page);result.markdownText=OCRFlowDocument.render(result.document);return result;
  }finally{signal?.removeEventListener('abort',abort);}
 }
});};
