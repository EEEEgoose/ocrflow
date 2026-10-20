const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {PDFDocument,PDFName}=require('../vendor/pdf-lib/pdf-lib.min.js');

async function setup({rejectSingle=false,empty=false,firstEmpty=false,cancel=false}={}) {
  const source=await PDFDocument.create(),calls=[],completed=[],controller=new AbortController();
  const image=await source.embedPng(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXXsAAAAASUVORK5CYII=','base64'));
  for(let i=0;i<17;i++)source.addPage([300+i,800]).drawImage(image,{x:0,y:0,width:10,height:10});
  const bytes=await source.save();
  const context={Uint8Array,TextEncoder,TextDecoder,URL,setTimeout,clearTimeout,btoa,atob,
    IOUtils:{read:async()=>bytes},Zotero:{getMainWindow:()=>({AbortController})},
    fetch:async(url,options={})=>{
      if(url.endsWith('/health'))return {ok:false,status:404};
      const request=JSON.parse(options.body);let result;
      if(request.method==='initialize')result={protocolVersion:'2024-11-05'};
      if(request.method==='tools/call'){
        const doc=await PDFDocument.load(Buffer.from(request.params.arguments.uri.split(',')[1],'base64'));
        const widths=doc.getPages().map(page=>page.getWidth());calls.push(widths);
        assert(doc.getPages().every(page=>page.node.Resources().lookup(PDFName.of('XObject')).keys().length>0),'copied PDF pages retain scanned images');
        if(widths.length>2||rejectSingle)return {ok:false,status:413,text:async()=>'Payload Too Large'};
        completed.push(...widths);if(cancel)controller.abort();
        result={content:[{type:'text',text:empty||(firstEmpty&&widths[0]===300)?'':widths.map(width=>'PAGE '+(width-299)).join('\n')}]};
      }
      return {ok:true,headers:{get:()=>null},text:async()=>JSON.stringify({id:request.id,result})};
    }};
  vm.createContext(context);for(const name of ['prompts.js','docflow.js','markitdown.js','workflow.js'])vm.runInContext(fs.readFileSync(name,'utf8'),context);
  const plugin=context.DocFlow;plugin.getPDFLibrary=()=>({PDFDocument});
  const attachment={attachmentFilename:'large.pdf',getFilePath:()=>'/large.pdf'};
  const parse=()=>plugin.parseWithMarkItDown(attachment,{markitdownBaseURL:'http://service.example',timeoutMS:120000},{signal:controller.signal});
  return {parse,calls,completed};
}

test('PDF MCP 413 recursively splits real pages and merges successful results in original order',async()=>{
  const s=await setup(),result=await s.parse();
  assert.equal(s.calls[0].length,17);assert(s.calls.some(pages=>pages.length===16));
  assert.deepEqual(s.completed,Array.from({length:17},(_,i)=>300+i));
  const numbers=Array.from(result.markdownText.matchAll(/PAGE (\d+)/g),match=>Number(match[1]));
  assert.deepEqual(numbers,Array.from({length:17},(_,i)=>i+1));assert.equal(result.warning,null);
});

test('a PDF page that still exceeds the service limit fails with a useful OCR choice message',async()=>{
  const s=await setup({rejectSingle:true});await assert.rejects(s.parse,/第 1 页单页仍超过.*MinerU.*AI/);
});

test('blank PDF conversion fails, while partially empty results carry a scanned-page warning',async()=>{
  const blank=await setup({empty:true});await assert.rejects(blank.parse,/扫描件.*MinerU.*AI/);
  const partial=await setup({firstEmpty:true}),result=await partial.parse();assert.match(result.warning,/扫描页/);assert(result.markdownText.includes('PAGE 17'));
});

test('canceling PDF conversion stops later page batches',async()=>{
  const s=await setup({cancel:true});await assert.rejects(s.parse,{name:'AbortError'});assert.equal(s.completed.length,2);
});
