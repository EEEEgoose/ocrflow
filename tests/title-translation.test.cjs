const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function setup(){
 const prefs=new Map([['extensions.docflow.llmApiBaseURL','https://test.invalid/v1'],['extensions.docflow.llmModel','fixture-model']]),items=new Map(),requests=[],saves=[],errors=[];
 const context={AbortController,setTimeout,clearTimeout,Zotero:{debug(){},logError:e=>errors.push(e),
  getMainWindow:()=>({AbortController}),Prefs:{get:key=>prefs.get(key)},Items:{get:id=>items.get(id)},
  ItemFields:{isValidForType:()=>true},DB:{executeTransaction:async run=>run()}}};
 vm.createContext(context);for(const file of ['prompts.js','docflow.js','workflow.js','title-translation.js'])vm.runInContext(fs.readFileSync(file,'utf8'),context);
 const m=context.DocFlow;m.refreshParseQueueDialog=()=>{};m.openParseQueueDialog=()=>{};let reply=async()=> '译名';
 m.requestDocumentAI=async(messages,settings,signal)=>{requests.push({messages,settings});return reply(messages,settings,signal)};
 const parent=(id,shortTitle='')=>{const fields={title:'Original title '+id,shortTitle};const p={id,itemTypeID:1,isRegularItem:()=>true,isAttachment:()=>false,
  getField:name=>fields[name]||'',setField:(name,value)=>fields[name]=value,loadAllData:async()=>{},save:async options=>saves.push({id,options}),fields};items.set(id,p);return p};
 const attachment=(id,pid)=>({id,parentItemID:pid,isRegularItem:()=>false,isAttachment:()=>true});
 const start=(selectedItems,options={service:'ai',targetLang:'FR',overwrite:false})=>m.handleTitleTranslation({selectedItems,options});
 return {m,context,prefs,items,requests,saves,errors,parent,attachment,start,reply:fn=>reply=fn,pref:(name,value)=>prefs.set('extensions.docflow.'+name,value)};
}
test('title actions deduplicate parent and attachments, need no Markdown, and never translate notes',async()=>{
 const s=setup(),p=s.parent(1),a=s.attachment(2,1),b=s.attachment(3,1),note={id:4,parentItemID:1,isNote:()=>true};
 assert.equal(s.m.collectTitleTasks([p,a,b,note]).length,1);assert.equal(s.m.collectTitleTasks([note]).length,0);
 assert.equal(s.m.collectTitleTasks([s.attachment(5,null)]).length,0);
 await s.start([p,a,b]);assert.equal(s.m.parseQueue.length,1);assert.equal(s.requests.length,1);assert.equal(p.fields.title,'Original title 1');assert.equal(p.fields.shortTitle,'译名');
 assert.equal(s.requests[0].messages[1].content,'Original title 1');assert(s.requests[0].messages[0].content.includes('FR'));assert.equal(s.saves[0].options.notifierData.skipRenameFile,true);
 assert.equal(s.m.parseQueue[0].state,'completed');assert(s.m.parseQueue[0].detail.includes('译名'));
});
test('existing short titles are skipped unless overwrite is explicitly selected; source is always title',async()=>{
 const s=setup(),p=s.parent(1,'Existing short');await s.start([p]);assert.equal(s.requests.length,0);assert.equal(p.fields.shortTitle,'Existing short');
 await s.start([p],{service:'ai',targetLang:'ZH',overwrite:true});assert.equal(s.requests[0].messages[1].content,'Original title 1');assert.equal(p.fields.shortTitle,'译名');
});
test('empty responses and HTTP errors preserve original data, record a reason and can retry',async()=>{
 const s=setup(),p=s.parent(1,'Keep');s.reply(async()=> '  ');await s.start([p],{service:'ai',targetLang:'AR',overwrite:true});
 const task=s.m.parseQueue[0];assert.equal(task.state,'failed');assert.match(task.error,/空值/);assert.equal(p.fields.shortTitle,'Keep');assert.equal(s.saves.length,0);
 s.reply(async()=>{throw Error('HTTP 429 quota')});await s.m.retryParseQueueTasks([task.id]);assert.match(task.error,/429/);assert.equal(p.fields.shortTitle,'Keep');
 s.reply(async()=> 'Arabic translated');await s.m.retryParseQueueTasks([task.id]);assert.equal(task.state,'completed');assert.equal(p.fields.shortTitle,'Arabic translated');assert.equal(task.settings.targetLang,'AR');assert.equal(task.settings.overwrite,true);
});
test('canceling a title request leaves shortTitle unchanged and independent tasks can complete',async()=>{
 const s=setup(),a=s.parent(1),b=s.parent(2);let began;const started=new Promise(r=>began=r);
 s.reply(async(messages,_settings,signal)=>{if(messages[1].content.endsWith('1')){began();await new Promise((_r,reject)=>signal.addEventListener('abort',()=>reject(signal.reason)));}return 'Second'});
 const running=s.start([a]);await started;await s.start([b],{service:'ai',targetLang:'ZH',modelID:'other:1'});for(let i=0;i<12;i++)await Promise.resolve();assert.equal(b.fields.shortTitle,'Second');await s.m.cancelParseQueueTask(s.m.parseQueue[0].id);await running;
 assert.equal(s.m.parseQueue[0].state,'canceled');assert.equal(a.fields.shortTitle,'');assert.equal(a.fields.title,'Original title 1');
});
test('edits to title or shortTitle during translation are protected and failed saves restore shortTitle',async()=>{
 const s=setup(),p=s.parent(1);s.reply(async()=>{p.fields.title='Changed title';return 'Old translation'});await s.start([p]);assert.match(s.m.parseQueue[0].error,/发生变化/);assert.equal(p.fields.shortTitle,'');
 s.reply(async()=>{p.fields.shortTitle='User edit';return 'Model response'});await s.start([p]);assert.equal(p.fields.shortTitle,'User edit');assert.equal(s.saves.length,0);
 p.save=async()=>{throw Error('disk full')};s.reply(async()=> 'Model response');await s.start([p],{service:'ai',targetLang:'ZH',overwrite:true});assert.equal(p.fields.shortTitle,'User edit');assert.match(s.m.parseQueue.at(-1).error,/disk full/);
});
test('title AI uses independently selected model and prompt; title language does not alter full translation language',()=>{
 const s=setup();s.pref('titleLanguage','FR');s.pref('translateLanguage','中文');s.pref('titleService','ai');
 s.pref('llmProviders',JSON.stringify([{id:'provider',llmProviderName:'Config',llmModel:'A',llmModel2:'B',llmApiBaseURL:'https://test/v1',llmModel2Concurrency:2}]));
 s.pref('aiWorkSettings',JSON.stringify({defaultModel:'provider:1',title:{model:'provider:2',prompt:'Custom {{language}}'}}));
 const defaults=s.m.getTitleTranslationSettings();assert.equal(defaults.aiSettings.model,'B');assert.equal(defaults.aiSettings.workPrompt,'Custom {{language}}');assert.equal(defaults.concurrency,2);
 const settings=s.m.getTitleTranslationSettings({modelID:'provider:1',targetLang:'JA'});assert.equal(settings.aiSettings.model,'A');assert.equal(settings.targetLang,'JA');assert.equal(s.m.getLLMSettings('translate').translateLanguage,'中文');assert.equal(s.m.getTitleTranslationSettings().targetLang,'FR');
});
test('DeepL and DeepLX tasks use their own queue lanes and retry the temporary service with refreshed credentials',async()=>{
 const s=setup(),p=s.parent(1);s.pref('titleService','deepl');s.pref('deeplApiKey','old');s.context.OCRFlowTitleServices={translate:async(_text,settings)=>{s.requests.push(settings);throw Error('quota')}};
 await s.start([p],{service:'deepl',targetLang:'DE'});const task=s.m.parseQueue[0];assert.equal(task.state,'failed');
 s.pref('titleService','deeplx');s.pref('deeplApiKey','new');s.context.OCRFlowTitleServices.translate=async(_text,settings)=>{s.requests.push(settings);return {text:'Translated'}};
 await s.m.retryParseQueueTasks([task.id]);assert.equal(s.requests[1].service,'deepl');assert.equal(s.requests[1].deeplApiKey,'new');assert.equal(task.settings.targetLang,'DE');assert.equal(p.fields.shortTitle,'Translated');
 assert.notEqual(s.m.parseQueueLane({kind:'title',settings:{service:'deepl',deeplPlan:'free'}}),s.m.parseQueueLane({kind:'title',settings:{service:'deeplx',deeplxEndpoint:'http://local/translate'}}));
});
test('missing titles and unsupported item fields do not issue translation requests',async()=>{
 const s=setup(),p=s.parent(1);p.fields.title='';await s.start([p]);assert.equal(s.requests.length,0);assert.match(s.m.parseQueue[0].detail,/标题为空/);
 p.fields.title='Original';s.context.Zotero.ItemFields.isValidForType=()=>false;await s.start([p]);assert.equal(s.requests.length,0);assert.match(s.m.parseQueue.at(-1).error,/不支持短标题/);
});

test('right-click command uses saved settings directly without opening a separate options window',async()=>{
 const s=setup(),p=s.parent(1);s.pref('titleLanguage','DE');s.pref('titleService','ai');
 const command=s.m.getContextMenuDefinitions().find(row=>row.id==='docflow-translate-title');
 await command.run({window:{openDialog(){throw Error('Must not open a dialog')}},selectedItems:[p]});
 assert.equal(s.m.parseQueue[0].settings.targetLang,'DE');assert.equal(s.m.parseQueue[0].state,'completed');assert.equal(p.fields.shortTitle,'译名');
});
