const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

function setup() {
  const prefs=new Map(Object.entries({apiMode:'local-v1',parserService:'ai','local.apiBaseURL':'http://local.example','local.modelVersion':'advanced','cloud.apiBaseURL':'https://cloud.example/v4','cloud.apiToken':'cloud-token','cloud.modelVersion':'vlm'}).map(([key,value])=>['extensions.docflow.'+key,value]));
  const calls=[],registered=[];
  const context={Zotero:{Prefs:{get:key=>prefs.get(key)},debug:()=>{},logError:error=>{throw error;},getMainWindows:()=>[],MenuManager:{registerMenu:menu=>registered.push(menu)}}};
  vm.createContext(context);for(const file of ['prompts.js','docflow.js','workflow.js'])vm.runInContext(fs.readFileSync(file,'utf8'),context);
  const plugin=context.DocFlow;plugin.enqueueDocumentTasks=async(kind,tasks,settings)=>calls.push({kind,tasks,settings});
  const file=(id,name)=>({id,libraryID:1,attachmentFilename:name,isAttachment:()=>true,isRegularItem:()=>false,isNote:()=>false,isPDFAttachment:()=>name.endsWith('.pdf'),getTags:()=>[],hasTag:()=>false,getField:()=>name,relatedItems:[]});
  return {plugin,prefs,calls,registered,context,pdf:file(1,'scan.pdf'),image:file(2,'scan.png'),epub:file(3,'book.epub')};
}

test('OCR submenu choices use saved service profiles without changing defaults',async()=>{
  const s=setup(),choices=s.plugin.getContextMenuDefinitions()[1].children,before=Array.from(s.prefs);
  assert.deepEqual(Array.from(choices,choice=>choice.id),['docflow-ocr-default','docflow-ocr-mineru-local','docflow-ocr-mineru-cloud','docflow-ocr-markitdown','docflow-ocr-ai']);
  for(const choice of choices)await choice.run({selectedItems:[s.pdf,s.image,s.epub]});
  assert.deepEqual(s.calls.map(call=>call.settings.parserService),['ai','mineru','mineru','markitdown','ai']);
  assert.equal(s.calls[1].settings.apiBaseURL,'http://local.example');assert.equal(s.calls[1].settings.modelVersion,'advanced');
  assert.equal(s.calls[2].settings.apiMode,'cloud');assert.equal(s.calls[2].settings.apiBaseURL,'https://cloud.example/v4');assert.equal(s.calls[2].settings.apiToken,'cloud-token');
  assert.deepEqual(s.calls.map(call=>Array.from(call.tasks,task=>task.attachment.id)),[[1,2,3],[1,2],[1,2],[1,2,3],[1,2]]);
  assert.deepEqual(Array.from(s.prefs),before);
});

test('MenuManager receives a nested OCR menu and enables only supported input formats',()=>{
  const s=setup();assert(s.plugin.registerMenuForZotero8());
  const menu=s.registered[0].menus[0].menus[1];assert.equal(menu.menuType,'submenu');assert.equal(menu.menus.length,5);assert.equal(menu.onCommand,undefined);
  const enabled=[];for(const leaf of menu.menus)leaf.onShowing(null,{items:[s.epub],setEnabled:value=>enabled.push(value)});
  assert.deepEqual(enabled,[true,false,false,true,false]);
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
