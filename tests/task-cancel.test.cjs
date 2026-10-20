const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path').posix;
const base = 'http://local.example:8000';
function gate() { let resolve; const promise = new Promise(r => resolve = r); return {promise, resolve}; }
function pendingRequest(signal) {
  signal.throwIfAborted();
  return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), {once: true}));
}
function fixture({mode = 'local-v1', lateSubmit = false, uploadPending = false, deleteStatus = 200, firstCompleted = false} = {}) {
  const reached = gate(), submission = gate(), saving = gate(), saved = gate();
  const calls = [], saves = [], files = new Map();
  let jobs = 0, stopStatus = deleteStatus, remoteCanceled = false, saveBlocked = false;
  const complete = {status: 'completed', files: [{status: 'completed', output_files: {zip: {file_id: 'output'}}}]};
  const context = {
    setTimeout, clearTimeout, URL, Headers, Uint8Array, btoa,
    PathUtils: {join: path.join, parent: path.dirname},
    IOUtils: {read: async () => Uint8Array.from([1, 2]), exists: async key => files.has(key), readUTF8: async key => files.get(key), makeDirectory: async () => {}, writeUTF8: async (key, value) => files.set(key, value)},
    Zotero: {getMainWindow: () => ({AbortController}), Prefs: {get: () => undefined, set: () => {}}, DataDirectory: {dir: '/data'}, Reader: {_readers: []}, debug: () => {}, logError: error => { throw error; }},
    fetch: async (url, options = {}) => {
      calls.push({url, options});
      let reply, status = 200;
      if (url.endsWith('/v1/uploads')) reply = uploadPending
        ? {status: 'pending', id: 'upload', upload_url: '/upload', upload_method: 'PUT'} : {status: 'completed', file: {id: 'input'}};
      else if (url.endsWith('/upload')) { reached.resolve(); return await pendingRequest(options.signal); }
      else if (url.endsWith('/v1/parse/jobs')) {
        jobs++;
        assert.equal(options.signal, undefined, 'Job submission must finish to retain its ID');
        if (lateSubmit && jobs === 1) { reached.resolve(); await submission.promise; }
        reply = jobs > 1 || firstCompleted ? {...complete, job_id: 'job-' + jobs} : {job_id: 'job-1', status: 'running'};
      }
      else if (url.endsWith('/v1/parse/jobs/job-1') && options.method === 'DELETE') {
        status = stopStatus;
        if (status === 200) remoteCanceled = true;
        reply = status === 200 ? {status: 'canceled'} : {error: 'Cancellation rejected'};
      }
      else if (url.endsWith('/v1/parse/jobs/job-1')) reply = remoteCanceled ? {status: 'canceled'} : complete;
      else if (url.endsWith('/file-urls/batch')) reply = {code: 0, data: {batch_id: 'cloud-job', file_urls: ['https://upload.example/content']}};
      else if (url === 'https://upload.example/content') reply = {};
      else if (url.includes('/extract-results/batch/')) { reached.resolve(); return await pendingRequest(options.signal); }
      else if (url.endsWith('/chat/completions')) { reached.resolve(); return await pendingRequest(options.signal); }
      else if (!url.endsWith('/v1/files/output/content')) throw Error('Unexpected request: ' + url);
      return {ok: status === 200, status, text: async () => JSON.stringify(reply), arrayBuffer: async () => Uint8Array.from([80, 75]).buffer};
    }
  };
  vm.createContext(context);
  assert.equal(vm.runInContext('typeof AbortController', context), 'undefined');
  for (const file of ['docflow.js', 'workflow.js', 'outline.js']) vm.runInContext(fs.readFileSync(file, 'utf8'), context);
  const plugin = context.DocFlow;
  plugin.openParseQueueDialog = () => {};
  plugin.getSettings = () => ({apiMode: mode, apiBaseURL: base, apiToken: 'test-token', modelVersion: mode === 'local-v1' ? 'advanced' : 'vlm', pollIntervalMS: 5000, timeoutMS: 60000, localJobTimeoutMS: 0});
  plugin.getLLMSettings = () => ({apiBaseURL: 'https://llm.example/v1', apiKey: 'test-key', model: 'model'});
  plugin.collectSourceFiles = items => items;
  plugin.extractNoteContentFromMineruZip = async () => ({markdownText: 'done'});
  plugin.saveResultAsMarkdownAttachment = async ({attachment}) => { saving.resolve(); if (saveBlocked) await saved.promise; saves.push(attachment.id); return {}; };
  plugin.refreshParseQueueDialog = () => {
    const task = plugin.parseQueue[0];
    if (!lateSubmit && !uploadPending && mode === 'local-v1' && task?.jobID && task.state === 'running') reached.resolve();
  };
  plugin.getPDFLibrary = () => ({PDFDocument: {
    load: async () => ({getPageCount: () => 304, getPageIndices: () => Array.from({length: 304}, (_, i) => i)}),
    create: async () => ({copyPages: async () => [{}], addPage: () => {}, save: async () => Uint8Array.from([1])})
  }});
  const attachment = id => ({id, key: 'PDF-' + id, libraryID: 1, getField: () => 'book-' + id + '.pdf', getFilePath: () => '/book-' + id + '.pdf'});
  return {plugin, context, calls, saves, attachment, reached, submission, saving, saved,
    setDeleteStatus: value => stopStatus = value, blockSaving: () => saveBlocked = true};
}

async function run() {
  // A queued task never uploads; canceling one item lets the next item run.
  const local = fixture();
  const running = local.plugin.handleParseCommand({selectedItems: [local.attachment(1), local.attachment(2), local.attachment(3)]});
  await local.reached.promise;
  await local.plugin.cancelParseQueueTask(2);
  assert.equal(local.plugin.parseQueue[1].state, 'canceled');
  await local.plugin.cancelParseQueueTask(1);
  await running;
  assert.deepEqual(Array.from(local.plugin.parseQueue, task => task.state), ['canceled', 'canceled', 'completed']);
  assert.deepEqual(local.saves, [3]);
  const deletes = local.calls.filter(call => call.options.method === 'DELETE');
  assert.equal(deletes.length, 1);
  assert.equal(deletes[0].url, base + '/v1/parse/jobs/job-1');
  assert.equal(deletes[0].options.headers.get('Authorization'), 'Bearer test-token');
  assert(!local.plugin.parseQueue[0].parsedResult);
  await local.plugin.retryParseQueueTasks([1]);
  assert.equal(local.plugin.parseQueue[0].state, 'completed');
  assert.equal(local.calls.filter(call => call.url.endsWith('/v1/parse/jobs')).length, 3);

  // Cancellation during POST waits for the ID, then cancels that exact job.
  const late = fixture({lateSubmit: true});
  const lateRun = late.plugin.handleParseCommand({selectedItems: [late.attachment(1)]});
  await late.reached.promise;
  await late.plugin.cancelParseQueueTask(1);
  assert.equal(late.plugin.parseQueue[0].state, 'stopping');
  assert(!late.calls.some(call => call.options.method === 'DELETE'));
  late.submission.resolve(); await lateRun;
  assert.equal(late.plugin.parseQueue[0].jobID, 'job-1');
  assert.equal(late.plugin.parseQueue[0].state, 'canceled');
  assert.equal(late.calls.filter(call => call.options.method === 'DELETE').length, 1);
  assert.deepEqual(late.saves, []);

  const upload = fixture({uploadPending: true});
  const uploadRun = upload.plugin.handleParseCommand({selectedItems: [upload.attachment(1)]});
  await upload.reached.promise; await upload.plugin.cancelParseQueueTask(1); await uploadRun;
  assert.equal(upload.plugin.parseQueue[0].state, 'canceled');
  assert(!upload.calls.some(call => call.url.endsWith('/v1/parse/jobs')));

  // Report cancellation failures honestly and allow an explicit second attempt.
  const failed = fixture({deleteStatus: 503});
  const failedRun = failed.plugin.handleParseCommand({selectedItems: [failed.attachment(1)]});
  await failed.reached.promise; await failed.plugin.cancelParseQueueTask(1); await failedRun;
  assert(failed.plugin.parseQueue[0].cancelFailed);
  assert.match(failed.plugin.parseQueue[0].detail, /未能确认服务端取消/);
  failed.setDeleteStatus(200); await failed.plugin.cancelParseQueueTask(1);
  assert.equal(failed.plugin.parseQueue[0].cancelFailed, false);
  assert.equal(failed.calls.filter(call => call.options.method === 'DELETE').length, 2);

  for (const status of [404, 409]) {
    const finished = fixture({deleteStatus: status});
    const operation = finished.plugin.handleParseCommand({selectedItems: [finished.attachment(1)]});
    await finished.reached.promise; await finished.plugin.cancelParseQueueTask(1); await operation;
    assert.equal(finished.plugin.parseQueue[0].state, 'canceled');
    assert.equal(finished.plugin.parseQueue[0].cancelFailed, false);
    assert.deepEqual(finished.saves, []);
    assert.match(finished.plugin.parseQueue[0].detail, status === 404 ? /不存在/ : /已结束/);
  }

  // Wait-expired jobs can still be canceled without restarting the worker.
  const waiting = fixture();
  waiting.plugin.parseQueue.push({id: 1, kind: 'parse', state: 'wait_expired', settings: waiting.plugin.getSettings(), jobID: 'job-1'});
  await waiting.plugin.cancelParseQueueTask(1);
  assert.equal(waiting.plugin.parseQueue[0].state, 'canceled');
  assert.equal(waiting.calls.length, 1);

  const cloud = fixture({mode: 'cloud'});
  const cloudRun = cloud.plugin.handleParseCommand({selectedItems: [cloud.attachment(1)]});
  await cloud.reached.promise; await cloud.plugin.cancelParseQueueTask(1); await cloudRun;
  assert.equal(cloud.plugin.parseQueue[0].state, 'canceled');
  assert.match(cloud.plugin.parseQueue[0].detail, /云端任务可能继续运行/);
  assert.equal(cloud.calls.filter(call => call.url.endsWith('/file-urls/batch')).length, 1);
  assert(!cloud.calls.some(call => call.options.method === 'DELETE'));
  assert.deepEqual(cloud.saves, []);

  const outline = fixture();
  const feature = outline.context.DocFlowOutline;
  feature.init(outline.plugin); outline.plugin.outline = feature;
  await feature.storeSource(outline.attachment(1), {outlinePages: ['第一章\n正文'], outlineHeadings: []});
  feature.enqueue(outline.attachment(1), true);
  const outlineRun = outline.plugin.processParseQueue();
  await outline.reached.promise; await outline.plugin.cancelParseQueueTask(1); await outlineRun;
  assert.equal(outline.plugin.parseQueue[0].state, 'canceled');
  assert.equal((await feature.load(outline.attachment(1))).outline.length, 0);
  assert.equal(outline.calls.filter(call => call.url.endsWith('/chat/completions')).length, 1);
  assert(!outline.calls.some(call => call.options.method === 'DELETE'));

  // Once attachment saving begins, the operation completes without a partial cancellation.
  const saving = fixture({firstCompleted: true}); saving.blockSaving();
  const saveRun = saving.plugin.handleParseCommand({selectedItems: [saving.attachment(1)]});
  await saving.saving.promise;
  assert(saving.plugin.parseQueue[0].saving);
  await saving.plugin.cancelParseQueueTask(1);
  assert.equal(saving.plugin.parseQueue[0].state, 'running');
  assert(!saving.plugin.parseQueue[0].controller.signal.aborted);
  saving.saved.resolve(); await saveRun;
  assert.equal(saving.plugin.parseQueue[0].state, 'completed');
  console.log('PASS: queued/running cancellation, late job IDs, upload interruption, retry, cancel errors, expired waits, cloud segments, LLM outlines and save completion.');
}
run().catch(error => {console.error(error); process.exitCode = 1;});
