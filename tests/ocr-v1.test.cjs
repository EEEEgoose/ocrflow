const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path').posix;

function setup() {
 const files=new Map(),prefs=new Map(),requests=[];let serial=0;
 const context={TextDecoder,TextEncoder,Uint8Array,ArrayBuffer,AbortController,FormData,Blob,URL,atob,btoa,setTimeout,clearTimeout,
  PathUtils:{join:(...parts)=>{if(parts.slice(1).some(p=>p.includes('/')))throw Error('PathUtils requires separate path components');return path.join(...parts);},parent:path.dirname,tempDir:'/tmp'},
  IOUtils:{read:async p=>{if(!files.has(p))throw Error('missing '+p);return files.get(p)},writeUTF8:async(p,t)=>files.set(p,new TextEncoder().encode(t)),
   write:async(p,b)=>files.set(p,b),makeDirectory:async()=>{},remove:async()=>{},exists:async p=>files.has(p),copy:async()=>{}},
  Zotero:{Prefs:{get:k=>prefs.get(k),set:(k,v)=>prefs.set(k,v)},debug:()=>{},logError:()=>{},getMainWindow:()=>({AbortController,FormData,Blob}),
   Attachments:{importFromFile:async opts=>{const target='/storage/'+(++serial)+'/'+path.basename(opts.file);files.set(target,files.get(opts.file));
    return {key:'R'+serial,getFilePath:async()=>target,addTag:()=>{},saveTx:async()=>{},eraseTx:async()=>files.delete(target)};}},
   Items:{get:()=>null}},
  fetch:async(url,options)=>{requests.push({url,options});throw Error('unexpected network request')}
 };
 vm.createContext(context);
 for(const name of ['prompts.js','docflow.js','workflow.js','document.js','layout.js','paddleocr.js','ocr-sources.js','translation.js','collation.js','preferences.js'])vm.runInContext(fs.readFileSync(name,'utf8'),context,{filename:name});
 const m=context.DocFlow,d=context.OCRFlowDocument;
 const withTimeout=m.withTimeout;
 m.withTimeout=run=>run();m.refreshParseQueueDialog=()=>{};
 const write=(p,text)=>files.set(p,new TextEncoder().encode(text));
 const pref=(name,value)=>prefs.set('extensions.docflow.'+name,value);
 const attachment={id:1,key:'PDFKEY',libraryID:1,attachmentFilename:'scan.png',getFilePath:async()=>'/scan.png',isPDFAttachment:()=>false,getField:()=> 'scan.png'};
 return {context,m,d,files,prefs,pref,write,attachment,requests,withTimeout};
}
const block=(type,text,index=0,bbox=[0,0,100,20])=>({type,index,bbox,lines:[{spans:[{content:text}]}]});

test('MinerU restores discarded footnotes, repeated page labels, captions, tables and original page boundaries',()=>{
 const {d}=setup();
 const doc=d.fromMineru({pdf_info:[
  {page_size:[600,800],preproc_blocks:[block('text','第一段①。'),{type:'image',index:1,bbox:[0,40,200,200],blocks:[
   {type:'image_body',lines:[{spans:[{image_path:'images/figure.png'}]}]},block('image_caption','图一：说明')]}],
   discarded_blocks:[block('page_footnote','① 第一页注文'),block('page_number','ix')]},
  {page_size:[600,800],preproc_blocks:[block('text','后文①结束')],discarded_blocks:[block('page_footnote','① 第二页注文')]},
  {page_size:[600,800],preproc_blocks:[block('text','继续叙述。')],discarded_blocks:[]}
 ]});
 const text=d.render(doc);
 assert(text.includes('第一段[^1]。'));assert(text.includes('后文[^2]结束<!--ocrflow-page:3-->继续叙述。'));
 assert(text.includes('[^1]: 第一页注文'));assert(text.includes('[^2]: 第二页注文'));
 assert(text.includes('图一：说明'));assert(text.includes('![](images/figure.png)'));assert.equal(doc.pages[0].printed,'ix');
 assert.equal(doc.blocks.find(b=>b.text.startsWith('后文')).fragments.length,2);
 assert(doc.changes.some(c=>c.kind==='恢复注文输出'));assert(doc.changes.some(c=>c.kind==='跨页接段'));
});

test('shared footnote markers map to one definition while enumeration without a note remains unchanged',()=>{
 const {d}=setup();const doc=d.fromMineru({pdf_info:[{preproc_blocks:[block('text','甲②乙③丙④')],discarded_blocks:[block('page_footnote','②③ 同一书目')]}]});
 assert(d.render(doc).includes('甲[^1]乙[^1]丙④'));assert.equal(doc.blocks.filter(b=>b.type==='footnote').length,1);
});

test('explicit cross-page merge links take precedence over punctuation but never merge a heading',()=>{
 const {d}=setup(),doc=d.fromMineru({pdf_info:[{preproc_blocks:[block('text','First.')],discarded_blocks:[]},{preproc_blocks:[block('text','Continuation')],discarded_blocks:[]}]},0,
  {pdfData:[[{block_position:'0-0',index:0}],[{block_position:'1-0',index:0}]],mergeConnections:[{blocks:['0-0','1-0']}]});
 assert.equal(d.visible(doc).length,1);assert(d.render(doc).includes('First.<!--ocrflow-page:2-->Continuation'));
});

test('Paddle official blocks and self-hosted parsing_res_list both retain captions, geometry and raw content',()=>{
 const {d}=setup();
 for(const prunedResult of [{blocks:[{label:'text',content:'正文',bbox:[1,2,3,4]},{label:'figure_title',content:'图注'}]},
  {width:100,height:200,parsing_res_list:[{block_label:'text',block_content:'正文',block_bbox:[1,2,3,4]},{block_label:'figure_title',block_content:'图注'}]}]){
  const doc=d.fromPaddle([{prunedResult}]);assert.equal(doc.blocks[0].text,'正文');assert.equal(doc.blocks[1].type,'caption');assert.deepEqual(Array.from(doc.blocks[0].fragments[0].rect),[1,2,3,4]);
 }
});

test('dual-source validation treats local/cloud as the same engine and compares AI model identity across providers',()=>{
 const {context}=setup(),s=context.OCRFlowSources,p=[{id:'a',llmModel:'Vision-X',llmModel2:'Vision-Y'},{id:'b',llmModel:'Vision-X',llmModel2:'PaddleOCR-VL-1.6'}];
 assert(!s.valid('mineru-local','mineru-cloud',p));assert(!s.valid('paddle-local','paddle-cloud',p));
 assert(s.valid('paddle-local','mineru-cloud',p));assert(s.valid('mineru-cloud','ai:a:1',p));
 assert(!s.valid('ai:a:1','ai:b:1',p));assert(s.valid('ai:a:1','ai:a:2',p));assert(!s.valid('paddle-cloud','ai:b:2',p));
});

test('settings snapshot retains both selected services and refuses invalid dual-source tasks before any upload',async()=>{
 const s=setup();s.pref('collationEnabled',true);s.pref('collationA','mineru-cloud');s.pref('collationB','paddle-local');
 s.pref('paddle.local.url','http://first');const settings=s.m.getSettings();s.pref('paddle.local.url','http://changed');
 assert.equal(settings.readerB.paddleSettings.baseURL,'http://first');assert.equal(settings.readerA.collationEnabled,false);
 s.pref('collationB','mineru-local');assert.throws(()=>s.m.getSettings(),/双引擎不能相同/);assert.equal(s.requests.length,0);
});

test('self-hosted Paddle uses the full parsing endpoint and preserves response and image bytes',async()=>{
 const s=setup();s.write('/scan.png','image');s.pref('paddle.local.url','http://local');
 s.context.fetch=async(url,options)=>{
  assert.equal(url,'http://local/layout-parsing');assert.equal(JSON.parse(options.body).fileType,1);
  return {ok:true,json:async()=>({errorCode:0,result:{layoutParsingResults:[{prunedResult:{parsing_res_list:[{block_label:'text',block_content:'正文'}]},markdown:{text:'正文\n\n![](images/f.png)',images:{'images/f.png':btoa('image')}}}]}})};
 };
 const result=await s.m.parseWithPaddle(s.attachment,{parserService:'paddle-local'});
 assert(result.markdownText.includes('正文'));assert(result.markdownText.includes('docflow-image://img-1'));
 assert.equal(result.embeddedImages[0].bytes.length,5);assert(result.rawFiles[0].text.includes('parsing_res_list'));
});

test('official Paddle uploads multipart, polls its job and consumes the JSONL result without sending credentials to result hosts',async()=>{
 const s=setup();s.write('/scan.png','image');s.pref('paddle.cloud.token','test-token');
 const calls=[];
 s.context.fetch=async(url,options)=>{
  calls.push(url);
  if(url.endsWith('/jobs')){assert(options.body instanceof FormData);assert.equal(options.body.get('model'),'PaddleOCR-VL-1.6');return {ok:true,json:async()=>({code:0,data:{jobId:'job-1'}})};}
  if(url.endsWith('/jobs/job-1'))return {ok:true,json:async()=>({code:0,data:{state:'done',resultUrl:{jsonUrl:'https://results.example/output'}}})};
  assert.equal(options.headers,undefined);
  return {ok:true,text:async()=>JSON.stringify({result:{layoutParsingResults:[{prunedResult:{blocks:[{label:'text',content:'正文'}]},markdown:{text:'正文'}}]}})};
 };
 const result=await s.m.parseWithPaddle(s.attachment,{parserService:'paddle-cloud'});
 assert(result.markdownText.includes('正文'));assert.equal(calls.length,3);assert(result.rawFiles[0].name.endsWith('.jsonl'));
});

test('translation batches bind by paragraph IDs, retry missing IDs and preserve protected formula/image anchors',async()=>{
 const s=setup(),settings={workKind:'translate',contextWindow:32768,outputTokens:8192,translateLanguage:'中文',translateChunkSize:20000};
 const units=s.m.translationUnits('First $x$ paragraph.\n\nSecond ![图](docflow-image://img-1) paragraph.',settings);
 assert.equal(units.length,2);assert(!JSON.stringify(units.map(u=>u.text)).includes('docflow-image'));
 const items=units.map(u=>({id:u.id+'.0',text:u.fragments[0]}));
 s.m.requestDocumentAI=async()=>JSON.stringify([{id:items[1].id,text:'译二 '+items[1].text},{id:items[0].id,text:'译一 '+items[0].text}]);
 const out=await s.m.translateAlignedBatch(items,settings);assert(out[0].startsWith('译一'));assert(out[1].startsWith('译二'));
 s.m.requestDocumentAI=async()=>JSON.stringify([{id:items[0].id,text:'missing formula'}]);
 const missing=await s.m.translateAlignedBatch(items,settings);assert.equal(missing[0],null);assert.equal(missing[1],null);
 s.m.requestDocumentAI=async()=>JSON.stringify([{id:items[0].id,text:items[0].text},{id:items[0].id,text:items[0].text}]);
 await assert.rejects(()=>s.m.translateAlignedBatch(items,settings),/重复/);
});

test('runtime bilingual translation saves one pair per paragraph while requesting multiple paragraphs together',async()=>{
 const s=setup();s.m.readSourceMarkdown=async()=>({filePath:'/source.md',markdown:'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.'});
 s.m.inlineStoredImagesInMarkdownAttachment=async({markdownText})=>({markdownText,embeddedImages:[]});
 let batches=[],saved;
 s.m.requestDocumentAI=async messages=>{const batch=JSON.parse(messages[1].content);batches.push(batch);return JSON.stringify([...batch].reverse().map(x=>({id:x.id,text:'译 '+x.text})));};
 s.m.saveTranslationAsMarkdownAttachment=async value=>{saved=value};
 const task={settings:{workKind:'translate',contextWindow:32768,outputTokens:8192,translateLanguage:'中文',translateChunkSize:20000,outputFormat:'html',translationMode:'bilingual'},controller:new AbortController(),mineruSource:{},parentItem:{}};
 await s.m.runTranslationTask(task);
 assert.equal(batches.length,1);assert.equal(batches[0].length,3);assert.equal(saved.pairs.length,3);assert(saved.pairs[1].translated.includes('Second'));
});

test('missing one translated paragraph retries only that paragraph and never shifts later pairs',async()=>{
 const s=setup();s.m.readSourceMarkdown=async()=>({filePath:'/source.md',markdown:'One.\n\nTwo.\n\nThree.'});
 s.m.inlineStoredImagesInMarkdownAttachment=async({markdownText})=>({markdownText,embeddedImages:[]});let counts=[],saved;
 s.m.requestDocumentAI=async messages=>{let batch=JSON.parse(messages[1].content);counts.push(batch.map(i=>i.id));return JSON.stringify(batch.filter((_,index)=>counts.length>1||index!==1));};
 s.m.saveTranslationAsMarkdownAttachment=async value=>saved=value;
 await s.m.runTranslationTask({settings:{workKind:'translate',contextWindow:32768,outputTokens:8192,translateLanguage:'中文',outputFormat:'html',translationMode:'bilingual'},controller:new AbortController(),mineruSource:{},parentItem:{}});
 assert.deepEqual(counts,[['p1.0','p2.0','p3.0'],['p2.0']]);assert.equal(saved.pairs[2].source,'Three.');
});

test('content reports include punctuation differences and applying a confirmed correction preserves the source fragments',()=>{
 const {d,m}=setup(),a=d.fromPaddle([{prunedResult:{blocks:[{label:'text',content:'甲，乙。'}]}}]),b=d.fromPaddle([{prunedResult:{blocks:[{label:'text',content:'甲；乙。'}]}}]);
 const collation=d.compare(a,b);assert.equal(collation.findings.length,1);assert.equal(collation.findings[0].difference.before,'，');
 const finding=collation.findings[0],fragment=JSON.stringify(a.blocks[0].fragments);
 m.applyCollationDecision({document:a},finding,[{id:a.blocks[0].id,before:a.blocks[0].text,after:b.blocks[0].text}],'原图');
 assert.equal(JSON.stringify(a.blocks[0].fragments),fragment);assert(m.documentReport(a).includes('甲，乙。'));assert(m.documentReport(a).includes('甲；乙。'));
 assert.throws(()=>m.applyCollationDecision({document:a},finding,[],''),/已经处理/);
});

test('HTML footnotes use separate source/target anchors, shared-note references remain unique, and raw/structure/reports are saved',async()=>{
 const s=setup(),doc=s.d.fromPaddle([{prunedResult:{blocks:[{label:'text',content:'正文。'}]}}]);
 const counts=new Map(),first=s.m.renderFootnotes('Text[^1] and again[^1]','source',counts),note=s.m.renderFootnotes('[^1]: 注文','source',counts);
 assert(first.includes('source-ref-1-2'));assert(first.includes('href="#source-note-1"'));assert(note.includes('id="source-note-1"'));
 const imported=await s.m.saveDocumentAttachment({libraryID:1,title:'test',markdown:'正文。',tag:'#DocFlow-Parse'});
 await s.m.saveDocumentData(imported,{document:doc,rawFiles:[{name:'layout.json',text:'raw'}]});
 const root=path.join(path.dirname(await imported.getFilePath()),'_ocrflow');
 assert(s.files.has(root+'/document.json'));assert(s.files.has(root+'/changes.html'));assert.equal(new TextDecoder().decode(s.files.get(root+'/raw/engine-a/0-layout.json')),'raw');
});

test('B failure preserves A and a missing-page result never claims complete coverage',async()=>{
 const s=setup(),doc=s.d.fromPaddle([{prunedResult:{blocks:[{label:'text',content:'A'}]}}]);
 s.m.parseAttachmentWithMineru=async()=>{throw Error('B failed')};
 const task={attachment:s.attachment,settings:{collationA:'mineru-cloud',collationB:'paddle-local'},parsedResult:{document:doc},controller:new AbortController()};
 await s.m.prepareCollation(task);assert.equal(task.parsedResult.document,doc);assert.equal(task.parsedResult.collation.status,'failed');
 const missing=s.d.compare(doc,s.d.create('other'));assert.equal(missing.comparedPages,0);assert.deepEqual(Array.from(missing.missingPages),[1]);
});

test('long paragraphs split internally but remain one bilingual row; note definition prefixes and code are preserved',async()=>{
 const s=setup(),settings={workKind:'translate',contextWindow:4096,outputTokens:1024,translateLanguage:'中文'};
 const text='word '.repeat(1600),units=s.m.translationUnits(text+'\n\n[^1]: 注文。\n\n```\n[^2]: literal\n```',settings);
 assert(units[0].fragments.length>1);assert.equal(units[0].fragments.join(''),text.trim());assert.equal(units[1].prefix,'[^1]: ');
 assert.equal(units[2].translated[0],units[2].fragments[0]);
 const html=s.m.renderFootnotes('```\n[^2]: literal\n```\n\n`[^1]`\n\nText[^3]\n\n[^3]: Note','doc');
 assert(html.includes('<code>[^1]</code>'));assert(!html.includes('doc-note-2'));assert(html.includes('value="3"'));
});

test('structure persistence does not replace image-1 inside image-10',async()=>{
 const s=setup(),doc=s.d.create('test');
 s.d.add(doc,'figure','![](docflow-image://img-1) ![](docflow-image://img-10)',1);
 const images=Array.from({length:10},(_,i)=>({marker:'docflow-image://img-'+(i+1),fileName:'f.png',mimeType:'image/png',bytes:new Uint8Array([1])}));
 const item={getFilePath:async()=>'/storage/test/doc.md'};
 await s.m.saveDocumentData(item,{document:doc,embeddedImages:images});
 const stored=JSON.parse(new TextDecoder().decode(s.files.get('/storage/test/_ocrflow/document.json')));
 assert.equal(stored.blocks[0].text,'![](images/image-1.png) ![](images/image-10.png)');
});

test('a plain-text table fallback survives structure rebuilding and publication metadata is not turned into a footnote',()=>{
 const {d}=setup(),doc=d.fromMineru({pdf_info:[{preproc_blocks:[block('table','A B C')],discarded_blocks:[block('page_footnote','收稿日期：2020年')]}]});
 assert(d.render(doc).includes('A B C'));assert(d.render(doc).includes('收稿日期'));assert.equal(doc.blocks.filter(b=>b.type==='footnote').length,0);
});

test('retrying stored collation calls only B and keeps the existing A document',async()=>{
 const s=setup(),a=s.d.fromPaddle([{prunedResult:{blocks:[{label:'text',content:'A。'}]}}]),b=s.d.fromPaddle([{prunedResult:{blocks:[{label:'text',content:'B。'}]}}]);
 const calls=[];s.m.parseAttachmentWithMineru=async(_a,settings)=>{calls.push(settings.parserService);return {document:b,markdownText:'B。'}};
 const review={document:a,original:s.attachment,root:'/review',collation:{status:'failed',sources:['mineru-cloud','paddle-local']}};
 await s.m.retryCollationReview(review,new AbortController().signal);
 assert.deepEqual(calls,['paddle-local']);assert.equal(review.document,a);assert.equal(review.collation.findings.length,1);
 assert(s.files.has('/review/collation.json'));
});

test('canceling an aligned translation before the response prevents saving',async()=>{
 const s=setup(),controller=new AbortController();let saved=false;
 s.m.readSourceMarkdown=async()=>({filePath:'/source.md',markdown:'One.'});
 s.m.inlineStoredImagesInMarkdownAttachment=async({markdownText})=>({markdownText,embeddedImages:[]});
 s.m.requestDocumentAI=async messages=>{controller.abort();return messages[1].content};
 s.m.saveTranslationAsMarkdownAttachment=async()=>{saved=true};
 await assert.rejects(()=>s.m.runTranslationTask({settings:{workKind:'translate',contextWindow:32768,translateLanguage:'中文'},controller,mineruSource:{},parentItem:{}}));
 assert.equal(saved,false);
});

test('page-by-page AI Markdown footnotes are renumbered without duplicate IDs or swallowing code examples',()=>{
 const {d,m}=setup();
 const markdown='<!-- 第 1 页 -->\n\nFirst[^1].\n\n[^1]: First note.\n\n<!-- 第 2 页 -->\n\nSecond[^1].\n\n[^1]: Second note.\n\n```\n[^1]: example\n```';
 const doc=d.fromMarkdown(markdown,'ai',text=>m.splitTranslationBlocks(text)),result=d.render(doc);
 assert(result.includes('First[^1].'));assert(result.includes('Second[^2].'));assert(result.includes('[^2]: Second note.'));
 assert(result.includes('```\n[^1]: example\n```'));assert.equal(doc.blocks.filter(b=>b.type==='footnote').length,2);
});

test('manual text collation cannot replace a source figure with a different reader image marker',()=>{
 const {d,m}=setup(),doc=d.create('mineru'),source=d.add(doc,'figure','![](images/image-1.png)',1);
 const finding={status:'pending',blockIDs:[source.id]};
 assert.throws(()=>m.applyCollationDecision({document:doc},finding,[{id:source.id,before:source.text,after:'![](docflow-image://img-2)'}],'原图'),/保留底稿的图片引用/);
 assert.equal(source.text,'![](images/image-1.png)');assert.equal(finding.status,'pending');
});

test('reader render numbering is ignored and adopting B preserves A footnote references',()=>{
 const {d,m}=setup(),a=d.create('a'),b=d.create('b');
 a.pages=[{page:1}];b.pages=[{page:1}];d.add(a,'paragraph','Text[^17].',1);d.add(b,'paragraph','Text[^16].',1);
 assert.equal(d.compare(a,b).findings.length,0);
 assert.equal(m.collationSuggestion({a:'Text[^17].',b:'Corrected[^16].'}),'Corrected[^17].');
 assert.equal(m.collationSuggestion({a:'Text[^17].',b:'Corrected.'}),null);
});

test('bare layout image references resolve to known image bytes without changing raw source or captions',async()=>{
 const s=setup(),name='layout-image.jpg',raw=`![插图](${name})\n\n文件名 ${name} 保留在图注中`;
 const document=s.d.fromPaddle([{prunedResult:{parsing_res_list:[{block_label:'image',block_content:`<img src="${name}">`}]}}]);
 const result={markdownText:raw,document,embeddedImages:[{entryName:'paper/images/'+name,fileName:name,marker:'docflow-image://img-1',mimeType:'image/jpeg',bytes:new Uint8Array([1,2,3])}]};
 s.m.finalizeDocument(result,'mineru');
 assert(result.markdownText.includes('![插图](docflow-image://img-1)'));assert(result.markdownText.includes('文件名 '+name));
 assert(result.document.blocks[0].text.includes('src="docflow-image://img-1"'));assert(result.document.blocks[0].rawText.includes(name));assert.equal(result.rawFiles[0].text,raw);
 const saved=await s.m.saveDocumentAttachment({libraryID:1,title:'Image test',markdown:result.markdownText,images:result.embeddedImages,format:'md',tag:'#DocFlow-Parse'});
 const path=await saved.getFilePath();assert(new TextDecoder().decode(s.files.get(path)).includes('images/image-1.jpg'));
 assert(s.files.get('/storage/1/images/image-1.jpg').length===3);
});
test('ambiguous image basenames are not silently bound to an unrelated page resource',()=>{
 const s=setup(),result={markdownText:'![](same.jpg)',embeddedImages:[{fileName:'one/same.jpg',marker:'docflow-image://img-1'},{fileName:'two/same.jpg',marker:'docflow-image://img-2'}]};
 s.m.normalizeResultImages(result);assert.equal(result.markdownText,'![](same.jpg)');
});
function aiReviewFixture(){
 const s=setup(),document=s.d.fromPaddle([{prunedResult:{parsing_res_list:[{block_label:'text',block_content:'原文[^1] $x$ ![](docflow-image://img-1)'}]}}]);
 const finding={id:'d1',page:1,blockIDs:[document.blocks[0].id],a:document.blocks[0].text,b:'对照识别',status:'pending'};
 const settings={modelID:'vision:2',model:'vision-review',providerName:'Test vision',apiBaseURL:'https://controlled.invalid',contextWindow:32768};
 const task={attachment:s.attachment,settings:{collationAI:settings},parsedResult:{document,collation:{status:'ready',findings:[finding]}},controller:new AbortController()};
 s.m.collationPageImage=async()=> 'data:image/png;base64,aW1hZ2U=';
 const reply=text=>JSON.stringify([{id:'d1',verdict:'b',reason:'原图该字笔画支持此读法',edits:[{id:document.blocks[0].id,text:text||document.blocks[0].text.replace('原文','修正')}]}]);
 return {...s,task,finding,settings,reply};
}
test('AI review sends both readings and source image, retains advice and raw reply, and never rewrites the source',async()=>{
 const s=aiReviewFixture(),before=s.task.parsedResult.document.blocks[0].text;
 s.m.requestDocumentAI=async(messages,settings)=>{assert.equal(settings.modelID,'vision:2');assert(messages[1].content[0].text.includes('对照识别'));assert(messages[1].content[1].image_url.url.startsWith('data:image/'));return s.reply();};
 await s.m.reviewCollationWithAI(s.task);
 assert.equal(s.task.parsedResult.document.blocks[0].text,before);assert.equal(s.finding.status,'pending');assert.equal(s.finding.ai.verdict,'b');
 assert.equal(s.task.parsedResult.collation.ai.status,'completed');assert(s.task.parsedResult.collation.ai.runs[0].raw.includes('修正'));
 assert.equal(s.m.collationAISuggestion({document:s.task.parsedResult.document},s.finding)[0].after,before.replace('原文','修正'));
});
test('AI suggestions that lose images or footnotes fail without altering either engine result',async()=>{
 const s=aiReviewFixture(),before=JSON.stringify(s.task.parsedResult.document);
 s.m.requestDocumentAI=async()=>s.reply('修正');await s.m.reviewCollationWithAI(s.task);
 assert.equal(s.task.parsedResult.collation.status,'ready');assert.equal(s.task.parsedResult.collation.ai.status,'failed');assert.equal(s.finding.status,'pending');
 assert.equal(JSON.stringify(s.task.parsedResult.document),before);assert.equal(s.m.collationAISuggestion({document:s.task.parsedResult.document},s.finding),null);
});
test('AI retry processes failed advice without rerunning OCR or erasing completed comparison',async()=>{
 const s=aiReviewFixture();s.m.requestDocumentAI=async()=>{throw Error('controlled timeout')};await s.m.reviewCollationWithAI(s.task);
 const review={source:{id:1},original:s.attachment,document:s.task.parsedResult.document,collation:s.task.parsedResult.collation,root:'/review'};
 let saved=0;s.m.saveCollationReview=async()=>{saved++;return {attachment:{id:2,getFilePath:async()=>'/review2/file.md'}}};
 s.m.getCollationAISettings=()=>s.settings;s.m.parseAttachmentWithMineru=async()=>{throw Error('OCR must not rerun')};
 s.m.requestDocumentAI=async()=>s.reply();await s.m.retryCollationAIReview(review,new AbortController().signal);
 assert.equal(review.collation.ai.status,'completed');assert(s.files.has('/review/collation.json'));assert.equal(saved,1);assert.equal(review.source.id,2);assert.equal(review.document.blocks[0].text,s.finding.a.replace('原文','修正'));
});
test('AI model is snapshotted independently from recognition sources and disabled mode adds no AI configuration',()=>{
 const s=setup();s.pref('llmProviders',JSON.stringify([{id:'vision',llmApiBaseURL:'https://controlled.invalid',llmModel:'a-model',llmModel2:'review-model'}]));
 s.pref('collationEnabled',true);s.pref('collationA','mineru-cloud');s.pref('collationB','paddle-local');
 let settings=s.m.getSettings();assert.equal(settings.collationAI,undefined);
 s.pref('collationAIEnabled',true);s.pref('collationAIModel','vision:2');settings=s.m.getSettings();
 s.pref('collationAIModel','vision:1');assert.equal(settings.collationAI.model,'review-model');assert.equal(settings.readerA.parserService,'mineru');
});
test('automatic AI collation saves a new edition, preserves base A and reuses the correction after a save failure',async()=>{
 const s=aiReviewFixture();s.task.settings.collationAIEnabled=true;s.m.requestDocumentAI=async()=>s.reply();await s.m.reviewCollationWithAI(s.task);
 const baseDocument=JSON.stringify(s.task.parsedResult.document),base={attachment:{key:'BASE',id:10}};let attempts=0,corrected;
 s.m.parentForDocument=()=>null;
 s.m.saveResultAsMarkdownAttachment=async options=>{attempts++;assert.equal(options.titleSuffix,' · AI 校勘');corrected=options.parsedResult;if(attempts===1)throw Error('controlled save failure');return {attachment:{id:11,key:'CORRECTED'}}};
 await assert.rejects(s.m.saveAutomaticCollation(s.task,base),/controlled save failure/);
 assert.equal(JSON.stringify(s.task.parsedResult.document),baseDocument);assert(s.task.aiCorrectedResult);
 const saved=await s.m.saveAutomaticCollation(s.task,base);assert.equal(saved.attachment.id,11);assert.equal(attempts,2);
 assert.equal(corrected.collation.baseAttachmentKey,'BASE');assert.equal(corrected.collation.ai.applied,1);assert.equal(corrected.collation.findings[0].confirmedBy,'ai');assert(corrected.document.blocks[0].text.startsWith('修正'));
 assert.equal(s.task.aiCorrectedResult,null);
 const finding=corrected.collation.findings[0],block=corrected.document.blocks[0];
 s.m.applyCollationDecision(corrected,finding,[{id:block.id,before:block.text,after:block.text.replace('修正','人工修正')}],'人工核图');
 assert.equal(finding.confirmedBy,'manual');assert.equal(finding.decisions.length,2);assert(block.text.startsWith('人工修正'));
});
test('automatic AI collation keeps uncertain readings and invalid protected references unchanged',async()=>{
 for(const reply of [s=>JSON.stringify([{id:'d1',verdict:'uncertain',reason:'原图不清',edits:[]}]),s=>s.reply('遗漏引用')]) {
  const s=aiReviewFixture(),before=JSON.stringify(s.task.parsedResult.document);s.m.requestDocumentAI=async()=>reply(s);await s.m.reviewCollationWithAI(s.task);
  assert.equal(s.m.applyAICollation({document:s.task.parsedResult.document,collation:s.task.parsedResult.collation}),0);assert.equal(JSON.stringify(s.task.parsedResult.document),before);assert.equal(s.finding.status,'pending');
 }
});
test('uncertain and unknown AI response identities do not become unchecked replacements',async()=>{
 const s=aiReviewFixture();s.m.requestDocumentAI=async()=>JSON.stringify([{id:'d1',verdict:'uncertain',reason:'原图不清晰',edits:[]}]);
 await s.m.reviewCollationWithAI(s.task);assert.equal(s.m.collationAISuggestion({document:s.task.parsedResult.document},s.finding),null);assert.equal(s.finding.status,'pending');
 const t=aiReviewFixture();t.m.requestDocumentAI=async()=>JSON.stringify([{id:'unknown',verdict:'a',reason:'x',edits:[]}]);await t.m.reviewCollationWithAI(t.task);assert.equal(t.task.parsedResult.collation.ai.status,'failed');
});


test('Paddle keeps one figure when layout uses a bare name and markdown resource uses images directory',()=>{
 const s=setup(),doc=s.d.fromPaddle([{prunedResult:{parsing_res_list:[{block_label:'image',block_content:'![](figure.png)'}]},markdown:{images:{'images/figure.png':'bytes'}}}]);
 assert.equal(doc.blocks.filter(block=>block.type==='figure').length,1);
});


test('MinerU ZIP resolves a unique bare image name to its images directory and refuses ambiguous names',async()=>{
 const s=setup();let reads=[];s.m.readZipEntryBytes=async(_zip,_dir,name)=>{reads.push(name);return new Uint8Array([1,2]);};
 const options={resourceURL:'figure.png',markdownEntryName:'full.md',zipReader:{},tempDir:'/tmp',embeddedByEntry:new Map(),addEmbedded:(entryName,_mime,bytes)=>({entryName,bytes})};
 const image=await s.m.resolveArchiveImageReference({...options,entryMap:new Map([['images/figure.png','images/figure.png']])});assert.equal(image.entryName,'images/figure.png');assert.equal(reads.length,1);
 const ambiguous=await s.m.resolveArchiveImageReference({...options,entryMap:new Map([['a/figure.png','a/figure.png'],['b/figure.png','b/figure.png']])});assert.equal(ambiguous,null);assert.equal(reads.length,1);
});

test('dual OCR with AI disabled never calls an additional model',async()=>{
 const s=setup(),document=s.d.fromPaddle([{prunedResult:{parsing_res_list:[{block_label:'text',block_content:'甲'}]}}]);
 s.m.parseAttachmentWithMineru=async()=>({document:s.d.fromPaddle([{prunedResult:{parsing_res_list:[{block_label:'text',block_content:'乙'}]}}]),markdownText:'乙'});
 s.m.requestDocumentAI=async()=>{throw Error('AI must not be called')};
 const task={attachment:s.attachment,settings:{collationA:'mineru-cloud',collationB:'paddle-local',collationAIEnabled:false},parsedResult:{document},controller:new AbortController()};
 await s.m.prepareCollation(task);assert.equal(task.parsedResult.collation.status,'ready');assert.equal(task.parsedResult.collation.ai,undefined);
});
test('AI advice image anchors are persisted using the same image paths as the document',async()=>{
 const s=aiReviewFixture();s.m.requestDocumentAI=async()=>s.reply();await s.m.reviewCollationWithAI(s.task);
 s.task.parsedResult.embeddedImages=[{marker:'docflow-image://img-1',fileName:'original.png',mimeType:'image/png',bytes:new Uint8Array([1])}];
 await s.m.saveDocumentData({getFilePath:async()=>'/out/full.md'},s.task.parsedResult);
 const stored=JSON.parse(new TextDecoder().decode(s.files.get('/out/_ocrflow/collation.json')));
 assert(stored.findings[0].ai.edits[0].text.includes('images/image-1.png'));
 assert(!stored.findings[0].ai.edits[0].text.includes('docflow-image://'));
 assert(stored.ai.runs[0].raw.includes('docflow-image://'),'original AI response is preserved without rewriting');
});

test('review opens a source-specific window and brings it forward',async()=>{
 const s=setup(),source={id:8,getFilePath:async()=>'/review/book.html'};let args,focused=0;
 s.m.collectDocumentTasks=()=>[{source}];s.context.Zotero.Items.getByLibraryAndKey=()=>s.attachment;
 s.write('/review/_ocrflow/document.json',JSON.stringify({source:{libraryID:1,key:'PDFKEY'}}));
 s.write('/review/_ocrflow/collation.json',JSON.stringify({status:'ready',findings:[]}));
 const reviewWindow={focus:()=>focused++};s.context.Zotero.getMainWindow=()=>({openDialog:(...options)=>{args=options;return reviewWindow;}});
 assert.equal(await s.m.openCollationReview({selectedItems:[source]}),reviewWindow);
 assert.equal(focused,1);assert.equal(args[1],'ocrflow-collation-8');assert.equal(args[3].review.source,source);
});

test('collation page images reuse the open PDF reader without selecting its tab again',async()=>{
 const s=setup();let opens=0,renders=0;
 const canvas={getContext:()=>({}),toDataURL:()=> 'data:image/png;base64,YQ=='};
 const view={initializedPromise:Promise.resolve(),_iframeWindow:{Object,document:{createElement:()=>canvas}}};
 const reader={itemID:1,_initPromise:Promise.resolve(),_internalReader:{_primaryView:view}};
 s.context.Zotero.Reader={_readers:[reader],open:async()=>{opens++;return reader;}};
 s.m.outline={getReaderApp:()=>({pdfDocument:{getPage:async()=>({getViewport:()=>({width:600,height:800}),render:()=>{renders++;return {promise:Promise.resolve()};}})}})};
 const attachment={id:1,isPDFAttachment:()=>true};
 assert.equal(await s.m.collationPageImage(attachment,1),'data:image/png;base64,YQ==');
 assert.equal(opens,0);assert.equal(renders,1);assert.equal(canvas.width,0);
 reader._isTabClosed=true;await s.m.collationPageImage(attachment,1);assert.equal(opens,1);
 s.context.Zotero.Reader.open=async()=>undefined;
 await assert.rejects(()=>s.m.collationPageImage(attachment,1),/请先打开此 PDF/);
});

test('image timeout is visible, retry keeps edits, and same-page findings reuse the image',async()=>{
 const s=setup(),finding={page:1},review={original:s.attachment,collation:{findings:[finding]}};
 const nodes=new Map(['image','image-status','retry-image','edits','reason','checked'].map(id=>[id,{textContent:'',value:'人工草稿',checked:false}]));
 const context={window:{arguments:[{plugin:s.m,review}],addEventListener:()=>{}},document:{getElementById:id=>nodes.get(id)}};
 vm.createContext(context);vm.runInContext(fs.readFileSync('collation-dialog.js','utf8'),context);
 const dialog=context.OCRFlowCollationDialog;let expire,calls=0;
 s.context.setTimeout=(fn,ms)=>{assert.equal(ms,30000);expire=fn;return 1;};s.context.clearTimeout=()=>{};
 s.m.withTimeout=s.withTimeout;s.m.collationPageImage=()=>{calls++;return new Promise(()=>{});};
 const loading=dialog.loadImage(finding);assert.match(nodes.get('image-status').textContent,/正在加载/);
 await Promise.resolve();expire();await loading;
 assert.match(nodes.get('image-status').textContent,/超时.*重试/);assert.equal(nodes.get('retry-image').hidden,false);assert.equal(dialog.loadedPage,null);
 s.m.collationPageImage=async()=>{calls++;return 'data:image/png;base64,YQ==';};
 await dialog.loadImage(finding);assert.equal(dialog.loadedPage,1);assert.equal(nodes.get('edits').value,'人工草稿');assert.equal(nodes.get('checked').checked,false);
 review.collation.findings[0]={page:1};await dialog.loadImage(dialog.current());
 assert.equal(calls,2);assert.equal(nodes.get('retry-image').hidden,true);
});

test('paused aligned translation exposes the API error and retries missing paragraphs with saved model settings',async()=>{
 const s=setup();vm.runInContext(fs.readFileSync('task-sidebar.js','utf8'),s.context);const sidebar=s.context.OCRFlowTaskSidebar;sidebar.init(s.m);s.m.sidebar=sidebar;sidebar.views.set({},{});
 s.m.readSourceMarkdown=async()=>({filePath:'/source.md',markdown:'First.\n\nSecond.'});s.m.inlineStoredImagesInMarkdownAttachment=async({markdownText})=>({markdownText,embeddedImages:[]});
 const settings={workKind:'translate',model:'old',apiBaseURL:'https://controlled.invalid/v1',contextWindow:32768,translateLanguage:'中文',translateChunkSize:30,translateConcurrency:1,translateRetryCount:0};
 const task={kind:'translate',settings,controller:new AbortController(),mineruSource:{},parentItem:{}};
 let paused;const waiting=new Promise(resolve=>paused=resolve),calls=[];let saved;
 s.m.refreshParseQueueDialog=()=>{if(task.decision)paused();};
 s.context.fetch=async(_url,options)=>{const payload=JSON.parse(options.body),items=JSON.parse(payload.messages[1].content);calls.push({model:payload.model,ids:items.map(i=>i.id)});
  if(payload.model==='old'&&items.some(i=>i.id==='p2.0'))return {ok:false,status:429,text:async()=> 'controlled rate limit'};
  return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(items.map(i=>({id:i.id,text:'译 '+i.text})))}}]})};};
 s.m.saveTranslationAsMarkdownAttachment=async value=>saved=value;
 const running=s.m.runAlignedTranslationTask(task);await waiting;
 assert.match(task.decision.options.failures[0].error,/429.*controlled rate limit/);assert.equal(task.decision.options.savable,1);assert.match(task.detail,/翻译已暂停/);
 assert.equal(sidebar.stepState(task,{state:'running'}),'waiting');
 s.m.getTranslationSettings=()=>({...settings,model:'new'});s.m.resolveTaskDecision(task,'retry');await running;
 assert.equal(calls.filter(c=>c.ids.includes('p1.0')).length,1);assert.equal(calls.at(-1).model,'new');assert.equal(saved.translationData.length,2);assert(saved.translationData.every(p=>p.complete));
});

test('zero completed translation cannot save and invalid retry settings leave the decision available',async()=>{
 const s=setup();vm.runInContext(fs.readFileSync('task-sidebar.js','utf8'),s.context);const sidebar=s.context.OCRFlowTaskSidebar;sidebar.init(s.m);s.m.sidebar=sidebar;sidebar.views.set({},{});
 const task={kind:'translate',settings:{translateLanguage:'中文'},controller:new AbortController()};
 const waiting=s.m.requestTaskDecision(task,{completed:1,savable:0,total:2,failures:[{error:'401 invalid key'}]});
 assert.throws(()=>s.m.resolveTaskDecision(task,'save'),/尚无完整译段/);assert(task.decision);
 s.m.getTranslationSettings=()=>{throw Error('invalid model settings');};assert.throws(()=>s.m.resolveTaskDecision(task,'retry'),/invalid model settings/);assert(task.decision);
 s.m.getTranslationSettings=()=>({translateLanguage:'English'});assert.throws(()=>s.m.resolveTaskDecision(task,'retry'),/语言已改变/);assert(task.decision);
 task.controller.abort();await assert.rejects(waiting);assert.equal(task.decision,null);
});

test('HTTP 429 respects Retry-After and retries without showing the stale source-reading phase',async()=>{
 const s=setup();s.m.readSourceMarkdown=async()=>({filePath:'/source.md',markdown:'First.\n\nSecond.'});s.m.inlineStoredImagesInMarkdownAttachment=async({markdownText})=>({markdownText,embeddedImages:[]});
 const task={settings:{workKind:'translate',model:'controlled',apiBaseURL:'https://controlled.invalid/v1',contextWindow:32768,translateLanguage:'中文',translateRetryCount:1},controller:new AbortController(),mineruSource:{},parentItem:{}};
 const phases=[],waits=[];let calls=0,saved;
 s.m.refreshParseQueueDialog=()=>phases.push(task.detail);s.m.delayParsePoll=async(ms,{signal})=>{signal.throwIfAborted();waits.push(ms);};
 s.context.fetch=async(_url,options)=>{calls++;if(calls===1)return {ok:false,status:429,headers:{get:()=> '7'},text:async()=> 'inference exceeds tpm/rpm limit'};
 const items=JSON.parse(JSON.parse(options.body).messages[1].content);return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(items)}}]})};};
 s.m.saveTranslationAsMarkdownAttachment=async value=>saved=value;
 await s.m.runAlignedTranslationTask(task);assert.equal(calls,2);assert.equal(waits.length,1);assert(waits[0]>6900&&waits[0]<=7000);
 assert(phases.some(text=>text.includes('正在请求模型翻译')));assert(phases.some(text=>text.includes('服务限流（HTTP 429）')));assert(saved.translationData.every(pair=>pair.complete));
});

test('translation can be canceled during rate-limit cooldown without another request or save',async()=>{
 const s=setup();s.m.readSourceMarkdown=async()=>({filePath:'/source.md',markdown:'First.'});s.m.inlineStoredImagesInMarkdownAttachment=async({markdownText})=>({markdownText,embeddedImages:[]});
 const task={settings:{workKind:'translate',model:'controlled',apiBaseURL:'https://controlled.invalid/v1',contextWindow:32768,translateLanguage:'中文',translateRetryCount:1},controller:new AbortController(),mineruSource:{},parentItem:{}};
 let waiting,calls=0;const paused=new Promise(resolve=>waiting=resolve);
 s.m.refreshParseQueueDialog=()=>{if(task.detail?.includes('服务限流'))waiting();};
 s.context.fetch=async()=>{calls++;return {ok:false,status:429,text:async()=> 'rate limit'};};
 s.m.saveTranslationAsMarkdownAttachment=async()=>{throw Error('must not save');};
 const running=s.m.runAlignedTranslationTask(task);await paused;task.controller.abort();await assert.rejects(running);assert.equal(calls,1);
});

test('paragraph batch sizes respect the configured model output budget',async()=>{
 const s=setup(),text=Array.from({length:40},(_,i)=>`Paragraph ${i}: historical text with details.`).join('\n\n');
 s.m.readSourceMarkdown=async()=>({filePath:'/source.md',markdown:text});s.m.inlineStoredImagesInMarkdownAttachment=async({markdownText})=>({markdownText,embeddedImages:[]});
 let batches=0;s.m.requestDocumentAI=async messages=>{const items=JSON.parse(messages[1].content);assert(items.reduce((sum,item)=>sum+s.m.estimateAITokens(JSON.stringify(item)),0)<=512);batches++;return JSON.stringify(items);};
 s.m.saveTranslationAsMarkdownAttachment=async value=>assert.equal(value.translationData.length,40);
 await s.m.runAlignedTranslationTask({settings:{workKind:'translate',outputTokens:512,contextWindow:32768,translateLanguage:'中文'},controller:new AbortController(),mineruSource:{},parentItem:{}});
 assert(batches>1);
});

test('exhausted rate-limit retries pause later batches instead of sending the entire document',async()=>{
 const s=setup();s.m.readSourceMarkdown=async()=>({filePath:'/source.md',markdown:'First.\n\nSecond.\n\nThird.'});s.m.inlineStoredImagesInMarkdownAttachment=async({markdownText})=>({markdownText,embeddedImages:[]});let calls=0;
 s.m.requestDocumentAI=async()=>{calls++;const error=Error('429 rate limit');error.status=429;throw error;};
 s.m.requestTaskDecision=async(_task,options)=>{assert.equal(options.failures.length,3);assert.match(options.failures[1].error,/暂未请求/);return 'discard';};
 await assert.rejects(()=>s.m.runAlignedTranslationTask({settings:{workKind:'translate',translateChunkSize:30,translateRetryCount:0,contextWindow:32768,translateLanguage:'中文',translateConcurrency:1},controller:new AbortController(),mineruSource:{},parentItem:{}}),/429/);
 assert.equal(calls,1);
});

test('cross-page prose is one translation unit while actual paragraphs keep their own page sources',()=>{
 const s=setup(),settings={workKind:'translate',contextWindow:32768};
 const units=s.m.translationUnits('<!--ocrflow-page:1-->\n\nThe argument continues\n\n<!--ocrflow-page:2-->\n\non the next page.\n\nA separate paragraph.\n\n<!--ocrflow-page:3-->\n\nAnother paragraph.',settings);
 assert.equal(units.length,3);assert.equal(units[0].source,'The argument continues on the next page.');assert.deepEqual(Array.from(units[0].pages),[1,2]);assert.equal(units[0].page,1);
 assert.equal(units[1].page,2);assert.deepEqual(Array.from(units[1].pages),[2]);assert.equal(units[2].page,3);
 const inline=s.m.translationUnits('<!--ocrflow-page:2-->\n\nFirst<!--ocrflow-page:3-->second<!--ocrflow-page:4-->third.',settings);
 assert.equal(inline[0].source,'First second third.');assert.deepEqual(Array.from(inline[0].pages),[2,3,4]);assert.equal(inline[0].page,2);
});

test('page joins handle Chinese and Arabic spacing without merging headings, lists, notes or complete paragraphs',()=>{
 const s=setup(),settings={workKind:'translate',contextWindow:32768};
 const units=s.m.translationUnits('<!--ocrflow-page:1-->\n\n这是跨页的\n\n<!--ocrflow-page:2-->\n\n同一段正文。',settings);
 assert.equal(units[0].source,'这是跨页的同一段正文。');
 const arabic=s.m.translationUnits('<!--ocrflow-page:1-->\n\nتاريخ الجزائر\n\n<!--ocrflow-page:2-->\n\nفي القديم والحديث.',settings);
 assert.equal(arabic.length,1);assert.equal(arabic[0].source,'تاريخ الجزائر في القديم والحديث.');
 for(const next of ['# New chapter','- New list item','[^1]: Footnote','| Table |','![Figure](image.png)','```js\ncode\n```']) {
  assert.equal(s.m.translationUnits('<!--ocrflow-page:1-->\n\nUnfinished text\n\n<!--ocrflow-page:2-->\n\n'+next,settings).length,2);
 }
 assert.equal(s.m.translationUnits('<!--ocrflow-page:1-->\n\nComplete paragraph.\n\n<!--ocrflow-page:2-->\n\nAnother paragraph.',settings).length,2);
 assert.equal(s.m.translationUnits('Two real paragraphs\n\nwithout any page boundary',settings).length,2);
 assert.equal(s.m.translationUnits('<!--ocrflow-page:1-->\n\nUnfinished\n\n<!--ocrflow-page:3-->\n\nmissing page in between',settings).length,2);
});

test('bilingual translation sends a cross-page paragraph together and displays all source pages',async()=>{
 const s=setup();s.m.readSourceMarkdown=async()=>({filePath:'/source.md',markdown:'<!--ocrflow-page:1-->\n\nA continuous argument\n\n<!--ocrflow-page:2-->\n\nacross the page boundary.'});s.m.inlineStoredImagesInMarkdownAttachment=async({markdownText})=>({markdownText,embeddedImages:[]});
 let input,saved;s.m.requestDocumentAI=async messages=>{input=JSON.parse(messages[1].content);return JSON.stringify(input.map(item=>({...item,text:'跨页段落的完整译文。'})));};
 s.m.saveTranslationAsMarkdownAttachment=async value=>{saved=value;return s.m.saveDocumentAttachment({libraryID:1,title:'跨页翻译',markdown:value.translatedText,format:'html',pairs:value.pairs});};
 await s.m.runAlignedTranslationTask({settings:{workKind:'translate',contextWindow:32768,translateLanguage:'中文',outputFormat:'html',translationMode:'bilingual'},controller:new AbortController(),mineruSource:{},parentItem:{}});
 assert.equal(input.length,1);assert.equal(input[0].text,'A continuous argument across the page boundary.');assert.equal(saved.pairs.length,1);assert.deepEqual(Array.from(saved.pairs[0].pages),[1,2]);
 const output=[...s.files.entries()].find(([name])=>name.startsWith('/storage/')&&name.endsWith('.html'));
 assert(new TextDecoder().decode(output[1]).includes('PDF 第 1、2 页'));
});
