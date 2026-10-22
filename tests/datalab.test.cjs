const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');
const {PDFDocument}=require('../vendor/pdf-lib/pdf-lib.min.js');
function setup(){
 const calls=[],statuses=[];const pdf=(async()=>{const doc=await PDFDocument.create();doc.addPage();doc.addPage();return doc.save()})();
 const initial={success:true,request_id:'cloud1',request_check_url:'https://datalab.test/api/v1/convert/cloud1'};
 const final={status:'complete',markdown:'{0}'+'-'.repeat(48)+'\n\n# Title\n\nBody[^n].\n\n![](figure.png)\n\n[^n]: Footnote',page_count:2,images:{'figure.png':btoa('image')},metadata:{fixture:true}};
 const states=[{status:'processing'},final];const response=data=>({ok:true,status:200,json:async()=>data,text:async()=>JSON.stringify(data)});
 const context={TextDecoder,Uint8Array,AbortController,FormData,Blob,URL,atob,btoa,setTimeout,clearTimeout,
  Zotero:{Prefs:{get:()=>undefined},getMainWindow:()=>({AbortController,FormData,Blob}),debug(){}},IOUtils:{read:async()=>pdf},
  fetch:async(url,options)=>{calls.push({url,options});if(url.endsWith('/health'))return response({status:'ok'});if(options.method==='POST')return response(initial);return response(states.shift()||final)}
 };
 vm.createContext(context);for(const file of ['prompts.js','docflow.js','marker.js','workflow.js','document.js','datalab.js'])vm.runInContext(fs.readFileSync(file,'utf8'),context);
 const m=context.DocFlow;context.OCRFlowDatalab.install(m);m.getPDFLibrary=()=>({PDFDocument});m.delayParsePoll=async()=>{};m.refreshParseQueueDialog=()=>{};
 const settings={parserService:'marker',markerSettings:{apiType:'cloud',baseURL:'https://datalab.test/api/v1',token:'cloud-secret',mode:'accurate'},timeoutMS:1000};
 return {m,context,calls,statuses,settings,initial,final,states,response,attachment:{id:1,attachmentFilename:'scan.pdf',getFilePath:async()=>'/scan.pdf'}};
}
test('Datalab submits a whole PDF once through Convert, polls the returned URL and retains images and page sources',async()=>{
 const s=setup(),result=await s.m.parseWithMarker(s.attachment,s.settings,{signal:new AbortController().signal,onStatus:x=>s.statuses.push(x)});
 assert.equal(s.calls.filter(c=>c.options.method==='POST').length,1);const upload=s.calls[0];assert.equal(upload.url,'https://datalab.test/api/v1/convert');assert.equal(upload.options.headers['X-API-Key'],'cloud-secret');assert.equal(upload.options.body.get('mode'),'accurate');assert.equal(upload.options.body.get('force_ocr'),null);assert.equal(upload.options.body.get('disable_image_captions'),'true');
 assert(s.calls.some(c=>c.url===s.initial.request_check_url));assert(s.statuses.every(x=>x.pageProgress===null));assert(result.markdownText.includes('docflow-image://img-1'));assert.equal(result.embeddedImages[0].bytes.length,5);assert.deepEqual(Array.from(result.document.pages,x=>x.page),[1,2]);assert.equal(JSON.parse(result.rawFiles[0].text).metadata.fixture,true);
});
test('completed cloud jobs resume without reading or uploading the source document',async()=>{
 const s=setup();s.states.splice(0,s.states.length,s.final);s.context.IOUtils.read=()=>{throw Error('must not read PDF')};await s.m.parseWithDatalab(s.attachment,s.settings,{jobID:'cloud1'});assert(!s.calls.some(c=>c.options.method==='POST'));
});
test('signed result downloads do not receive the Datalab API key',async()=>{
 const s=setup(),fetch=s.context.fetch;s.states.splice(0,s.states.length,{status:'complete',result_url:'https://files.example/result?signature=fixture'});
 s.context.fetch=async(url,options)=>{if(url.startsWith('https://files.example')){s.calls.push({url,options});assert.equal(options.headers['X-API-Key'],undefined);return s.response(s.final)}return fetch(url,options)};
 await s.m.parseWithDatalab(s.attachment,s.settings,{jobID:'cloud1'});assert(s.calls.some(c=>c.url.startsWith('https://files.example')));
});
test('canceling while uploading retains the cloud request ID and never sends a fake server cancel request',async()=>{
 const s=setup(),controller=new AbortController(),fetch=s.context.fetch;let began,release;const started=new Promise(r=>began=r),gate=new Promise(r=>release=r);
 s.context.fetch=async(url,options)=>{if(options.method==='POST'){began();await gate}return fetch(url,options)};
 const running=s.m.parseWithDatalab(s.attachment,s.settings,{signal:controller.signal,onStatus:x=>s.statuses.push(x)});await started;controller.abort();release();await assert.rejects(running);assert(s.statuses.some(x=>x.jobID==='cloud1'));
 const task={kind:'parse',started:true,settings:s.settings,cancelSettings:s.settings,cancelJobID:'cloud1'};await s.m.finishParseQueueCancellation(task);assert.equal(task.state,'canceled');assert.match(task.detail,/Datalab 云端任务可能继续/);assert(!s.calls.some(c=>c.options.method==='DELETE'));
});
test('a transient cloud polling failure reconnects without a second upload',async()=>{
 const s=setup(),fetch=s.context.fetch;let fail=true;s.context.fetch=async(url,options)=>{if(options.method!=='POST'&&fail){fail=false;throw new TypeError('network')}return fetch(url,options)};
 await s.m.parseWithDatalab(s.attachment,s.settings,{onStatus:x=>s.statuses.push(x)});assert.equal(s.calls.filter(c=>c.options.method==='POST').length,1);assert(s.statuses.some(x=>x.phase==='Datalab · reconnecting'));
});
test('connection tests do not upload a document, and an unsupported check origin is rejected',async()=>{
 const s=setup(),result=await s.context.OCRFlowDatalab.testConnection(s.settings.markerSettings.baseURL,'key');assert(result.notice.includes('不提交计费文档'));assert(s.calls.every(c=>c.options.method!=='POST'));
 s.initial.request_check_url='https://other.example/steal';await assert.rejects(s.m.parseWithDatalab(s.attachment,s.settings),/服务器不一致/);assert(!s.calls.some(c=>c.url.includes('other.example')));
});
test('explicit retry of a failed cloud job submits one replacement job',async()=>{
 const s=setup();s.states.splice(0,s.states.length,{status:'failed',error:'old request failed'},s.final);
 await s.m.parseWithDatalab(s.attachment,s.settings,{jobID:'failed-old'});assert.equal(s.calls.filter(c=>c.options.method==='POST').length,1);assert(s.calls[0].url.endsWith('/failed-old'));
});
test('loading the settings helper cannot replace live conversion methods owned by the main plugin',()=>{
 const original=()=> 'main lifetime',runtime={parseWithDatalab:original},context={DocFlow:runtime};vm.createContext(context);vm.runInContext(fs.readFileSync('datalab.js','utf8'),context);assert.equal(runtime.parseWithDatalab,original);assert.equal(typeof context.OCRFlowDatalab.testConnection,'function');
});
