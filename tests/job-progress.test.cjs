const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const calls = [], prefs = new Map([
  ['extensions.docflow.apiMode', 'local-v1'],
  ['extensions.docflow.apiBaseURL', 'http://127.0.0.1:41835'],
  ['extensions.docflow.lastLocalJobID', 'job-existing']
]);
const inputs = new Map([
  ['mineru-job-id', {value: ''}],
  ['mineru-job-progress-output', {textContent: ''}],
  ['mineru-job-progress-button', {id:'mineru-job-progress-button',textContent:'查询任务进度',disabled:false,setAttribute(){}}]
]);
let reply = {
  job_id: 'job-existing', status: 'running', tier: 'advanced',
  created_at: '2026-10-01T00:00:00Z',
  progress: {completed: 0, failed: 0, total: 1},
  files: [{name: 'book.pdf', status: 'running'}]
};
let httpStatus = 200;
const context = {
  AbortController, setTimeout, clearTimeout, Date,
  Zotero: {Prefs: {get: key => prefs.get(key)}},
  fetch: async (url, options) => {
    calls.push({url, options});
    return {ok: httpStatus === 200, status: httpStatus, text: async () => JSON.stringify(reply)};
  }
};
vm.createContext(context);
vm.runInContext(fs.readFileSync('preferences.js', 'utf8'), context);
const panel = context.DocFlowPreferences;
panel.$ = id => inputs.get(id);
panel.saveSettings = () => true;
for (const field of panel.FIELDS) {
  if (!inputs.has(field.id)) inputs.set(field.id, {value: String(prefs.get(panel.PREF_BRANCH + field.pref) || ''), checked: false});
}

async function run() {
  await panel.queryJobProgress();
  assert.equal(calls[0].url, 'http://127.0.0.1:41835/v1/parse/jobs/job-existing');
  assert.equal(calls[0].options.method, 'GET');
  assert.match(inputs.get('mineru-job-progress-output').textContent, /解析中 \(running\)/);
  assert.match(inputs.get('mineru-job-progress-output').textContent, /已完成文件: 0\/1/);
  assert.match(inputs.get('mineru-job-progress-output').textContent, /已用时:/);
  assert.equal(inputs.get('mineru-job-progress-button').disabled, false);

  reply.files[0].page_progress = {completed: 128, total: 304, remaining: 176, stage: 'processing'};
  await panel.queryJobProgress();
  assert.match(inputs.get('mineru-job-progress-output').textContent, /已处理页面: 128\/304，剩余: 176/);
  assert.match(inputs.get('mineru-job-progress-output').textContent, /阶段: 页面处理/);
  reply.files[0].page_progress = {completed: 304, total: 304, remaining: 0, stage: 'exporting'};
  await panel.queryJobProgress();
  assert.match(inputs.get('mineru-job-progress-output').textContent, /阶段: 生成结果/);
  assert.match(inputs.get('mineru-job-progress-output').textContent, /解析中 \(running\)/);

  inputs.get('mineru-job-id').value = 'job-other';
  reply.status = 'failed';
  reply.progress = {completed: 0, failed: 1, total: 1};
  reply.files = [{name: 'book.pdf', status: 'failed', error: {message: 'Parser error'}}];
  await panel.queryJobProgress();
  assert(calls[3].url.endsWith('/job-other'));
  assert.match(inputs.get('mineru-job-progress-output').textContent, /Parser error/);
  assert.match(inputs.get('mineru-job-progress-output').textContent, /失败: 1/);

  httpStatus = 404;
  await panel.queryJobProgress();
  assert.match(inputs.get('mineru-job-progress-output').textContent, /查询失败: HTTP 404/);
  assert.equal(inputs.get('mineru-job-progress-button').disabled, false);
  assert(calls.every(call => call.options.method === 'GET'));

  prefs.set('extensions.docflow.apiMode', 'cloud');
  inputs.get('mineru-api-mode').value = 'cloud';
  await panel.queryJobProgress();
  assert.equal(calls.length, 5);
  assert.match(inputs.get('mineru-job-progress-output').textContent, /请先选择本地/);
  console.log('PASS: existing-job queries, actual file counts, server errors, and no task resubmission.');
}
run().catch(error => {console.error(error); process.exitCode = 1;});
