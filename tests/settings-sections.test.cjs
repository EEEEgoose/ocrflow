const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const prefix='extensions.docflow.';

class Element {
  constructor() {this.value='';this.checked=false;this.disabled=false;this.hidden=false;this.textContent='';this.attributes={};this.listeners={};this.localName='input';}
  setAttribute(name,value) {this.attributes[name]=value;}
  addEventListener(name,callback) {this.listeners[name]=callback;}
  querySelectorAll() {return [];}
  click() {return this.listeners.click();}
}

function setup() {
  const prefs=new Map(), requests=[];
  const source=fs.readFileSync('preferences.xhtml','utf8');
  const elements=new Map(Array.from(source.matchAll(/\bid="([^"]+)"/g),match=>[match[1],new Element()]));
  const context={AbortController,setTimeout,clearTimeout,URL,Date,
    pref:(key,value)=>{if(!prefs.has(key))prefs.set(key,value);},
    Zotero:{Prefs:{get:key=>prefs.get(key),set:(key,value)=>prefs.set(key,value)},logError:error=>{throw error;}},
    fetch:async(url,options={})=>{
      requests.push({url,options});
      const reply=url.endsWith('/openapi.json') ? {info:{title:'Marker API'},paths:{'/v1/parse/jobs':{post:{}}}} : url.endsWith('/chat/completions') ? {choices:[{message:{content:'OK'}}]} : url.endsWith('/file-urls/batch') ? {code:0,data:{batch_id:'test',file_urls:[]}} : {status:'ok'};
      return {ok:true,status:200,json:async()=>reply,text:async()=>JSON.stringify(reply)};
    }
  };
  vm.createContext(context);
  for(const file of ['prompts.js','prefs.js','docflow.js','markitdown.js','marker.js','preferences.js']) vm.runInContext(fs.readFileSync(file,'utf8'),context);
  for(const [key,value]of Object.entries({apiMode:'local-v1',apiBaseURL:'http://mineru.saved',modelVersion:'standard',markitdownBaseURL:'http://mark.saved',llmApiBaseURL:'https://ai.saved/v1',llmModel:'saved-model'})) prefs.set(prefix+key,value);
  const panel=context.DocFlowPreferences;
  require("./preferences-dom.cjs")(context, panel, elements);
  panel.$=id=>elements.get(id);panel.init();assert(panel.initialized);
  const value=(id,text)=>{elements.get(id).value=text;};
  return {prefs,elements,requests,panel,plugin:context.DocFlow,source,value,prompts:context.OCRFlowPrompts};
}

test('settings buttons show busy state, restore labels and acknowledge saved or invalid settings',()=>{
 const s=setup(),button=s.elements.get('ocrflow-marker-test');button.textContent='测试连接';let animations=0;button.animate=()=>animations++;
 s.panel.setButtonBusy(button,true);assert.equal(button.textContent,'测试中…');assert.equal(button.disabled,true);assert.equal(button.attributes['aria-busy'],'true');
 s.panel.setButtonBusy(button,false);assert.equal(button.textContent,'测试连接');assert.equal(button.disabled,false);
 s.panel.buttonFeedback(button,'success');assert.equal(button.attributes['data-result'],'success');assert.equal(animations,1);
 assert.equal(s.panel.saveSettings({section:'marker'}),true);assert.equal(s.elements.get('ocrflow-marker-save').attributes['data-result'],'saved');
 s.value('mineru-poll-interval-sec','invalid');assert.equal(s.panel.saveSettings(),false);assert.equal(s.elements.get('mineru-save-button').attributes['data-result'],'error');
});

test('settings keep service tests, independent model tests, one footer save and optional output checkboxes',()=>{
  const s=setup();
  const ids=Array.from(s.source.matchAll(/\bid="([^"]+)"/g),match=>match[1]);
  assert.equal(new Set(ids).size,ids.length,'each settings control must have a unique ID');
  for(const section of ['markitdown','mineru']) {
    assert(s.elements.has('ocrflow-'+section+'-save'));assert(s.elements.has('ocrflow-'+section+'-test'));
  }
  assert(s.elements.has('ocrflow-ai-save'));assert(!s.elements.has('ocrflow-ai-test'));
  for(const slot of [1,2])assert(s.elements.has('ocrflow-model-'+slot+'-test'));
  assert(!s.elements.has('mineru-test-button'));assert(!s.elements.has('mineru-test-llm-button'));
  const footer=s.source.slice(s.source.indexOf('<html:footer'),s.source.indexOf('</html:footer>'));
  assert.equal((footer.match(/<html:button/g)||[]).length,1);
  for(const id of ['mineru-parseGenerateHTML','mineru-parseLinkSourcePDF']) {
    const tag=s.source.match(new RegExp('<html:input[^>]*id="'+id+'"[^>]*>'))[0];
    assert(!tag.includes('disabled='));assert.equal(s.elements.get(id).checked,true);
  }
  assert(s.panel.API_FIELDS.every(name=>typeof name==='string'));
  assert(s.panel.LLM_PROVIDER_FIELDS.every(name=>typeof name==='string'));
});

test('local save writes only its service, even when another section has invalid drafts',()=>{
  const s=setup();
  s.value('docflow-markitdown-url','http://mark.draft');s.value('mineru-api-base-url','http://mineru.draft');
  s.value('mineru-summary-request-json','{invalid');
  assert.equal(s.elements.get('ocrflow-markitdown-save').click(),true);
  assert.equal(s.prefs.get(prefix+'markitdownBaseURL'),'http://mark.draft');
  assert.equal(s.prefs.get(prefix+'apiBaseURL'),'http://mineru.saved');
  assert.equal(s.prefs.get(prefix+'local.apiBaseURL'),undefined);
  assert.equal(s.prefs.get(prefix+'summaryRequestJSON'),'');
  s.value('mineru-summary-request-json','');s.value('mineru-llm-model','new-ai-model');
  assert.equal(s.elements.get('ocrflow-ai-save').click(),true);
  assert.equal(s.prefs.get(prefix+'llmModel'),'new-ai-model');
  assert.equal(s.prefs.get(prefix+'local.apiBaseURL'),undefined);
  assert.equal(s.elements.get('ocrflow-mineru-save').click(),true);
  assert.equal(s.prefs.get(prefix+'local.apiBaseURL'),'http://mineru.draft');
});

test('editing and testing use visible drafts but never save them or route to the selected parser instead',async()=>{
  const s=setup();
  s.value('docflow-parser-service','ai');
  s.value('docflow-markitdown-url','http://mark.unsaved/');
  s.elements.get('docflow-markitdown-url').listeners.input();
  assert.equal(s.prefs.get(prefix+'markitdownBaseURL'),'http://mark.saved');
  s.value('mineru-api-base-url','http://mineru.unsaved');
  s.value('mineru-llm-api-base-url','https://ai.unsaved/v1');s.value('mineru-llm-model','unsaved-model');
  const before=JSON.stringify([...s.prefs]);
  await s.elements.get('ocrflow-markitdown-test').click();
  await s.elements.get('ocrflow-mineru-test').click();
  await s.elements.get('ocrflow-model-1-test').click();
  assert.equal(s.requests[0].url,'http://mark.unsaved/health');
  assert.equal(s.requests[1].url,'http://mineru.unsaved/v1/health');
  assert.equal(s.requests[2].url,'https://ai.unsaved/v1/chat/completions');
  assert.equal(JSON.parse(s.requests[2].options.body).model,'unsaved-model');
  assert.equal(JSON.stringify([...s.prefs]),before);
  for(const section of ['markitdown','mineru','model-1']) {
    assert.equal(s.elements.get('ocrflow-'+section+'-test').disabled,false);
    assert.match(s.elements.get('ocrflow-'+section+'-status').textContent,/成功/);
  }
});

test('switching MinerU mode and AI providers preserves unrelated unsaved edits',()=>{
  const s=setup();s.value('docflow-markitdown-url','http://do-not-save');s.value('mineru-llm-model','ai-draft');
  s.value('mineru-api-mode','cloud');s.panel.switchAPIMode();
  assert.equal(s.elements.get('docflow-markitdown-url').value,'http://do-not-save');
  assert.equal(s.elements.get('mineru-llm-model').value,'ai-draft');
  assert.equal(s.prefs.get(prefix+'markitdownBaseURL'),'http://mark.saved');
  s.value('mineru-api-base-url','https://cloud.unsaved');s.panel.addLLMProvider();
  assert.equal(s.elements.get('mineru-api-base-url').value,'https://cloud.unsaved');
  assert.notEqual(s.prefs.get(prefix+'cloud.apiBaseURL'),'https://cloud.unsaved');
  assert.equal(s.prefs.get(prefix+'markitdownBaseURL'),'http://mark.saved');
});

test('footer save persists optional output behavior and invalid fields do not partially save',()=>{
  const s=setup();
  s.elements.get('mineru-parseGenerateHTML').checked=false;s.elements.get('mineru-parseLinkSourcePDF').checked=false;
  s.elements.get('mineru-parseGenerateHTML').listeners.change();
  assert.equal(s.elements.get('mineru-parseImageMode').disabled,true);
  assert.equal(s.elements.get('mineru-save-button').click(),true);
  assert.equal(s.plugin.getSettings().outputFormat,'md');assert.equal(s.plugin.getSettings().parseLinkSourcePDF,false);
  s.value('docflow-markitdown-url','http://must-not-be-saved');s.value('mineru-timeout-sec','');
  const before=JSON.stringify([...s.prefs]);
  assert.equal(s.elements.get('mineru-save-button').click(),false);
  assert.equal(JSON.stringify([...s.prefs]),before);
});

test('cloud language saves within MinerU settings and remains selected but disabled in local mode',async()=>{
  const s=setup();
  assert.equal(s.elements.get('mineru-cloud-language').value,'auto');
  assert.equal(s.elements.get('mineru-cloud-language').disabled,true);
  s.value('mineru-api-mode','cloud');s.panel.switchAPIMode();
  assert.equal(s.elements.get('mineru-cloud-language').disabled,false);
  s.value('mineru-cloud-language','arabic');s.value('mineru-api-token','test-cloud-token');
  assert.equal(s.elements.get('ocrflow-mineru-save').click(),true);
  assert.equal(s.prefs.get(prefix+'cloudLanguage'),'arabic');
  assert.equal(s.plugin.getSettings().cloudLanguage,'arabic');
  await s.elements.get('ocrflow-mineru-test').click();
  assert.equal(JSON.parse(s.requests.at(-1).options.body).language,'arabic');
  s.value('mineru-api-mode','local-v1');s.panel.switchAPIMode();
  assert.equal(s.elements.get('mineru-cloud-language').disabled,true);
  assert.equal(s.elements.get('mineru-cloud-language').value,'arabic');
  s.value('mineru-api-mode','cloud');s.panel.switchAPIMode();
  assert.equal(s.elements.get('mineru-cloud-language').value,'arabic');
});


test('work options live with their models, and obsolete note controls are removed',()=>{
  const s=setup();
  const groups={summary:['mineru-summary-language'],translate:['mineru-translateOutputFormat','mineru-translateMode','mineru-translate-language','mineru-translate-chunk-size','mineru-translate-retry-count'],outline:['mineru-auto-outline','mineru-outline-use-ai']};
  for(const [kind,ids]of Object.entries(groups)){
    const start=s.source.indexOf(`id="ocrflow-work-${kind}"`);
    const next=s.source.indexOf('<html:div class="ocrflow-work"',start);
    const block=s.source.slice(start,next<0?s.source.indexOf('aria-labelledby="ocrflow-output-heading"'):next);
    for(const id of ids) assert(block.includes(`id="${id}"`),id);
  }
  for(const id of ['mineru-note-title-prefix','mineru-note-include-images']) assert(!s.elements.has(id));
  assert(!s.source.includes('总结、翻译与阅读器大纲'));
  assert.equal(typeof s.plugin.handleMarkdownToNoteCommand,'undefined');
  assert.equal(typeof s.plugin.saveResultAsNote,'undefined');
});

test('settings show shared built-in prompts, preserve edits, and restore defaults without pinning them',()=>{
  const s=setup();
  for(const kind of s.panel.WORK_KINDS){
    assert.equal(s.elements.get(s.panel.workFieldID(kind,'prompt')).value,s.prompts.defaults[kind]);
    assert.equal(s.elements.get('ocrflow-work-'+kind+'-default').value,s.prompts.defaults[kind]);
  }
  assert(s.elements.get('ocrflow-work-metadata-format').value.includes('shortTitle'));
  s.value('mineru-summary-prompt','Custom {{language}}');
  assert(s.elements.get('ocrflow-work-save').click());
  assert.equal(s.plugin.getLLMSettings('summary').workPrompt,'Custom {{language}}');
  s.panel.loadSettings();
  assert.equal(s.elements.get('mineru-summary-prompt').value,'Custom {{language}}');
  s.elements.get('ocrflow-work-summary-reset').click();
  assert.equal(s.elements.get('mineru-summary-prompt').value,s.prompts.defaults.summary);
  assert.equal(s.plugin.getLLMSettings('summary').workPrompt,'Custom {{language}}','reset must wait for save');
  assert(s.elements.get('ocrflow-work-save').click());
  assert.equal(s.plugin.getLLMSettings('summary').workPrompt,'');
  assert.equal(s.prefs.get(prefix+'summaryPrompt'),'');
  s.prompts.defaults.summary+=' New built-in version.';
  s.panel.loadSettings();
  assert.equal(s.elements.get('mineru-summary-prompt').value,s.prompts.defaults.summary);
  s.value('ocrflow-work-ocr-prompt','Custom OCR');
  assert(s.elements.get('ocrflow-work-save').click());
  s.value('ocrflow-work-ocr-prompt','');
  assert(s.elements.get('ocrflow-work-save').click());
  s.panel.loadSettings();
  assert.equal(s.elements.get('ocrflow-work-ocr-prompt').value,s.prompts.defaults.ocr);
});

test('saving work options preserves service credentials and updates the outline assignment',()=>{
  const s=setup();
  s.value('mineru-summary-language','English');s.value('mineru-translate-language','Français');
  s.value('mineru-translateOutputFormat','html');s.value('mineru-translateMode','bilingual');
  s.value('mineru-translate-chunk-size','10000');s.value('mineru-translate-retry-count','3');
  s.elements.get('mineru-auto-outline').checked=true;s.elements.get('mineru-outline-use-ai').checked=false;
  s.value('ocrflow-work-outline-model','provider-0:1');s.value('ocrflow-work-outline-prompt','Custom outline');
  s.value('mineru-llm-api-key','UNSAVED_KEY');
  assert(s.elements.get('ocrflow-work-save').click());
  const outline=s.plugin.getLLMSettings('outline');
  assert.equal(outline.workPrompt,'Custom outline');assert.equal(outline.model,'saved-model');
  assert.equal(s.prefs.get(prefix+'summaryLanguage'),'English');assert.equal(s.prefs.get(prefix+'translateLanguage'),'Français');
  assert.equal(s.prefs.get(prefix+'translateMode'),'bilingual');assert.equal(s.prefs.get(prefix+'translateChunkSize'),10000);
  assert.equal(s.prefs.get(prefix+'autoOutline'),true);assert.equal(s.prefs.get(prefix+'outlineUseAI'),false);
  assert.notEqual(s.prefs.get(prefix+'llmApiKey'),'UNSAVED_KEY');
  s.panel.loadSettings();assert.equal(s.elements.get('mineru-translate-language').value,'Français');
});


test('settings navigation keeps unsaved values and shows one module at a time',()=>{
  const s=setup();
  s.value('mineru-llm-api-key','unsaved-key');
  const before=JSON.stringify([...s.prefs]);
  s.elements.get('ocrflow-tab-ai').click();
  assert.equal(s.elements.get('ocrflow-panel-ai').hidden,false);
  assert.equal(s.elements.get('ocrflow-panel-services').hidden,true);
  s.elements.get('ocrflow-tab-work').click();
  s.elements.get('ocrflow-work-tab-translate').click();
  assert.equal(s.elements.get('ocrflow-work-translate').hidden,false);
  assert.equal(s.elements.get('ocrflow-work-summary').hidden,true);
  s.elements.get('ocrflow-tab-ai').click();
  assert.equal(s.elements.get('mineru-llm-api-key').value,'unsaved-key');
  assert.equal(JSON.stringify([...s.prefs]),before);
  for(const key of ['services','ai','work','collation','output','tasks']) assert(s.elements.has('ocrflow-tab-'+key));
  assert(s.source.includes('id="queue-body"'));
  assert(!s.elements.has('mineru-open-queue-button'));
});

test('one PaddleOCR entry resolves the chosen API and preserves both profiles',()=>{
  const s=setup();
  const picker=s.source.slice(s.source.indexOf('id="docflow-parser-service"'),s.source.indexOf('</menulist>',s.source.indexOf('id="docflow-parser-service"')));
  assert.equal((picker.match(/label="PaddleOCR"/g)||[]).length,1);
  assert(!picker.includes('paddle-local'));assert(!picker.includes('paddle-cloud'));
  s.prefs.set(prefix+'parserService','paddle-local');s.panel.loadSettings();
  assert.equal(s.elements.get('docflow-parser-service').value,'paddle');
  assert.equal(s.elements.get('ocrflow-paddle-mode').value,'local');
  s.value('ocrflow-paddle-cloud-url','https://cloud.example/ocr');s.value('ocrflow-paddle-local-url','http://local.example');
  assert(s.panel.saveSettings());assert.equal(s.plugin.getSettings().parserService,'paddle-local');
  s.value('ocrflow-paddle-mode','cloud');s.panel.syncPaddleMode();assert(s.panel.saveSettings());
  assert.equal(s.plugin.getSettings().parserService,'paddle-cloud');
  assert.equal(s.prefs.get(prefix+'paddle.local.url'),'http://local.example');
  assert.equal(s.elements.get('ocrflow-paddle-local-fields').hidden,true);
  s.value('ocrflow-paddle-mode','local');s.panel.syncPaddleMode();
  assert.equal(s.elements.get('ocrflow-paddle-cloud-url').value,'https://cloud.example/ocr');
});

test('network timeout defaults to 1200 seconds and retains explicit saved values',()=>{
  const s=setup();
  assert.equal(s.plugin.getSettings().timeoutMS,1200000);
  assert.equal(s.panel.readCurrentSettings(true).timeoutMS,1200000);
  s.prefs.set(prefix+'local.timeoutSec',90);s.panel.loadSettings();
  assert.equal(s.plugin.getSettings().timeoutMS,90000);
  assert.equal(s.elements.get('mineru-timeout-sec').value,'90');
});

test('AI collation requires an independently selected model and restores it after reload',()=>{
 const s=setup();s.elements.get('ocrflow-collation-enabled').checked=true;s.elements.get('ocrflow-collation-ai-enabled').checked=true;
 assert.equal(s.panel.saveSettings({section:'work'}),false);assert.match(s.elements.get('ocrflow-work-status').textContent,/AI 校勘模型/);
 s.value('mineru-llm-model-2','proof-model');assert(s.panel.saveSettings({section:'ai'}));
 s.value('ocrflow-collation-ai-model','provider-0:2');assert(s.panel.saveSettings({section:'work'}));
 assert.equal(s.prefs.get(prefix+'collationAIModel'),'provider-0:2');assert(s.panel.isModelInUse('provider-0:2'));
 s.panel.loadSettings();assert.equal(s.elements.get('ocrflow-collation-ai-model').value,'provider-0:2');assert(s.elements.get('ocrflow-collation-ai-enabled').checked);
});


test('Marker settings save independently and test the upload API without uploading files',async()=>{
 const s=setup();s.value('ocrflow-marker-url','http://marker.saved/');s.value('ocrflow-marker-token','');s.value('ocrflow-marker-mode','fast');s.elements.get('ocrflow-marker-force-ocr').checked=true;
 s.value('docflow-markitdown-url','http://unsaved.other');assert(s.panel.saveSettings({section:'marker'}));
 assert.equal(s.prefs.get(prefix+'marker.url'),'http://marker.saved/');assert.equal(s.prefs.get(prefix+'marker.mode'),'fast');assert.equal(s.prefs.get(prefix+'marker.forceOCR'),true);assert.equal(s.prefs.get(prefix+'markitdownBaseURL'),'http://mark.saved');
 await s.panel.testMarkerConnection();assert.equal(s.requests.at(-1).url,'http://marker.saved/openapi.json');assert.equal(s.requests.at(-1).options.body,undefined);assert(s.elements.get('ocrflow-marker-status').textContent.includes('成功'));
 s.panel.showService('marker');assert.equal(s.elements.get('ocrflow-service-panel-marker').hidden,false);assert.equal(s.elements.get('ocrflow-service-panel-paddle').hidden,true);
});
