const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path').posix;
function setup({markdown='![Publisher](../IMAGES/logo_editeur.png)',mode='rest'}={}){
 const png=Uint8Array.from([137,80,78,71]),entries=new Map([['OEBPS/IMAGES/logo_editeur.png',png],['OEBPS/Artwork/logo_editeur.png',Uint8Array.from([1,2,3])]]),files=new Map([['/storage/BOOK/book.epub',Uint8Array.from([80,75])]]),reads=[],controller=new AbortController();let closed=0,removed=0;
 const zip={open(){},close(){closed++},findEntries(){let i=0,names=[...entries.keys()];return {hasMore:()=>i<names.length,getNext:()=>names[i++]}},extract(name,file){if(!entries.has(name))throw Error('ZIP entry missing');files.set(file.path,entries.get(name))}};
 const win={AbortController,FormData,Blob,fetch:async()=>({ok:true,json:async()=>({markdown})})};
 const context={Uint8Array,TextDecoder,TextEncoder,setTimeout,clearTimeout,atob,btoa,Zotero:{getMainWindow:()=>win,debug(){}},PathUtils:{join:path.join,parent:path.dirname,tempDir:'/tmp'},
  IOUtils:{read:async name=>{reads.push(name);if(!files.has(name))throw Error('file does not exist');return files.get(name)},makeDirectory:async()=>{},remove:async()=>{removed++}},
  Components:{classes:{'@mozilla.org/libjar/zip-reader;1':{createInstance:()=>zip}},interfaces:{nsIZipReader:{}}}};
 vm.createContext(context);for(const name of ['prompts.js','docflow.js','markitdown.js','workflow.js'])vm.runInContext(fs.readFileSync(name,'utf8'),context);
 const m=context.DocFlow;m.pathToNSIFile=name=>({path:name});context.OCRFlowMarkItDown.connect=async()=>({mode,endpoint:'http://mock.invalid',signal:controller.signal});context.OCRFlowMarkItDown.convert=async()=>markdown;
 const attachment={attachmentFilename:'book.epub',getFilePath:async()=>'/storage/BOOK/book.epub'};
 return {m,context,entries,reads,controller,closed:()=>closed,removed:()=>removed,parse:()=>m.parseWithMarkItDown(attachment,{markitdownBaseURL:'http://mock.invalid'},{signal:controller.signal})};
}
test('whole-file EPUB conversion reads relative images from the ZIP instead of Zotero storage',async()=>{
 for(const mode of ['rest','mcp']){
  const s=setup({mode}),result=await s.parse();assert.equal(result.markdownText,'![Publisher](docflow-image://img-1)');assert.equal(result.embeddedImages[0].entryName,'OEBPS/IMAGES/logo_editeur.png');assert.deepEqual(Array.from(result.embeddedImages[0].bytes),[137,80,78,71]);
  assert(!s.reads.some(p=>p==='/storage/IMAGES/logo_editeur.png'));assert.equal(s.closed(),1);assert(s.removed()>0);
 }
});
test('EPUB Markdown and HTML reuse the same archive image and preserve inline and remote images',async()=>{
 const data='data:image/png;base64,iVBORw==',s=setup({markdown:'![A](../IMAGES/logo_editeur.png)\n<img src="../IMAGES/logo_editeur.png" alt="Publisher"/>\n![inline]('+data+')\n![remote](https://example.com/logo.png)'}),result=await s.parse();
 assert.equal(result.embeddedImages.length,2);const archived=result.embeddedImages.find(image=>image.entryName==='OEBPS/IMAGES/logo_editeur.png');assert.equal(result.markdownText.split(archived.marker).length-1,2);assert(result.embeddedImages.some(image=>image.entryName.startsWith('data:')));assert(result.markdownText.includes('https://example.com/logo.png'));
});
test('missing EPUB image reports an archive error and closes resources without reading the surrounding filesystem',async()=>{
 const s=setup({markdown:'![Missing](../IMAGES/missing.png)'});await assert.rejects(s.parse(),/EPUB.*图片.*missing\.png/);assert.equal(s.closed(),1);assert(!s.reads.some(p=>p.startsWith('/storage/IMAGES/')));
});
test('EPUB conversion cancellation is checked while loading images and still releases the archive',async()=>{
 const s=setup();const read=s.context.IOUtils.read;s.context.IOUtils.read=async name=>{const data=await read(name);if(name.startsWith('/tmp/'))s.controller.abort();return data};await assert.rejects(s.parse(),{name:'AbortError'});assert.equal(s.closed(),1);
});

test('missing MarkItDown settings explain the EPUB requirement before any file is read',async()=>{
 const s=setup(),file={attachmentFilename:'book.epub',getFilePath:async()=>{throw Error('Must not read file')}};
 for(const markitdownBaseURL of ['', '   '])await assert.rejects(s.m.parseWithMarkItDown(file,{markitdownBaseURL},{}),/EPUB 需要 MarkItDown，请先在识别服务中配置。/);
 assert.equal(s.reads.length,0);
 file.attachmentFilename='book.docx';await assert.rejects(s.m.parseWithMarkItDown(file,{},{}),/请先在 OCRFlow 设置中填写 MarkItDown 服务地址/);
});
