const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path').posix;
const {PDFDocument,PDFName}=require('../vendor/pdf-lib/pdf-lib.min.js');
function setup(){
 const files=new Map(),batches=new Map(),applied=[],uploads=[],statuses=[];let next=0,failName='',failOnce=false;
 const context={AbortController,URL,Headers,Uint8Array,TextEncoder,TextDecoder,btoa,setTimeout,clearTimeout,PathUtils:{tempDir:'/tmp',join:path.join,parent:path.dirname},
  IOUtils:{exists:async p=>files.has(p),makeDirectory:async()=>{},write:async(p,b)=>files.set(p,b),read:async p=>files.get(p),remove:async()=>{}},
  Zotero:{getMainWindow:()=>({AbortController}),debug(){},Prefs:{get(){}},Promise:{delay:async()=>{}}},fetch:async(url,options)=>{
   const [id,index]=url.replace('https://upload/','').split('/');const row=batches.get(id).rows[Number(index)];row.uploaded=true;row.bytes=options.body;uploads.push(row);return {ok:true};
  }};
 vm.createContext(context);for(const name of ['docflow.js','recognition.js'])vm.runInContext(fs.readFileSync(name,'utf8'),context);
 const m=context.DocFlow;m.getPDFLibrary=()=>({PDFDocument});m.requestMineruJSON=async request=>{
  if(request.url.endsWith('/file-urls/batch')){
   assert(request.body.files.length<=50);applied.push(request.body);const id=String(++next),rows=request.body.files.map(file=>({...file,polls:0}));batches.set(id,{rows});return {code:0,data:{batch_id:id,file_urls:rows.map((_,i)=>`https://upload/${id}/${i}`)}};
  }
  const batch=batches.get(request.url.split('/').at(-1));return {code:0,data:{extract_result:[...batch.rows].reverse().map(row=>{
   if(!row.uploaded)return {data_id:row.data_id,state:'pending'};
   const failed=failOnce&&row.name.includes(failName);if(failed)failOnce=false;
   return {data_id:row.data_id,state:failed?'failed':++row.polls===1?'running':'done',extract_progress:{extracted_pages:1},err_msg:'controlled failure',full_zip_url:row.data_id};
  })}};
 };
 m.downloadParseResultZip=async({zipURL})=>new TextEncoder().encode(zipURL);
 m.extractNoteContentFromMineruZip=async(bytes,name)=>{
  const dataID=new TextDecoder().decode(bytes),row=[...batches.values()].flatMap(b=>b.rows).find(r=>r.data_id===dataID);
  const pdf=/\.pdf$/.test(name)?await PDFDocument.load(new Uint8Array(row.bytes)):null;
  if(pdf)assert(pdf.getPages().every(page=>page.node.Resources().lookup(PDFName.of('XObject')).keys().length));
  return {markdownText:`${name}: ![](docflow-image://img-1)`,embeddedImages:[{marker:'docflow-image://img-1',fileName:'same.png',bytes:Uint8Array.of(1)}],outlinePages:pdf?pdf.getPages().map(p=>'page-'+(p.getWidth()-299)):[],outlineHeadings:[{title:name,page:1}]};
 };
 return {m,context,files,applied,uploads,statuses,fail:(name)=>{failName=name;failOnce=true;}};
}
const settings={apiBaseURL:'https://cloud/api/v4',apiToken:'test',modelVersion:'vlm',recognitionLanguage:'arabic',pollIntervalMS:1,timeoutMS:10000};
async function source(count){
 const pdf=await PDFDocument.create(),image=await pdf.embedPng(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXXsAAAAASUVORK5CYII=','base64'));
 for(let i=0;i<count;i++)pdf.addPage([300+i,800]).drawImage(image,{x:0,y:0,width:10,height:10});return pdf.save();
}
test('real PDF page copying preserves scans, uses 200-page pieces, offsets outlines and remaps colliding images',async()=>{
 for(const count of [200,201,401]){
  const s=setup(),state={};const result=await s.m.parseCloudDocument(await source(count),'book.pdf',1,settings,{cloudState:state,onStatus:p=>s.statuses.push(p)});
  assert.equal(s.applied.length,1);assert.equal(s.applied[0].files.length,Math.ceil(count/200));
  assert.equal(s.applied[0].language,'arabic');assert.equal(s.applied[0].enable_formula,true);
  assert.deepEqual(Array.from(result.outlinePages),Array.from({length:count},(_,i)=>'page-'+(i+1)));
  assert.deepEqual(Array.from(result.outlineHeadings,h=>h.page),Array.from({length:Math.ceil(count/200)},(_,i)=>i*200+1));
  assert.equal(new Set(result.embeddedImages.map(i=>i.marker)).size,Math.ceil(count/200));
  assert(s.statuses.some(p=>p.pageProgress?.completed===count));
 }
});

test('the document entry point retains its caller-owned cloud state and checkpoints submitted batches',async()=>{
 const s=setup(),cloudState={},snapshots=[];s.files.set('/source.pdf',await source(201));
 const attachment={id:1,attachmentFilename:'source.pdf',getFilePath:async()=>'/source.pdf'};
 const result=await s.m.parseAttachmentWithMineru(attachment,{...settings,apiMode:'cloud'},{cloudState,checkpoint:async()=>{
  snapshots.push((cloudState.parts||[]).map(part=>({batchID:part.batchID,uploaded:part.uploaded})));
 }});
 assert.equal(result.outlinePages.length,201);assert.equal(cloudState.totalPages,201);
 assert(snapshots.some(parts=>parts.length===2&&parts.every(part=>part.batchID)));
 assert(snapshots.some(parts=>parts.length===2&&parts.every(part=>part.uploaded)));
});

test('an interrupted upload is checked against its existing batch before resuming',async()=>{
 const s=setup();const response=await s.m.requestMineruJSON({url:settings.apiBaseURL+'/file-urls/batch',body:{files:[{name:'document.docx',data_id:'existing-part'}]}});
 await s.context.fetch(response.data.file_urls[0],{method:'PUT',body:Uint8Array.of(1)});
 const cloudState={parts:[{index:0,start:0,end:0,name:'document.docx',path:'/missing/part',dataID:'existing-part',batchID:response.data.batch_id,
  uploadURL:response.data.file_urls[0],uploadStarted:true,uploaded:false}]};
 const result=await s.m.parseCloudDocument(Uint8Array.of(1),'document.docx',1,settings,{cloudState});
 assert(result.markdownText.startsWith('document.docx'));assert.equal(s.applied.length,1);assert.equal(s.uploads.length,1);
});

test('a resumed uploaded cloud document does not require its original local attachment',async()=>{
 const s=setup();const response=await s.m.requestMineruJSON({url:settings.apiBaseURL+'/file-urls/batch',body:{files:[{name:'document.docx',data_id:'existing-part'}]}});
 await s.context.fetch(response.data.file_urls[0],{method:'PUT',body:Uint8Array.of(1)});
 const cloudState={parts:[{index:0,start:0,end:0,name:'document.docx',path:'/missing/part',dataID:'existing-part',batchID:response.data.batch_id,uploaded:true}]};
 const attachment={id:1,attachmentFilename:'document.docx',getFilePath:async()=>{throw Error('An uploaded job must not read its original input');}};
 const result=await s.m.parseAttachmentWithMineru(attachment,{...settings,apiMode:'cloud'},{cloudState});
 assert(result.markdownText.startsWith('document.docx'));assert.equal(s.applied.length,1);assert.equal(s.uploads.length,1);
});

test('an encrypted PDF is normalized before the cloud uploader receives its bytes',async()=>{
 const s=setup(),encrypted=fs.readFileSync('tests/fixtures/permission-encrypted.pdf'),plain=fs.readFileSync('tests/fixtures/encryption-source.pdf');let normalized=0;
 s.context.Zotero.PDFWorker={_enqueue:async fn=>fn(),_query:async()=>{normalized++;return {buf:Uint8Array.from(plain).buffer};}};
 const result=await s.m.parseCloudDocument(encrypted,'restricted.pdf',1,settings,{cloudState:{}});
 assert.equal(normalized,1);assert.equal(s.uploads.length,1);assert.deepEqual(Buffer.from(s.uploads[0].bytes),plain);
 assert.deepEqual(Array.from(result.outlinePages),['page-1','page-2','page-3']);assert.deepEqual(encrypted,fs.readFileSync('tests/fixtures/permission-encrypted.pdf'));
});
test('51 files from five documents split into batches of at most 50 and results match data_id despite reverse response order',async()=>{
 const s=setup(),contexts=Array.from({length:5},()=>({cloudState:{}}));let active=0,peak=0;
 const fetch=s.context.fetch;s.context.fetch=async(...args)=>{peak=Math.max(peak,++active);await new Promise(r=>setTimeout(r,1));const reply=await fetch(...args);active--;return reply;};
 const parts=Array.from({length:51},(_,i)=>({index:i,start:0,end:0,path:'/p'+i,name:'file'+i+'.docx',dataID:'doc-'+i}));
 const results=await Promise.all(parts.map((part,i)=>{s.files.set(part.path,Uint8Array.of(i));return s.m.queueCloudPart(part,settings,contexts[i%5],()=>{});}));
 assert.deepEqual(s.applied.map(b=>b.files.length),[50,1]);assert(peak<=5,'only one upload per document may be active across batches');
 results.forEach((r,i)=>assert(r.markdownText.startsWith('file'+i+'.docx')));
});
test('failed pieces retry independently, keeping successful output and original page offsets',async()=>{
 const s=setup(),cloudState={},bytes=await source(401);s.fail('pages-201-400');
 await assert.rejects(s.m.parseCloudDocument(bytes,'book.pdf',1,settings,{cloudState}),/controlled failure/);
 const count=s.uploads.length;assert.equal(cloudState.parts.filter(p=>p.result).length,2);
 const result=await s.m.parseCloudDocument(bytes,'book.pdf',1,settings,{cloudState});assert.equal(s.uploads.length,count+1);assert.equal(result.outlinePages.length,401);assert.equal(result.outlineHeadings[1].page,201);
});
test('canceling one document does not abort another document sharing its batch',async()=>{
 const s=setup(),controller=new AbortController();let canceled=false;
 const a=s.m.parseCloudDocument(Uint8Array.of(1),'a.docx',1,settings,{cloudState:{},signal:controller.signal,onStatus:p=>{if(p.jobID&&!canceled){canceled=true;controller.abort();}}});
 const cancellation=assert.rejects(a,{name:'AbortError'});
 const b=s.m.parseCloudDocument(Uint8Array.of(2),'b.docx',2,settings,{cloudState:{}});
 await cancellation;assert((await b).markdownText.startsWith('b.docx'));
});
test('HTML uses its dedicated model and omits formula, table, and language parameters',async()=>{
 const s=setup();await s.m.parseCloudDocument(Uint8Array.of(1),'page.html',1,{...settings,modelVersion:'MinerU-HTML',enableFormula:false,enableTable:false},{cloudState:{}});
 for(const key of ['language','enable_formula','enable_table'])assert(!(key in s.applied[0]));
});
test('direct and secondary-reader cloud calls honor the default two-document limit and release slots after completion',async()=>{
 const s=setup(),work=Array.from({length:6},()=>({cloudState:{}}));
 const runs=work.map((context,i)=>s.m.parseCloudDocument(Uint8Array.of(i),'document'+i+'.docx',i,settings,context));
 await Promise.all(runs);assert(s.applied.every(batch=>batch.files.length<=2));assert.equal(s.m.cloudDocumentCount,0);assert.equal(s.m.cloudDocumentWaiting.length,0);
});

test('the cloud document pool admits ten documents and reports waiting work accurately',async()=>{
 const s=setup(),contexts=Array.from({length:11},()=>({onStatus:update=>s.statuses.push(update)}));
 const runs=contexts.map(context=>s.m.acquireCloudDocument(context,10));
 await Promise.all(runs.slice(0,10));assert.equal(s.m.cloudDocumentCount,10);
 assert(s.statuses.some(update=>update.phase==='等待识别名额'));
 s.m.cloudDocumentCount--;s.m.pumpCloudDocuments();await runs[10];assert.equal(s.m.cloudDocumentCount,10);
});

test('manual cloud progress queries reuse existing batches and refresh every pending slice without uploading',async()=>{
 const s=setup(),requests=[];
 const task={state:'running',active:true,settings,cloudState:{totalPages:3,parts:[
  {batchID:'batch-a',dataID:'a',uploaded:true,start:0,end:2,state:'pending',appliedAt:Date.now()-120000},
  {batchID:'batch-b',dataID:'b',uploaded:true,start:2,end:3,state:'pending',appliedAt:Date.now()-120000}
 ]}};
 s.m.refreshParseQueueDialog=()=>{};
 s.m.requestMineruJSON=async request=>{requests.push(request);return {code:0,data:{extract_result:[{data_id:request.url.endsWith('batch-a')?'a':'b',state:'running',extract_progress:{total_pages:2,extracted_pages:1}}]}};};
 assert(s.m.canQueryCloudTask(task));await s.m.queryCloudTaskProgress(task);
 assert.equal(requests.length,2);assert(requests.every(request=>!request.method||request.method==='GET'));
 assert(task.cloudState.parts.every(part=>part.state==='running'));assert.equal(task.progress.completed,2);
 assert.equal(task.cloudQuerying,false);assert.equal(s.uploads.length,0);assert.equal(s.applied.length,0);
 s.m.requestMineruJSON=async()=>{throw Error('controlled query failure');};
 await s.m.queryCloudTaskProgress(task);assert(task.cloudQueryMessage.includes('controlled query failure'));
 assert.equal(task.state,'running');assert(task.cloudState.parts.every(part=>part.uploaded));
 assert.deepEqual(task.cloudState.parts.map(part=>part.batchID),['batch-a','batch-b']);
});

test('cloud queue progress includes elapsed time and an older response cannot undo completion',()=>{
 const s=setup(),part={dataID:'a',batchID:'existing',uploaded:true,start:0,end:3,state:'pending',appliedAt:Date.now()-180000};
 const update=s.m.cloudDocumentProgress({totalPages:3,parts:[part]});
 assert.equal(update.phase,'MinerU · queued');assert(update.displayText.includes('已等待 3 分钟'));
 s.m.updateCloudPartProgress(part,{state:'done'});s.m.updateCloudPartProgress(part,{state:'pending'});
 assert.equal(part.state,'done');
});

test('repeat manual query clicks share the busy state and a timeout only ends the manual request',async()=>{
 const s=setup(),task={state:'running',settings:{...settings,timeoutMS:10},cloudState:{parts:[{batchID:'existing',dataID:'a',uploaded:true,start:0,end:1,state:'pending'}]}};
 let calls=0;s.m.refreshParseQueueDialog=()=>{};
 s.m.requestMineruJSON=({signal})=>{calls++;return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));};
 const first=s.m.queryCloudTaskProgress(task);await s.m.queryCloudTaskProgress(task);await first;
 assert.equal(calls,1);assert.equal(task.cloudQuerying,false);assert(task.cloudQueryMessage.includes('查询已超时或终止'));
 assert.equal(task.state,'running');assert.equal(task.cloudState.parts[0].batchID,'existing');assert.equal(task.cloudState.parts[0].uploaded,true);
});

test('a manual query can finish an existing cloud task while an automatic query is stalled',async()=>{
 const s=setup(),request=s.m.requestMineruJSON;let queries=0,ready;
 const uploaded=new Promise(resolve=>ready=resolve);
 s.m.refreshParseQueueDialog=()=>{};
 s.m.requestMineruJSON=async options=>{
  if(options.url.endsWith('/file-urls/batch'))return request(options);
  if(++queries===1)return new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));
  const result=await request(options);result.data.extract_result.forEach(part=>part.state='done');return result;
 };
 const task={state:'running',settings,cloudState:{}};
 const running=s.m.parseCloudDocument(Uint8Array.of(1),'document.docx',1,settings,{cloudState:task.cloudState,onStatus:status=>{
  if(status.parts?.some(part=>part.state==='pending'))ready();
 }});
 await uploaded;await s.m.queryCloudTaskProgress(task);
 assert((await running).markdownText.startsWith('document.docx'));
 assert.equal(s.applied.length,1);assert.equal(s.uploads.length,1);assert.equal(s.m.cloudDocumentCount,0);
});

test('manual and automatic completion responses share one result download',async()=>{
 const s=setup();let downloads=0,finish=0,release;
 const pending=new Promise(resolve=>release=resolve);
 s.m.downloadParseResultZip=async()=>{downloads++;await pending;return Uint8Array.of(1);};
 s.m.extractNoteContentFromMineruZip=async()=>({markdownText:'Result'});
 const row={part:{start:0,end:1,uploaded:true,name:'document.pdf'},settings,context:{},progress(){},finish(){finish++;row.settled=true;}};
 const first=s.m.applyCloudRowResult(row,{state:'done',full_zip_url:'https://result.invalid'});
 const second=s.m.applyCloudRowResult(row,{state:'done',full_zip_url:'https://result.invalid'});
 assert.equal(downloads,1);release();await Promise.all([first,second]);assert.equal(finish,1);
});
