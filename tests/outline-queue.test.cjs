const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path').posix;
const assert = require('node:assert/strict');
const files = new Map();
let parses = 0, saves = 0, attempts = 0;
let failCache = false;
const context = {
	AbortController,
  PathUtils: {join: path.join, parent: path.dirname},
  IOUtils: {exists: async key => files.has(key), readUTF8: async key => files.get(key), makeDirectory: async () => {}, writeUTF8: async (key, value) => {
    if (failCache && JSON.parse(value).outline.length) throw new Error('Disk full');
    files.set(key, value);
  }},
  Zotero: {getMainWindow: () => ({AbortController}), Prefs: {get: () => undefined}, DataDirectory: {dir: '/data'}, Reader: {_readers: []}, debug: () => {}, logError: () => {}},
  fetch: async () => {
    attempts++;
    if (attempts === 1) return {ok: false, status: 503, text: async () => 'busy'};
    return {ok: true, json: async () => ({choices: [{message: {content: '{"outline":[{"title":"第一章","level":1,"summary":"摘要","page":1}]}'}}]})};
  }
};
vm.createContext(context);
for (const file of ['prompts.js','docflow.js', 'workflow.js', 'outline.js']) vm.runInContext(fs.readFileSync(file, 'utf8'), context);
const owner = context.DocFlow, feature = context.DocFlowOutline;
owner.outline = feature; feature.init(owner);
const attachment = {id: 1, key: 'PDF', libraryID: 1, isPDFAttachment: () => true, getField: () => 'book.pdf', getFilePath: () => '/book.pdf'};
owner.openParseQueueDialog = () => {};
owner.getSettings = () => ({apiMode: 'local-v1'});
owner.getLLMSettings = () => ({apiBaseURL: 'https://llm.example/v1', model: 'model', apiKey: 'key'});
owner.collectSourceFiles = () => [attachment];
owner.parseAttachmentWithMineru = async () => {parses++; return {outlinePages: ['第一章\n正文'], outlineHeadings: [{title: '第一章', page: 1, level: 1}], markdownText: '# 第一章'};};
owner.saveResultAsMarkdownAttachment = async () => {saves++; return {};};
async function run() {
  await owner.handleParseCommand({selectedItems: []});
  assert.equal(owner.parseQueue.length, 2);
  assert.equal(owner.parseQueue[0].state, 'completed');
  assert.equal(owner.parseQueue[1].kind, 'outline');
  assert.equal(owner.parseQueue[1].state, 'completed');
  await owner.retryParseQueueTasks([owner.parseQueue[1].id]);
  assert.equal(owner.parseQueue[1].state, 'completed');
  assert.equal(parses, 1); assert.equal(saves, 1); assert.equal(attempts, 2);
  assert.equal((await feature.load(attachment)).outline[0].summary, '摘要');
  failCache = true;
  const regenerated = feature.enqueue(attachment, true);
  await owner.processParseQueue();
  assert.equal(regenerated.state, 'failed');
  assert(regenerated.parsedResult.outline.length);
  const callsBeforeRetry = attempts;
  failCache = false;
  await owner.retryParseQueueTasks([regenerated.id]);
  assert.equal(regenerated.state, 'completed');
  assert.equal(attempts, callsBeforeRetry);
  console.log('PASS: parsing automatically queues an outline; outline-only failures and retries do not reparse or resave the PDF.');
}
run().catch(error => {console.error(error); process.exitCode = 1;});
