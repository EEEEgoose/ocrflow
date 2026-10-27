const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path').posix;

async function check({format, link, importChangesTitle = false, importFails = false}) {
  const originalTitle = '原始自定义 PDF 标题';
  let automaticRenames = 0, sourceTitleWrites = 0, imports = 0, serial = 1;
  const files = new Map(), relations = new Map(), saves = [];
  const source = {
    id: 1, libraryID: 1, title: originalTitle, related: new Set(),
    getField: () => source.title, getFilePath: () => '/source/original.pdf',
    setField: (field, value) => {assert.equal(field, 'title'); sourceTitleWrites++; source.title = value;},
    addRelatedItem: item => {if (source.related.has(item.id)) return false; source.related.add(item.id); return true;},
    save: async options => {saves.push(options); notifySave(options); relations.set(1, [...source.related]);},
    saveTx: async options => {saves.push(options); notifySave(options);},
    reload: async () => {}
  };
  function notifySave(options) {
    if (!options?.notifierData?.skipRenameFile) {
      automaticRenames++;
      source.title = 'PDF';
    }
  }
  const parent = {id: 10, getField: () => '书名', loadDataType: async () => {},
    getCreatorsJSON: () => [{creatorType: 'author', name: '作者'}],
    addTag: () => {}, saveTx: async options => {saves.push(options); notifySave(options);}};
  const context = {
    PathUtils: {join: path.join, parent: path.dirname, tempDir: '/tmp'},
    IOUtils: {makeDirectory: async () => {}, writeUTF8: async (file, value) => files.set(file, value), remove: async () => {}},
    Zotero: {debug: () => {}, logError: error => {throw error;},
      DB: {executeTransaction: async operation => operation()},
      Attachments: {importFromFile: async options => {
        imports++; notifySave(options.saveOptions);
        if (importChangesTitle) source.title = 'PDF';
        if (importFails) throw Error('Import failed');
        const stored = '/storage/' + (++serial) + '/' + path.basename(options.file);
        files.set(stored, files.get(options.file));
        const related = new Set();
        return {id: serial, libraryID: 1, title: options.title,
          getFilePath: async () => stored, addTag: () => {},
          saveTx: async options => {saves.push(options); notifySave(options);},
          addRelatedItem: item => {if (related.has(item.id)) return false; related.add(item.id); return true;},
          save: async options => {saves.push(options); notifySave(options); relations.set(serial, [...related]);},
          reload: async () => {}, eraseTx: async () => {}};
      }}}
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync('docflow.js', 'utf8'), context);
vm.runInContext(fs.readFileSync('attachment-naming.js','utf8'),context);
  const plugin = context.DocFlow;
  plugin.renderDocumentBody = text => '<p>' + text + '</p>';
  const save = () => plugin.saveResultAsMarkdownAttachment({attachment: source, parentItem: parent,
    parsedResult: {markdownText: '正文'}, settings: {outputFormat: format, parseLinkSourcePDF: link}});
  if (importFails) await assert.rejects(save, /Import failed/);
  else {
    const result = await save();
    assert.equal(result.attachment.title, 'OCRFlow_作者_年份不详_书名');
    assert.equal(path.basename(await result.attachment.getFilePath()), 'OCRFlow_作者_年份不详_书名.' + format);
    if (link) assert.deepEqual(relations.get(1), [result.attachment.id]);
    else assert.equal(relations.has(1), false);
  }
  assert.equal(source.title, originalTitle);
  assert.equal(source.getFilePath(), '/source/original.pdf');
  assert.equal(automaticRenames, 0);
  assert.equal(sourceTitleWrites, importChangesTitle ? 1 : 0);
  assert.equal(imports, 1);
  assert(saves.every(options => options.notifierData.skipRenameFile === true));
}

(async () => {
  for (const format of ['md', 'html']) for (const link of [false, true]) await check({format, link});
  await check({format: 'html', link: true, importChangesTitle: true});
  await check({format: 'md', link: false, importChangesTitle: true, importFails: true});
  console.log('PASS: source PDF title preservation, rename-notifier exclusion, successful/failed import and linked/unlinked HTML/MD output.');
})().catch(error => {console.error(error); process.exitCode = 1;});
