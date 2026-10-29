const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {PDFDocument}=require('../vendor/pdf-lib/pdf-lib.min.js');
function setup(){
 const prefs=new Map(),calls=[];
 const inputPDF=(async()=>{const pdf=await PDFDocument.create();pdf.addPage().drawText('First page');pdf.addPage().drawText('Second page');return pdf.save();})();
 let result={success:true,output:'{0}'+'-'.repeat(48)+'\n\n# Title\n\nText[^a].\n\n![Figure](figure.png)\n\n[^a]: Footnote\n\n{1}'+'-'.repeat(48)+'\n\nSecond page.',images:{'figure.png':btoa('image')},metadata:{page_stats:[{page_id:0},{page_id:1}]}};
 const state=(status,completed=0,stage='ocr')=>({job_id:'job1',status,stage,detail:stage,progress:{completed,total:2,unit:'页'}});
 const states=[state('running',0),state('running',1),state('running',2,'structure'),state('completed',2)];
 const response=data=>({ok:true,status:200,text:async()=>JSON.stringify(data)});
 const context={TextDecoder,Uint8Array,AbortController,FormData,Blob,URL,atob,btoa,setTimeout,clearTimeout,
  Zotero:{Prefs:{get:key=>prefs.get(key)},getMainWindow:()=>({AbortController,FormData,Blob}),debug:()=>{}},IOUtils:{read:async()=>inputPDF},
  fetch:async(url,options)=>{calls.push({url,options});if(url.endsWith('/openapi.json'))return response({paths:{'/v1/parse/jobs':{post:{}}}});if(options.method==='POST')return response(state('queued'));if(options.method==='DELETE')return response(state('canceled'));if(url.endsWith('/result'))return response(result);return response(states.shift()||state('completed',2));}};
 vm.createContext(context);for(const name of ['prompts.js','docflow.js','marker.js','workflow.js','document.js','layout.js','paddleocr.js','ocr-sources.js','collation.js'])vm.runInContext(fs.readFileSync(name,'utf8'),context);
 const m=context.DocFlow;m.refreshParseQueueDialog=()=>{};m.getPDFLibrary=()=>({PDFDocument});m.delayParsePoll=async()=>{};
 const attachment={id:1,attachmentFilename:'scan.pdf',getFilePath:async()=>'/scan.pdf'};
 const settings={parserService:'marker',markerSettings:{baseURL:'http://marker.test/',token:'test-token',mode:'balanced',forceOCR:true},timeoutMS:1000};
 return {m,context,prefs,calls,attachment,settings,states,state,response,setResult:value=>result=value};
}

test('Marker uploads the whole PDF once, polls real stages and downloads one full result',async()=>{
 const s=setup(),statuses=[];const result=await s.m.parseAttachmentWithMineru(s.attachment,s.settings,{signal:new AbortController().signal,onStatus:status=>statuses.push(status)});
 const uploads=s.calls.filter(c=>c.options.method==='POST');assert.equal(uploads.length,1);assert.equal(uploads[0].url,'http://marker.test/v1/parse/jobs');const form=uploads[0].options.body;
 assert.equal(form.get('file').name,'scan.pdf');assert.equal((await PDFDocument.load(await form.get('file').arrayBuffer())).getPageCount(),2);assert.equal(form.get('paginate_output'),'true');assert.equal(form.get('force_ocr'),'true');assert.equal(form.get('mode'),'balanced');assert.equal(uploads[0].options.headers.Authorization,'Bearer test-token');
 assert(statuses.some(row=>row.jobID==='job1'&&row.pageProgress?.completed===1));assert(statuses.some(row=>row.phase==='Marker · structure'&&row.pageProgress.completed===2));assert.equal(s.calls.at(-1).url,'http://marker.test/v1/parse/jobs/job1/result');
 const queued=statuses.find(row=>row.phase==='Marker · queued');assert.equal(queued.pageProgress,null);assert.match(queued.displayText,/尚未开始识别/);assert(!queued.displayText.includes('0/2'));
 assert.deepEqual(Array.from(result.document.pages,p=>p.page),[1,2]);assert(result.markdownText.includes('docflow-image://img-1'));assert(result.markdownText.includes('[^1]: Footnote'));assert.equal(result.embeddedImages[0].bytes.length,5);assert.equal(result.rawFiles[0].name,'response.json');assert.equal(JSON.parse(result.rawFiles[0].text).metadata.page_stats.length,2);
});

test('a known job resumes without uploading or reading the original PDF again',async()=>{
 const s=setup();s.states.splice(0,s.states.length,s.state('completed',2));s.context.IOUtils.read=()=>{throw Error('must not read PDF');};
 await s.m.parseWithMarker(s.attachment,s.settings,{jobID:'job1'});assert(!s.calls.some(c=>c.options.method==='POST'));assert.equal(s.calls[0].url,'http://marker.test/v1/parse/jobs/job1');
});

test('original-layout HTML requests geometry with the same Marker job and keeps its Markdown output',async()=>{
 const s=setup();
 s.setResult({success:true,output:'Original recognized text.',images:{},layout:{children:[{bbox:[0,0,600,800],children:[{block_type:'Text',html:'<p>Original recognized text.</p>',bbox:[10,20,500,40]}]}]}});
 const result=await s.m.parseWithMarker(s.attachment,{...s.settings,outputFormat:'html'});
 assert.equal(s.calls.filter(c=>c.options.method==='POST').length,1);
 assert.equal(s.calls.find(c=>c.options.method==='POST').options.body.get('include_layout'),'true');
 assert(result.markdownText.includes('Original recognized text.'));assert.equal(result.document.layout[0].regions[0].text,'Original recognized text.');
 assert(JSON.parse(result.rawFiles[0].text).layout);
});

test('Markdown-layout HTML does not request extra Marker geometry',async()=>{
 const s=setup();await s.m.parseWithMarker(s.attachment,{...s.settings,outputFormat:'html',htmlLayout:'markdown'});
 assert.equal(s.calls.find(c=>c.options.method==='POST').options.body.get('include_layout'),null);
});
test('temporary polling and result download outages reconnect without reuploading',async()=>{
 const s=setup(),fetch=s.context.fetch,statuses=[];let pollFailures=0,resultFailures=0;
 s.context.fetch=async(url,options)=>{
  if(options.method!=='POST'&&!url.endsWith('/result')&&pollFailures++===0)throw new TypeError('NetworkError when attempting to fetch resource.');
  if(url.endsWith('/result')&&resultFailures++===0)return {ok:false,status:503,text:async()=> 'restarting'};
  return fetch(url,options);
 };
 const result=await s.m.parseWithMarker(s.attachment,s.settings,{onStatus:row=>statuses.push(row)});
 assert(result.markdownText);assert.equal(s.calls.filter(row=>row.options.method==='POST').length,1);assert.equal(statuses.filter(row=>row.phase==='Marker · reconnecting').length,2);assert(statuses.filter(row=>row.phase==='Marker · reconnecting').every(row=>row.jobID==='job1'));
});
test('a persistent outage retains the original task for continuation and never submits another upload',async()=>{
 const s=setup(),fetch=s.context.fetch,statuses=[];let attempts=0;
 s.context.fetch=async(url,options)=>{if(options.method==='POST')return fetch(url,options);attempts++;throw new TypeError('NetworkError');};
 await assert.rejects(()=>s.m.parseWithMarker(s.attachment,s.settings,{onStatus:row=>statuses.push(row)}),error=>error.name==='MarkerConnectionError'&&error.message.includes('job1'));
 assert.equal(attempts,4);assert.equal(s.calls.filter(row=>row.options.method==='POST').length,1);assert.equal(statuses.at(-1).phase,'Marker · reconnecting');
 s.context.fetch=fetch;s.states.splice(0,s.states.length,s.state('completed',2));s.context.IOUtils.read=()=>{throw Error('must not reread PDF')};
 await s.m.parseWithMarker(s.attachment,s.settings,{jobID:'job1'});assert.equal(s.calls.filter(row=>row.options.method==='POST').length,1);
});
test('reconnecting an existing task is cancelable and does not turn cancellation into a retry',async()=>{
 const s=setup(),controller=new AbortController();let attempts=0;
 s.context.fetch=async()=>{attempts++;throw new TypeError('NetworkError')};
 s.m.delayParsePoll=async(_ms,{signal})=>{controller.abort();signal.throwIfAborted()};
 await assert.rejects(()=>s.m.parseWithMarker(s.attachment,s.settings,{jobID:'job1',signal:controller.signal}));assert.equal(attempts,1);assert.equal(s.calls.length,0);
});

test('failed jobs expose the error without downloading a partial result',async()=>{
 const s=setup();s.states.splice(0,s.states.length,{...s.state('failed',1),error:'GPU out of memory'});
 await assert.rejects(()=>s.m.parseWithMarker(s.attachment,s.settings),/GPU out of memory/);assert(!s.calls.some(c=>c.url.endsWith('/result')));
});

test('cancellation during submission retains the returned job ID and cancels that exact server task',async()=>{
 const s=setup(),controller=new AbortController();let began,release;const started=new Promise(r=>began=r),gate=new Promise(r=>release=r);const statuses=[];
 const fetch=s.context.fetch;s.context.fetch=async(url,options)=>{if(options.method==='POST'){began();await gate;}return fetch(url,options);};
 const running=s.m.parseWithMarker(s.attachment,s.settings,{signal:controller.signal,onStatus:row=>statuses.push(row)});await started;controller.abort();release();await assert.rejects(running);assert(statuses.some(row=>row.jobID==='job1'));
 await s.m.finishParseQueueCancellation({kind:'parse',started:true,settings:s.settings,cancelSettings:s.settings,cancelJobID:'job1'});
 const cancel=s.calls.find(c=>c.options.method==='DELETE');assert.equal(cancel.url,'http://marker.test/v1/parse/jobs/job1');assert.equal(s.calls.filter(c=>c.options.method==='POST').length,1);
});

test('request timeout aborts the upload; wait timeout preserves its job for continuation',async()=>{
 const s=setup();let expire,sent;const started=new Promise(r=>sent=r);s.context.setTimeout=fn=>{expire=fn;return 1;};s.context.clearTimeout=()=>{};
 s.context.fetch=async(url,options)=>{s.calls.push({url,options});sent();return new Promise((_r,reject)=>options.signal.addEventListener('abort',()=>reject(Error('aborted'))));};
 const running=s.m.parseWithMarker(s.attachment,s.settings);await started;expire();await assert.rejects(running,/超时/);assert(s.calls[0].options.signal.aborted);
 const t=setup();let clock=0;t.context.Date={now:()=>clock+=100};const reports=[];
 await assert.rejects(()=>t.m.parseWithMarker(t.attachment,{...t.settings,localJobTimeoutMS:50},{onStatus:row=>reports.push(row)}),{name:'MarkerJobWaitTimeout'});assert(reports.some(row=>row.jobID==='job1'));assert(!t.calls.some(c=>c.options.method==='DELETE'));
});

test('connection testing requires jobs API and rejects GUI addresses',async()=>{
 const s=setup();const result=await s.context.OCRFlowMarker.testConnection('http://marker.test/marker/upload','');assert.equal(result.endpoint,'http://marker.test/v1/parse/jobs');assert.equal(s.calls[0].options.body,undefined);
 s.context.fetch=async()=>({ok:true,text:async()=>'<html>Streamlit</html>'});await assert.rejects(()=>s.context.OCRFlowMarker.testConnection('http://gui.test'),/Streamlit/);
 s.context.fetch=async()=>s.response({paths:{'/marker/upload':{post:{}}}});await assert.rejects(()=>s.context.OCRFlowMarker.testConnection('http://old.test'),/任务与进度/);
});

test('Marker is an independent captured source and cannot duplicate Surya in dual OCR',()=>{
 const s=setup(),sources=s.context.OCRFlowSources;s.prefs.set('extensions.docflow.marker.url','http://original.test');const config={collationEnabled:false};s.m.captureOCRSettings(config);s.prefs.set('extensions.docflow.marker.url','http://changed.test');assert.equal(config.markerSettings.baseURL,'http://original.test');
 assert(!sources.valid('marker','marker',[]));assert(sources.valid('marker','paddle-cloud',[]));assert(!sources.valid('marker','ai:surya:1',[{id:'surya',llmModel:'datalab-to/surya-ocr-2'}]));
});

test('a missing server job is resubmitted once and can still be polled',async()=>{
 const s=setup(),fetch=s.context.fetch;let first=true;
 s.context.fetch=async(url,options)=>{if(first){first=false;return {ok:false,status:404,text:async()=> 'missing job'};}return fetch(url,options);};
 await s.m.parseWithMarker(s.attachment,s.settings,{jobID:'missing'});assert.equal(s.calls.filter(c=>c.options.method==='POST').length,1);assert(s.calls.some(c=>c.url.endsWith('/result')));
});

test('canceling during a status request aborts polling without uploading again',async()=>{
 const s=setup(),fetch=s.context.fetch,controller=new AbortController();let began;const started=new Promise(r=>began=r);
 s.context.fetch=async(url,options)=>{if(options.method==='POST')return fetch(url,options);s.calls.push({url,options});began();return new Promise((_r,reject)=>options.signal.addEventListener('abort',()=>reject(Error('poll aborted'))));};
 const running=s.m.parseWithMarker(s.attachment,s.settings,{signal:controller.signal});await started;controller.abort();await assert.rejects(running,{name:'AbortError'});assert.equal(s.calls.filter(c=>c.options.method==='POST').length,1);assert(s.calls.at(-1).options.signal.aborted);
});
test('an uncertain submission cancellation stays unconfirmed instead of claiming server termination',async()=>{
 const s=setup(),task={kind:'parse',started:true,settings:s.settings,phase:'提交 Marker 任务'};
 await s.m.finishParseQueueCancellation(task);assert.equal(task.cancelFailed,true);assert.match(task.detail,/取消未确认/);assert.match(task.error,/任务 ID/);assert(!s.calls.some(call=>call.options.method==='DELETE'));
});
test('queued Marker status clears upload progress and retains its job ID before rendering',async()=>{
 const s=setup(),task={attachment:s.attachment,settings:s.settings,controller:new AbortController()};
 s.m.parseAttachmentWithMineru=async(_attachment,_settings,{onStatus})=>{
  onStatus({phase:'提交 Marker 任务',pageProgress:{completed:0,total:2,unit:'页'}});assert.equal(task.progress.total,2);
  s.m.setTaskStep=()=>{throw Error('controlled view closed')};
  onStatus({phase:'Marker · queued',jobID:'job1',pageProgress:null});
 };
 await assert.rejects(()=>s.m.runParseTask(task),/controlled view closed/);assert.equal(task.jobID,'job1');assert.equal(task.cancelJobID,'job1');assert.equal(task.progress,null);
});


test('dual OCR lists both Marker profiles and captures the explicitly selected connection',()=>{
 const s=setup(),sources=s.context.OCRFlowSources;
 const choices=sources.choices([]).filter(row=>row.value.startsWith('marker'));
 assert.deepEqual(Array.from(choices,row=>row.value),['marker-cloud','marker-local']);
 assert(!sources.valid('marker-cloud','marker-local',[]));assert(sources.valid('marker-cloud','mineru-local',[]));
 s.prefs.set('extensions.docflow.marker.apiType','cloud');
 s.prefs.set('extensions.docflow.marker.url','http://local.test');s.prefs.set('extensions.docflow.marker.token','local-key');
 s.prefs.set('extensions.docflow.marker.cloud.url','https://cloud.test/api/v1');s.prefs.set('extensions.docflow.marker.cloud.token','cloud-key');
 const local=s.m.sourceSettings('marker-local',{}),cloud=s.m.sourceSettings('marker-cloud',{});
 assert.equal(local.markerSettings.apiType,'local');assert.equal(local.markerSettings.baseURL,'http://local.test');assert.equal(local.markerSettings.token,'local-key');
 assert.equal(cloud.markerSettings.apiType,'cloud');assert.equal(cloud.markerSettings.baseURL,'https://cloud.test/api/v1');assert.equal(cloud.markerSettings.token,'cloud-key');
 s.prefs.set('extensions.docflow.marker.apiType','local');assert.equal(cloud.markerSettings.apiType,'cloud');
 assert.equal(s.m.sourceSettings('marker',{}).markerSettings.apiType,'local');
});
