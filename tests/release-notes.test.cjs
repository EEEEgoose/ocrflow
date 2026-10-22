const {test}=require('node:test');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');

function render(current,previous,version='1.3.5',previousRef='v1.3.4') {
 return spawnSync('python3',['-c','import json,sys; from release_notes import render; print(render(*json.load(sys.stdin)))'],{input:JSON.stringify([current,previous,version,previousRef]),encoding:'utf8'});
}
test('Release notes include only new entries and separate features from fixes',()=>{
 const old='## 1.3.4\n- Existing fix\n';
 const result=render('## 1.3.5\n### 新增功能\n- Unified deployment guide\n### 修复问题\n- Correct usage manual\n'+old,old);
 assert.equal(result.status,0,result.stderr);assert(result.stdout.includes('## 新增功能\n\n- Unified deployment guide'));assert(result.stdout.includes('## 修复问题\n\n- Correct usage manual'));assert(!result.stdout.includes('Existing fix'));assert(result.stdout.includes('compare/v1.3.4...v1.3.5'));
});
test('Release extraction follows actual tagged contents instead of assuming matching package and development versions',()=>{
 const old='## 1.2.9\n- Old development record\n';
 const result=render('## 1.2.10\n### 修复问题\n- Rate limit recovery\n'+old,old,'1.2.4','v1.2.3');
 assert.equal(result.status,0,result.stderr);assert(result.stdout.includes('Rate limit recovery'));assert(!result.stdout.includes('Old development record'));assert(result.stdout.includes('本次未新增功能'));
});
test('empty or unclassified Release changes stop publication instead of producing misleading notes',()=>{
 const unchanged=render('## 1.3.4\n- Same\n','## 1.3.4\n- Same\n');assert.notEqual(unchanged.status,0);assert(unchanged.stderr.includes('没有新增更新记录'));
 const missing=render('## 1.3.5\n- Unclassified change\n','');assert.notEqual(missing.status,0);assert(missing.stderr.includes('### 新增功能'));
});
