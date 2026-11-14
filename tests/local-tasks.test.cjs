const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const base='https://mineru.invalid/proxy';
function setup({cached=false,external=false}={}){
 const calls=[],statuses=[],checkpoints=[];let polls=0,reads=0;
 const file={file_id:'file-1',file_name:'paper.pdf'};
 const context={URL,Headers,Uint8Array,AbortController,setTimeout,clearTimeout,
  IOUtils:{read:async()=>{reads++;return Uint8Array.of(1,2,3)}},
  Zotero:{Prefs:{get(){},set(){}},getMainWindow:()=>({AbortController}),debug(){},logError(){}},
  fetch:async(url,options={})=>{
   calls.push({url,options});let body;
   if(url===base+'/v1/health')body={version:'4.1.0',features:{task_output_formats:['default','html']}};
   else if(url===base+'/v1/tasks'&&options.method==='POST'){
    assert.deepEqual(JSON.parse(options.body),{files:[{file_name:'paper.pdf',bytes:3}],tier:'standard',output_formats:['default']});
    body={task_id:'job/a',status:cached?'pending':'waiting-file',files:[{...file,status:cached?'pending':'waiting-file',...(!cached?{upload:{url:base+'/upload',headers:{'X-Upload':'yes'}}}:{})}]};
   }else if(url===base+'/v1/tasks/job%2Fa'){
    polls++;
    body={task_id:'job/a',status:polls===1&&!cached?'waiting-file':'completed',progress:{completed:polls===1&&!cached?0:1,failed:0,total:1},
     files:[{...file,status:polls===1&&!cached?'waiting-file':'completed',...(polls===1&&!cached?{upload:{url:base+'/upload',headers:{'X-Upload':'yes'}}}:{result_url:external?'https://storage.invalid/result.zip':base+'/v1/files/file-1/content'})}]};
   }else if(url===base+'/upload'){assert.equal(options.method,'PUT');assert.equal(new Headers(options.headers).get('X-Upload'),'yes');body={status:'pending'};}
   else if(url.endsWith('/cancel')){assert.equal(options.method,'POST');body={status:'canceled',files:[{...file,status:'canceled'}]};}
   else if(url.endsWith('/content')||url.endsWith('/result.zip'))return {ok:true,status:200,arrayBuffer:async()=>Uint8Array.of(80,75).buffer};
   else throw Error('Unexpected '+url);
   return {ok:true,status:200,text:async()=>JSON.stringify(body)};
  }};
 vm.createContext(context);vm.runInContext(fs.readFileSync('docflow.js','utf8'),context);
 const m=context.DocFlow;m.delayParsePoll=async()=>{};m.refreshParseQueueDialog=()=>{};
 m.extractNoteContentFromMineruZip=async()=>({markdownText:'done'});
 const settings={parserService:'mineru',apiMode:'local-v1',apiBaseURL:base,apiToken:'fixture',modelVersion:'standard',pollIntervalMS:5000,localJobTimeoutMS:60000};
 const state={};const options={localTaskState:state,onStatus:status=>statuses.push(status),checkpoint:async()=>checkpoints.push({...state})};
 const attachment={id:1,getFilePath:async()=>'/paper.pdf',attachmentFilename:'paper.pdf'};
 return {m,context,calls,statuses,settings,options,state,attachment,checkpoints,reads:()=>reads};
}
test('MinerU 4.1 creates JSON Tasks, checkpoints IDs, uploads missing bytes and downloads a per-file ZIP',async()=>{
 const s=setup();assert.equal((await s.m.parseAttachmentWithMineru(s.attachment,s.settings,s.options)).markdownText,'done');
 assert.equal(s.calls.filter(call=>call.options.method==='PUT').length,1);
 assert(!s.calls.some(call=>/\/v1\/uploads|\/parse\/jobs|\/complete$/.test(call.url)));
 assert.equal(s.state.fileID,'file-1');assert(s.checkpoints.some(state=>state.fileID==='file-1'));
 assert(s.statuses.some(status=>status.jobID==='job/a'));assert.equal(s.reads(),1);
});
test('MinerU 4.1 resumes an existing task without reading or uploading the source',async()=>{
 const s=setup({cached:true});s.options.jobID='job/a';
 assert.equal((await s.m.parseAttachmentWithMineru(s.attachment,s.settings,s.options)).markdownText,'done');
 assert.equal(s.reads(),0);assert(!s.calls.some(call=>call.options.method==='POST'||call.options.method==='PUT'));
});
test('MinerU 4.1 result downloads omit the API credential for external storage',async()=>{
 const s=setup({cached:true,external:true});await s.m.parseAttachmentWithMineru(s.attachment,s.settings,s.options);
 const download=s.calls.find(call=>call.url.startsWith('https://storage.invalid'));
 assert.equal(new Headers(download.options.headers).has('Authorization'),false);
});
test('MinerU 4.1 cancellation uses POST Tasks cancel',async()=>{
 const s=setup();const task={kind:'parse',state:'running',settings:{...s.settings,localAPIProtocol:'tasks'},jobID:'job/a'};
 await s.m.finishParseQueueCancellation(task);
 assert(s.calls.some(call=>call.url===base+'/v1/tasks/job%2Fa/cancel'&&call.options.method==='POST'));
 assert.equal(task.cancelFailed,false);assert.equal(task.state,'canceled');
});

test('a restored successful PUT is not repeated while its task still reports waiting-file',async()=>{
 const s=setup();s.options.jobID='job/a';Object.assign(s.state,{fileID:'file-1',uploaded:true});
 await s.m.parseAttachmentWithMineru(s.attachment,s.settings,s.options);
 assert.equal(s.reads(),0);assert(!s.calls.some(call=>call.options.method==='PUT'));
});
test('waiting-file without an upload action is polled without uploading',async()=>{
 const s=setup(),fetch=s.context.fetch;s.options.jobID='job/a';
 s.context.fetch=async(url,options)=>{
  const response=await fetch(url,options);
  if(url===base+'/v1/tasks/job%2Fa'){
   const body=JSON.parse(await response.text());delete body.files[0].upload;
   return {...response,text:async()=>JSON.stringify(body)};
  }return response;
 };
 await s.m.parseAttachmentWithMineru(s.attachment,s.settings,s.options);
 assert.equal(s.reads(),0);assert(!s.calls.some(call=>call.options.method==='PUT'));
});
test('query errors preserve the task ID and never cause automatic task creation',async()=>{
 const s=setup(),fetch=s.context.fetch;s.options.jobID='job/a';
 s.context.fetch=async(url,options)=>url===base+'/v1/tasks/job%2Fa'
  ? {ok:false,status:503,text:async()=>'temporarily unavailable'} : fetch(url,options);
 await assert.rejects(s.m.parseAttachmentWithMineru(s.attachment,s.settings,s.options),/503/);
 assert(!s.calls.some(call=>call.options.method==='POST'));
});
test('per-file failure messages propagate without resubmitting a new task',async()=>{
 const s=setup(),fetch=s.context.fetch;
 s.context.fetch=async(url,options)=>url===base+'/v1/tasks/job%2Fa'
  ? {ok:true,status:200,text:async()=>JSON.stringify({task_id:'job/a',status:'failed',files:[{file_id:'file-1',status:'failed',error:{code:'parse_failed',message:'controlled parse failure'}}]})} : fetch(url,options);
 await assert.rejects(s.m.parseAttachmentWithMineru(s.attachment,s.settings,s.options),/controlled parse failure/);
 assert.equal(s.calls.filter(call=>call.options.method==='POST').length,1);
});
test('canceling during task submission retains the returned task ID for server cancellation',async()=>{
 const s=setup(),fetch=s.context.fetch,controller=new AbortController();s.options.signal=controller.signal;
 s.context.fetch=async(url,options)=>{
  const response=await fetch(url,options);
  if(url===base+'/v1/tasks'){assert.equal(options.signal,undefined);controller.abort();}
  return response;
 };
 await assert.rejects(s.m.parseAttachmentWithMineru(s.attachment,s.settings,s.options),{name:'AbortError'});
 assert(s.statuses.some(status=>status.jobID==='job/a'));assert.equal(s.state.fileID,'file-1');
 const task={kind:'parse',settings:s.settings,jobID:'job/a'};await s.m.finishParseQueueCancellation(task);
 assert(s.calls.some(call=>call.url.endsWith('/cancel')));
});

test('local Tasks waiting timeout preserves the existing task for continuation',async()=>{
 const s=setup(),fetch=s.context.fetch;let elapsed=0;
 s.context.Date={now:()=>elapsed};s.settings.localJobTimeoutMS=5;
 s.options.jobID='job/a';Object.assign(s.state,{fileID:'file-1',uploaded:true});
 s.m.delayParsePoll=async()=>{elapsed=10};
 s.context.fetch=async(url,options)=>{
  const response=await fetch(url,options);
  if(url===base+'/v1/tasks/job%2Fa'){
   const body=JSON.parse(await response.text());body.status='pending';body.files[0].status='pending';
   return {...response,text:async()=>JSON.stringify(body)};
  }return response;
 };
 await assert.rejects(s.m.parseAttachmentWithMineru(s.attachment,s.settings,s.options),{name:'MineruJobWaitTimeout'});
 assert(!s.calls.some(call=>call.options.method==='POST'||call.options.method==='PUT'));
 assert(s.statuses.some(status=>status.jobID==='job/a'));
});

test('local Tasks upload names use the existing filename sanitizer',async()=>{
 const s=setup(),fetch=s.context.fetch;s.attachment.attachmentFilename='paper:.pdf';
 s.context.fetch=async(url,options)=>{
  if(url===base+'/v1/tasks'){
   const body=JSON.parse(options.body);assert.equal(body.files[0].file_name,'paper_.pdf');
   body.files[0].file_name='paper.pdf';options={...options,body:JSON.stringify(body)};
  }return fetch(url,options);
 };
 await s.m.parseAttachmentWithMineru(s.attachment,s.settings,s.options);
});
