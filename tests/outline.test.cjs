const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path').posix;
const assert = require('node:assert/strict');
const files = new Map(), prefs = new Map();
let apiCalls = 0, workerCalls = 0, promptTexts = [];
let aiOutput = {outline: [{level: 1, title: '第一章', summary: '章节概要', page: 1}, {level: 2, title: '研究方法', summary: '方法概要', page: 2}]};
const owner = {
  id: 'plugin-id', PREF_BRANCH: 'extensions.docflow.', parseQueue: [], parseQueueNextID: 1,
  refreshParseQueueDialog: () => {}, getLLMSettings: () => ({apiBaseURL: 'https://llm.example/v1', model: 'model', apiKey: 'test'}),
  applyAIContextBudget(){},parseOptionalJSONObject: () => ({}), mergeRequestPayload: payload => payload
};
const context = {
  PathUtils: {join: path.join, parent: path.dirname},
  IOUtils: {exists: async key => files.has(key), readUTF8: async key => files.get(key), makeDirectory: async () => {}, writeUTF8: async (key, value) => files.set(key, value)},
  Zotero: {
    DataDirectory: {dir: '/data'}, Prefs: {get: key => prefs.get(key)}, Reader: {_readers: []},
    PDFWorker: {getFullText: async () => {workerCalls++; return {text: ''};}}
  },
  fetch: async (_url, options) => {
    apiCalls++; promptTexts.push(JSON.parse(options.body).messages[1].content);
    return {ok: true, json: async () => ({choices: [{message: {content: JSON.stringify(aiOutput)}}]})};
  }
};
vm.createContext(context);
vm.runInContext(fs.readFileSync('prompts.js', 'utf8'), context);
vm.runInContext(fs.readFileSync('outline.js', 'utf8'), context);
const outlineFeature = context.DocFlowOutline;
outlineFeature.init(owner);
const att = (id, key) => ({id, key, libraryID: 1, getField: () => 'book.pdf'});
const a = att(1, 'AAAA'), b = att(2, 'BBBB');
async function run() {
  const local = outlineFeature.parseMineruDocument({
    metadata: {document: {page_count: 3}},
    pages: [{page_idx: 0, blocks: [{type: 'title', content: '第一章'}, {type: 'text', content: '正文'}]},
      {page_idx: 1, blocks: [{type: 'heading', content: '研究方法', level: 2}]}]
  });
  assert.equal(local.pages.length, 3);
  assert.equal(local.headings[1].page, 2);
  assert.equal(local.headings[1].level, 2);
  const cloud = outlineFeature.parseMineruDocument([{type: 'text', text: '第一章', text_level: 1, page_idx: 0}, {type: 'text', text: '正文', page_idx: 1}]);
  assert.equal(cloud.headings[0].page, 1);
  assert.equal(cloud.pages[1], '正文');
  const middle = outlineFeature.parseMineruDocument({pdf_info: [{page_idx: 0, para_blocks: [{type: 'title', lines: [{spans: [{content: '第一章'}]}]}]}]});
  assert.equal(middle.headings[0].title, '第一章');
  await outlineFeature.storeSource(a, {outlinePages: local.pages, outlineHeadings: local.headings});
  const first = await outlineFeature.generate(a);
  assert.equal(apiCalls, 1); assert.equal(workerCalls, 0);
  assert.equal(first[0].page, 1); assert.equal(first[1].page, 2);
  assert(promptTexts[0].includes('PDF 第 2 页'));
  await outlineFeature.generate(a); assert.equal(apiCalls, 1);
  outlineFeature.cache.clear(); await outlineFeature.generate(a); assert.equal(apiCalls, 1);

  prefs.set(owner.PREF_BRANCH + 'outlineUseAI', false);
  await outlineFeature.storeSource(b, {outlinePages: ['第一章', '研究方法'], markdownText: '# 第一章\n```js\n# fake heading\n```\n## 研究方法'});
  const second = await outlineFeature.generate(b);
  assert.equal(second.length, 2); assert.equal(second[1].page, 2); assert.equal(apiCalls, 1);
  assert.equal((await outlineFeature.load(a)).outline[0].summary, '章节概要');
  assert.equal((await outlineFeature.load(b)).outline[0].summary, '');

  const entries = [{title: '第一章', page: 1}, {title: '研究方法', page: 1}, {title: '不存在', page: null}];
  outlineFeature.locatePages(entries, ['目录\n第一章\n研究方法', '第一章\n正文', '研究方法\n正文'], []);
  assert.deepEqual(entries.map(entry => entry.page), [2, 3, null]);
  const chunks = outlineFeature.pageChunks(['x'.repeat(22000), '', '第三页']);
  assert(chunks.every(chunk => chunk.length <= 20000));
  assert(chunks[1].includes('PDF 第 1 页')); assert(chunks[1].includes('PDF 第 3 页'));

  context.Zotero.Reader._readers = [{_item: a, _internalReader: {_primaryView: {_iframeWindow: {wrappedJSObject: {PDFViewerApplication: {pdfDocument: {
    getOutline: async () => [{title: '书签一', dest: [0], items: [{title: '书签二', dest: 'named'}]}],
    getDestination: async () => [{num: 2}], getPageIndex: async () => 2
  }}}}}}}];
  const bookmarks = await outlineFeature.generate(a, {force: true});
  assert.equal(bookmarks[0].page, 1); assert.equal(bookmarks[1].page, 3); assert.equal(bookmarks[1].level, 2);
  assert.equal(apiCalls, 1);
  context.Zotero.Reader._readers = [];
  prefs.set(owner.PREF_BRANCH + 'outlineUseAI', true);
  const scan = att(3, 'SCAN');
  await assert.rejects(() => outlineFeature.generate(scan), /扫描 PDF 请重新使用 MinerU/);
  assert.equal(apiCalls, 1);
  assert.throws(() => outlineFeature.parseAIOutline('not JSON'), /不是有效 JSON/);
  const native = att(4, 'NATIVE');
  const pageReads = [];
  context.Zotero.Reader._readers = [{_item: native, _internalReader: {_primaryView: {_iframeWindow: {wrappedJSObject: {PDFViewerApplication: {pdfDocument: {
    getOutline: async () => [], numPages: 3,
    getPage: async () => ({}), // Reproduce the page object visible to the plugin in the reported failure.
    getPageData: async ({pageIndex}) => {
      pageReads.push(pageIndex);
      const title = pageIndex === 1 ? '第一章' : '研究方法';
      const data = {chars: pageIndex === 0 ? [] : [
        ...Array.from(title, (c, i) => ({c, u: c, paragraphBreakAfter: i === title.length - 1})),
        {c: 'ignored', ignorable: true},
        {c: '正', u: '正'}, {c: '文', u: '文', lineBreakAfter: true},
        {c: 'A', u: 'A', spaceAfter: true}, {c: 'B', u: 'B'}
      ]};
      return pageIndex === 2 ? {wrappedJSObject: data} : data;
    }
  }}}}}}}];
  const nativeOutline = await outlineFeature.generate(native);
  assert.equal(nativeOutline[0].page, 2); assert.equal(nativeOutline[1].page, 3);
  assert.deepEqual(pageReads, [0, 1, 2]);
  assert.deepEqual(Array.from((await outlineFeature.load(native)).pages), ['', '第一章\n\n正文\nA B', '研究方法\n\n正文\nA B']);
  const interrupted = att(6, 'INTERRUPTED');
  let failRead = true;
  context.Zotero.Reader._readers = [{_item: interrupted, _internalReader: {_primaryView: {_iframeWindow: {wrappedJSObject: {PDFViewerApplication: {pdfDocument: {
    getOutline: async () => [], numPages: 3,
    getPageData: async ({pageIndex}) => {
      if (pageIndex === 1 && failRead) throw new Error('Page read failed');
      return {chars: [{c: pageIndex === 0 ? '第一章' : pageIndex === 1 ? '研究方法' : '正文'}]};
    }
  }}}}}}}];
  await assert.rejects(() => outlineFeature.generate(interrupted), /Page read failed/);
  assert.equal((await outlineFeature.load(interrupted)).pages.length, 0);
  failRead = false;
  await outlineFeature.generate(interrupted);
  assert.equal((await outlineFeature.load(interrupted)).pages.length, 3);
  context.Zotero.Reader._readers = [];
  context.Zotero.PDFWorker.getFullText = async () => ({text: '第一章\f研究方法', totalPages: 3});
  const mismatch = att(5, 'MISMATCH');
  await assert.rejects(() => outlineFeature.generate(mismatch), /页码不能准确对应/);
  assert.equal((await outlineFeature.load(mismatch)).pages.length, 0);
  await assert.rejects(() => outlineFeature.generate(mismatch), /页码不能准确对应/);
  assert.equal(apiCalls, 3);
  console.log('PASS: local/cloud page data, cache and PDF identity, AI and no-AI generation, bookmarks, contents-page exclusion and long-page chunking.');
}
run().catch(error => {console.error(error); process.exitCode = 1;});
