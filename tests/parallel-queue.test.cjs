const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const gate=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve:()=>resolve()}};
const tick=async()=>{for(let i=0;i<8;i++)await Promise.resolve()};
function setup(){
 const context={AbortController,URL,setTimeout,clearTimeout,Zotero:{debug(){},logError(){},getMainWindow:()=>({AbortController}),Prefs:{get:()=>undefined}}};
 vm.createContext(context);for(const name of ['prompts.js','docflow.js','workflow.js'])vm.runInContext(fs.readFileSync(name,'utf8'),context);
 const m=context.DocFlow;m.refreshParseQueueDialog=()=>{};m.openParseQueueDialog=()=>{};
 const task=(id,kind,settings={})=>({id,kind,state:'queued',title:'Fixture '+id,attachment:{id,getField:()=> 'Fixture '+id},settings:{apiBaseURL:'https://test.invalid/v1',model:'model-a',concurrency:1,...settings}});
 return {m,context,task};
}
test('independent operations and newly submitted work start while a long OCR task is still running',async()=>{
 const {m,task}=setup(),ocr=gate(),summary=gate(),started=[];
 m.runParseTask=async t=>{started.push(t.id);await ocr.promise;return {}};
 m.runDocumentTask=async t=>{started.push(t.id);if(t.id===2)await summary.promise};
 m.runTranslationTask=async t=>{started.push(t.id)};
 m.parseQueue=[task(1,'parse',{parserService:'marker'}),task(2,'summary'),task(3,'summary')];
 const running=m.processParseQueue();assert.deepEqual(started,[1,2]);assert.equal(m.parseQueue[2].state,'queued');
 m.parseQueueNextID=4;await m.enqueueDocumentTasks('translate',[{attachment:{id:4,getField:()=> 'New'}}],{apiBaseURL:'https://test.invalid/v1',model:'model-b'});assert(started.includes(4));
 summary.resolve();await tick();assert(started.includes(3),'a completed summary must release its lane without waiting for OCR');assert.equal(m.parseQueue[0].state,'running');
 ocr.resolve();await running;assert(m.parseQueue.every(t=>t.state==='completed'));assert.equal(m.parseQueueRunning,false);
});
test('same operation with different endpoints or models runs concurrently, while identical lanes retain order',async()=>{
 const {m,task}=setup(),release=gate(),started=[];
 m.runDocumentTask=async t=>{started.push(t.id);if(t.id!==5)await release.promise};
 m.parseQueue=[task(1,'summary'),task(2,'summary',{model:'model-b'}),task(3,'summary',{apiBaseURL:'https://other.invalid/v1'}),task(4,'metadata'),task(5,'summary')];
 const running=m.processParseQueue();assert.deepEqual(started,[1,2,3,4]);assert.equal(m.parseQueue[4].state,'queued');release.resolve();await running;assert.deepEqual(started,[1,2,3,4,5]);
});
test('different OCR providers run concurrently and conflict on the same bibliographic item waits',async()=>{
 const {m,task}=setup(),release=gate(),started=[];
 m.runParseTask=async t=>{started.push(t.id);await release.promise;return {}};m.runDocumentTask=async t=>{started.push(t.id)};
 m.parseQueue=[task(1,'parse',{parserService:'marker',markerSettings:{baseURL:'http://marker.invalid'}}),task(2,'parse',{parserService:'mineru'}),task(3,'summary')];
 m.parseQueue[0].parentItem={id:42};m.parseQueue[2].parentItem={id:42};
 const running=m.processParseQueue();assert.deepEqual(started,[1,2]);release.resolve();await running;assert(started.includes(3));
});
test('canceling one active lane or a queued conflict leaves independent work running',async()=>{
 const {m,task}=setup(),release=gate();
 m.runDocumentTask=async t=>{if(t.id===1)await new Promise((_resolve,reject)=>t.controller.signal.addEventListener('abort',()=>reject(t.controller.signal.reason)));else if(t.id===2)await release.promise};
 m.parseQueue=[task(1,'summary'),task(2,'metadata'),task(3,'summary')];
 const running=m.processParseQueue();await m.cancelParseQueueTask(3);await m.cancelParseQueueTask(1);await tick();assert.equal(m.parseQueue[0].state,'canceled');assert.equal(m.parseQueue[2].state,'canceled');assert.equal(m.parseQueue[1].state,'running');release.resolve();await running;assert.equal(m.parseQueue[1].state,'completed');
});
test('model request concurrency is shared across operations and waiting calls are cancelable',async()=>{
 const {m,context}=setup(),release=gate(),started=[];let active=0,peak=0;
 context.fetch=async(_url,options)=>{const payload=JSON.parse(options.body);started.push(payload.messages[0].content);active++;peak=Math.max(peak,active);await release.promise;active--;return {ok:true,json:async()=>({choices:[{message:{content:'OK'}}]})}};
 const settings={apiBaseURL:'https://test.invalid/v1',model:'same-model',concurrency:2},controller=new AbortController();
 const requests=[m.requestDocumentAI([{role:'user',content:'summary'}],settings),m.requestDocumentAI([{role:'user',content:'translation'}],settings),m.requestDocumentAI([{role:'user',content:'canceled'}],settings,controller.signal)];
 const cancellation=assert.rejects(requests[2],{name:'AbortError'});await tick();assert.equal(started.length,2);controller.abort();await cancellation;release.resolve();await Promise.all(requests.slice(0,2));await tick();assert.equal(peak,2);assert(!started.includes('canceled'));assert.equal(m.aiRequestPools.size,0);
});
test('a busy model does not block another model and a failure releases its request slot',async()=>{
 const {m}=setup(),release=gate(),started=[];
 const first=m.withAIRequestSlot({apiBaseURL:'https://test.invalid',model:'a'},null,async()=>{started.push('a');await release.promise;throw Error('controlled failure')});
 const failure=assert.rejects(first,/controlled failure/);
 const second=m.withAIRequestSlot({apiBaseURL:'https://test.invalid',model:'a'},null,async()=>started.push('a retry'));
 await m.withAIRequestSlot({apiBaseURL:'https://test.invalid',model:'b'},null,async()=>started.push('b'));assert.deepEqual(started,['a','b']);release.resolve();await failure;await second;await tick();assert.deepEqual(started,['a','b','a retry']);assert.equal(m.aiRequestPools.size,0);
});
test('changing a configured model name does not make the old snapshot block the replacement model',async()=>{
 const {m,task}=setup(),release=gate(),started=[];
 m.runDocumentTask=async t=>{started.push(t.settings.model);await release.promise};
 m.parseQueue=[task(1,'summary',{modelID:'provider:1',model:'old'}),task(2,'summary',{modelID:'provider:1',model:'new'})];
 const running=m.processParseQueue();assert.deepEqual(started,['old','new']);release.resolve();await running;
 const pending=gate(),settings={apiBaseURL:'https://test.invalid',modelID:'provider:1'};
 const old=m.withAIRequestSlot({...settings,model:'old'},null,()=>pending.promise);let replacement=false;
 await m.withAIRequestSlot({...settings,model:'new'},null,()=>{replacement=true});assert(replacement);pending.resolve();await old;
});
test('the configured model concurrency also admits multiple documents in the same AI operation',async()=>{
 const {m,task}=setup(),release=gate(),started=[];
 m.runDocumentTask=async t=>{started.push(t.id);await release.promise};
 m.parseQueue=[task(1,'summary',{concurrency:2}),task(2,'summary',{concurrency:2}),task(3,'summary',{concurrency:2})];
 const running=m.processParseQueue();assert.deepEqual(started,[1,2]);release.resolve();await running;assert.deepEqual(started,[1,2,3]);
});
