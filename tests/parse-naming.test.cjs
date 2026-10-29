const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path').posix;
const files = new Map(), imports = [];
let serial = 0;
const context = {
  PathUtils: {join: path.join, parent: path.dirname, tempDir: '/tmp'},
  IOUtils: {
    makeDirectory: async () => {}, writeUTF8: async (name, value) => files.set(name, value),
    remove: async () => {}
  },
  Zotero: {
    debug: () => {}, logError: error => {throw error;},
    Attachments: {importFromFile: async options => {
      const stored = '/storage/' + (++serial) + '/' + path.basename(options.file);
      files.set(stored, files.get(options.file));
      const item = {title: options.title === undefined ? '网页' : options.title,
        getFilePath: async () => stored, addTag: () => {}, saveTx: async () => {}, eraseTx: async () => {}};
      imports.push({options, item});
      return item;
    }}
  }
};
vm.createContext(context);
vm.runInContext(fs.readFileSync('docflow.js', 'utf8'), context);
vm.runInContext(fs.readFileSync('attachment-naming.js','utf8'),context);
const plugin = context.DocFlow;
plugin.prepareOriginalLayout = () => [];
plugin.renderOriginalLayout = () => ({body:'',style:'',script:''});
plugin.renderDocumentBody = text => '<p>' + text + '</p>';
const attachment = {libraryID: 1, getFilePath: () => '/source/original.pdf', getField: () => 'PDF'};
function parent(title, creators) {
  let loaded = false;
  return {
    id: 1, getField: field => field === 'title' ? title : '',
    loadDataType: async type => {assert.equal(type, 'creators'); loaded = true;},
    getCreatorsJSON: () => {assert(loaded, 'Creator data must be loaded before reading'); return creators;},
    addTag: () => {}, saveTx: async () => {}
  };
}

async function check(parentItem, stem, format, source = attachment, htmlLayout = "original") {
  if (format === "html") stem = stem.replace(/^OCRFlow_/,htmlLayout === "markdown" ? "OCRFlow_MD布局_" : "OCRFlow_原文布局_");
  const result = await plugin.saveResultAsMarkdownAttachment({attachment: source, parentItem,
    parsedResult: {markdownText: '正文'}, settings: {outputFormat: format, htmlLayout, parseLinkSourcePDF: false}});
  const entry = imports.at(-1);
  const stored = await result.attachment.getFilePath();
  assert.equal(path.basename(stored), stem + '.' + format);
  assert.equal(entry.options.title, stem);
  assert.equal(entry.item.title, stem);
  assert.equal(entry.options.parentItemID, parentItem?.id);
  if (format === 'html') {
    assert(files.get(stored).includes('<title>' + plugin.escapeHTML(stem) + '</title>'));
    assert.equal(files.get(stored.replace(/\.html$/, '.md')), '正文');
  }
}

async function run() {
  const book = parent('早期殖民主义侵略史', [
    {creatorType: 'author', name: '艾周昌'},
    {creatorType: 'author', lastName: '程', firstName: '纯'},
    {creatorType: 'editor', name: '编辑名字'}
  ]);
  for (const format of ['md', 'html']) await check(book, 'OCRFlow_艾周昌等_年份不详_早期殖民主义侵略史', format);
  await check(parent('Orientalism', [{creatorType: 'author', firstName: 'Edward W.', lastName: 'Said'}]),
    'OCRFlow_Said_年份不详_Orientalism', 'html');
  await check(undefined, 'OCRFlow_未知作者_年份不详_original', 'html', attachment, 'markdown');
  await check(parent('历史研究', [{creatorType: 'author', name: '中国社会科学院'}]),
    'OCRFlow_中国社会科学院_年份不详_历史研究', 'md');
  await check(parent('史料: 研究/选编?', [{creatorType: 'author', name: '作者'}]),
    'OCRFlow_作者_年份不详_史料_ 研究_选编_', 'html');
  await check(parent('', []), 'OCRFlow_未知作者_年份不详_original', 'md');
  await check(undefined, 'OCRFlow_未知作者_年份不详_original', 'html');
  await check(undefined, 'OCRFlow_未知作者_年份不详_扫描书', 'md', {libraryID: 1, getFilePath: () => false, getField: () => '扫描书.pdf'});
  console.log('PASS: metadata names, Chinese/Western/institutional authors, HTML/MD and companion names, explicit attachment titles and PDF fallbacks.');
}
run().catch(error => {console.error(error); process.exitCode = 1;});
