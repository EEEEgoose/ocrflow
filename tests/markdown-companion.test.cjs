const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path').posix;

function setup(){
  const files=new Map();
  const context={TextDecoder,PathUtils:{join:path.join,parent:path.dirname,tempDir:'/tmp'},
    IOUtils:{exists:async name=>files.has(name),getChildren:async dir=>Array.from(files.keys()).filter(name=>path.dirname(name)===dir),read:async name=>{if(!files.has(name))throw Error('Missing '+name);return files.get(name);},writeUTF8:async(name,text)=>files.set(name,new TextEncoder().encode(text)),makeDirectory:async()=>{},remove:async()=>{}},
    Zotero:{debug:()=>{},Attachments:{importFromFile:async options=>{
      const stored='/storage/LONG/OCRFlow_shortened.html';files.set(stored,files.get(options.file));
      return {getFilePath:async()=>stored,addTag:()=>{},saveTx:async()=>{},eraseTx:async()=>{}};
    }}}
  };
  vm.createContext(context);vm.runInContext(fs.readFileSync('docflow.js','utf8'),context);
  const plugin=context.DocFlow;plugin.renderDocumentBody=text=>'<p>'+text+'</p>';
  const put=(name,text)=>files.set(name,new TextEncoder().encode(text));
  return {plugin,files,put,item:name=>({getFilePath:async()=>name})};
}

test('the companion Markdown uses the final imported HTML filename after Zotero shortens it',async()=>{
  const s=setup(),item=await s.plugin.saveDocumentAttachment({libraryID:1,title:'OCRFlow_Test Author_' + 'Étude d’un document et de ses différentes éditions, présentation et comparaison — '.repeat(8),markdown:'# Original document',format:'html',keepMarkdown:true,tag:'#DocFlow-Parse'});
  const filePath=(await item.getFilePath()).replace(/\.html$/,'.md');
  assert(s.files.has(filePath));assert.equal((await s.plugin.readSourceMarkdown(item)).markdown,'# Original document');
});

test('an existing differently named Markdown in the same storage directory is read without changing files',async()=>{
  const s=setup(),html='/storage/OLD/shortened.html',markdown='/storage/OLD/OCRFlow_original_long_title.md';
  s.put(html,'<html>not the source</html>');s.put(markdown,'# Existing original Markdown');
  const before=Array.from(s.files.entries());
  const result=await s.plugin.readSourceMarkdown(s.item(html));
  assert.equal(result.filePath,markdown);assert.equal(result.markdown,'# Existing original Markdown');assert.deepEqual(Array.from(s.files.entries()),before);
});

test('an exact companion takes precedence and multiple unmatched Markdown files are not guessed',async()=>{
  const s=setup(),html='/storage/MULTI/book.html';s.put(html,'<html/>');s.put('/storage/MULTI/book.md','RIGHT');s.put('/storage/MULTI/other.md','OTHER');
  assert.equal((await s.plugin.readSourceMarkdown(s.item(html))).markdown,'RIGHT');
  s.files.delete('/storage/MULTI/book.md');s.put('/storage/MULTI/another.md','ANOTHER');
  await assert.rejects(()=>s.plugin.readSourceMarkdown(s.item(html)),/多个 Markdown/);
});

test('missing Markdown does not fall back to HTML or another storage directory',async()=>{
  const s=setup();s.put('/storage/EMPTY/book.html','<script type="application/json" id="mineru-source">{"markdown":"STALE"}</script>');s.put('/storage/OTHER/book.md','WRONG DOCUMENT');
  await assert.rejects(()=>s.plugin.readSourceMarkdown(s.item('/storage/EMPTY/book.html')),/原始 Markdown/);
  await assert.rejects(()=>s.plugin.readSourceMarkdown(s.item('/storage/EMPTY/missing.md')),/原始 Markdown/);
});
