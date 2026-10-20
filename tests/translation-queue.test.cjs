const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

function gate(){let resolve;return {promise:new Promise(r=>resolve=r),resolve:()=>resolve()};}
function setup(texts=['A\n\nB']){
  const settings={apiBaseURL:'https://ai.example/v1',apiKey:'',model:'test',translateLanguage:'中文',translateChunkSize:1,translateConcurrency:2,translateRetryCount:1,outputFormat:'md'};
  const documents=texts.map((text,index)=>({id:index+1,text,getField:()=>`Document ${index+1}`}));
  const calls=[],saves=[],reads=[],details=[];let opened=0,reply=async row=>'T:'+row.text,saveError=false,decision='discard';
  const context={setTimeout,clearTimeout,TextDecoder,Uint8Array,
    Zotero:{debug:()=>{},logError:()=>{},getMainWindow:()=>({AbortController}),ProgressWindow:function(){throw Error('Legacy progress popup must not be used');}},
    fetch:async(url,options)=>{
      const payload=JSON.parse(options.body),row={url,options,payload,text:payload.messages[1].content};calls.push(row);
      const content=await reply(row);return {ok:true,json:async()=>({choices:[{message:{content}}]})};
    }};
  vm.createContext(context);for(const file of ['docflow.js','workflow.js'])vm.runInContext(fs.readFileSync(file,'utf8'),context);
  const plugin=context.DocFlow;
  plugin.getLLMSettings=()=>({...settings});
  plugin.collectTranslateTasks=items=>items.map(source=>({mineruSource:source,parentItem:{id:source.id,libraryID:1,getField:()=>`Book ${source.id}`}}));
  plugin.readSourceMarkdown=async source=>{reads.push(source.id);return {filePath:`/doc-${source.id}.md`,markdown:source.text};};
  plugin.openParseQueueDialog=()=>opened++;
  plugin.refreshParseQueueDialog=()=>details.push(...plugin.parseQueue.map(task=>task.detail));
  plugin.confirmRetryFailedChunks=()=>decision;
  plugin.saveTranslationAsMarkdownAttachment=async data=>{if(saveError)throw Error('disk full');saves.push(data);};
  const start=(items=documents)=>plugin.handleTranslateCommand({selectedItems:items});
  return {plugin,context,settings,documents,calls,saves,reads,details,start,get opened(){return opened;},setReply:fn=>reply=fn,setSaveError:value=>saveError=value,setDecision:value=>decision=value};
}

test('translation enters the shared queue, deduplicates clicks and finishes documents in order',async()=>{
  const s=setup(['A\n\nB','C']),started=gate(),release=gate();
  s.setReply(async row=>{if(row.text==='A'){started.resolve();await release.promise;}return 'T:'+row.text;});
  const running=s.start();await started.promise;
  assert.deepEqual(Array.from(s.plugin.parseQueue,task=>task.state),['running','queued']);
  assert(s.plugin.parseQueue.every(task=>task.kind==='translate'));assert.equal(s.plugin.parseQueue[0].title,'Book 1');
  await s.start([s.documents[0]]);assert.equal(s.plugin.parseQueue.length,2);
  release.resolve();await running;
  assert.deepEqual(Array.from(s.plugin.parseQueue,task=>task.state),['completed','completed']);
  assert.deepEqual(s.saves.map(save=>save.sourceAttachment.id),[1,2]);assert.equal(s.calls.at(-1).text,'C');
  assert(s.details.some(text=>text.includes('/2 段')));assert(s.plugin.parseQueue.every(task=>task.translation===null));
  assert(s.opened>0);assert(s.calls.every(row=>!('Authorization' in row.options.headers)),'local anonymous AI remains supported');
});

test('failed translation retries only missing chunks with refreshed provider settings',async()=>{
  const s=setup();let failing=true;
  s.setReply(async row=>{if(row.text==='B'&&failing)throw Error('model busy');return 'T:'+row.text;});
  await s.start();const task=s.plugin.parseQueue[0];
  assert.equal(task.state,'failed');assert.match(task.error,/model busy/);assert.equal(s.saves.length,0);
  assert.equal(task.translation.parts[0],'T:A');
  failing=false;s.settings.apiKey='updated-key';await s.plugin.retryParseQueueTasks([task.id]);
  assert.equal(task.state,'completed');assert.equal(s.calls.filter(row=>row.text==='A').length,1);assert.equal(s.calls.filter(row=>row.text==='B').length,3);
  assert.equal(s.calls.at(-1).options.headers.Authorization,'Bearer updated-key');assert.equal(s.saves[0].translatedText,'T:A\n\nT:B');
});

test('queued cancellation skips a document and running cancellation aborts all active translation requests',async()=>{
  const s=setup(['A\n\nB\n\nC','D','E']),started=gate();let pending=0;
  s.setReply(row=>{
    if(row.text==='E')return 'T:E';
    return new Promise((resolve,reject)=>{
      row.options.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});
      if(++pending===2)started.resolve();
    });
  });
  const running=s.start();await started.promise;
  await s.plugin.cancelParseQueueTask(s.plugin.parseQueue[1].id);
  await s.plugin.cancelParseQueueTask(s.plugin.parseQueue[0].id);await running;
  assert.deepEqual(Array.from(s.plugin.parseQueue,task=>task.state),['canceled','canceled','completed']);
  assert.deepEqual(s.calls.map(row=>row.text),['A','B','E']);assert(s.calls.slice(0,2).every(row=>row.options.signal.aborted));
  assert.deepEqual(s.saves.map(save=>save.sourceAttachment.id),[3]);assert.match(s.plugin.parseQueue[0].detail,/已终止翻译/);
});

test('retrying a save failure reuses completed translations without calling AI again',async()=>{
  const s=setup();s.setSaveError(true);await s.start();
  const task=s.plugin.parseQueue[0],count=s.calls.length;assert.equal(task.state,'failed');assert.match(task.error,/disk full/);
  s.setSaveError(false);await s.plugin.retryParseQueueTasks([task.id]);
  assert.equal(task.state,'completed');assert.equal(s.calls.length,count);assert.equal(s.saves.length,1);
});

test('a chosen partial output can retry saving without retranslating failed chunks',async()=>{
  const s=setup();s.setDecision('save');s.setSaveError(true);
  s.setReply(async row=>{if(row.text==='B')throw Error('model busy');return 'T:A';});
  await s.start();const task=s.plugin.parseQueue[0],count=s.calls.length;assert.equal(task.state,'failed');
  s.setSaveError(false);await s.plugin.retryParseQueueTasks([task.id]);
  assert.equal(task.state,'completed');assert.equal(s.calls.length,count);assert.match(task.detail,/已保存部分译文 1\/2/);
  assert.equal(s.saves[0].partial.completed,1);assert(s.saves[0].translatedText.includes('未翻译\n\nB'));
});

test('changing the target language starts fresh instead of mixing cached languages',async()=>{
  const s=setup();let failing=true;
  s.setReply(async row=>{if(row.text==='B'&&failing)throw Error('busy');return 'T:'+row.text;});
  await s.start();failing=false;s.settings.translateLanguage='English';
  await s.plugin.retryParseQueueTasks([s.plugin.parseQueue[0].id]);
  assert.equal(s.plugin.parseQueue[0].state,'completed');assert.equal(s.calls.filter(row=>row.text==='A').length,2);
  assert(s.calls.at(-1).payload.messages[0].content.includes('into English'));assert.equal(s.saves[0].language,'English');
});

test('translation timeout aborts the underlying HTTP request',async()=>{
  const s=setup(),started=gate();let expire;
  s.context.setTimeout=callback=>{expire=callback;return 1;};s.context.clearTimeout=()=>{};
  s.setReply(row=>new Promise((resolve,reject)=>{row.options.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});started.resolve();}));
  const running=s.plugin.callLLMForTranslation('A','中文',s.settings,1,1);await started.promise;expire();
  await assert.rejects(running,{name:'TimeoutError'});assert(s.calls[0].options.signal.aborted);
});
