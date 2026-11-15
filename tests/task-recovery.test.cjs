const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path').posix;
const {webcrypto}=require('node:crypto');

const ROOT='/data/ocrflow-tasks',INDEX=ROOT+'/index.json',LEGACY=ROOT+'/queue.enc';
function setup(shared={files:new Map(),logins:[],items:new Map(),prefs:new Map()}){
 const files=shared.files,tmp=options=>assert(options?.tmpPath,'writes must be atomic');
 const context={Uint8Array,ArrayBuffer,TextEncoder,TextDecoder,AbortController,setTimeout,clearTimeout,atob,btoa,
  PathUtils:{join:path.join,parent:path.dirname},
  IOUtils:{exists:async p=>files.has(p),readUTF8:async p=>{if(!files.has(p))throw Error('Missing '+p);return files.get(p)},read:async p=>files.get(p),
   write:async(p,bytes,options)=>{tmp(options);files.set(p,bytes)},writeUTF8:async(p,text,options)=>{tmp(options);files.set(p,text)},
   makeDirectory:async p=>{for(let dir=p;dir!=='/'&&!files.has(dir);dir=path.dirname(dir))files.set(dir,{directory:true})},
   getChildren:async p=>[...files.keys()].filter(key=>path.dirname(key)===p),
   remove:async p=>{for(const key of [...files.keys()])if(key===p||key.startsWith(p+'/'))files.delete(key);},
   move:async(a,b)=>{for(const key of [...files.keys()])if(key===a||key.startsWith(a+'/')){files.set(b+key.slice(a.length),files.get(key));files.delete(key);}},
   copy:async(a,b)=>{if(!files.has(a))throw Error('Missing input');files.set(b,files.get(a));}},
  Services:{logins:{findLogins:()=>shared.logins}},
  Zotero:{DataDirectory:{dir:'/data'},getMainWindow:()=>({crypto:webcrypto,AbortController}),debug(){},logError(){},
   Libraries:{getAll:()=>[{libraryID:1}]},
   Items:{get:id=>shared.items.get(id),getByLibraryAndKeyAsync:async(lib,key)=>[...shared.items.values()].find(item=>item.libraryID===lib&&item.key===key)}}};
 vm.createContext(context);for(const file of ['docflow.js','task-recovery.js'])vm.runInContext(fs.readFileSync(file,'utf8'),context,{filename:file});
 const owner=context.DocFlow;owner.config={state:'unlocked',crypto:webcrypto,get:key=>shared.prefs.get(key)};owner.refreshParseQueueDialog=()=>{};
 owner.processParseQueue=async()=>{owner.resumed=(owner.resumed||0)+1;};
 const item=id=>{const value={id,key:'ITEM'+id,libraryID:1,getField:()=> 'Fixture',toJSON:()=>({key:'ITEM'+id,itemType:'attachment',title:'Fixture'}),loadAllData:async()=>{}};shared.items.set(id,value);return value;};
 const store=context.OCRFlowTaskRecovery;owner.taskRecovery=store;
 return {shared,context,owner,store,item};
}
const copy=shared=>({...shared,files:new Map(shared.files)});
const taskFile=id=>`${ROOT}/tasks/${id}/task.json`;
const allText=files=>[...files.values()].filter(value=>typeof value==='string').join('\n');
async function legacyRecord(s,snapshot,version=2){
 const raw=webcrypto.getRandomValues(new Uint8Array(32));s.shared.logins.push({username:'/data',password:s.store.base64(raw)});
 const key=await webcrypto.subtle.importKey('raw',raw,'AES-GCM',false,['encrypt']),iv=webcrypto.getRandomValues(new Uint8Array(12));
 const data=await webcrypto.subtle.encrypt({name:'AES-GCM',iv},key,new TextEncoder().encode(s.store.encode(snapshot)));
 s.shared.files.set(LEGACY,JSON.stringify({format:'ocrflow-tasks',version,iv:s.store.base64(iv),data:s.store.base64(new Uint8Array(data))}));
}

test('task records store configuration references instead of secrets and restore item references, resources and cloud parts',async()=>{
 const s=setup();s.shared.prefs.set('extensions.docflow.apiToken','fixture-secret');
 s.shared.prefs.set('extensions.docflow.marker.token','Bearer marker-secret');
 s.shared.prefs.set('extensions.docflow.llmProviders',JSON.stringify([{id:'p1',llmApiKey:'provider-secret'}]));
 await s.store.init(s.owner);const attachment=s.item(1);
 s.shared.files.set('/tmp/source/part-0',Uint8Array.of(1,2,3));
 s.owner.parseQueue=[{id:7,kind:'parse',state:'running',attachment,jobID:'existing-batch',
  settings:{apiToken:'fixture-secret',apiBaseURL:'https://ocr.example.test',markerSettings:{token:'marker-secret'},summarySettings:{apiKey:'provider-secret'},deeplApiKey:'unknown-secret'},
  cancelSettings:{apiToken:'fixture-secret'},
  cloudState:{dir:'/tmp/source',totalPages:1,parts:[{path:'/tmp/source/part-0',start:0,end:1,batchID:'existing-batch',uploaded:true,dataID:'part-1'}]},
  parsedResult:{embeddedImages:[{bytes:Uint8Array.of(4,5)}]}}];s.owner.parseQueueNextID=8;
 s.owner.parseQueue[0].localTaskState={fileID:'task-file-a',uploaded:true};
 s.owner.parseQueue[0].paddleStateB={parts:[{bytes:Uint8Array.of(9,8),name:'slice.pdf',count:1,jobID:'paddle-existing'}]};
 await s.store.flush();
 const text=allText(s.shared.files);
 for(const secret of ['fixture-secret','marker-secret','provider-secret','unknown-secret'])assert(!text.includes(secret),secret);
 assert(JSON.parse(s.shared.files.get(taskFile(7))).task.jobID==='existing-batch');
 assert.equal(JSON.parse(s.shared.files.get(INDEX)).nextID,8);assert.equal(s.shared.logins.length,0);
 s.shared.files.delete('/tmp/source/part-0');s.shared.prefs.set('extensions.docflow.apiToken','rotated-secret');
 const reopened=setup(s.shared);await reopened.store.init(reopened.owner);
 const task=reopened.owner.parseQueue[0];assert.equal(task.attachment,attachment);assert.equal(task.jobID,'existing-batch');
 assert.equal(task.settings.apiToken,'rotated-secret');assert.equal(task.cancelSettings.apiToken,'rotated-secret');
 assert.equal(task.settings.markerSettings.token,'marker-secret');assert.equal(task.settings.summarySettings.apiKey,'provider-secret');
 assert.equal(task.settings.deeplApiKey,'');assert.equal(task.settings.apiBaseURL,'https://ocr.example.test');
 assert.equal(task.state,'queued');assert.equal(reopened.owner.parseQueueNextID,8);
 assert.deepEqual(Array.from(task.parsedResult.embeddedImages[0].bytes),[4,5]);
 assert(task.cloudState.parts[0].path.startsWith(reopened.store.directory+'/'));
 assert(s.shared.files.has(task.cloudState.parts[0].path));assert.equal(reopened.owner.resumed,1);
 assert.equal(task.localTaskState.fileID,'task-file-a');
 assert.equal(task.paddleStateB.parts[0].bytes,undefined);assert.equal(task.paddleStateB.parts[0].jobID,'paddle-existing');
 assert.deepEqual(Array.from(s.shared.files.get(task.paddleStateB.parts[0].path)),[9,8]);
});

test('recovery waits for configuration unlock and keeps paused decisions paused',async()=>{
 const s=setup();await s.store.init(s.owner);
 s.owner.parseQueue=[{id:1,kind:'translate',state:'running',attachment:s.item(1),settings:{},decision:{options:{}},translation:{units:[{translated:['已完成',null]}]}}];
 await s.store.flush();
 const reopened=setup(s.shared);reopened.owner.config.state='locked';await reopened.store.init(reopened.owner);
 assert.equal(reopened.store.pendingUnlock,true);assert.equal(reopened.owner.parseQueue.length,0);assert.equal(reopened.owner.resumed,undefined);
 reopened.owner.config.state='unlocked';await reopened.store.restore();
 assert.equal(reopened.owner.parseQueue[0].state,'waiting');assert.equal(reopened.owner.parseQueue[0].translation.units[0].translated[0],'已完成');
 await reopened.store.restore();assert.equal(reopened.owner.parseQueue.length,1);assert.equal(reopened.owner.resumed,1);
});

test('shutdown aborts requests, waits for saves and persists their final outcome',async()=>{
 const s=setup();await s.store.init(s.owner);let finishSave;
 const active={id:1,kind:'parse',state:'running',attachment:s.item(1),settings:{},controller:new AbortController()};
 const saving={id:2,kind:'translate',state:'running',saving:true,attachment:s.item(2),settings:{}};
 active.workPromise=new Promise(resolve=>active.controller.signal.addEventListener('abort',()=>{active.active=false;resolve();}));
 saving.workPromise=new Promise(resolve=>finishSave=()=>{saving.state='completed';saving.saving=false;resolve();});
 s.owner.parseQueue=[active,saving];s.owner.parseQueueWork=new Set([active.workPromise,saving.workPromise]);
 const stopping=s.store.shutdown();await Promise.resolve();assert(active.controller.signal.aborted);
 finishSave();await stopping;
 const reopened=setup(s.shared);await reopened.store.init(reopened.owner);
 assert.equal(reopened.owner.parseQueue[0].state,'queued');assert.equal(reopened.owner.parseQueue[1].state,'completed');
});

test('a restored translation requests only unfinished fragments through its normal entry point',async()=>{
 const s=setup();await s.store.init(s.owner);const item=s.item(1);
 const units=['One.','Two.'].map((source,index)=>({id:'p'+(index+1),source,prefix:'',protectedParts:[],fragments:[source],translated:[index===0?'一。':null]}));
 s.owner.parseQueue=[{id:1,kind:'translate',state:'running',attachment:item,mineruSource:item,parentItem:item,
  settings:{translateLanguage:'中文',translateChunkSize:1000},translation:{language:'中文',paragraphBudget:1000,units,images:[]}}];
 await s.store.flush();const reopened=setup(s.shared);await reopened.store.init(reopened.owner);
 vm.runInContext(fs.readFileSync('translation.js','utf8'),reopened.context);
 const task=reopened.owner.parseQueue[0],requested=[];task.controller=new AbortController();
 reopened.owner.getAIChunkBudget=()=>5000;reopened.owner.getAIOutputBudget=()=>5000;reopened.owner.isOpenRouterMiMo=()=>false;
 reopened.owner.estimateAITokens=text=>text.length;
 reopened.owner.mapAIWork=async(items,_limit,run)=>{for(const item of items)await run(item);};
 reopened.owner.translateAlignedBatch=async items=>{requested.push(...items.map(item=>item.id));return items.map(()=> '二。');};
 let savingStage;reopened.owner.saveTranslationAsMarkdownAttachment=async()=>{savingStage=JSON.parse(s.shared.files.get(taskFile(1))).task.stage;return item;};
 await reopened.owner.runAlignedTranslationTask(task);assert.deepEqual(requested,['p2.0']);assert.equal(task.translation.units[0].translated[0],'一。');
 assert.equal(savingStage,'saving');assert.equal(task.stage,'saved');
});

test('an update finishes the saving organize stage and resumes only the remaining stages',async()=>{
 const s=setup();await s.store.init(s.owner);vm.runInContext(fs.readFileSync('workflow.js','utf8'),s.context);
 const parent=s.item(1),source=s.item(2);let beginSave,finishSave,summaryCalls=0;
 const saving=new Promise(resolve=>beginSave=resolve),saved=new Promise(resolve=>finishSave=resolve);
 s.owner.parentForDocument=()=>parent;
 s.owner.runTitleTranslation=async child=>{child.saving=true;beginSave();await saved;child.titleTranslation={text:'译文'};child.resultAttachment=parent;return '已保存';};
 s.owner.runDocumentTask=async()=>summaryCalls++;
 const task={id:1,kind:'organize',state:'running',active:true,attachment:parent,source,settings:{titleSettings:{},summarySettings:{},translationSettings:{},outlineSettings:{}},controller:new AbortController(),organizeStages:{outline:{state:'skipped'}}};
 s.owner.parseQueue=[task];task.workPromise=s.owner.runOrganizeReadingStages(task);s.owner.parseQueueWork=new Set([task.workPromise]);
 await saving;const stopping=s.store.shutdown();finishSave();await stopping;assert.equal(summaryCalls,0);
 const reopened=setup(s.shared);await reopened.store.init(reopened.owner);vm.runInContext(fs.readFileSync('workflow.js','utf8'),reopened.context);
 const restored=reopened.owner.parseQueue[0];restored.controller=new AbortController();
 reopened.owner.parentForDocument=()=>parent;reopened.owner.parseOptionalJSONObject=()=>({});
 reopened.owner.runTitleTranslation=async()=>{throw Error('Completed title translation must be reused');};
 reopened.owner.runDocumentTask=async child=>{summaryCalls++;assert.equal(child.parentTask,restored);assert.equal(child.organizeStage,'summary');};
 reopened.owner.runTranslationTask=async()=>{};
 await reopened.owner.runOrganizeReadingStages(restored);assert.equal(summaryCalls,1);assert.equal(restored.state,'completed');
});

test('write failures keep the previous task record and damaged task records are set aside without blocking others',async()=>{
 const s=setup();await s.store.init(s.owner);
 s.owner.parseQueue=[{id:1,kind:'parse',state:'queued',attachment:s.item(1),settings:{}},{id:2,kind:'parse',state:'queued',attachment:s.item(2),settings:{}}];
 await s.store.flush();
 const previous=s.shared.files.get(taskFile(1));s.owner.parseQueue[0].detail='changed';
 s.context.IOUtils.writeUTF8=async()=>{throw Error('Disk full');};
 await assert.rejects(s.store.flush(),/Disk full/);assert.equal(s.shared.files.get(taskFile(1)),previous);assert(s.store.error.includes('Disk full'));
 s.shared.files.set(taskFile(1),'unreadable record');const reopened=setup(s.shared);await reopened.store.init(reopened.owner);
 assert.deepEqual(Array.from(reopened.owner.parseQueue,task=>task.id),[2]);assert(reopened.store.error.includes('1 个任务'));
 assert(!s.shared.files.has(taskFile(1)));
 assert([...s.shared.files.entries()].some(([name,value])=>name.startsWith(ROOT+'/damaged/1-')&&value==='unreadable record'));
 await reopened.store.flush();assert(reopened.store.error.includes('damaged'));
 const added={id:3,kind:'parse',state:'queued',attachment:s.item(3),settings:{}};reopened.owner.parseQueue.push(added);
 assert.equal(reopened.owner.parseQueueNextID>=3,true);
});

test('records from a newer plugin version are left untouched',async()=>{
 const s=setup();s.shared.files.set(INDEX,JSON.stringify({format:'ocrflow-tasks',version:99,nextID:5,order:[]}));
 await s.store.init(s.owner);assert(s.store.error.includes('更新版本'));assert.equal(s.store.loaded,undefined);
 s.owner.parseQueue=[{id:1,kind:'parse',state:'queued',attachment:s.item(1),settings:{}}];await s.store.flush();
 assert.equal(JSON.parse(s.shared.files.get(INDEX)).version,99);assert(!s.shared.files.has(taskFile(1)));
});

test('unconfirmed submissions, unconfirmed saves and unknown stages require a user decision',async()=>{
 const s=setup();await s.store.init(s.owner);const attachment=s.item(1);
 s.owner.parseQueue=[
  {id:1,kind:'parse',state:'running',phase:'提交 Datalab 任务',attachment,settings:{}},
  {id:2,kind:'parse',state:'running',attachment,settings:{},paddleState:{parts:[{submitting:true}]}},
  {id:3,kind:'parse',state:'completed',attachment,settings:{}},
  {id:4,kind:'parse',state:'canceled',attachment,settings:{}},
  {id:5,kind:'parse',state:'running',phase:'提交 Marker 任务',jobID:'primary',cancelJobID:null,attachment,settings:{}},
  {id:6,kind:'parse',state:'running',stage:'submitting',phase:'renamed text',attachment,settings:{}},
  {id:7,kind:'parse',state:'running',stage:'submitting',jobID:'known',attachment,settings:{}},
  {id:8,kind:'parse',state:'running',stage:'saving',attachment,settings:{}},
  {id:9,kind:'organize',state:'running',attachment,settings:{},organizeStages:{translate:{state:'running',task:{kind:'translate',stage:'saving',attachment}}}},
  {id:10,kind:'parse',state:'running',stage:'future-stage',jobID:'known',attachment,settings:{}},
  {id:11,kind:'parse',state:'running',stage:'submitting',phase:'提交 Marker 任务',jobID:'known',attachment,settings:{}}
 ];await s.store.flush();const reopened=setup(s.shared);await reopened.store.init(reopened.owner);
 assert.deepEqual(Array.from(reopened.owner.parseQueue,task=>task.state),['waiting','waiting','completed','canceled','waiting','waiting','queued','waiting','waiting','waiting','queued']);
 const detail=id=>reopened.owner.parseQueue.find(task=>task.id===id).detail;
 assert(detail(1).includes('提交结果未确认'));assert(detail(6).includes('提交结果未确认'));
 assert(detail(8).includes('保存结果未确认'));assert(detail(9).includes('保存结果未确认'));assert(detail(10).includes('其他版本'));
});

test('a parse task records its stage before submitting and before saving so an interruption resumes safely',async()=>{
 const s=setup();await s.store.init(s.owner);const attachment=s.item(1);let crash;
 Object.assign(s.owner,{recognitionSettingsFor:(_item,settings)=>settings,finalizeDocument(){},dispatchParseQueue(){},documentExtension:()=>'pdf'});
 const task={id:1,kind:'parse',state:'running',attachment,settings:{parserService:'marker'},controller:new AbortController()};s.owner.parseQueue=[task];
 s.owner.parseAttachmentWithMineru=async(_item,_settings,options)=>{
  options.onStatus({phase:'any text',stage:'submitting',jobID:null});await options.checkpoint();crash.submitting=copy(s.shared);
  options.onStatus({phase:'polling',stage:'submitting',jobID:'job-1'});await options.checkpoint();crash.submitted=copy(s.shared);
  return {markdownText:'Synthetic'};
 };
 s.owner.saveResultAsMarkdownAttachment=async()=>{crash.saving=copy(s.shared);return {attachment};};
 crash={};await s.owner.runParseTask(task);
 const resume=async shared=>{const r=setup(shared);await r.store.init(r.owner);return r.owner.parseQueue[0];};
 assert.equal((await resume(crash.submitting)).state,'waiting');
 const submitted=await resume(crash.submitted);assert.equal(submitted.state,'queued');assert.equal(submitted.jobID,'job-1');
 const saving=await resume(crash.saving);assert.equal(saving.state,'waiting');assert(saving.detail.includes('保存结果未确认'));
 assert.equal(task.stage,'saved');assert.equal(JSON.parse(s.shared.files.get(taskFile(1))).task.stage,'saved');
});

test('clearing tasks persists the empty queue and removes their directories and retained input files',async()=>{
 const s=setup();await s.store.init(s.owner);s.shared.files.set('/tmp/part',Uint8Array.of(1));
 s.owner.parseQueue=[{id:1,kind:'parse',state:'failed',attachment:s.item(1),settings:{},cloudState:{dir:'/tmp',parts:[{path:'/tmp/part',uploaded:true}]}}];
 await s.store.flush();const part=s.owner.parseQueue[0].cloudState.parts[0].path;assert(s.shared.files.has(part));
 s.owner.parseQueue=[];s.owner.parseQueueNextID=10;await s.store.flush();assert(!s.shared.files.has(part));assert(!s.shared.files.has(taskFile(1)));
 const reopened=setup(s.shared);await reopened.store.init(reopened.owner);
 assert.equal(reopened.owner.parseQueue.length,0);assert.equal(reopened.owner.parseQueueNextID,10);
});

test('unlock restores saved queued tasks even when new tasks already occupy the queue',async()=>{
 const s=setup();await s.store.init(s.owner);
 s.owner.parseQueue=[{id:1,kind:'organize',state:'queued',attachment:s.item(1),settings:{}}];s.owner.parseQueueNextID=2;
 await s.store.flush();
 const reopened=setup(s.shared);reopened.owner.config.state='locked';await reopened.store.init(reopened.owner);
 assert.equal(reopened.store.pendingUnlock,true);
 reopened.owner.parseQueue=[{id:1,kind:'parse',state:'queued',attachment:s.item(2),settings:{}},
  {id:2,kind:'outline',state:'waiting_dependency',requiredParseID:1,attachment:s.item(2),settings:{}}];
 reopened.owner.parseQueueNextID=3;reopened.owner.config.state='unlocked';await reopened.store.restore();
 assert.equal(reopened.owner.parseQueue.length,3);
 const [saved,parse,outline]=reopened.owner.parseQueue;
 assert.equal(saved.attachment.id,1);assert.equal(parse.attachment.id,2);
 assert.notEqual(parse.id,saved.id);assert.equal(outline.requiredParseID,parse.id);
 assert.equal(new Set(reopened.owner.parseQueue.map(task=>task.id)).size,3);
 await reopened.store.flush();const again=setup(s.shared);await again.store.init(again.owner);
 assert.deepEqual(Array.from(again.owner.parseQueue,task=>task.attachment.id),[1,2,2]);
});

test('new queued tasks are checkpointed before processing starts',async()=>{
 const s=setup();await s.store.init(s.owner);vm.runInContext(fs.readFileSync('workflow.js','utf8'),s.context);
 s.owner.openParseQueueDialog=()=>{};
 s.owner.processParseQueue=async()=>{assert(s.shared.files.has(INDEX),'admitted tasks must be durable before execution');};
 await s.owner.enqueueDocumentTasks('organize',[{attachment:s.item(1)}],{});
 const reopened=setup(s.shared);await reopened.store.init(reopened.owner);
 assert.equal(reopened.owner.parseQueue.length,1);assert.equal(reopened.owner.parseQueue[0].state,'queued');
});

test('tasks admitted while checkpoint decoding is pending survive restoration',async()=>{
 const s=setup();await s.store.init(s.owner);
 s.owner.parseQueue=[{id:1,kind:'organize',state:'queued',attachment:s.item(1),settings:{}}];await s.store.flush();
 const reopened=setup(s.shared),decode=reopened.store.decode.bind(reopened.store);
 let entered,finish;
 const decoding=new Promise(resolve=>entered=resolve),release=new Promise(resolve=>finish=resolve);
 reopened.store.decode=async(...args)=>{entered();await release;return decode(...args)};
 const restoring=reopened.store.init(reopened.owner);await decoding;
 reopened.owner.parseQueue.push({id:1,kind:'parse',state:'queued',attachment:s.item(2),settings:{}});
 finish();await restoring;
 assert.deepEqual(Array.from(reopened.owner.parseQueue,task=>task.attachment.id),[1,2]);
 assert.equal(new Set(reopened.owner.parseQueue.map(task=>task.id)).size,2);
});

test('Zotero item toJSON does not replace durable item references',async()=>{
 const s=setup();await s.store.init(s.owner);const attachment=s.item(1);
 attachment.toJSON=()=>({key:attachment.key,itemType:'attachment',title:'Fixture'});
 s.owner.parseQueue=[{id:1,kind:'organize',state:'queued',attachment,source:attachment,settings:{}}];
 await s.store.flush();const reopened=setup(s.shared);await reopened.store.init(reopened.owner);
 assert.equal(reopened.owner.parseQueue[0].attachment,attachment);
 assert.equal(reopened.owner.parseQueue[0].source,attachment);
 assert.equal(typeof reopened.owner.parseQueue[0].attachment.getField,'function');
});

test('legacy JSON item records regain live references for retry, locate and nested organize stages',async()=>{
 const s=setup();await s.store.init(s.owner);const attachment=s.item(1),source=s.item(2);
 const legacy=item=>({key:item.key,itemType:'attachment',title:'Fixture'});
 await legacyRecord(s,{nextID:2,tasks:[{id:1,kind:'organize',state:'failed',attachment:legacy(attachment),source:legacy(source),settings:{},
  organizeResults:{translate:legacy(source)},ocrBaseSaved:{attachment:legacy(source)},
  organizeStages:{translate:{state:'failed',task:{kind:'translate',attachment:legacy(attachment),source:legacy(source),translation:{units:[{translated:['done',null]}]}}}}}]});
 const reopened=setup(s.shared);await reopened.store.init(reopened.owner);
 const row=reopened.owner.parseQueue[0];assert.equal(row.attachment,attachment);assert.equal(row.source,source);
 assert.equal(row.organizeResults.translate,source);assert.equal(row.ocrBaseSaved.attachment,source);
 assert.equal(row.organizeStages.translate.task.attachment,attachment);
 assert.equal(row.organizeStages.translate.task.translation.units[0].translated[0],'done');
 let selected;reopened.context.Zotero.Items.getAsync=async id=>s.shared.items.get(id);
 reopened.context.Zotero.getMainWindow=()=>({ZoteroPane:{selectItem:async id=>{selected=id;return true}},focus(){}});
 await reopened.owner.locateTaskItem(row);assert.equal(selected,attachment.id);
 reopened.owner.getOrganizeSettings=()=>({});reopened.owner.processParseQueue=async()=>{};
 await reopened.owner.retryParseQueueTasks([1]);assert.equal(row.state,'queued');
});

test('recovery reports string and native-style exceptions with their actual reason',async()=>{
 for (const error of ['out of memory',{name:'NS_ERROR_FILE_ACCESS_DENIED'},null]) {
  const s=setup();s.context.IOUtils.exists=async()=>true;
  s.context.IOUtils.readUTF8=async()=>{throw error};
  await s.store.init(s.owner);
  assert(!s.store.error.includes('undefined'));
  assert(s.store.error.includes(typeof error==='string'?error:error?.name||'未知错误'));
  assert.equal(s.store.loaded,undefined);
  assert.equal(s.owner.resumed,undefined);
 }
});

test('recovery catches filesystem errors while checking the checkpoint',async()=>{
 const s=setup();s.context.IOUtils.exists=async()=>{throw 'checkpoint access denied'};
 await s.store.init(s.owner);
 assert(s.store.error.includes('checkpoint access denied'));
 assert.equal(s.store.loaded,undefined);
});

test('large Base64 resources decode in bounded blocks including padding and block boundaries',()=>{
 const s=setup();
 s.context.atob=text=>{assert(text.length<=32768);return atob(text)};
 for(const length of [0,1,2,3,24575,24576,24577,120000]){
  const bytes=Uint8Array.from({length},(_,index)=>index%256);
  assert.deepEqual(Buffer.from(s.store.bytes(Buffer.from(bytes).toString('base64'))),Buffer.from(bytes));
 }
});

test('binary resources are written once and unchanged tasks are not rewritten',async()=>{
 const s=setup();await s.store.init(s.owner);const bytes=new Uint8Array(300000).fill(123);
 s.owner.parseQueue=[{id:1,kind:'parse',state:'failed',attachment:s.item(1),settings:{},parsedResult:{embeddedImages:[{bytes}]}},
  {id:2,kind:'parse',state:'queued',attachment:s.item(2),settings:{}}];
 const writes=[];const {write,writeUTF8}=s.context.IOUtils;
 s.context.IOUtils.write=async(...args)=>{writes.push(args[0]);return write(...args)};
 s.context.IOUtils.writeUTF8=async(...args)=>{writes.push(args[0]);return writeUTF8(...args)};
 await s.store.flush();
 assert(s.shared.files.get(taskFile(1)).length<10000);assert.equal(writes.filter(name=>name.endsWith('.bin')).length,1);
 writes.length=0;await s.store.flush();assert.deepEqual(writes,[]);
 s.owner.parseQueue[1].detail='progress';await s.store.flush();assert.deepEqual(writes,[taskFile(2)]);
 const reopened=setup(s.shared);await reopened.store.init(reopened.owner);
 assert.deepEqual(Buffer.from(reopened.owner.parseQueue[0].parsedResult.embeddedImages[0].bytes),Buffer.from(bytes));
 await reopened.store.flush();
 assert.equal([...s.shared.files.keys()].filter(name=>name.endsWith('.bin')).length,1);
});

test('failed record replacement preserves the binary resources referenced by the previous record',async()=>{
 const s=setup();await s.store.init(s.owner);
 s.owner.parseQueue=[{id:1,kind:'parse',state:'failed',attachment:s.item(1),settings:{},parsedResult:{embeddedImages:[{bytes:Uint8Array.of(1)}]}}];
 await s.store.flush();
 s.owner.parseQueue[0].parsedResult.embeddedImages[0].bytes=Uint8Array.of(2);
 s.context.IOUtils.writeUTF8=async()=>{throw Error('Disk full')};
 await assert.rejects(s.store.flush(),/Disk full/);
 const reopened=setup(s.shared);await reopened.store.init(reopened.owner);
 assert.deepEqual(Array.from(reopened.owner.parseQueue[0].parsedResult.embeddedImages[0].bytes),[1]);
 await reopened.store.flush();
 assert.equal([...s.shared.files.keys()].filter(name=>name.endsWith('.bin')).length,1);
});

test('encrypted legacy records migrate to plain task records without secrets and remove the old files',async()=>{
 for(const version of [1,2]){
  const s=setup();s.shared.prefs.set('extensions.docflow.apiToken','fixture-secret');await s.store.init(s.owner);
  const snapshot={nextID:4,tasks:[{id:1,kind:'parse',state:'queued',attachment:s.item(1),settings:{apiToken:'fixture-secret'},parsedResult:{embeddedImages:[{bytes:Uint8Array.of(7,8,9)}]}},
   {id:2,kind:'outline',state:'waiting_dependency',requiredParseID:1,attachment:s.item(1),settings:{}}]};
  await legacyRecord(s,snapshot,version);
  if(version===2){
   s.shared.files.set(ROOT+'/resources/raw.bin',Uint8Array.of(5));
   const text=s.store.encode({nextID:4,tasks:[{...snapshot.tasks[0],parsedResult:{embeddedImages:[{bytes:'@'}]}},snapshot.tasks[1]]}).replace('"bytes":"@"','"bytes":{"$ocrflowFile":"resources/raw.bin"}');
   const raw=s.store.bytes(s.shared.logins.at(-1).password),key=await webcrypto.subtle.importKey('raw',raw,'AES-GCM',false,['encrypt']),iv=webcrypto.getRandomValues(new Uint8Array(12));
   const data=await webcrypto.subtle.encrypt({name:'AES-GCM',iv},key,new TextEncoder().encode(text));
   s.shared.files.set(LEGACY,JSON.stringify({format:'ocrflow-tasks',version:2,iv:s.store.base64(iv),data:s.store.base64(new Uint8Array(data))}));
  }
  const reopened=setup(s.shared);
  reopened.owner.parseQueue=[{id:1,kind:'parse',state:'queued',attachment:s.item(2),settings:{}}];reopened.owner.parseQueueNextID=2;
  await reopened.store.init(reopened.owner);
  const [first]=reopened.owner.parseQueue;assert.equal(first.settings.apiToken,'fixture-secret');
  assert.deepEqual(Array.from(first.parsedResult.embeddedImages[0].bytes),version===1?[7,8,9]:[5]);
  await reopened.store.flush();
  assert(!s.shared.files.has(LEGACY));assert(![...s.shared.files.keys()].some(name=>name.startsWith(ROOT+'/resources')));
  assert(!allText(s.shared.files).includes('fixture-secret'));
  const again=setup(s.shared);await again.store.init(again.owner);
  assert.deepEqual(Array.from(again.owner.parseQueue,task=>[task.kind,task.attachment.id]),[['parse',1],['outline',1],['parse',2]]);
  assert.equal(again.owner.parseQueue[1].requiredParseID,again.owner.parseQueue[0].id);assert.equal(new Set(again.owner.parseQueue.map(task=>task.id)).size,3);
  assert.equal(again.owner.parseQueue[0].settings.apiToken,'fixture-secret');
 }
});

test('legacy records written by an older version after migration are imported alongside current records',async()=>{
 const s=setup();await s.store.init(s.owner);
 s.owner.parseQueue=[{id:1,kind:'parse',state:'queued',attachment:s.item(1),settings:{}}];s.owner.parseQueueNextID=2;await s.store.flush();
 await legacyRecord(s,{nextID:2,tasks:[{id:1,kind:'translate',state:'queued',attachment:s.item(2),settings:{}}]});
 const reopened=setup(s.shared);await reopened.store.init(reopened.owner);
 assert.deepEqual(Array.from(reopened.owner.parseQueue,task=>task.kind),['parse','translate']);
 assert.equal(new Set(reopened.owner.parseQueue.map(task=>task.id)).size,2);
});

test('an unreadable legacy record is preserved and blocks overwriting',async()=>{
 const s=setup();s.shared.files.set(LEGACY,'unreadable record');await s.store.init(s.owner);
 assert(s.store.error.includes('任务恢复记录读取失败'));await s.store.flush();
 assert.equal(s.shared.files.get(LEGACY),'unreadable record');assert.equal(s.owner.resumed,undefined);
});

test('large Markdown and raw text are retained in reusable task files',async()=>{
 const s=setup();await s.store.init(s.owner);const text='Synthetic Markdown paragraph.\n'.repeat(10000);
 s.owner.parseQueue=[{id:1,kind:'parse',state:'failed',attachment:s.item(1),settings:{},parsedResult:{markdownText:text,rawFiles:[{text}]}}];
 await s.store.flush();assert(s.shared.files.get(taskFile(1)).length<10000);
 assert.equal([...s.shared.files.keys()].filter(name=>name.endsWith('.txt')).length,1);
 const reopened=setup(s.shared);await reopened.store.init(reopened.owner);
 assert.equal(reopened.owner.parseQueue[0].parsedResult.markdownText,text);
 assert.equal(reopened.owner.parseQueue[0].parsedResult.rawFiles[0].text,text);
 await reopened.store.flush();assert.equal([...s.shared.files.keys()].filter(name=>name.endsWith('.txt')).length,1);
 reopened.owner.parseQueue[0].parsedResult.markdownText='short';await reopened.store.flush();
 assert.equal([...s.shared.files.keys()].filter(name=>name.endsWith('.txt')).length,1);
 reopened.owner.parseQueue=[];await reopened.store.flush();
 assert.equal([...s.shared.files.keys()].filter(name=>name.endsWith('.txt')).length,0);
 assert.equal(reopened.store.caches.size,0);
});
