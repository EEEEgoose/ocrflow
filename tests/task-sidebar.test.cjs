const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
function setup(){
 const plugin={parseQueue:[],parentForDocument:()=>null,refreshParseQueueDialog(){},confirmRetryFailedChunks:()=> 'save'};
 const context={DocFlow:plugin,Zotero:{getMainWindow:()=>({})}};
 vm.createContext(context);vm.runInContext(fs.readFileSync('task-sidebar.js','utf8'),context);
 const sidebar=context.OCRFlowTaskSidebar;sidebar.init(plugin);plugin.sidebar=sidebar;
 return {plugin,sidebar,context};
}
test('sidebar stylesheet uses the installed version so an upgrade requests a fresh asset',()=>{
 const s=setup();s.sidebar.render=()=>{};
 const node=()=>({appendChild(){},append(){},insertBefore(){},querySelector:()=>null,addEventListener(){},setAttribute(){},classList:{toggle(){}}});
 const makeWindow=()=>{
  const nodes=new Map(['zotero-item-pane','zotero-view-item-sidenav','zotero-item-pane-content'].map(id=>[id,node()]));
  return {document:{documentElement:node(),getElementById:id=>nodes.get(id),createElementNS:()=>node(),addEventListener(){}},
   ZoteroPane:{getSelectedItems:()=>[]},addEventListener(){},MutationObserver:class{observe(){}}};
 };
 s.plugin.version='1.5.7';const oldWindow=makeWindow();s.sidebar.mount(oldWindow);
 s.plugin.version='1.5.8';const newWindow=makeWindow();s.sidebar.mount(newWindow);
 const oldURL=s.sidebar.views.get(oldWindow).style.href,newURL=s.sidebar.views.get(newWindow).style.href;
 assert.notEqual(newURL,oldURL);assert.equal(new URL(newURL).searchParams.get('v'),'1.5.8');
 assert.equal(new URL(newURL).pathname,'/content/task-sidebar.css');
});
test('timeline records real stages and retains failed comparison after successful source saving',()=>{
 const {plugin,sidebar}=setup();const task={kind:'parse',settings:{collationEnabled:true}};
 plugin.initializeTaskSteps(task);
 plugin.setTaskStep(task,'extract','识别全文','已识别3/10页');
 plugin.setTaskStep(task,'structure','整理文档结构');
 assert.equal(task.steps.find(s=>s.id==='extract').state,'completed');
 plugin.setTaskStep(task,'compare','对照识别 B','连接失败','failed');
 plugin.setTaskStep(task,'save','保存结果');task.state='completed';task.collationStatus='failed';plugin.finishTaskSteps(task);
 assert.equal(task.steps.find(s=>s.id==='compare').state,'failed');
 assert.equal(task.steps.find(s=>s.id==='save').state,'completed');
 assert.match(sidebar.stateLabel(task),/对照识别未完成/);
 task.partial=true;assert.match(sidebar.stateLabel(task),/部分译文/);
});
test('Marker server queue is labeled separately from active OCR',()=>{
 const {sidebar}=setup(),task={state:'running',phase:'Marker · queued'};
 assert.equal(sidebar.stateLabel(task),'Marker 服务端排队中');task.phase='Marker · ocr';assert.equal(sidebar.stateLabel(task),'正在执行');task.state='canceled';task.phase='Marker · queued';assert.equal(sidebar.stateLabel(task),'已终止');
});
test('failed step becomes pending on retry and completed extraction stays available',()=>{
 const {plugin}=setup();const task={kind:'parse',settings:{}};
 plugin.initializeTaskSteps(task);plugin.setTaskStep(task,'extract','识别全文');plugin.setTaskStep(task,'save','保存结果');
 task.state='failed';plugin.finishTaskSteps(task);plugin.initializeTaskSteps(task);
 assert.equal(task.steps.find(s=>s.id==='extract').state,'completed');
 assert.equal(task.steps.find(s=>s.id==='save').state,'pending');
});
function documentSetup(){
 const s=setup(), items=new Map();
 s.context.Zotero.Items={get:id=>items.get(id),getByLibraryAndKey:(_lib,key)=>[...items.values()].find(item=>item.key===key)};
 vm.runInContext(fs.readFileSync('workflow.js','utf8'),s.context);
 const item=(id,filename,parentID=null,tags=[])=>{const doc={id,key:'K'+id,libraryID:1,parentID,parentItemID:parentID,attachmentFilename:filename,
   relatedItems:[],getField:()=>filename||'文献'+id,isAttachment:()=>!!filename,isRegularItem:()=>!filename,isNote:()=>false,
   isPDFAttachment:()=>filename?.endsWith('.pdf'),getTags:()=>tags.map(tag=>({tag})),getAttachments:()=>[...items.values()].filter(item=>item.parentID===id).map(item=>item.id)};
   items.set(id,doc);return doc;};
 let selected=[];const view={fileID:null,launching:new Set(),window:{ZoteroPane:{getSelectedItems:()=>selected}}};
 return {...s,item,view,select:docs=>{selected=docs;}};
}
test('selection follows source, parent and generated result without falling back to an unrelated task',()=>{
 const s=documentSetup(), parent=s.item(10),file=s.item(5,'source.pdf',10),source=s.item(20,'source.md',10,['#DocFlow-Parse']);
 source.relatedItems=[file.key];file.relatedItems=[source.key];
 s.plugin.parseQueue=[{id:1,state:'running',attachment:file,resultAttachment:source}];
 s.select([parent]);s.sidebar.followSelection(s.view);assert.equal(s.view.taskID,1);
 s.select([source]);s.sidebar.followSelection(s.view);assert.equal(s.view.taskID,1);
 s.select([s.item(99)]);s.sidebar.followSelection(s.view);assert.equal(s.view.taskID,null);
});
test('attachment selection scopes operations, full text and tasks to one file',()=>{
 const s=documentSetup(),parent=s.item(1),a=s.item(2,'first.pdf',1),b=s.item(3,'second.pdf',1),text=s.item(4,'second.md',1,['#DocFlow-Parse']);
 text.relatedItems=[b.key];b.relatedItems=[text.key];s.select([parent]);
 let doc=s.sidebar.documentContext(s.view);assert.equal(doc.file,a);assert.equal(doc.source,null);
 assert(!s.sidebar.canPerform(doc,'translate'));assert(s.sidebar.canPerform(doc,'ocr'));
 s.view.fileID=b.id;doc=s.sidebar.documentContext(s.view);assert.equal(doc.source,text);assert(s.sidebar.canPerform(doc,'translate'));
 s.plugin.parseQueue=[{id:7,attachment:a,state:'running'},{id:8,attachment:text,kind:'translate',state:'completed'}];
 assert.deepEqual(Array.from(s.sidebar.documentTasks(doc),t=>t.id),[8]);
 assert(s.sidebar.canPerform(doc,'summary',true));
});

test('existing translations are matched to their exact recognized source and exclude partial or Markdown results',()=>{
 const s=documentSetup(),parent=s.item(1),a=s.item(2,'a.pdf',1),b=s.item(3,'b.pdf',1),
  sourceA=s.item(4,'a.html',1,['#DocFlow-Parse']),sourceB=s.item(5,'b.html',1,['#DocFlow-Parse']);
 sourceA.relatedItems=[a.key];a.relatedItems=[sourceA.key];sourceB.relatedItems=[b.key];b.relatedItems=[sourceB.key];
 const other=s.item(6,'a-translated.html',1,['#DocFlow-Translation']);other.relatedItems=[sourceA.key];
 const correct=s.item(7,'b-translated.html',1,['#DocFlow-Translation']);correct.relatedItems=[sourceB.key];
 s.item(8,'partial.html',1,['#DocFlow-Translation-Partial']).relatedItems=[sourceB.key];
 s.item(9,'translation.md',1,['#DocFlow-Translation']).relatedItems=[sourceB.key];
 s.select([b]);assert.equal(s.sidebar.documentContext(s.view).translation,correct);
 s.select([a]);assert.equal(s.sidebar.documentContext(s.view).translation,other);
 s.context.Zotero.Reader={getByTabID:()=>({itemID:correct.id})};
 s.view.window.Zotero_Tabs={selectedType:'reader',selectedID:'reader-b'};
 const context=s.sidebar.documentContext(s.view);assert.equal(context.item,correct);assert.equal(context.source,sourceB);assert.equal(context.file,b);
});

test('older translated HTML resolves its source from saved translation metadata without guessing another attachment',async()=>{
 const s=documentSetup(),parent=s.item(1),a=s.item(2,'a.pdf',1),b=s.item(3,'b.pdf',1),sourceA=s.item(4,'a.html',1,['#DocFlow-Parse']),sourceB=s.item(5,'b.html',1,['#DocFlow-Parse']),translated=s.item(6,'legacy.html',1,['#DocFlow-Translation']);
 sourceA.relatedItems=[a.key];sourceB.relatedItems=[b.key];translated.getFilePath=async()=>'/legacy/result.html';
 sourceA.getFilePath=async()=>'/a/result.html';sourceB.getFilePath=async()=>'/b/result.html';
 s.context.PathUtils={parent:require('node:path').posix.dirname,join:require('node:path').posix.join};
 s.context.IOUtils={exists:async path=>path==='/legacy/_ocrflow/translation.json',readUTF8:async()=>JSON.stringify({sourceKey:sourceB.key})};
 s.sidebar.render=()=>{};s.sidebar.views.set(s.view.window,s.view);
 s.select([translated]);assert.equal(s.sidebar.documentContext(s.view).source,null);
 await s.sidebar.loadTranslationContext(s.view,translated);assert.equal(s.sidebar.documentContext(s.view).source,sourceB);
 await s.sidebar.loadSourceActions(s.view,sourceB);assert.equal(s.view.sourceActions.translation,translated);
 await s.sidebar.loadSourceActions(s.view,sourceA);assert.equal(s.view.sourceActions.translation,null);
});

test('opening generated HTML uses the built-in reader and shows the OCRFlow sidebar without submitting recognition',async()=>{
 const s=documentSetup(),html=s.item(1,'recognized.html',null,['#DocFlow-Parse']);let opened,placed=0,toggled=0;
 s.context.Zotero.Reader={open:async id=>opened=id};s.sidebar.place=()=>placed++;
 s.sidebar.toggle=(_view,open,manual)=>{assert(open&&manual);toggled++;};
 s.plugin.handleParseCommand=()=>{throw Error('opening a result must not submit OCR');};
 await s.sidebar.openDocument(s.view,html);assert.equal(opened,html.id);assert.equal(placed,1);assert.equal(toggled,1);
});
test('source-less parents and multiple selections have no actionable document; standalone files can create parents',()=>{
 const s=documentSetup(),parent=s.item(1),file=s.item(2,'standalone.pdf');
 s.select([parent]);assert(!s.sidebar.canPerform(s.sidebar.documentContext(s.view),'organize'));
 s.select([file]);let doc=s.sidebar.documentContext(s.view);assert(s.sidebar.canPerform(doc,'parent'));assert(!s.sidebar.canPerform(doc,'summary'));
 s.select([parent,file]);assert.equal(s.sidebar.documentContext(s.view).item,null);
});
test('sidebar dispatches exactly one selected source and uses its linked text for AI work',async()=>{
 const s=documentSetup(),parent=s.item(1),a=s.item(2,'first.pdf',1),b=s.item(3,'second.pdf',1),text=s.item(4,'second.md',1,['#DocFlow-Parse']);
 b.relatedItems=[text.key];text.relatedItems=[b.key];s.select([parent]);s.view.fileID=b.id;s.sidebar.render=()=>{};
 const calls=[];s.plugin.handleParseCommand=async options=>calls.push(['ocr',options.selectedItems]);
 s.plugin.handleTranslateCommand=async options=>calls.push(['translate',options.selectedItems]);
 await s.sidebar.performDocumentAction(s.view,'ocr');await s.sidebar.performDocumentAction(s.view,'translate');
 assert.equal(calls[0][1][0],b);assert.equal(calls[0][1].length,1);assert.equal(calls[1][1][0],text);
 assert.equal(s.view.launching.size,0);
});
test('terminal task states never label a pending or stopped step as executing',()=>{
 const {sidebar}=setup();
 assert.equal(sidebar.stepState({state:'canceled'},{state:'running'}),'canceled');
 assert.equal(sidebar.stepState({state:'canceled'},{state:'pending'}),'not_run');
 assert.equal(sidebar.stepState({state:'failed'},{state:'pending'}),'not_run');
 assert.equal(sidebar.stepState({state:'running'},{state:'pending'}),'pending');
});
test('manual collapse prevents later tasks from opening the sidebar until the user reopens it',()=>{
 const {sidebar}=setup();let opens=0,renders=0;
 sidebar.views.set({}, {dismissed:true,taskID:1});sidebar.toggle=()=>opens++;sidebar.render=()=>renders++;
 sidebar.showTask({id:2});assert.equal(opens,0);assert.equal(renders,1);
 [...sidebar.views.values()][0].dismissed=false;sidebar.showTask({id:3});assert.equal(opens,1);
});
test('translation decision waits for a sidebar action, keeps cached units, and cancellation rejects waiting',async()=>{
 const {plugin,sidebar}=setup();sidebar.views.set({},{});
 const controller=new AbortController();const task={controller,translation:{units:[{translated:['done']}]}};
 const waiting=plugin.requestTaskDecision(task,{completed:1,total:2});assert(task.decision);
 plugin.resolveTaskDecision(task,'retry');assert.equal(await waiting,'retry');assert.equal(task.decision,null);
 assert.equal(task.translation.units[0].translated[0],'done');
 const canceled=plugin.requestTaskDecision(task,{});controller.abort();await assert.rejects(canceled);assert.equal(task.decision,null);
});
test('without a main sidebar, translation retains the existing confirmation flow',async()=>{
 const {plugin}=setup();assert.equal(await plugin.requestTaskDecision({},{}),'save');
});


test('stopping engine B cancels its own job and endpoint instead of the completed engine A job',async()=>{
 const context={DocFlow:null,setTimeout,clearTimeout,Zotero:{getMainWindow:()=>({AbortController})}};
 vm.createContext(context);vm.runInContext(fs.readFileSync('docflow.js','utf8'),context);
 const plugin=context.DocFlow,requests=[];
 plugin.refreshParseQueueDialog=()=>{};plugin.requestMineruJSON=async options=>{requests.push(options);return {status:'canceled'};};
 const task={kind:'parse',started:true,settings:{apiMode:'local-v1',apiBaseURL:'http://engine-a'},jobID:'job-a',
  cancelSettings:{apiMode:'local-v1',apiBaseURL:'http://engine-b'},cancelJobID:'job-b'};
 await plugin.finishParseQueueCancellation(task);
 assert.equal(requests[0].url,'http://engine-b/v1/parse/jobs/job-b');assert.equal(requests[0].method,'DELETE');
 requests.length=0;task.cancelJobID=null;await plugin.finishParseQueueCancellation(task);
 assert.equal(requests.length,0,'B has not submitted a job, so A must never be canceled');
});


test('review and differences actions reflect saved companion files rather than just the presence of text',async()=>{
 const s=setup(),view={window:{}};s.sidebar.views.set(view.window,view);s.sidebar.render=()=>{};
 s.context.PathUtils={parent:()=>'/storage/R',join:(...parts)=>parts.join('/')};
 s.context.IOUtils={exists:async path=>path.endsWith('/changes.html')};
 await s.sidebar.loadSourceActions(view,{id:9,getFilePath:async()=>'/storage/R/document.md'});
 assert.equal(view.sourceActions.id,9);assert.equal(view.sourceActions.review,false);assert.equal(view.sourceActions.changes,true);
});


test('pointer-held controls are not replaced by progress or native pane refreshes',()=>{
 const {sidebar}=setup();const view={pointerActive:true};
 sidebar.render(view);assert.equal(view.renderPending,true);
});
test('an open native select survives refresh after pointer release until selection or dismissal',()=>{
 const {sidebar}=setup();const view={pointerActive:false,selectActive:{isConnected:true}};
 sidebar.render(view);assert.equal(view.renderPending,true);
});
test('opening a review reports pending state, ignores repeat clicks and releases after failure',async()=>{
 const {sidebar,plugin}=setup(),view={};let reject,calls=0;
 const pending=new Promise((_resolve,r)=>reject=r),states=[];sidebar.render=()=>states.push(view.reviewOpening);
 plugin.openCollationReview=()=>{calls++;return pending;};
 const opening=sidebar.openReview(view,{id:1});assert.equal(view.reviewOpening,true);
 await sidebar.openReview(view,{id:1});assert.equal(calls,1);
 reject(Error('missing original'));await assert.rejects(opening,/missing original/);
 assert.equal(view.reviewOpening,false);assert.deepEqual(states,[true,false]);
});
test('a busy document still dispatches another action for queue deduplication',async()=>{
 const s=documentSetup(),parent=s.item(1),file=s.item(2,'file.pdf',1);s.select([parent]);
 s.plugin.parseQueue=[{id:1,attachment:file,state:'running'}];s.sidebar.render=()=>{};
 let calls=0;s.plugin.handleParseCommand=async()=>calls++;
 await s.sidebar.performDocumentAction(s.view,'ocr');assert.equal(calls,1);assert.equal(s.view.error,null);
});

test('child notes operate on the parent document while standalone notes explain the restriction',async()=>{
 const s=documentSetup(),parent=s.item(1),file=s.item(2,'book.pdf',1),text=s.item(3,'book.md',1,['#DocFlow-Parse']);
 file.relatedItems=[text.key];text.relatedItems=[file.key];
 const note=s.item(4,null,1);note.isNote=()=>true;note.isRegularItem=()=>false;
 s.select([note]);let context=s.sidebar.documentContext(s.view);
 assert.equal(context.parent,parent);assert.equal(context.file,file);assert.equal(context.source,text);
 assert(s.sidebar.canPerform(context,'summary'));
 const calls=[];s.sidebar.render=()=>{};s.plugin.handleDocumentCommand=async(kind,options)=>calls.push([kind,options.selectedItems[0]]);
 await s.sidebar.performDocumentAction(s.view,'summary');assert.equal(calls[0][1],text);
 const standalone=s.item(5);standalone.isNote=()=>true;standalone.isRegularItem=()=>false;s.select([standalone]);
 context=s.sidebar.documentContext(s.view);
 for(const kind of ['organize','ocr','metadata','summary','translate','outline','parent']) {
  assert(!s.sidebar.canPerform(context,kind));assert.match(s.sidebar.actionUnavailableReason(context,kind),/独立笔记/);
 }
 await s.sidebar.performDocumentAction(s.view,'summary');assert.equal(calls.length,1);assert.match(s.view.error.message,/独立笔记/);
});

test('selected Markdown is reused explicitly and is never its own original for rerunning OCR',async()=>{
 const s=documentSetup(),parent=s.item(1),text=s.item(2,'imported.md',1);s.select([text]);
 let context=s.sidebar.documentContext(s.view);
 assert.equal(context.file,null);assert.equal(context.source,text);
 assert(s.sidebar.canPerform(context,'translate'));assert(!s.sidebar.canPerform(context,'ocr'));
 assert.match(s.sidebar.actionUnavailableReason(context,'ocr'),/未关联原文件/);
 assert.match(s.sidebar.actionUnavailableReason(context,'outline'),/原始 PDF/);
 const file=s.item(3,'original.pdf',1);text.relatedItems=[file.key];file.relatedItems=[text.key];
 const calls=[];s.sidebar.render=()=>{};s.plugin.handleOrganizeCommand=async options=>calls.push(options.selectedItems[0]);
 await s.sidebar.performDocumentAction(s.view,'organize');assert.equal(calls[0],text);
 context=s.sidebar.documentContext(s.view);assert(s.sidebar.canPerform(context,'ocr'));
 s.plugin.handleParseCommand=async options=>calls.push(options.selectedItems[0]);
 await s.sidebar.performDocumentAction(s.view,'ocr');assert.equal(calls[1],file);
});


test('sidebar title translation works without source files and sends the selected parent directly',async()=>{
 const s=documentSetup(),parent=s.item(1);s.select([parent]);s.sidebar.render=()=>{};
 const context=s.sidebar.documentContext(s.view);assert(s.sidebar.canPerform(context,'title'));assert(s.sidebar.canPerform(context,'title',true));
 const calls=[];s.plugin.handleTitleTranslation=async options=>calls.push(options.selectedItems);
 await s.sidebar.performDocumentAction(s.view,'title');assert.equal(calls.length,1);assert.equal(calls[0][0],parent);assert.equal(s.view.launching.size,0);
 s.select([s.item(2,'standalone.pdf')]);assert.match(s.sidebar.actionUnavailableReason(s.sidebar.documentContext(s.view),'title'),/先建立条目/);
});
test('parent title tasks remain visible when either of its attachments is selected',()=>{
 const s=documentSetup(),parent=s.item(1),a=s.item(2,'first.pdf',1),b=s.item(3,'second.pdf',1),other=s.item(4);
 s.plugin.parseQueue=[{id:1,kind:'title',attachment:parent,state:'running'},{id:2,kind:'title',attachment:other,state:'running'},{id:3,kind:'parse',attachment:a,state:'running'}];
 s.select([b]);assert.deepEqual(Array.from(s.sidebar.documentTasks(s.sidebar.documentContext(s.view)),t=>t.id),[1]);
 s.select([a]);assert.deepEqual(Array.from(s.sidebar.documentTasks(s.sidebar.documentContext(s.view)),t=>t.id),[1,3]);
});

test('sidebar layout conversion uses the selected recognized file and opens the new attachment without OCR',async()=>{
 const s=documentSetup(),parent=s.item(1),file=s.item(2,'source.pdf',1),source=s.item(3,'existing.html',1,['#DocFlow-Parse']),converted=s.item(4,'new_MD布局.html',1,['#DocFlow-Parse']);
 source.relatedItems=[file.key];file.relatedItems=[source.key];s.select([source]);s.sidebar.render=()=>{};
 const calls=[];s.plugin.convertDocumentLayout=async options=>{calls.push(options);assert(s.view.layoutConverting);return converted;};
 s.sidebar.openDocument=async(view,item)=>{assert.equal(view,s.view);assert.equal(item,converted);};
 await s.sidebar.convertDocumentLayout(s.view,'markdown');
 assert.equal(calls.length,1);assert.equal(calls[0].source,source);assert.equal(calls[0].original,file);assert.equal(calls[0].htmlLayout,'markdown');
 assert.equal(s.view.layoutConverting,false);assert.equal(s.view.launching.size,0);
 s.plugin.convertDocumentLayout=async()=>{throw Error('missing geometry');};
 await assert.rejects(s.sidebar.convertDocumentLayout(s.view,'original'),/missing geometry/);
 assert.equal(s.view.layoutConverting,false);assert.equal(s.view.launching.size,0);
});
