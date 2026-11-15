const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path').posix;

function setup() {
 const files = new Map();
 const checkName = name => {
  if (Buffer.byteLength(path.basename(name), 'utf8') > 255) throw Error('NS_ERROR_FILE_NAME_TOO_LONG');
 };
 const context = {
  TextEncoder,
  PathUtils: {join:path.join, parent:path.dirname, tempDir:'/tmp'},
  IOUtils: {
   makeDirectory:async()=>{}, remove:async()=>{}, exists:async name=>files.has(name),
   writeUTF8:async(name, text)=>{checkName(name);files.set(name, text)},
   move:async(from, to)=>{checkName(to);files.set(to, files.get(from));files.delete(from)}
  },
  Zotero: {
   debug(){}, logError(){},
   Attachments: {importFromFile:async options=>{
    const stored = '/storage/item/' + path.basename(options.file);
    files.set(stored, files.get(options.file));
    return {title:options.title, getFilePath:async()=>stored, addTag(){}, saveTx:async()=>{}, eraseTx:async()=>{}};
   }}
  }
 };
 vm.createContext(context);
 for (const file of ['docflow.js','attachment-naming.js']) vm.runInContext(fs.readFileSync(file,'utf8'), context);
 const m = context.DocFlow;
 m.renderDocumentBody = text=>'<p>'+text+'</p>';
 return {m, context, files, checkName};
}

test('long output names fit filesystem byte limits while preserving displayed titles and companion Markdown', async()=>{
 for (const stem of ['An annotated legal collection '.repeat(20), 'Édition législative française '.repeat(20), '中文书名与阿拉伯文العربية😀'.repeat(25)]) {
  for (const format of ['html','md']) {
   const {m, files} = setup();
   const title = 'OCRFlow_MD布局_' + stem;
   const item = await m.saveDocumentAttachment({libraryID:1,title,markdown:'Full document',format,keepMarkdown:true,tag:'#DocFlow-Parse'});
   const filename = path.basename(await item.getFilePath());
   assert(Buffer.byteLength(filename,'utf8') <= 255);
   assert(filename.endsWith('.'+format));
   assert(filename.startsWith('OCRFlow_MD布局_'));
   assert(!filename.includes('\uFFFD'));
   assert.equal(item.title,title);
   if (format==='html') assert.equal(files.get((await item.getFilePath()).replace(/\.html$/,'.md')),'Full document');
  }
 }
});

test('attachment renaming limits filename bytes and moves the HTML companion under the same stem', async()=>{
 const {m, context, files, checkName} = setup();
 let current = '/storage/item/old.html';
 const item = {
  isAttachment:()=>true, getTags:()=>[{tag:'#DocFlow-Parse'}],
  attachmentFilename:'old.html', getFilePath:async()=>current,
  getField:()=> 'OCRFlow_MD布局_old', setField(){}, saveTx:async()=>{},
  renameAttachmentFile:async name=>{checkName(name);current='/storage/item/'+name;return true}
 };
 const parent = {getAttachments:()=>[1]};
 context.Zotero.Items = {get:()=>item};
 m.documentFileStem = async()=> 'Author_1896_'+'Législation française et commentaires '.repeat(20);
 m.documentExtension = ()=> 'html';
 files.set('/storage/item/old.md','Full document');
 await m.renameDocumentAttachments(parent);
 assert(Buffer.byteLength(path.basename(current),'utf8') <= 255);
 assert.equal(files.get(current.replace(/\.html$/,'.md')),'Full document');
});
