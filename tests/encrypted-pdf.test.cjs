const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {PDFDocument}=require('../vendor/pdf-lib/pdf-lib.min.js');
const original=fs.readFileSync('tests/fixtures/permission-encrypted.pdf'),plain=fs.readFileSync('tests/fixtures/encryption-source.pdf');
function setup(){
 const calls=[];const context={Uint8Array,TextDecoder,TextEncoder,atob,btoa,Zotero:{PDFWorker:{
  _enqueue:async fn=>{calls.push('queue');return fn();},
  _query:async(action,data,transfer)=>{
   calls.push(action);assert.equal(action,'pdf.writeAnnotations');assert.equal(data.annotations.length,0);assert.equal(transfer[0],data.buf);
   assert.deepEqual(Buffer.from(data.buf),original);
   structuredClone(data,{transfer}); // Simulate the native worker detaching the transferred copy.
   return {buf:Uint8Array.from(plain).buffer};
  }
 }}};
 vm.createContext(context);vm.runInContext(fs.readFileSync('docflow.js','utf8'),context);
 const m=context.DocFlow;m.getPDFLibrary=()=>({PDFDocument});return {m,context,calls};
}
test('permission-encrypted PDFs use the native processor and return loadable bytes without changing the input',async()=>{
 const s=setup(),bytes=Uint8Array.from(original),status=[];
 await assert.rejects(PDFDocument.load(bytes),/encrypted/);
 const result=await s.m.loadPDFForParsing(bytes,{onStatus:value=>status.push(value)});
 assert.deepEqual(s.calls,['queue','pdf.writeAnnotations']);assert(!result.pdf.isEncrypted);assert.equal(result.pdf.getPageCount(),3);
 assert.deepEqual(Buffer.from(result.bytes),plain);assert.deepEqual(Buffer.from(bytes),original);
 assert(status.some(value=>value.phase==='处理加密 PDF'));
});
test('unencrypted PDFs keep their original bytes and do not enter the native worker',async()=>{
 const s=setup(),result=await s.m.loadPDFForParsing(plain);
 assert.equal(result.bytes,plain);assert.equal(result.pdf.getPageCount(),3);assert.equal(s.calls.length,0);
});
test('an opening password produces an actionable error and other parsing failures remain intact',async()=>{
 const s=setup();s.context.Zotero.PDFWorker._query=async()=>{throw Error(JSON.stringify({name:'PasswordException',message:'No password given'}));};
 await assert.rejects(s.m.loadPDFForParsing(original),/PDF 需要打开密码/);
 const before=s.calls.length;await assert.rejects(s.m.loadPDFForParsing(Uint8Array.of(1,2,3)),/PDF|header/);assert.equal(s.calls.length,before);
});
test('cancellation after native preparation prevents returning a PDF for upload',async()=>{
 const s=setup(),controller=new AbortController();
 s.context.Zotero.PDFWorker._query=async()=>{controller.abort();return {buf:Uint8Array.from(plain).buffer};};
 await assert.rejects(s.m.loadPDFForParsing(original,{signal:controller.signal}),{name:'AbortError'});
});

test('the PDF library logs recoverable parser warnings in its Zotero loading scope',async()=>{
 const logs=[],context={Uint8Array,ArrayBuffer,setTimeout,atob,btoa,Zotero:{debug:message=>logs.push(message)},Services:{scriptloader:{
  loadSubScript(_uri,scope){
   const suppliedConsole=Object.hasOwn(scope,'console');vm.createContext(scope);
   if(!suppliedConsole)vm.runInContext('delete globalThis.console',scope);
   vm.runInContext(fs.readFileSync('vendor/pdf-lib/pdf-lib.min.js','utf8'),scope);
  }
 }}};
 vm.createContext(context);vm.runInContext(fs.readFileSync('docflow.js','utf8'),context);
 const bytes=new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R /LargeNumber 9007199254740993 >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF');
 const result=await context.DocFlow.loadPDFForParsing(bytes);
 assert.equal(result.pdf.getPageCount(),1);assert.equal(result.bytes,bytes);
 assert(logs.some(message=>message.includes('Parsed number that is too large')));
});
