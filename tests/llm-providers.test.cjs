const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path').posix;
const prefix = 'extensions.docflow.';

class Element {
  constructor() {
    this.value = ''; this.checked = false; this.disabled = false; this.hidden = false;
    this.textContent = ''; this.style = {}; this.attributes = {}; this.listeners = {};
    this.localName = 'input';
  }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  click() { if (!this.disabled && !this.hidden) return this.listeners.click(); }
}

function fixture(prefs) {
  const inputs = new Map(Array.from(fs.readFileSync('preferences.xhtml', 'utf8').matchAll(/\bid="([^"]+)"/g), m => [m[1], new Element()]));
  const requests = [], files = new Map();
  const context = {
    AbortController, setTimeout, clearTimeout, TextDecoder, Uint8Array, URL,
    pref: (key, value) => { if (!prefs.has(key)) prefs.set(key, value); },
    PathUtils: {join: path.join, parent: path.dirname},
    IOUtils: {exists: async key => files.has(key), readUTF8: async key => files.get(key), makeDirectory: async () => {}, writeUTF8: async (key, value) => files.set(key, value)},
    Zotero: {
      Prefs: {get: key => prefs.get(key), set: (key, value) => prefs.set(key, value)},
      getMainWindow: () => ({AbortController}), DataDirectory: {dir: '/data'}, Reader: {_readers: []}, debug: () => {}, logError: error => { throw error; }
    },
    fetch: async (url, options) => {
      const payload = JSON.parse(options.body);
      requests.push({url, options, payload});
      const content = payload.messages[0].content.includes('文献结构分析助手')
        ? JSON.stringify({outline: [{level: 1, title: '第一章', summary: '概要', page: 1}]}) : '已生成';
      const reply = {choices: [{message: {content}}], model: payload.model};
      return {ok: true, json: async () => reply, text: async () => JSON.stringify(reply)};
    }
  };
  vm.createContext(context);
  for (const file of ['prompts.js','prefs.js', 'docflow.js', 'workflow.js', 'preferences.js', 'outline.js']) {
    vm.runInContext(fs.readFileSync(file, 'utf8'), context);
  }
  const panel = context.DocFlowPreferences, plugin = context.DocFlow;
  panel.$ = id => inputs.get(id);
  panel.syncParseOptions = () => {}; // MinerU tier menus are tested separately.
  require("./preferences-dom.cjs")(context, panel, inputs);
  panel.init();
  assert.equal(panel.initialized, true);
  const edit = (id, value) => { inputs.get(id).value = value; };
  const click = id => inputs.get(id).click();
  const provider = () => plugin.getLLMSettings();
  return {context, panel, plugin, inputs, edit, click, provider, requests};
}

const {test} = require('node:test');
function legacyPrefs() {
  return new Map(Object.entries({llmApiBaseURL:'https://first.example/v1/',llmApiKey:'Bearer test-key-one',llmModel:'model-one',summaryRequestJSON:'{"enable_thinking":true}',translateRequestJSON:'{"max_tokens":4096}',summaryLanguage:'English',summaryPrompt:'Keep this shared prompt'}).map(([key,value])=>[prefix+key,value]));
}
test('upgrade pins the previous AI as default; editing another provider never changes it',()=>{
 const prefs=legacyPrefs(), a=fixture(prefs);
 assert.equal(a.provider().model,'model-one');
 assert.equal(a.plugin.getLLMSettings('summary').summaryRequestJSON,'{"enable_thinking":true}');
 const snapshot=a.provider();
 a.click('mineru-llm-provider-add');
 assert.equal(a.provider().model,'model-one');
 a.edit('mineru-llm-provider-name','Second');a.edit('mineru-llm-api-base-url','https://second.example/v1');a.edit('mineru-llm-api-key','test-key-two');a.edit('mineru-llm-model','model-two');a.edit('mineru-llm-model-2','model-two-fast');
 a.click('ocrflow-ai-save');
 const id=a.panel.llmProviders[1].id;
 a.edit('ocrflow-work-summary-model',id+':2');a.edit('mineru-summary-prompt','Custom {{language}}');a.edit('mineru-summary-request-json','{"temperature":0.1}');
 assert.equal(a.click('mineru-save-button'),true);
 assert.equal(a.plugin.getLLMSettings('summary').model,'model-two-fast');
 assert.equal(a.plugin.getLLMSettings('summary').apiKey,'test-key-two');
 assert.equal(a.plugin.getLLMSettings('parent').model,'model-one');
 a.click('mineru-llm-provider-0');assert.equal(a.plugin.getLLMSettings('summary').model,'model-two-fast');
 assert.equal(snapshot.model,'model-one');
 const reopened=fixture(prefs);assert.equal(reopened.plugin.getLLMSettings('summary').model,'model-two-fast');
 assert.equal(reopened.inputs.get('mineru-summary-prompt').value,'Custom {{language}}');
 assert.equal(reopened.inputs.get('ocrflow-work-summary-model').children.find(c=>c.value===id+':2').textContent,'Second + model-two-fast');
});
test('the five-provider limit and deletion keep referenced model selections intact',()=>{
 const a=fixture(legacyPrefs());assert.equal(a.panel.deleteLLMProvider(),false);
 for(let i=0;i<4;i++)a.click('mineru-llm-provider-add');
 assert.equal(a.panel.llmProviders.length,5);assert.equal(a.panel.addLLMProvider(),false);
 assert.equal(a.panel.deleteLLMProvider(),true);assert.equal(a.panel.llmProviders.length,4);
 a.click('mineru-llm-provider-0');assert.equal(a.panel.deleteLLMProvider(),false);
 assert.equal(a.provider().model,'model-one');
});
test('model limits and work parameters validate atomically; blanks restore defaults',()=>{
 const a=fixture(legacyPrefs());
 a.edit('ocrflow-model-1-context','64K');a.edit('ocrflow-model-1-concurrency','2');
 a.edit('mineru-summary-request-json','{"model":"wrong"}');
 assert.equal(a.click('mineru-save-button'),false);
 assert.equal(a.plugin.getLLMSettings('summary').contextWindow,32768);
 a.edit('mineru-summary-request-json','');a.edit('ocrflow-model-1-context','');a.edit('ocrflow-model-1-concurrency','');a.edit('mineru-summary-prompt','');
 assert.equal(a.click('mineru-save-button'),true);
 const settings=a.plugin.getLLMSettings('summary');assert.equal(settings.contextWindow,32768);assert.equal(settings.concurrency,1);assert.equal(settings.workPrompt,'');assert.equal(settings.summaryRequestJSON,'');
 a.edit('ocrflow-model-1-concurrency','9');assert.equal(a.click('mineru-save-button'),false);
 a.edit('ocrflow-model-1-concurrency','');a.edit('ocrflow-model-1-context','100');assert.equal(a.click('mineru-save-button'),false);
});
test('separate connection buttons test each visible model without saving drafts',async()=>{
 const prefs=legacyPrefs(),a=fixture(prefs);
 a.edit('mineru-llm-model-2','vision-two');
 const before=JSON.stringify([...prefs]);await a.click('ocrflow-model-1-test');await a.click('ocrflow-model-2-test');
 assert.deepEqual(a.requests.map(r=>r.payload.model),['model-one','vision-two']);
 assert.equal(JSON.stringify([...prefs]),before);
 assert(a.requests.every(r=>r.options.headers.Authorization==='Bearer test-key-one'));
});
test('upgrade loads legacy parameters from the assigned provider, and clearing them selects built-in defaults',()=>{
 const prefs=legacyPrefs();
 prefs.set(prefix+'llmProviders',JSON.stringify([{llmProviderName:'First',llmApiBaseURL:'https://one.example/v1',llmModel:'one',summaryRequestJSON:'{"temperature":0.1}'},{llmProviderName:'Second',llmApiBaseURL:'https://two.example/v1',llmModel:'two',summaryRequestJSON:'{"temperature":0.7}'}]));
 prefs.set(prefix+'llmProviderIndex',1);
 const a=fixture(prefs);
 assert.equal(a.inputs.get('mineru-summary-request-json').value,'{"temperature":0.7}');
 assert.equal(a.click('mineru-save-button'),true);
 assert.equal(a.plugin.getLLMSettings('summary').summaryRequestJSON,'{"temperature":0.7}');
 a.edit('mineru-summary-request-json','');assert.equal(a.click('mineru-save-button'),true);
 assert.equal(a.plugin.getLLMSettings('summary').summaryRequestJSON,'');
});
test('each model saves its own limits; assigned works share those limits while prompts stay independent',()=>{
 const prefs=legacyPrefs(),a=fixture(prefs);
 a.edit('mineru-llm-model-2','model-two');
 a.edit('ocrflow-model-1-context','64K');a.edit('ocrflow-model-1-concurrency','2');
 a.edit('ocrflow-model-2-context','128K');a.edit('ocrflow-model-2-concurrency','4');
 assert.equal(a.click('ocrflow-ai-save'),true);
 for(const kind of ['parent','metadata','summary','ocr','translate']) {
   a.edit('ocrflow-work-'+kind+'-model',kind==='ocr'?'provider-0:2':'provider-0:1');
 }
 a.edit('mineru-summary-prompt','Summary only');a.edit('ocrflow-work-parent-prompt','Parent only');
 assert.equal(a.click('mineru-save-button'),true);
 for(const kind of ['parent','metadata','summary','translate']){const settings=a.plugin.getLLMSettings(kind);assert.equal(settings.contextWindow,65536);assert.equal(settings.concurrency,2);}
 assert.equal(a.plugin.getTranslationSettings().translateConcurrency,2);
 assert.equal(a.plugin.getLLMSettings('ocr').contextWindow,131072);assert.equal(a.plugin.getLLMSettings('ocr').concurrency,4);
 assert.equal(a.plugin.getLLMSettings('parent').workPrompt,'Parent only');assert.equal(a.plugin.getLLMSettings('summary').workPrompt,'Summary only');
 assert(!a.inputs.has('ocrflow-work-summary-context'));assert(!a.inputs.has('mineru-translate-concurrency'));
 const reopened=fixture(prefs);assert.equal(reopened.inputs.get('ocrflow-model-2-context').value,'128K');assert.equal(reopened.plugin.getLLMSettings('ocr').concurrency,4);
});
test('legacy work limits do not override a chosen model, and other provider drafts keep their limits',()=>{
 const prefs=legacyPrefs();prefs.set(prefix+'aiWorkSettings',JSON.stringify({defaultModel:'provider-0:1',summary:{context:'999999',concurrency:'8'}}));
 const a=fixture(prefs);assert.equal(a.plugin.getLLMSettings('summary').concurrency,1);assert.equal(a.plugin.getLLMSettings('summary').contextWindow,32768);
 a.edit('ocrflow-model-1-context','64K');a.edit('ocrflow-model-1-concurrency','2');
 a.click('mineru-llm-provider-add');a.edit('mineru-llm-model','second');a.edit('ocrflow-model-1-context','128K');a.edit('ocrflow-model-1-concurrency','3');
 a.click('mineru-llm-provider-0');assert.equal(a.inputs.get('ocrflow-model-1-context').value,'64K');assert.equal(a.inputs.get('ocrflow-model-1-concurrency').value,'2');
 a.click('mineru-llm-provider-1');assert.equal(a.inputs.get('ocrflow-model-1-context').value,'128K');assert.equal(a.inputs.get('ocrflow-model-1-concurrency').value,'3');
});
test('model connection tests run independently and retain separate success and failure results',async()=>{
 const prefs=legacyPrefs(),a=fixture(prefs),pending={},calls=[];
 a.edit('mineru-llm-model-2','model-two');a.edit('mineru-llm-api-base-url','https://unsaved.example/v1');
 a.context.fetch=(url,options)=>new Promise(resolve=>{const payload=JSON.parse(options.body);calls.push({url,payload});pending[payload.model]=resolve;});
 const before=JSON.stringify([...prefs]);
 const first=a.click('ocrflow-model-1-test');assert(a.inputs.get('ocrflow-model-1-test').disabled);assert(!a.inputs.get('ocrflow-model-2-test').disabled);
 const second=a.click('ocrflow-model-2-test');assert(a.inputs.get('ocrflow-model-2-test').disabled);
 assert.deepEqual(calls.map(call=>call.payload.model),['model-one','model-two']);assert(calls.every(call=>call.url==='https://unsaved.example/v1/chat/completions'));
 pending['model-two']({ok:true,status:200,text:async()=>JSON.stringify({choices:[{message:{content:'OK'}}]})});await second;
 assert.match(a.inputs.get('ocrflow-model-2-status').textContent,/测试成功/);assert(!a.inputs.get('ocrflow-model-2-test').disabled);assert(a.inputs.get('ocrflow-model-1-test').disabled);
 pending['model-one']({ok:false,status:503,text:async()=> 'Model unavailable'});await first;
 assert.match(a.inputs.get('ocrflow-model-1-status').textContent,/测试失败/);assert.match(a.inputs.get('ocrflow-model-1-output').textContent,/HTTP 503/);
 assert.match(a.inputs.get('ocrflow-model-2-status').textContent,/测试成功/);assert(!a.inputs.get('ocrflow-model-1-test').disabled);
 assert.equal(JSON.stringify([...prefs]),before);
});
test('model two can be tested when model one is blank; an empty selected model sends no request',async()=>{
 const a=fixture(legacyPrefs());a.edit('mineru-llm-model','');a.edit('mineru-llm-model-2','model-two');
 await a.click('ocrflow-model-2-test');assert.deepEqual(a.requests.map(r=>r.payload.model),['model-two']);
 await a.click('ocrflow-model-1-test');assert.equal(a.requests.length,1);assert.match(a.inputs.get('ocrflow-model-1-status').textContent,/请先填写/);
 assert.match(a.inputs.get('ocrflow-model-2-status').textContent,/测试成功/);
});
test('connection checks recognize reasoning-only and token-limited responses without calling them full replies',async()=>{
 const a=fixture(legacyPrefs());
 const cases=[
  {message:{content:null,reasoning:'Private reasoning text'},finish_reason:'stop'},
  {message:{content:'',reasoning_content:'Private reasoning text'},finish_reason:'stop'},
  {message:{content:'',reasoning_details:[{type:'reasoning.text',text:'Private reasoning text'}]},finish_reason:'stop'},
  {message:{content:null},finish_reason:'length'},
  {message:{content:'O'},finish_reason:'length'}
 ];
 for(const choice of cases){
  a.context.fetch=async(_url,options)=>{assert.equal(JSON.parse(options.body).max_tokens,512);return {ok:true,status:200,text:async()=>JSON.stringify({choices:[choice],usage:{completion_tokens:512}})};};
  await a.click('ocrflow-model-1-test');
  const status=a.inputs.get('ocrflow-model-1-status');assert.match(status.textContent,/已连通/);assert.doesNotMatch(status.textContent,/测试成功|测试失败/);assert.equal(status.attributes['data-state'],'warning');
  assert.doesNotMatch(a.inputs.get('ocrflow-model-1-output').textContent,/Private reasoning text/);
 }
});
test('real API errors and genuinely empty replies keep meaningful diagnostic failures',async()=>{
 const a=fixture(legacyPrefs());
 const cases=[
  [{error:{code:429,message:'Rate limited'}},/429.*Rate limited/],
  [{code:20012,message:'Model unavailable for this account'},/20012.*Model unavailable/],
  [{choices:[{message:{content:null},finish_reason:'error',error:{message:'Provider down'}}]},/Provider down/],
  [{choices:[{message:{content:' '},finish_reason:'stop'}],usage:{completion_tokens:0}},/空正文.*stop.*0/],
  [{choices:[]},/Chat Completions/]
 ];
 for(const [body,expected]of cases){
  a.context.fetch=async()=>({ok:true,status:200,text:async()=>JSON.stringify(body)});await a.click('ocrflow-model-1-test');
  assert.match(a.inputs.get('ocrflow-model-1-status').textContent,/测试失败/);assert.match(a.inputs.get('ocrflow-model-1-output').textContent,expected);
 }
});
test('editing a model clears only its old test result and cancels its pending test; late replies stay hidden',async()=>{
 const a=fixture(legacyPrefs()),pending={};
 a.edit('mineru-llm-model-2','model-two');await a.click('ocrflow-model-2-test');
 a.context.fetch=(_url,options)=>new Promise(resolve=>pending[JSON.parse(options.body).model]={resolve,signal:options.signal});
 const old=a.click('ocrflow-model-1-test');a.edit('mineru-llm-model','new-model');a.inputs.get('mineru-llm-model').listeners.input();
 assert(pending['model-one'].signal.aborted);assert.equal(a.inputs.get('ocrflow-model-1-status').textContent,'');assert(a.inputs.get('ocrflow-model-1-output').hidden);
 assert.match(a.inputs.get('ocrflow-model-2-status').textContent,/测试成功/);
 const current=a.click('ocrflow-model-1-test');
 pending['new-model'].resolve({ok:true,status:200,text:async()=>JSON.stringify({choices:[{message:{content:'OK'}}]})});await current;
 pending['model-one'].resolve({ok:true,status:200,text:async()=>JSON.stringify({choices:[{message:{content:'Old reply'}}]})});await old;
 assert.match(a.inputs.get('ocrflow-model-1-status').textContent,/new-model 测试成功/);assert.doesNotMatch(a.inputs.get('ocrflow-model-1-output').textContent,/Old reply/);
});
test('provider switches and shared connection edits invalidate both test results',async()=>{
 const a=fixture(legacyPrefs());a.edit('mineru-llm-model-2','two');
 await a.click('ocrflow-model-1-test');await a.click('ocrflow-model-2-test');
 a.edit('mineru-llm-api-key','new-key');a.inputs.get('mineru-llm-api-key').listeners.input();
 for(const slot of [1,2]){assert.equal(a.inputs.get('ocrflow-model-'+slot+'-status').textContent,'');assert(a.inputs.get('ocrflow-model-'+slot+'-output').hidden);}
 let resolve,signal;a.context.fetch=(_url,options)=>new Promise(done=>{resolve=done;signal=options.signal;});const old=a.click('ocrflow-model-1-test');
 a.click('mineru-llm-provider-add');assert(signal.aborted);assert(!a.inputs.get('ocrflow-model-1-test').disabled);
 resolve({ok:true,status:200,text:async()=>JSON.stringify({choices:[{message:{content:'Wrong provider reply'}}]})});await old;
 assert.equal(a.inputs.get('ocrflow-model-1-status').textContent,'');assert(a.inputs.get('ocrflow-model-1-output').hidden);
});
test('context accepts direct K/M text, decimals and lowercase; invalid units cannot be saved',()=>{
 const a=fixture(legacyPrefs());
 for(const [input,tokens]of [['128K',131072],['1M',1048576],['1.5m',1572864],[' 64 k ',65536],['.5M',524288],['','']])assert.equal(a.panel.parseContextTokens(input),tokens);
 for(const input of ['32768','1G','0K','-1M','abc'])assert.throws(()=>a.panel.parseContextTokens(input),/128K/);
 a.edit('ocrflow-model-1-context','1.5M');assert.equal(a.click('ocrflow-ai-save'),true);assert.equal(a.plugin.getLLMSettings('parent').contextWindow,1572864);
 a.edit('ocrflow-model-1-context','1G');assert.equal(a.click('ocrflow-ai-save'),false);assert.equal(a.plugin.getLLMSettings('parent').contextWindow,1572864);
 a.edit('ocrflow-model-1-context','');assert.equal(a.click('ocrflow-ai-save'),true);assert.equal(a.plugin.getLLMSettings('parent').contextWindow,32768);
});
test('old token counts display as K/M and save back without changing their exact values',()=>{
 const prefs=legacyPrefs();prefs.set(prefix+'llmProviders',JSON.stringify([{id:'provider-0',llmProviderName:'First',llmApiBaseURL:'https://one.example/v1',llmModel:'one',llmModel2:'two',llmModelContext:1048576,llmModel2Context:1000000}]));
 const a=fixture(prefs);assert.equal(a.inputs.get('ocrflow-model-1-context').value,'1M');assert.equal(a.inputs.get('ocrflow-model-2-context').value,'976.5625K');
 assert.equal(a.click('ocrflow-ai-save'),true);
 const provider=JSON.parse(prefs.get(prefix+'llmProviders'))[0];assert.equal(provider.llmModelContext,1048576);assert.equal(provider.llmModel2Context,1000000);
 a.edit('ocrflow-work-ocr-model','provider-0:2');assert.equal(a.click('mineru-save-button'),true);assert.equal(a.plugin.getLLMSettings('ocr').contextWindow,1000000);
 assert(a.inputs.get('ocrflow-work-ocr-actual').textContent.includes('976.5625K'));
});


test('each model saves and reloads an independent output budget with tokens or K/M input',()=>{
 const a=fixture(legacyPrefs());
 for(const [input,tokens]of [['8K',8192],['1.5k',1536],['512',512],['1M',1048576],['','']])assert.equal(a.panel.parseOutputTokens(input),tokens);
 for(const input of ['0','-1','1.5','1G','wrong'])assert.throws(()=>a.panel.parseOutputTokens(input),/最大输出长度/);
 a.edit('ocrflow-model-1-context','64K');a.edit('ocrflow-model-1-max-output','16K');a.edit('mineru-llm-model-2','two');a.edit('ocrflow-model-2-max-output','8192');
 assert.equal(a.click('ocrflow-ai-save'),true);
 assert.equal(a.plugin.getLLMSettings('summary').outputTokens,16384);
 a.edit('ocrflow-work-ocr-model','provider-0:2');assert.equal(a.click('mineru-save-button'),true);
 assert.equal(a.plugin.getLLMSettings('ocr').outputTokens,8192);
 a.panel.loadSettings();assert.equal(a.inputs.get('ocrflow-model-1-max-output').value,'16K');assert.equal(a.inputs.get('ocrflow-model-2-max-output').value,'8K');
 assert.match(a.inputs.get('ocrflow-work-ocr-actual').textContent,/输出 8K/);
 a.edit('ocrflow-model-1-max-output','');assert.equal(a.click('ocrflow-ai-save'),true);
 assert.equal(a.plugin.getLLMSettings('summary').outputTokens,0);
 assert.equal(a.plugin.getLLMSettings('ocr').outputTokens,8192);
});

test('output budgets cannot consume the entire context and invalid saves leave the provider unchanged',()=>{
 const prefs=legacyPrefs(),a=fixture(prefs);
 a.edit('ocrflow-model-1-max-output','8K');assert.equal(a.click('ocrflow-ai-save'),true);
 const saved=prefs.get(prefix+'llmProviders');
 for(const output of ['32K','64K','0','1G']){
  a.edit('ocrflow-model-1-max-output',output);a.edit('mineru-llm-api-key','unsaved-key');
  assert.equal(a.click('ocrflow-ai-save'),false);assert.equal(prefs.get(prefix+'llmProviders'),saved);
 }
 assert.equal(a.plugin.getLLMSettings('summary').outputTokens,8192);
});
