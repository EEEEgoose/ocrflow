const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');

test('settings task queue omits the manual local MinerU job query',()=>{
 const source=fs.readFileSync('preferences.xhtml','utf8');
 assert(!source.includes('查询本地 MinerU 任务'));
 for(const id of ['mineru-job-id','mineru-job-progress-button','mineru-job-progress-output']) assert(!source.includes('id="'+id+'"'));
 assert(source.includes('id="queue-retry-failed"'));
 assert(source.includes('id="queue-clear"'));
});
