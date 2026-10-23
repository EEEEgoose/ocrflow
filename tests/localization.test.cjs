const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function setup(locale='en-US'){
 const context={Zotero:{locale}};vm.createContext(context);
 for(const file of ['locale/en-US/ui.js','localization.js'])vm.runInContext(fs.readFileSync(file,'utf8'),context);
 return {context,l10n:context.OCRFlowL10n,t:context.ocrflowText};
}
test('UI language follows Zotero while Chinese locales retain their source strings',()=>{
 const {context,l10n,t}=setup();assert.equal(l10n.language,'en-US');assert.equal(t('流程配置'),'Workflows');
 for(const locale of ['zh-CN','zh-TW','zh-HK']){context.Zotero.locale=locale;assert.equal(t('流程配置'),'流程配置');}
 context.Zotero.locale='fr-FR';assert.equal(t('流程配置'),'Workflows');
});
test('dynamic messages preserve substituted document text, punctuation, model names and literal dollar signs',()=>{
 const {t}=setup();assert.equal(t('已写入短标题（ZH）：翻译标题 $& ${model}'),'Short Title updated (ZH): 翻译标题 $& ${model}');
 assert.equal(t('任务 ID: job-123'),'Task ID: job-123');assert.equal(t('已识别 12/30 页'),'Recognized 12/30 pages');
 assert.equal(t('实际使用：中文配置 + 模型甲 · 并发 2 · 上下文 128K · 输出 16K'),'Using: 中文配置 + 模型甲 · Concurrency 2 · Context 128K · Output 16K');
 assert.equal(t('Unknown server message: 你好'),'Unknown server message: 你好');
});
test('static localization translates labels and accessibility text but preserves form values and document fields',()=>{
 const {l10n}=setup();
 const element=(name,attrs={},protectedText=false)=>({localName:name,attrs,hasAttribute(k){return Object.hasOwn(this.attrs,k)},getAttribute(k){return this.attrs[k]},setAttribute(k,v){this.attrs[k]=v},closest(){return protectedText?this:null}});
 const label=element('label'),prompt=element('textarea',{},true),pre=element('pre',{},true),input=element('input',{placeholder:'请填写服务地址'}),option=element('option'),button=element('button');
 input.value='中文服务名';option.value='中文';prompt.value='请用中文总结';
 const texts=[{parentElement:label,nodeValue:'  识别服务  '},{parentElement:prompt,nodeValue:'翻译标题'},{parentElement:pre,nodeValue:'识别文档'},{parentElement:option,nodeValue:'中文'}];
 const root={nodeType:1,hasAttribute:()=>false,querySelectorAll:()=>[label,prompt,pre,input,option,button],ownerDocument:{documentElement:element('html'),createTreeWalker(){let i=-1;return {nextNode(){return ++i<texts.length},get currentNode(){return texts[i]}}}}};
 l10n.localize(root);assert.equal(texts[0].nodeValue,'  Recognition  ');assert.equal(texts[1].nodeValue,'翻译标题');assert.equal(texts[2].nodeValue,'识别文档');
 assert.equal(texts[3].nodeValue,'Chinese');assert.equal(option.value,'中文');assert.equal(input.value,'中文服务名');assert.equal(prompt.value,'请用中文总结');assert.equal(input.attrs.placeholder,'Enter the service URL');assert.equal(button.attrs['data-saved-label'],' ✓ Saved');
});
test('English catalog covers every static settings, queue and proofreading label without changing placeholders',()=>{
 const {context}=setup(),catalog=context.OCRFlowEnglish;
 for(const [key,value]of Object.entries(catalog)){
  assert(!/[\u3400-\u9fff]/.test(value),key);
  const fields=s=>Array.from(s.matchAll(/\{(\d+)\}/g),m=>m[1]).sort();assert.deepEqual(fields(value),fields(key),key);
 }
 const decode=s=>s.replaceAll('&quot;','"').replaceAll('&amp;','&').replaceAll('&lt;','<').replaceAll('&gt;','>');
 for(const name of ['preferences.xhtml','task-queue.xhtml','collation.xhtml']){
  const source=fs.readFileSync(name,'utf8').replace(/<(?:html:)?style\b[^>]*>[\s\S]*?<\/(?:html:)?style>/g,'');
  const strings=[...Array.from(source.matchAll(/>([^<>]*[\u3400-\u9fff][^<>]*)</g),m=>decode(m[1].trim())),...Array.from(source.matchAll(/(?:aria-label|label|title|placeholder)="([^"]*[\u3400-\u9fff][^"]*)"/g),m=>decode(m[1]))];
  for(const text of strings)assert(Object.hasOwn(catalog,text),name+': '+text);
 }
});
test('native menu registration uses English fallback labels, and recognition choices preserve custom AI names',()=>{
 const {context}=setup(),registered=[];context.Zotero.MenuManager={registerMenu:menu=>registered.push(menu)};
 for(const file of ['prompts.js','docflow.js','workflow.js','ocr-sources.js'])vm.runInContext(fs.readFileSync(file,'utf8'),context);
 context.DocFlow.registerMenuForZotero8();const menus=registered[0].menus[0].menus.filter(row=>row.menuType!=='separator');
 assert.equal(menus[0].label,'Organize document');assert(menus.some(row=>row.label==='Translate title'));assert(menus.some(row=>row.label==='Create item'));
 const sources=context.OCRFlowSources.choices([{id:'custom',llmProviderName:'翻译标题',llmModel:'识别文档'}]);
 assert.equal(sources[0].label,'Marker (Datalab hosted API)');assert.equal(sources.at(-1).label,'翻译标题 · 识别文档');
});
