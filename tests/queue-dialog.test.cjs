const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
class Element {
  constructor() {this.children = []; this.dataset = {}; this.listeners = {}; this.textContent = ''; this.disabled = false; this.style = {}; this.clientHeight = 0; this.scrollHeight = 0; this.scrollTop = 0;}
  set textContent(value) {this.text=String(value??'');this.textWrites=(this.textWrites||0)+1;}
  get textContent() {return this.text;}
  append(...children) {for (const child of children) this.appendChild(child);}
  appendChild(child) {this.children.push(child); child.parent = this;}
  remove() {this.parent.children.splice(this.parent.children.indexOf(this), 1);}
  addEventListener(type, callback) {this.listeners[type] = callback;}
  setAttribute(name, value) {this[name] = value;}
  querySelector() {return new Element();}
}
const elements = new Map(Array.from(fs.readFileSync('task-queue.xhtml', 'utf8').matchAll(/\bid="([^"]+)"/g), match => [match[1], new Element()]));
const retries = [], cancellations = [];
const plugin = {
  parseQueueViews:new Set(),
  parseQueue: [
    {id: 1, title: '书籍.pdf', settings: {apiMode: 'local-v1'}, state: 'running', detail: '已等待 2 分钟', jobID: 'job-live', error: ''},
    {id: 2, title: '失败.pdf', settings: {apiMode: 'cloud'}, state: 'failed', detail: '失败', error: 'API error'},
    {id: 3, title: '等待.pdf', settings: {apiMode: 'local-v1'}, state: 'wait_expired', detail: '等待结束', error: 'Wait limit'}
  ],
  retryParseQueueTasks: async ids => retries.push(Array.from(ids)),
  cancelParseQueueTask: async id => cancellations.push(id)
};
const events = {};
let selection='';const copied=[];
const window = {arguments: [{plugin}],getSelection:()=>({toString:()=>selection}), ResizeObserver: class {observe() {} disconnect() {}}, addEventListener: (type, callback) => events[type] = callback, removeEventListener:type=>delete events[type], close: () => events.unload()};
plugin.parseQueueWindow = window;
const context = {window,Components:{classes:{'@mozilla.org/widget/clipboardhelper;1':{getService:()=>({copyString:text=>copied.push(text)})}},interfaces:{nsIClipboardHelper:{}}}, document: {getElementById: id => elements.get(id), createElementNS: () => new Element()}};
vm.createContext(context);
vm.runInContext(fs.readFileSync('docflow.js', 'utf8'), context);
for (const name of ['canClearParseQueueTask', 'clearParseQueueTasks', 'refreshParseQueueDialog']) plugin[name] = context.DocFlow[name];
vm.runInContext(fs.readFileSync('task-queue.js', 'utf8'), context);
// The model may render as soon as the dialog script loads, before DOMContentLoaded.
context.DocFlowTaskQueue.render();
events.DOMContentLoaded();
const view = context.DocFlowTaskQueue;
plugin.parseQueue[0].kind='translate';plugin.parseQueue[0].settings.translateLanguage='中文';view.render();
assert.equal(view.rows.get(1).mode.textContent,'翻译文献 → 中文');
const titleWrites=view.rows.get(1).title.textWrites,errorWrites=view.rows.get(2).error.textWrites;
plugin.parseQueue[0].detail='进度更新';view.render();
assert.equal(view.rows.get(1).title.textWrites,titleWrites,'progress refresh must keep unchanged text nodes so selection survives');
assert.equal(view.rows.get(2).error.textWrites,errorWrites,'error text must remain selectable while other tasks update');
selection='الإدارة الاستعمارية\npage.trim is not a function';let prevented=0;
events.keydown({key:'c',metaKey:true,preventDefault:()=>prevented++});
events.keydown({key:'C',ctrlKey:true,preventDefault:()=>prevented++});
assert.deepEqual(copied,[selection,selection]);assert.equal(prevented,2);
selection='';events.keydown({key:'c',metaKey:true,preventDefault:()=>prevented++});
assert.equal(copied.length,2);assert.equal(prevented,2,'empty selection must leave the clipboard alone');
view.rows.get(2).copy.listeners.click();
assert(copied.at(-1).includes('失败.pdf'));assert(copied.at(-1).includes('API error'));
assert(!copied.at(-1).includes('job-live'));assert.equal(elements.get('queue-copy-status').textContent,'已复制本条任务');
view.rows.get(1).copy.listeners.click();
for(const text of ['书籍.pdf','进度更新','job-live'])assert(copied.at(-1).includes(text));
assert.equal(elements.get('queue-body').children.length, 3);
assert.match(elements.get('queue-summary').textContent, /处理中 1/);
assert.equal(view.rows.get(1).retry.disabled, true);
assert.equal(view.rows.get(2).retry.disabled, false);
assert.equal(view.rows.get(2).error.textContent, 'API error');
assert.equal(view.rows.get(3).retry.textContent, '继续等待');
assert.equal(view.rows.get(1).cancel.disabled, false);
assert.equal(view.rows.get(2).cancel.disabled, true);
view.rows.get(1).cancel.listeners.click();
assert.deepEqual(cancellations, [1]);
plugin.parseQueue[0].state = 'stopping'; view.render();
assert.equal(view.rows.get(1).cancel.disabled, true);
assert.match(elements.get('queue-summary').textContent, /终止中 1/);
plugin.parseQueue[0].state = 'canceled'; plugin.parseQueue[0].cancelFailed = true; view.render();
assert.equal(view.rows.get(1).cancel.textContent, '重试终止');
assert.equal(view.rows.get(1).cancel.disabled, false);
assert.equal(view.rows.get(1).retry.textContent, '重新处理');
plugin.parseQueue[0].state = 'running'; plugin.parseQueue[0].cancelFailed = false; plugin.parseQueue[0].saving = true; view.render();
assert.equal(view.rows.get(1).cancel.disabled, true);
plugin.parseQueue[0].saving = false;
view.rows.get(2).retry.listeners.click();
elements.get('queue-retry-failed').listeners.click();
view.rows.get(3).retry.listeners.click();
assert.deepEqual(retries, [[2], [2], [3]]);
plugin.parseQueue[1].state = 'completed';
view.render();
assert.equal(elements.get('queue-body').children.length, 3);
assert.equal(view.rows.get(2).retry.disabled, true);
assert.equal(elements.get('queue-retry-failed').disabled, true);
plugin.parseQueue.push(
  {id: 4, title: '取消未确认.pdf', settings: {apiMode: 'local-v1'}, state: 'canceled', cancelFailed: true},
  {id: 5, title: '排队.pdf', settings: {apiMode: 'local-v1'}, state: 'queued'},
  {id: 6, title: '正在终止.pdf', settings: {apiMode: 'local-v1'}, state: 'stopping'}
);
view.render();
elements.get('queue-clear').listeners.click();
assert.deepEqual(plugin.parseQueue.map(task => task.id), [1, 3, 4, 5, 6]);
assert.equal(elements.get('queue-body').children.length, 5);
assert.equal(view.rows.has(2), false);
assert.equal(view.rows.get(3).number.textContent, '2');
assert.equal(elements.get('queue-clear').disabled, true);
assert.deepEqual(cancellations, [1]);
plugin.parseQueue[0].state = 'completed'; plugin.parseQueue[0].active = true;
plugin.parseQueue[2].cancelFailed = false;
view.render(); elements.get('queue-clear').listeners.click();
assert(view.rows.has(1), 'The worker must finish before removing its completed row');
assert.equal(view.rows.has(4), false);
for (const task of plugin.parseQueue) {task.state = 'completed'; task.active = false;}
view.render(); elements.get('queue-clear').listeners.click();
assert.equal(plugin.parseQueue.length, 0);
assert.equal(view.rows.size, 0);
assert.equal(elements.get('queue-body').children.length, 0);
assert.equal(elements.get('queue-summary').textContent, '暂无任务');
assert.equal(elements.get('queue-clear').disabled, true);
assert.equal(elements.get('queue-retry-failed').disabled, true);
plugin.parseQueue.push({id: 7, title: '新任务.pdf', settings: {apiMode: 'local-v1'}, state: 'running'});
view.render();
assert.equal(elements.get('queue-body').children.length, 1);
assert.equal(view.rows.get(7).number.textContent, '1');
plugin.parseQueue.push({id: 8, kind: 'organize', title: '等待附件', settings: {}, state: 'waiting', detail: '添加文件后继续整理'});
view.render();
assert.equal(view.rows.get(8).mode.textContent, '一键整理');
assert.equal(view.rows.get(8).state.textContent, '待补充');
assert.equal(view.rows.get(8).retry.textContent, '继续整理');
assert.equal(view.rows.get(8).retry.disabled, false);
assert.equal(view.rows.get(8).cancel.disabled, true);
view.rows.get(8).retry.listeners.click();
assert.deepEqual(retries.at(-1), [8]);
assert(plugin.canClearParseQueueTask(plugin.parseQueue.at(-1)));
elements.get('queue-close').listeners.click();
assert.equal(plugin.parseQueueWindow, null);
assert.equal(plugin.parseQueueViews.size,0,'closing the view unregisters it before its script scope is destroyed');
assert(!events.keydown,'closing removes the window clipboard listener');
assert.equal(plugin.parseQueue[0].state, 'running');
console.log('PASS: dialog rows, button binding, retry-all selection, early rendering and close without task cancellation.');
