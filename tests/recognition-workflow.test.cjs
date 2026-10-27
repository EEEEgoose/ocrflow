const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function setup(){
 const prefs=new Map(),items=new Map(),context={setTimeout,clearTimeout,AbortController,Uint8Array,
  Zotero:{getMainWindow:()=>({AbortController}),Prefs:{get:k=>prefs.get(k),set:(k,v)=>prefs.set(k,v)},Items:{get:id=>items.get(id),getByLibraryAndKey:(_lib,key)=>[...items.values()].find(i=>i.key===key)},debug(){},logError(){}},
  IOUtils:{exists:async()=>true}};
 vm.createContext(context);for(const file of ['prompts.js','docflow.js','workflow.js','document.js','translation.js','recognition.js','attachment-naming.js','task-sidebar.js'])vm.runInContext(fs.readFileSync(file,'utf8'),context);
 const m=context.DocFlow;m.refreshParseQueueDialog=()=>{};m.openParseQueueDialog=()=>{};
 let next=1;function item(filename,parent=null,tags=[]){const i={id:next++,libraryID:1,key:'K'+next,attachmentFilename:filename,parentItemID:parent?.id,relatedItems:[],
  getField:f=>f==='title'?(filename||'Book'):f==='date'?'2024':'',getTags:()=>tags.map(tag=>({tag})),isRegularItem:()=>!filename,isAttachment:()=>!!filename,
  isPDFAttachment:()=>filename?.endsWith('.pdf'),getAttachments:()=>[...items.values()].filter(c=>c.parentItemID===i.id).map(c=>c.id),getCreatorsJSON:()=>[{lastName:'Rahal',creatorType:'author'},{lastName:'Other',creatorType:'author'}]};items.set(i.id,i);return i;}
 return {m,prefs,context,item,sidebar:context.OCRFlowTaskSidebar};
}
test('file defaults and explicit sources use captured profiles without changing another format or requiring a PDF',()=>{
 const s=setup(),settings={parserService:'marker',apiMode:'cloud',markerSettings:{},defaultServices:{office:'mineru-cloud',html:'mineru-cloud',image:'ai'},mineruProfiles:{'mineru-cloud':{apiMode:'cloud',apiBaseURL:'https://saved',enableFormula:false,enableTable:true,modelVersion:'vlm'}}};
 s.m.getSettings=()=>{throw Error('queued settings must not read later preferences');};
 assert.equal(s.m.recognitionSettingsFor(s.item('book.pdf'),settings).parserService,'marker');
 let office=s.m.recognitionSettingsFor(s.item('book.docx'),settings);assert.equal(office.apiBaseURL,'https://saved');assert.equal(office.enableFormula,false);
 assert.equal(s.m.recognitionSettingsFor(s.item('saved.html'),settings).modelVersion,'MinerU-HTML');assert.equal(s.m.recognitionSettingsFor(s.item('photo.png'),settings).parserService,'ai');
 assert.equal(s.m.recognitionSettingsFor(s.item('book.epub'),settings).parserService,'markitdown');
 assert.throws(()=>s.m.recognitionSettingsFor(s.item('book.docx'),{...settings,explicitService:true}),/不支持/);
});
test('five cloud documents start, the sixth queues, and another document model remains independent',async()=>{
 const s=setup();let release;const gate=new Promise(r=>release=r),started=[];
 s.m.runParseTask=async task=>{task.cloudRecognizing=true;started.push(task.id);await gate;return {};};
 s.m.runDocumentTask=async task=>started.push(task.id);s.m.resolveTaskPrerequisites=()=>true;
 for(let i=1;i<=6;i++)s.m.parseQueue.push({id:i,kind:'parse',state:'queued',attachment:s.item('p'+i+'.pdf'),settings:{recognitionResolved:true,parserService:'mineru',apiMode:'cloud'}});
 s.m.parseQueue.push({id:7,kind:'summary',state:'queued',attachment:s.item('s.pdf'),settings:{model:'other'}});
 const running=s.m.processParseQueue();assert.deepEqual(started,[1,2,3,4,5,7]);assert.equal(s.m.parseQueue[5].state,'queued');release();await running;assert(started.includes(6));
});
test('waiting operations do not occupy slots and use the newly created source after recognition succeeds',async()=>{
 const s=setup(),parent=s.item(),pdf=s.item('original.pdf',parent);let release;const gate=new Promise(r=>release=r),seen=[];
 s.m.runParseTask=async()=>{await gate;const md=s.item('new.md',parent,['#DocFlow-Parse']);md.relatedItems=[pdf.key];pdf.relatedItems=[md.key];return {attachment:md};};
 s.m.runDocumentTask=async task=>seen.push(task.source.attachmentFilename);
 s.m.parseQueue=[{id:1,kind:'parse',state:'queued',attachment:pdf,settings:{parserService:'markitdown'}},{id:2,kind:'summary',state:'queued',attachment:pdf,settings:{model:'a'}}];
 const running=s.m.processParseQueue();assert.equal(s.m.parseQueue[1].state,'waiting_dependency');assert.equal(s.m.parseQueue[1].active,undefined);
 release();await running;assert.deepEqual(seen,['new.md']);assert.equal(s.m.parseQueue[1].state,'completed');
});
test('page separators occur once per PDF page and never split one cross-page translation unit',()=>{
 const s=setup(),D=s.context.OCRFlowDocument,doc=D.create('fixture');doc.pages=[{page:1},{page:2}];D.add(doc,'paragraph','unfinished text',1);D.add(doc,'paragraph','continued on next page.',2);D.add(doc,'paragraph','Another paragraph.',2);D.prepare(doc);
 const output=s.m.pageDisplayMarkdown(D.render(doc));assert.equal((output.match(/PDF 第 1 页/g)||[]).length,1);assert.equal((output.match(/PDF 第 2 页/g)||[]).length,1);
 const paragraphs=s.m.translationParagraphs(output);assert.equal(paragraphs.length,2);assert.match(paragraphs[0].text,/unfinished text\s+continued on next page/);assert(!paragraphs.some(p=>/PDF 第|---/.test(p.text)));assert.deepEqual(Array.from(paragraphs[0].pages),[1,2]);
});
test('close persists for one version, mute spans 1.x releases, and a new major is still shown',()=>{
 const s=setup();s.sidebar.init(s.m);s.sidebar.refresh=()=>{};
 assert(s.sidebar.showUpdateNotice('1.5.6'));s.sidebar.dismissUpdateNotice('1.5.6');assert(!s.sidebar.showUpdateNotice('1.5.6'));assert(s.sidebar.showUpdateNotice('1.5.7'));
 s.sidebar.dismissUpdateNotice('1.5.6',true);assert(!s.sidebar.showUpdateNotice('1.6.0'));assert(s.sidebar.showUpdateNotice('2.0.0'));
});
test('file stems use first author surname plus 等 and the publication year',async()=>{
 const s=setup(),parent=s.item();assert.equal(await s.m.documentFileStem(parent),'Rahal等_2024_Book');
});
test('capturing a not-yet-configured local MinerU profile does not reuse the cloud endpoint or token',()=>{
 const s=setup(),branch=s.m.PREF_BRANCH;s.prefs.set(branch+'apiMode','cloud');s.prefs.set(branch+'apiBaseURL','https://cloud.example/api/v4');s.prefs.set(branch+'apiToken','cloud-secret');
 const captured=s.m.getSettings();assert.equal(captured.mineruProfiles['mineru-local'].apiBaseURL,'http://127.0.0.1:8000');assert.equal(captured.mineruProfiles['mineru-local'].apiToken,'');assert.equal(captured.mineruProfiles['mineru-cloud'].apiToken,'cloud-secret');
});
