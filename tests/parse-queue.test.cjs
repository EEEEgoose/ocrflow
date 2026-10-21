const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
let opened = 0;
const prefWindow = {document:{readyState:'complete'}, Zotero_Preferences:{
  waitForFirstPaneLoad:async()=>{}, navigateToPane:async()=>{}, getScope:()=>({DocFlowPreferences:{showSection:key=>assert.equal(key,'tasks')}})
}};
const context = {Zotero: {debug: () => {}, logError: () => {},
  PreferencePanes:{pluginPanes:[{pluginID:null,id:'ocrflow-preferences'}]},
  Utilities:{Internal:{openPreferences:id=>{assert.equal(id,'ocrflow-preferences');opened++;return prefWindow;}}},
  getMainWindow:()=>({AbortController})}};
vm.createContext(context);
for (const name of ['prompts.js','docflow.js', 'workflow.js']) vm.runInContext(fs.readFileSync(name, 'utf8'), context);
const plugin = context.DocFlow;
plugin.getSettings = mode => ({apiMode: mode || 'local-v1', apiToken: ''});
plugin.collectSourceFiles = items => items;
const file = id => ({id, libraryID: 1, getField: () => 'file-' + id, getFilePath: () => '/file-' + id + '.pdf'});
const parseCalls = [], saveCalls = [];
let releaseFirst, releaseRetry, releaseAfterClear;
const firstGate = new Promise(resolve => releaseFirst = resolve);
const retryGate = new Promise(resolve => releaseRetry = resolve);
const clearGate = new Promise(resolve => releaseAfterClear = resolve);
let active = 0, secondAttempts = 0, thirdSaves = 0;
plugin.parseAttachmentWithMineru = async (attachment, _settings, options) => {
  active++;
  assert.equal(active, 1, 'More than one queue item is executing');
  parseCalls.push(attachment.id);
  options.onStatus({jobID: 'job-' + attachment.id, displayText: 'Parsing file ' + attachment.id});
  try {
    if (attachment.id === 1) await firstGate;
    if (attachment.id === 5) await clearGate;
    if (attachment.id === 2) {
      secondAttempts++;
      if (secondAttempts === 1) throw new Error('Server failure');
      assert.equal(options.jobID, 'job-2');
      await retryGate;
    }
    if (attachment.id === 4 && !options.jobID) {
      const error = new Error('Wait limit reached'); error.name = 'MineruJobWaitTimeout'; throw error;
    }
    if (attachment.id === 4) assert.equal(options.jobID, 'job-4');
    return {markdownText: 'result-' + attachment.id};
  }
  finally {active--;}
};
plugin.saveResultAsMarkdownAttachment = async ({attachment}) => {
  saveCalls.push(attachment.id);
  if (attachment.id === 3 && ++thirdSaves === 1) throw new Error('Disk full');
  return {};
};
async function run() {
  const deadView = new Proxy({}, {get(){throw new TypeError("can't access dead object");}});
  plugin.parseQueueViews.add(deadView);

  const first = plugin.handleParseCommand({selectedItems: [file(1), file(2)]});
  assert.equal(plugin.parseQueue[0].state, 'running');
  assert.equal(plugin.parseQueueViews.has(deadView),false,'a disposed UI view must not stop the queue worker');
  await plugin.handleParseCommand({selectedItems: [file(1), file(3)]});
  assert.equal(plugin.parseQueue.length, 3);
  assert.equal(opened, 2);
  // Leaving preferences does not stop the queue.
  releaseFirst(); await first;
  assert.deepEqual(Array.from(plugin.parseQueue, task => task.state), ['completed', 'failed', 'failed']);
  assert.match(plugin.parseQueue[1].error, /Server failure/);
  assert.equal(plugin.parseQueue[2].parsedResult.markdownText, 'result-3');
  const retries = plugin.retryParseQueueTasks([2, 3]);
  const duplicateClick = plugin.retryParseQueueTasks([2, 3]);
  releaseRetry(); await Promise.all([retries, duplicateClick]);
  assert.deepEqual(Array.from(plugin.parseQueue, task => task.state), ['completed', 'completed', 'completed']);
  assert.deepEqual(parseCalls, [1, 2, 3, 2]);
  assert.deepEqual(saveCalls, [1, 3, 2, 3]);
  assert(plugin.parseQueue.every(task => task.parsedResult === null));
  await plugin.retryParseQueueTasks([1]);
  assert.deepEqual(parseCalls, [1, 2, 3, 2]);
  await plugin.handleParseCommand({selectedItems: [file(4)]});
  assert.equal(opened, 3);
  assert.equal(plugin.parseQueue[3].state, 'wait_expired');
  await plugin.retryParseQueueTasks([4]);
  assert.equal(plugin.parseQueue[3].state, 'completed');
  const afterClear = plugin.handleParseCommand({selectedItems: [file(5)]});
  const runningTask = plugin.parseQueue.find(task => task.attachment.id === 5);
  assert.equal(runningTask.state, 'running');
  const nextID = plugin.parseQueueNextID;
  plugin.clearParseQueueTasks();
  assert.equal(plugin.parseQueue.length, 1);
  assert.equal(plugin.parseQueue[0], runningTask);
  assert.equal(plugin.parseQueueNextID, nextID);
  releaseAfterClear(); await afterClear;
  assert.equal(runningTask.state, 'completed');
  assert.equal(saveCalls.at(-1), 5);
  plugin.clearParseQueueTasks();
  assert.equal(plugin.parseQueue.length, 0);
  const createController = plugin.createAbortController.bind(plugin);
  let failSetup = true;
  plugin.createAbortController = () => {
    if (failSetup) { failSetup = false; throw new Error('Controller setup failed'); }
    return createController();
  };
  await plugin.handleParseCommand({selectedItems: [file(6), file(7)]});
  assert.deepEqual(Array.from(plugin.parseQueue, task => task.state), ['failed', 'completed']);
  assert.match(plugin.parseQueue[0].error, /Controller setup failed/);
  assert.equal(plugin.parseQueue[0].active, false);
  assert.equal(plugin.parseQueueRunning, false);
  console.log('PASS: settings queue navigation, sequential queue, additions during work, failure retries, save-only retry, no duplicate clicks, and wait continuation.');
}
run().catch(error => {console.error(error); process.exitCode = 1;});
