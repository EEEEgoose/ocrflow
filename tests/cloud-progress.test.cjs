const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
test('batch polling displays true page progress and waits for done even after all pages have been analyzed',async()=>{
 const context={setTimeout,clearTimeout,Zotero:{getMainWindow:()=>({AbortController})}};vm.createContext(context);
 for(const file of ['docflow.js','recognition.js'])vm.runInContext(fs.readFileSync(file,'utf8'),context);
 const m=context.DocFlow,part={dataID:'document',batchID:'batch',uploaded:true,start:0,end:10},states=[],replies=[
  {state:'running',extract_progress:{extracted_pages:0,total_pages:10}},
  {state:'running',extract_progress:{extracted_pages:10,total_pages:10}},
  {state:'done',full_zip_url:'https://example.invalid/result.zip'}
 ];let queries=0,downloads=0;
 m.requestMineruJSON=async()=>({code:0,data:{extract_result:[{data_id:'document',...replies[queries++]}]}});
 m.downloadParseResultZip=async()=>{downloads++;return Uint8Array.of(1)};m.extractNoteContentFromMineruZip=async()=>({markdownText:'result'});
 let resolve;const done=new Promise(r=>resolve=r),row={part,settings:{apiBaseURL:'https://cloud.example',pollIntervalMS:1,timeoutMS:1000},context:{},settled:false,
  progress:()=>states.push({state:part.state,completed:part.completed,saved:!!part.result}),finish:(error)=>{assert.ifError(error);row.settled=true;resolve();}};
 await m.pollCloudRows([row]);await done;
 assert.equal(queries,3);assert.equal(downloads,1);assert.equal(states[0].completed,0);assert.equal(states[1].completed,10);assert.equal(states[1].state,'running');assert.equal(states[1].saved,false);
 assert(part.result);
});
