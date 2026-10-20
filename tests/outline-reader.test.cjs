const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
class Element {
  constructor(tag) {this.tagName = tag; this.children = []; this.dataset = {}; this.style = {}; this.attributes = {}; this.listeners = {}; this.className = ''; this._text = '';}
  get textContent() {return this._text;}
  set textContent(value) {this._text = value; this.children = [];}
  append(...elements) {for (const element of elements) {element.parentNode = this; this.children.push(element);}}
  appendChild(element) {this.append(element);}
  remove() {if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this);}
  get classList() {return {contains: value => this.className.split(' ').includes(value), add: value => {if (!this.className.split(' ').includes(value)) this.className += ' ' + value;}, remove: value => this.className = this.className.split(' ').filter(v => v !== value).join(' ')};}
  setAttribute(key, value) {this.attributes[key] = value;}
  getAttribute(key) {return this.attributes[key] || null;}
  removeAttribute(key) {delete this.attributes[key];}
  addEventListener(type, callback) {this.listeners[type] = callback;}
  querySelectorAll(selector) {
    const result = [];
    const visit = element => {for (const child of element.children) {if (selector.startsWith('.') && child.classList.contains(selector.slice(1))) result.push(child); visit(child);}};
    visit(this); return result;
  }
  querySelector(selector) {return this.querySelectorAll(selector)[0] || null;}
}
const head = new Element('head'), body = new Element('body');
const doc = {head, body, createElementNS: (_ns, tag) => new Element(tag), getElementById: id => {
  let found = null;
  const visit = node => {if (node.id === id) found = node; for (const child of node.children) visit(child);};
  visit(head); visit(body); return found;
}};
let host = new Element('div'); host.id = 'sidebarContent'; body.append(host);
const outlineButton = new Element('button'); outlineButton.id = 'viewOutline'; outlineButton.className = 'active'; body.append(outlineButton);
const handlers = {}, pageEvents = new Map();
let observers = 0;
const viewWindow = {document: doc, addEventListener: (type, handler) => handlers[type] = handler, removeEventListener: type => delete handlers[type],
  MutationObserver: class {constructor(callback) {this.callback = callback; observers++;} observe() {} disconnect() {this.disconnected = true;}}};
const app = {pdfViewer: {currentPageNumber: 1}, eventBus: {on: (type, callback) => pageEvents.set(type, callback), off: type => pageEvents.delete(type)}};
const attachment = {id: 1, key: 'BOOK', libraryID: 1};
const navigations = [];
const reader = {type: 'pdf', _item: attachment, _initPromise: Promise.resolve(), _iframeWindow: viewWindow,
  _internalReader: {_primaryView: {initializedPromise: Promise.resolve(), _iframeWindow: {wrappedJSObject: {PDFViewerApplication: app}}}},
  navigate: async location => navigations.push(location.pageIndex)};
const context = {Zotero: {Reader: {unregisterEventListener: () => {}}, logError: error => {throw error;}}};
vm.createContext(context);
vm.runInContext(fs.readFileSync('prompts.js', 'utf8'), context);
vm.runInContext(fs.readFileSync('outline.js', 'utf8'), context);
const feature = context.DocFlowOutline;
feature.owner = {id: 'plugin', openParseQueueDialog: () => {}, processParseQueue: async () => {}};
feature.cache.set(feature.key(attachment), {outline: [
  {title: 'Chapter 1', level: 2, page: 1, summary: '第一章概要'},
  {title: 'Section', level: 3, page: 2, summary: '节概要'},
  {title: 'Subsection', level: 4, page: 2, summary: '子节概要'},
  {title: 'Chapter 2', level: 2, page: 3, summary: '第二章概要'}
]});
async function run() {
  await Promise.all([feature.attachReader(reader), feature.attachReader(reader)]);
  assert.equal(observers, 1);
  const entry = feature.readers.get(reader);
  let panel = doc.getElementById('mineru-reader-outline');
  assert.equal(host.getAttribute('data-mineru-outline-active'), 'true');
  let rows = panel.querySelectorAll('.mo-row');
  assert.equal(rows.length, 4);
  assert.equal(rows[0].querySelector('.mo-title').title, '第一章概要');
  rows[1].querySelector('.mo-title').listeners.click();
  assert.deepEqual(navigations, [1]);
  feature.highlight(entry, 2);
  assert(rows[1].classList.contains('mo-active'));
  pageEvents.get('pagechanging')({pageNumber: 3});
  assert(rows[3].classList.contains('mo-active'));
  rows[1].querySelector('.mo-toggle').listeners.click();
  assert.equal(rows[2].style.display, 'none');
  rows[0].querySelector('.mo-toggle').listeners.click();
  rows[0].querySelector('.mo-toggle').listeners.click();
  assert.equal(rows[2].style.display, 'flex');
  assert.equal(rows[1].querySelector('.mo-toggle').textContent, '▾');
  const toggleAll = panel.children[0].children[1];
  toggleAll.listeners.click();
  assert.equal(rows[0].style.display, 'flex'); assert.equal(rows[1].style.display, 'none');
  toggleAll.listeners.click(); assert.equal(rows[1].style.display, 'flex');
  outlineButton.className = ''; entry.observer.callback(); assert.equal(panel.style.display, 'none');
  outlineButton.className = 'active'; entry.observer.callback(); assert.equal(panel.style.display, 'flex');
  host.remove(); host = new Element('div'); host.id = 'sidebarContent'; body.append(host);
  entry.observer.callback(); panel = doc.getElementById('mineru-reader-outline');
  assert.equal(panel.querySelectorAll('.mo-row').length, 4);
  feature.shutdown();
  assert.equal(feature.readers.size, 0);
  assert.equal(doc.getElementById('mineru-reader-outline'), null);
  assert.equal(doc.getElementById('mineru-outline-style'), null);
  assert.equal(host.getAttribute('data-mineru-outline-active'), null);
  assert.equal(pageEvents.size, 0);
  console.log('PASS: reader mount/rebuild, page navigation, tooltips, same-page highlight, nested collapse and full listener cleanup.');
}
run().catch(error => {console.error(error); process.exitCode = 1;});
