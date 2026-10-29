const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

function setup() {
  const prefs=new Map(Object.entries({apiMode:'local-v1',parserService:'ai','local.apiBaseURL':'http://local.example','local.modelVersion':'advanced','cloud.apiBaseURL':'https://cloud.example/v4','cloud.apiToken':'cloud-token','cloud.modelVersion':'vlm'}).map(([key,value])=>['extensions.docflow.'+key,value]));
  const calls=[],registered=[];
  const context={Zotero:{Prefs:{get:key=>prefs.get(key)},debug:()=>{},logError:error=>{throw error;},getMainWindows:()=>[],MenuManager:{registerMenu:menu=>registered.push(menu)}}};
  vm.createContext(context);for(const file of ['prompts.js','docflow.js','workflow.js','title-translation.js'])vm.runInContext(fs.readFileSync(file,'utf8'),context);
  const plugin=context.DocFlow;plugin.enqueueDocumentTasks=async(kind,tasks,settings)=>calls.push({kind,tasks,settings});
  const file=(id,name)=>({id,libraryID:1,attachmentFilename:name,isAttachment:()=>true,isRegularItem:()=>false,isNote:()=>false,isPDFAttachment:()=>name.endsWith('.pdf'),getTags:()=>[],hasTag:()=>false,getField:()=>name,relatedItems:[]});
  return {plugin,prefs,calls,registered,context,pdf:file(1,'scan.pdf'),image:file(2,'scan.png'),epub:file(3,'book.epub')};
}

test('OCR submenu choices use saved service profiles without changing defaults',async()=>{
  const s=setup(),choices=s.plugin.getContextMenuDefinitions()[1].children,before=Array.from(s.prefs);
  assert.deepEqual(Array.from(choices,choice=>choice.id),['docflow-ocr-default','docflow-ocr-mineru-local','docflow-ocr-mineru-cloud','docflow-ocr-markitdown','docflow-ocr-paddle-cloud','docflow-ocr-paddle-local','docflow-ocr-marker-cloud','docflow-ocr-marker-local','docflow-ocr-ai']);
  for(const choice of choices)await choice.run({selectedItems:[s.pdf,s.image,s.epub]});
  assert.deepEqual(s.calls.map(call=>call.settings.parserService),['ai','mineru','mineru','markitdown','paddle-cloud','paddle-local','marker','marker','ai']);
  assert.equal(s.calls[1].settings.apiBaseURL,'http://local.example');assert.equal(s.calls[1].settings.modelVersion,'advanced');
  assert.equal(s.calls[2].settings.apiMode,'cloud');assert.equal(s.calls[2].settings.apiBaseURL,'https://cloud.example/v4');assert.equal(s.calls[2].settings.apiToken,'cloud-token');
  assert.deepEqual(s.calls.map(call=>Array.from(call.tasks,task=>task.attachment.id)),[[1,2,3],[1,2],[1,2],[1,2,3],[1,2],[1,2],[1],[1],[1,2]]);
  assert.deepEqual(Array.from(s.prefs),before);
});

test('MenuManager receives a nested OCR menu and enables only supported input formats',()=>{
  const s=setup();assert(s.plugin.registerMenuForZotero8());
  const menu=s.registered[0].menus[0].menus.find(menu=>menu.l10nID==="docflow-menu-parse-pdf");assert.equal(menu.menuType,'submenu');assert.equal(menu.menus.length,9);assert.equal(menu.onCommand,undefined);
  const enabled=[];for(const leaf of menu.menus)leaf.onShowing(null,{items:[s.epub],setEnabled:value=>enabled.push(value)});
  assert.deepEqual(enabled,[true,false,false,true,false,false,false,false,false]);
  menu.menus[2].onCommand(null,{items:[s.pdf],menuElem:{ownerGlobal:{}}});
  assert.equal(s.calls[0].settings.parserService,'mineru');assert.equal(s.calls[0].settings.apiMode,'cloud');
});

test('retry keeps the chosen OCR service while refreshing saved credentials',async()=>{
  const s=setup();
  s.plugin.parseQueue=[{id:1,kind:'parse',state:'failed',settings:{parserService:'markitdown',apiMode:'local-v1'}},{id:2,kind:'parse',state:'failed',settings:{parserService:'mineru',apiMode:'cloud'}}];
  s.plugin.refreshParseQueueDialog=()=>{};s.plugin.processParseQueue=async()=>{};
  s.prefs.set('extensions.docflow.cloud.apiToken','updated-token');
  await s.plugin.retryParseQueueTasks([1,2]);
  assert.equal(s.plugin.parseQueue[0].settings.parserService,'markitdown');
  assert.equal(s.plugin.parseQueue[1].settings.parserService,'mineru');assert.equal(s.plugin.parseQueue[1].settings.apiToken,'updated-token');
  assert.equal(s.prefs.get('extensions.docflow.parserService'),'ai');
});

test('the existing direct-menu fallback also builds OCR choices and dispatches one selected action',()=>{
  const s=setup(),elements=new Map();delete s.context.Zotero.MenuManager;
  class Element {
    constructor(tag){this.tag=tag;this.children=[];this.attrs={};this.style={};this.events={};}
    set id(value){this._id=value;elements.set(value,this);}get id(){return this._id;}
    setAttribute(key,value){this.attrs[key]=value;}
    appendChild(child){this.children.push(child);}
    addEventListener(type,fn){this.events[type]=fn;}
  }
  const popup=new Element('menupopup');elements.set('zotero-itemmenu',popup);
  const win={document:{getElementById:id=>elements.get(id),createXULElement:tag=>new Element(tag)},ZoteroPane:{getSelectedItems:()=>[s.pdf]}};
  s.plugin.addToWindow(win);
  assert.equal(elements.get('docflow-parse-pdf').tag,'menu');assert.equal(elements.get('docflow-ocr-ai').tag,'menuitem');
  elements.get('docflow-ocr-ai').events.command();
  assert.equal(s.calls.length,1);assert.equal(s.calls[0].settings.parserService,'ai');assert.equal(s.calls[0].tasks[0].attachment.id,s.pdf.id);
});


test('menu actions have native label attributes, vector icons and compact functional groups',()=>{
  const s=setup();s.plugin.registerMenuForZotero8();
  const root=s.registered[0].menus[0], actions=root.menus.filter(menu=>menu.menuType!=='separator');
  assert.equal(actions[0].l10nID,'docflow-menu-organize');
  assert.equal(root.menus.filter(menu=>menu.menuType==='separator').length,3);
  const walk=items=>items.flatMap(item=>[item,...(item.children?walk(item.children):[])]);
  for(const locale of ['zh-CN','en-US']) {
    const text=fs.readFileSync(`locale/${locale}/docflow.ftl`,'utf8');
    for(const definition of walk(s.plugin.getContextMenuDefinitions())) {
      const entry=text.split(definition.l10nID+' =')[1]?.split(/\n(?=\S)/)[0];
      assert(entry&&/^\s+\.label = \S/m.test(entry),locale+' '+definition.l10nID+' must supply a native menu label');
    }
  }
  for(const item of actions) {assert(item.icon.endsWith('.svg'));assert(fs.existsSync(item.icon));}
});

test('Marker menu uses the chosen endpoint and retry refreshes that endpoint without changing defaults',async()=>{
 const s=setup(),set=(k,v)=>s.prefs.set('extensions.docflow.marker.'+k,v);
 set('apiType','local');set('url','http://marker.example');set('token','self-token');set('cloud.url','https://datalab.example/api/v1');set('cloud.token','online-token');
 const before=Array.from(s.prefs),choices=s.plugin.getOCRMenuDefinitions();
 await choices.find(c=>c.id==='docflow-ocr-marker-cloud').run({selectedItems:[s.pdf]});
 await choices.find(c=>c.id==='docflow-ocr-marker-local').run({selectedItems:[s.pdf]});
 assert.equal(s.calls[0].settings.markerSettings.apiType,'cloud');assert.equal(s.calls[0].settings.markerSettings.baseURL,'https://datalab.example/api/v1');assert.equal(s.calls[0].settings.markerSettings.token,'online-token');
 assert.equal(s.calls[1].settings.markerSettings.apiType,'local');assert.equal(s.calls[1].settings.markerSettings.baseURL,'http://marker.example');assert.equal(s.calls[1].settings.markerSettings.token,'self-token');
 assert.deepEqual(Array.from(s.prefs),before);
 s.plugin.parseQueue=s.calls.map((call,i)=>({id:i+1,kind:'parse',state:'failed',settings:call.settings}));
 set('apiType','cloud');set('cloud.token','renewed-online');set('token','renewed-self');
 s.plugin.refreshParseQueueDialog=()=>{};s.plugin.processParseQueue=async()=>{};
 await s.plugin.retryParseQueueTasks([1,2]);
 assert.deepEqual(s.plugin.parseQueue.map(task=>task.settings.markerSettings.apiType),['cloud','local']);
 assert.deepEqual(s.plugin.parseQueue.map(task=>task.settings.markerSettings.token),['renewed-online','renewed-self']);
 assert(s.plugin.parseQueue.every(task=>task.settings.explicitService));
});
