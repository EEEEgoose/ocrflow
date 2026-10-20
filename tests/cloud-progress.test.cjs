const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

test('cloud polling displays real page counts when available and completes only on done',async()=>{
  const context={};vm.createContext(context);vm.runInContext(fs.readFileSync('docflow.js','utf8'),context);
  const plugin=context.DocFlow,states=[],replies=[
    {state:'running',extract_progress:{extracted_pages:0,total_pages:10}},
    {state:'running',extract_progress:{extracted_pages:10,total_pages:10}},
    {state:'done',full_zip_url:'https://example.test/result.zip'}
  ];
  let queries=0;
  plugin.requestMineruJSON=async()=>({code:0,data:{extract_result:[{data_id:'document',...replies[queries++]}]}});
  plugin.delayParsePoll=async()=>{};
  const result=await plugin.pollMineruExtractResult({apiBaseURL:'https://cloud.example',batchID:'batch',dataID:'document',timeoutMS:10000,pollIntervalMS:0,statusContext:{phase:'等待解析',onStatus:state=>states.push(state)}});
  assert(states[0].displayText.includes('0/10 页'));assert(states[1].displayText.includes('10/10 页'));
  assert.equal(queries,3,'100% page analysis must not finish the job before export completes');
  assert.equal(result.state,'done');assert(!states[2].displayText.includes('10/10 页'));
});
