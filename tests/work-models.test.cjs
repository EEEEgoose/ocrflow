const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'), vm=require('node:vm');
function setup() {
 const prefs=new Map(), requests=[],win={AbortController};
 let reply=async payload=>payload.response_format?'{"title":"原文标题"}':'AI result';
 const ctx={URL,setTimeout,clearTimeout,Uint8Array,TextEncoder,TextDecoder,btoa,
  pref:(key,value)=>{if(!prefs.has(key))prefs.set(key,value);},
  Zotero:{Prefs:{get:key=>prefs.get(key),set:(key,value)=>prefs.set(key,value)},getMainWindow:()=>win,debug(){},logError(){}},
  IOUtils:{read:async()=>new Uint8Array([1,2,3])},
  fetch:async(url,options)=>{const payload=JSON.parse(options.body);requests.push({url,payload,signal:options.signal});return {ok:true,json:async()=>({choices:[{message:{content:await reply(payload)},finish_reason:'stop'}]})};}
 };
 vm.createContext(ctx);for(const file of ['prompts.js','prefs.js','docflow.js','metadata.js','workflow.js'])vm.runInContext(fs.readFileSync(file,'utf8'),ctx);
 const plugin=ctx.DocFlow;
 const put=(name,value)=>prefs.set('extensions.docflow.'+name,value);
 put('llmProviders',JSON.stringify([{id:'text',llmProviderName:'文本',llmApiBaseURL:'https://text.example/v1',llmApiKey:'text-key',llmModel:'text-1',llmModel2:'text-2',llmModelConcurrency:'2',llmModelContext:'65536',llmModel2Concurrency:'2'},{id:'vision',llmProviderName:'视觉',llmApiBaseURL:'https://vision.example/v1',llmModel:'vision-1',llmModel2:'vision-2',llmModel2Concurrency:'2'}]));
 const work={defaultModel:'text:1',parent:{model:'text:2',prompt:'只识别文件名',params:'{"temperature":0.1}'},metadata:{model:'text:1',prompt:'提取题名',params:'{"temperature":0.2}'},summary:{model:'text:2',prompt:'Custom summary {{language}}',params:'{"temperature":0.4}'},ocr:{model:'vision:2',prompt:'Custom OCR',params:'{"temperature":0.5}'},translate:{model:'text:1',prompt:'Custom translation {{language}}',params:'{"temperature":0.6}'}};
 const save=()=>put('aiWorkSettings',JSON.stringify(work));save();
 return {plugin,requests,prefs,put,work,save,ctx,setReply:fn=>reply=fn};
}
test('all five real request paths use their assigned model, endpoint, prompt and parameters',async()=>{
 const a=setup(),p=a.plugin;
 await p.identify('','book.pdf',true,{},p.getLLMSettings('parent'));
 await p.identify('文档','book.pdf',false,{},p.getLLMSettings('metadata'));
 await p.summarizeDocument('Document',p.getLLMSettings('summary'));
 await p.parseWithVision({isPDFAttachment:()=>false,getFilePath:()=>'/image.png',attachmentFilename:'image.png'},p.getLLMSettings('ocr'),{});
 const translation=p.getTranslationSettings();await p.callLLMForTranslation('Document','English',translation,1,1);
 assert.deepEqual(a.requests.map(r=>r.payload.model),['text-2','text-1','text-2','vision-2','text-1']);
 assert.deepEqual(a.requests.map(r=>r.payload.temperature),[0.1,0.2,0.4,0.5,0.6]);
 assert.match(a.requests[3].url,/vision\.example/);assert.match(a.requests[0].url,/text\.example/);
 for(const [index,phrase]of ['只识别文件名','提取题名','Custom summary 中文','Custom OCR','Custom translation English'].entries())assert(a.requests[index].payload.messages[0].content.includes(phrase));
 assert(a.requests.every(r=>r.payload.max_tokens>0&&!('context_window'in r.payload)));
 assert(a.requests[1].payload.messages[0].content.includes('shortTitle'));
});
test('context budgets split multilingual text without losing content and stop oversized requests',async()=>{
 const a=setup(),p=a.plugin;const settings=p.getLLMSettings('summary');settings.contextWindow=16384;
 const text='عربي中文😀abc\n\n'.repeat(1800);const chunks=p.splitAIText(text,settings);
 assert(chunks.length>1);assert.equal(chunks.join(''),text);
 assert(chunks.every(chunk=>p.estimateAITokens(chunk)<=p.getAIChunkBudget(settings)));
 const before=a.requests.length;
 await assert.rejects(p.requestDocumentAI([{role:'system',content:'x'.repeat(20000)}],settings),/上下文窗口/);
 assert.equal(a.requests.length,before);
 settings.summaryRequestJSON='{"max_completion_tokens":1024}';
 await p.requestDocumentAI([{role:'user',content:'hello'}],settings);
 assert.equal(a.requests.at(-1).payload.max_completion_tokens,1024);assert(!('max_tokens' in a.requests.at(-1).payload));
});
test('summary concurrency is bounded and paragraph summaries remain in document order',async()=>{
 const a=setup(),p=a.plugin;let active=0,peak=0;
 a.setReply(async payload=>{active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,5));active--;return payload.messages[1].content.slice(0,30);});
 const settings=p.getLLMSettings('summary');settings.contextWindow=16384;
 await p.summarizeDocument('A'.repeat(10000)+'B'.repeat(10000),settings);
 assert.equal(peak,2);assert(a.requests.at(-1).payload.messages[1].content.indexOf('AAAA')<a.requests.at(-1).payload.messages[1].content.indexOf('BBBB'));
});
test('page concurrency preserves OCR output order even when the first page finishes last',async()=>{
 const a=setup(),p=a.plugin;let active=0,peak=0;
 const view={Object,document:{createElement:()=>({getContext:()=>({}),toDataURL:()=> 'data:image/jpeg;base64,AQID'})}};
 const pdfDocument={numPages:3,getPage:async()=>({getViewport:()=>({width:100,height:100}),render:()=>({promise:Promise.resolve()})})};
 a.ctx.Zotero.Reader={_readers:[{itemID:12,_internalReader:{_primaryView:{_iframeWindow:view}}}]};p.outline={getReaderApp:()=>({pdfDocument})};
 a.setReply(async payload=>{let page=Number(payload.messages[1].content[0].text.match(/\d+/)[0]);active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,page===1?20:2));active--;return 'Page '+page;});
 const result=await p.parseWithVision({id:12,isPDFAttachment:()=>true},p.getLLMSettings('ocr'),{});
 assert.equal(peak,2);assert.deepEqual(Array.from(result.outlinePages),['Page 1','Page 2','Page 3']);
});
test('parent queue concurrency is honored, snapshots stay stable and retry refreshes assigned models',async()=>{
 const a=setup(),p=a.plugin;let active=0,peak=0;
 p.refreshParseQueueDialog=()=>{};p.openParseQueueDialog=()=>{};
 p.runDocumentTask=async()=>{active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,5));active--;};
 const settings=p.getLLMSettings('parent');
 const tasks=Array.from({length:3},(_,i)=>({attachment:{id:i+1,getField:()=> 'file'}}));
 await p.enqueueDocumentTasks('parent',tasks,settings);assert.equal(peak,2);assert(p.parseQueue.every(task=>task.state==='completed'));
 a.work.parent.model='vision:1';a.save();assert.equal(p.parseQueue[0].settings.model,'text-2');
 p.parseQueue[0].state='failed';await p.retryParseQueueTasks([p.parseQueue[0].id]);assert.equal(p.parseQueue[0].settings.model,'vision-1');
});
test('parallel metadata merges publication pages before later chapters',async()=>{
 const a=setup(),p=a.plugin;let active=0,peak=0,captured;
 const parent={itemTypeID:1,loadAllData:async()=>{},getField:()=>'',getCreatorsJSON:()=>[],save:async()=>{}};
 const attachment={id:100,getField:()=> 'file.pdf',attachmentFilename:'file.pdf'};
 a.ctx.Zotero.Items={get:()=>attachment};a.ctx.Zotero.ItemFields={isValidForType:()=>true};a.ctx.Zotero.DB={executeTransaction:async fn=>fn()};
 p.parentForDocument=()=>parent;p.findDocumentMarkdown=()=>({id:200});p.readSourceMarkdown=async()=>({markdown:'A'.repeat(40000)+'B'.repeat(40000)+'C'.repeat(1000)});p.refreshParseQueueDialog=()=>{};
 p.applyMetadata=(_parent,data)=>captured=data;
 p.identify=async chunk=>{active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,chunk[0]==='A'?20:2));active--;return chunk[0]==='A'?{title:'Publication title',shortTitle:'出版页译名'}:{title:'Wrong later citation',shortTitle:'错误引文译名',publisher:'Publisher'};};
 const settings=p.getLLMSettings('metadata');settings.concurrency=2;
 await p.runDocumentTask({kind:'metadata',attachment,settings,controller:new AbortController()});
 assert.equal(peak,2);assert.equal(captured.title,'Publication title');assert.equal(captured.shortTitle,'出版页译名');assert.equal(captured.publisher,'Publisher');
});
test('translation rebuilds its chunk cache when the token budget changes',async()=>{
 const a=setup(),p=a.plugin;let reads=0,saved;
 p.readSourceMarkdown=async()=>{reads++;return {filePath:'/source.md',markdown:'Text'}};
 p.inlineStoredImagesInMarkdownAttachment=async({markdownText})=>({markdownText,embeddedImages:[]});p.refreshParseQueueDialog=()=>{};
 p.saveTranslationAsMarkdownAttachment=async value=>saved=value;
 const settings=p.getTranslationSettings();
 const task={settings,controller:new AbortController(),translation:{language:'中文',chunkSize:20000,chunkBudget:1,chunks:['Old'],parts:['Old translation']},mineruSource:{},parentItem:{},title:'Book'};
 await p.runTranslationTask(task);
 assert.equal(reads,1);assert(!saved.translatedText.includes('Old translation'));assert.equal(a.requests.length,1);
});
test('parent batches respect the concurrency of each selected model when assignments differ',async()=>{
 const a=setup(),p=a.plugin,active={},peak={};
 p.refreshParseQueueDialog=()=>{};
 p.runDocumentTask=async task=>{const id=task.settings.modelID;active[id]=(active[id]||0)+1;peak[id]=Math.max(peak[id]||0,active[id]);await new Promise(resolve=>setTimeout(resolve,5));active[id]--;};
 p.parseQueue=[{id:1,settings:{modelID:'text:1',concurrency:3}},{id:2,settings:{modelID:'vision:1',concurrency:1}},{id:3,settings:{modelID:'vision:1',concurrency:1}}].map(task=>({...task,kind:'parent',state:'queued'}));
 await p.processParseQueue();assert.equal(peak['vision:1'],1);assert(p.parseQueue.every(task=>task.state==='completed'));
});


test('summary output exhaustion reports the actual budget and reasoning usage, then honors a saved increase',async()=>{
 const a=setup(),p=a.plugin,requests=[];let truncated=true;
 a.ctx.fetch=async(url,options)=>{
  const payload=JSON.parse(options.body);requests.push(payload);
  return {ok:true,json:async()=>({choices:[{finish_reason:truncated?'length':'stop',message:{content:truncated?'Incomplete':'Complete summary'}}],usage:{completion_tokens:payload.max_tokens,completion_tokens_details:{reasoning_tokens:7000}}})};
 };
 await assert.rejects(p.summarizeDocument('Short document',p.getLLMSettings('summary')),error=>{
  assert.match(error.message,/输出被截断/);assert.match(error.message,/8192/);assert.match(error.message,/推理 7000/);assert.match(error.message,/工作模型配置/);return true;
 });
 a.work.summary.params='{"max_tokens":16384}';a.save();truncated=false;
 assert.equal(await p.summarizeDocument('Short document',p.getLLMSettings('summary')),'Complete summary');
 assert.deepEqual(requests.map(request=>request.max_tokens),[8192,16384]);
});

test('outline generation uses its assigned model, editable prompt and multilingual context budget',async()=>{
 const a=setup(),p=a.plugin,requests=[];
 vm.runInContext(fs.readFileSync('outline.js','utf8'),a.ctx);
 a.work.outline={model:'text:2',prompt:'Custom outline JSON',params:'{"max_tokens":2048}'};a.save();
 a.ctx.fetch=async(url,options)=>{const payload=JSON.parse(options.body);requests.push(payload);return {ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:'{"outline":[{"title":"章节","page":1}]}'}}]})};};
 a.ctx.Zotero.Reader={_readers:[]};
 const feature=a.ctx.DocFlowOutline;feature.init(p);
 const data={pages:['章节\n'+'中文عربي'.repeat(5000)],headings:[],outline:[]};
 feature.load=async()=>data;feature.save=async()=>{};
 const settings=p.getLLMSettings('outline');settings.contextWindow=16384;
 await feature.generate({id:1},{settings});
 assert(requests.length>1);
 assert(requests.every(request=>request.model==='text-2'&&request.messages[0].content==='Custom outline JSON'&&request.max_tokens===2048));
 assert(requests.every(request=>p.estimateAITokens(request.messages[1].content)+p.estimateAITokens(request.messages[0].content)+256+2048<=16384));
 assert(requests.every(request=>request.messages[1].content.includes('PDF 第 1 页')));
});


test('all work requests inherit their selected model output budget and explicit request limits take priority',async()=>{
 const a=setup(),p=a.plugin;
 const providers=JSON.parse(a.prefs.get('extensions.docflow.llmProviders'));
 providers[0].llmModelMaxOutput=6144;providers[0].llmModel2MaxOutput=12288;providers[1].llmModel2MaxOutput=4096;
 a.put('llmProviders',JSON.stringify(providers));
 await p.identify('','book.pdf',true,{},p.getLLMSettings('parent'));
 await p.identify('Document','book.pdf',false,{},p.getLLMSettings('metadata'));
 await p.summarizeDocument('Document',p.getLLMSettings('summary'));
 await p.parseWithVision({isPDFAttachment:()=>false,getFilePath:()=>'/image.png',attachmentFilename:'image.png'},p.getLLMSettings('ocr'),{});
 await p.callLLMForTranslation('Document','English',p.getTranslationSettings(),1,1);
 assert.deepEqual(a.requests.map(request=>request.payload.max_tokens),[12288,6144,12288,4096,6144]);
 a.work.translate.params='{"max_completion_tokens":2048}';a.save();
 await p.callLLMForTranslation('Document','English',p.getTranslationSettings(),1,1);
 assert.equal(a.requests.at(-1).payload.max_completion_tokens,2048);
 assert(!('max_tokens' in a.requests.at(-1).payload));
});
