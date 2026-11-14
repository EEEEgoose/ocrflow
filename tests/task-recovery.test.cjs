const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path').posix;
const {webcrypto}=require('node:crypto');

function setup(shared={files:new Map(),logins:[],items:new Map()}){
 const context={Uint8Array,ArrayBuffer,TextEncoder,TextDecoder,AbortController,setTimeout,clearTimeout,atob,btoa,
  PathUtils:{join:path.join,parent:path.dirname},
  IOUtils:{exists:async p=>shared.files.has(p),readUTF8:async p=>shared.files.get(p),read:async p=>shared.files.get(p),write:async(p,bytes)=>shared.files.set(p,bytes),
   makeDirectory:async p=>shared.files.set(p,{directory:true}),getChildren:async p=>[...shared.files.keys()].filter(key=>path.dirname(key)===p),
   remove:async p=>{for(const key of shared.files.keys())if(key===p||key.startsWith(p+'/'))shared.files.delete(key);},
   copy:async(a,b)=>{if(!shared.files.has(a))throw Error('Missing input');shared.files.set(b,shared.files.get(a));},
   writeUTF8:async(p,text,options)=>{assert.equal(options.tmpPath,p+'.tmp');shared.files.set(p,text);}},
  Services:{logins:{findLogins:()=>shared.logins,addLoginAsync:async login=>shared.logins.push(login)}},
  Cc:{'@mozilla.org/login-manager/loginInfo;1':{createInstance:()=>({init(host,form,realm,username,password){Object.assign(this,{host,realm,username,password});}})}},Ci:{nsILoginInfo:{}},
  Zotero:{DataDirectory:{dir:'/data'},getMainWindow:()=>({crypto:webcrypto,AbortController}),debug(){},logError(){},
   Libraries:{getAll:()=>[{libraryID:1}]},
   Items:{get:id=>shared.items.get(id),getByLibraryAndKeyAsync:async(lib,key)=>[...shared.items.values()].find(item=>item.libraryID===lib&&item.key===key)}}};
 vm.createContext(context);for(const file of ['docflow.js','task-recovery.js'])vm.runInContext(fs.readFileSync(file,'utf8'),context,{filename:file});
 const owner=context.DocFlow;owner.config={state:'unlocked',crypto:webcrypto};owner.refreshParseQueueDialog=()=>{};
 owner.processParseQueue=async()=>{owner.resumed=(owner.resumed||0)+1;};
 const item=id=>{const value={id,key:'ITEM'+id,libraryID:1,getField:()=> 'Fixture',toJSON:()=>({key:'ITEM'+id,itemType:'attachment',title:'Fixture'}),loadAllData:async()=>{}};shared.items.set(id,value);return value;};
 const store=context.OCRFlowTaskRecovery;owner.taskRecovery=store;
 return {shared,context,owner,store,item};
}

test('task recovery encrypts settings and preserves item references, binary resources and durable cloud parts',async()=>{
 const s=setup();await s.store.init(s.owner);const attachment=s.item(1);
 s.shared.files.set('/tmp/source/part-0',Uint8Array.of(1,2,3));
 s.owner.parseQueue=[{id:7,kind:'parse',state:'running',attachment,settings:{apiToken:'fixture-secret'},jobID:'existing-batch',
  cloudState:{dir:'/tmp/source',totalPages:1,parts:[{path:'/tmp/source/part-0',start:0,end:1,batchID:'existing-batch',uploaded:true,dataID:'part-1'}]},
  parsedResult:{embeddedImages:[{bytes:Uint8Array.of(4,5)}]}}];s.owner.parseQueueNextID=8;
 s.owner.parseQueue[0].localTaskState={fileID:'task-file-a',uploaded:true};
 s.owner.parseQueue[0].localTaskStateB={fileID:'task-file-b',uploaded:false};
 s.owner.parseQueue[0].paddleStateB={parts:[{bytes:Uint8Array.of(9,8),name:'slice.pdf',count:1,jobID:'paddle-existing'}]};
 await s.store.flush();const encrypted=s.shared.files.get(s.store.path);
 assert(!encrypted.includes('fixture-secret'));assert(!encrypted.includes('existing-batch'));assert.equal(s.shared.logins.length,1);
 s.shared.files.delete('/tmp/source/part-0');
 const reopened=setup(s.shared);await reopened.store.init(reopened.owner);
 const task=reopened.owner.parseQueue[0];assert.equal(task.attachment,attachment);assert.equal(task.jobID,'existing-batch');
 assert.equal(task.settings.apiToken,'fixture-secret');assert.equal(task.state,'queued');assert.equal(reopened.owner.parseQueueNextID,8);
 assert.deepEqual(Array.from(task.parsedResult.embeddedImages[0].bytes),[4,5]);
 assert(task.cloudState.parts[0].path.startsWith(reopened.store.directory+'/'));
 assert(s.shared.files.has(task.cloudState.parts[0].path));assert.equal(reopened.owner.resumed,1);
 assert.equal(task.localTaskState.fileID,'task-file-a');assert.equal(task.localTaskState.uploaded,true);
 assert.equal(task.localTaskStateB.fileID,'task-file-b');assert.equal(task.localTaskStateB.uploaded,false);
 assert.equal(task.paddleStateB.parts[0].bytes,undefined);assert.equal(task.paddleStateB.parts[0].jobID,'paddle-existing');
 assert.deepEqual(Array.from(s.shared.files.get(task.paddleStateB.parts[0].path)),[9,8]);
});

test('recovery waits for configuration unlock and keeps paused decisions paused',async()=>{
 const s=setup();await s.store.init(s.owner);
 s.owner.parseQueue=[{id:1,kind:'translate',state:'running',attachment:s.item(1),settings:{},decision:{options:{}},translation:{units:[{translated:['已完成',null]}]}}];
 await s.store.flush();
 const reopened=setup(s.shared);reopened.owner.config.state='locked';await reopened.store.init(reopened.owner);
 assert.equal(reopened.owner.parseQueue.length,0);assert.equal(reopened.owner.resumed,undefined);
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
 reopened.owner.saveTranslationAsMarkdownAttachment=async()=>item;
 await reopened.owner.runAlignedTranslationTask(task);assert.deepEqual(requested,['p2.0']);assert.equal(task.translation.units[0].translated[0],'一。');
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

test('write failures keep the previous checkpoint and unreadable records are preserved for recovery',async()=>{
 const s=setup();await s.store.init(s.owner);
 s.owner.parseQueue=[{id:1,kind:'parse',state:'queued',attachment:s.item(1),settings:{}}];await s.store.flush();
 const previous=s.shared.files.get(s.store.path);
 s.context.IOUtils.writeUTF8=async()=>{throw Error('Disk full');};
 await assert.rejects(s.store.flush(),/Disk full/);assert.equal(s.shared.files.get(s.store.path),previous);assert(s.store.error.includes('Disk full'));
 s.shared.files.set(s.store.path,'unreadable record');const reopened=setup(s.shared);await reopened.store.init(reopened.owner);
 assert(reopened.store.error.includes('任务恢复记录读取失败'));await reopened.store.flush();
 assert.equal(s.shared.files.get(s.store.path),'unreadable record');assert.equal(reopened.owner.resumed,undefined);
});

test('unconfirmed provider submissions require a user decision while completed and canceled tasks stay terminal',async()=>{
 const s=setup();await s.store.init(s.owner);const attachment=s.item(1);
 s.owner.parseQueue=[
  {id:1,kind:'parse',state:'running',phase:'提交 Datalab 任务',attachment,settings:{}},
  {id:2,kind:'parse',state:'running',attachment,settings:{},paddleState:{parts:[{submitting:true}]}},
  {id:3,kind:'parse',state:'completed',attachment,settings:{}},
  {id:4,kind:'parse',state:'canceled',attachment,settings:{}},
  {id:5,kind:'parse',state:'running',phase:'提交 Marker 任务',jobID:'primary',cancelJobID:null,attachment,settings:{}}
 ];await s.store.flush();const reopened=setup(s.shared);await reopened.store.init(reopened.owner);
 assert.deepEqual(Array.from(reopened.owner.parseQueue,task=>task.state),['waiting','waiting','completed','canceled','waiting']);
 assert(reopened.owner.parseQueue[0].detail.includes('提交结果未确认'));
});

test('clearing tasks persists the empty queue and removes only their retained input files',async()=>{
 const s=setup();await s.store.init(s.owner);s.shared.files.set('/tmp/part',Uint8Array.of(1));
 s.owner.parseQueue=[{id:1,kind:'parse',state:'failed',attachment:s.item(1),settings:{},cloudState:{dir:'/tmp',parts:[{path:'/tmp/part',uploaded:true}]}}];
 await s.store.flush();const part=s.owner.parseQueue[0].cloudState.parts[0].path;assert(s.shared.files.has(part));
 s.owner.parseQueue=[];s.owner.parseQueueNextID=10;await s.store.flush();assert(!s.shared.files.has(part));
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
 assert.equal(again.owner.parseQueue.length,3);
});

test('new queued tasks are checkpointed before processing starts',async()=>{
 const s=setup();await s.store.init(s.owner);vm.runInContext(fs.readFileSync('workflow.js','utf8'),s.context);
 s.owner.openParseQueueDialog=()=>{};
 s.owner.processParseQueue=async()=>{assert(s.shared.files.has(s.store.path),'admitted tasks must be durable before execution');};
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
 reopened.store.decode=async text=>{entered();await release;return decode(text)};
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
 s.owner.parseQueue=[{id:1,kind:'organize',state:'failed',attachment:legacy(attachment),source:legacy(source),settings:{},
  organizeResults:{translate:legacy(source)},ocrBaseSaved:{attachment:legacy(source)},
  organizeStages:{translate:{state:'failed',task:{kind:'translate',attachment:legacy(attachment),source:legacy(source),translation:{units:[{translated:['done',null]}]}}}}}];
 await s.store.flush();const reopened=setup(s.shared);await reopened.store.init(reopened.owner);
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
