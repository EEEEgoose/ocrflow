const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path').posix;
const {PDFDocument,PDFName}=require('../vendor/pdf-lib/pdf-lib.min.js');
function setup(){
 const files=new Map(),batches=new Map(),applied=[],uploads=[],statuses=[];let next=0,failName='',failOnce=false;
 const context={AbortController,URL,Headers,Uint8Array,TextEncoder,TextDecoder,btoa,setTimeout,clearTimeout,PathUtils:{tempDir:'/tmp',join:path.join},
  IOUtils:{makeDirectory:async()=>{},write:async(p,b)=>files.set(p,b),read:async p=>files.get(p),remove:async()=>{}},
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
test('direct and secondary-reader cloud calls also honor the five-document limit and release slots after completion',async()=>{
 const s=setup(),work=Array.from({length:6},()=>({cloudState:{}}));
 const runs=work.map((context,i)=>s.m.parseCloudDocument(Uint8Array.of(i),'document'+i+'.docx',i,settings,context));
 await Promise.all(runs);assert(s.applied.every(batch=>batch.files.length<=5));assert.equal(s.m.cloudDocumentCount,0);assert.equal(s.m.cloudDocumentWaiting.length,0);
});
