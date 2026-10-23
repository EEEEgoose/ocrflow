const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function fixture(reply){
 const requests=[],ctx={setTimeout,clearTimeout,Zotero:{getMainWindow:()=>({AbortController})},fetch:async(url,options)=>{requests.push({url,options,body:JSON.parse(options.body)});return reply(url,options);}};
 vm.createContext(ctx);vm.runInContext(fs.readFileSync('translation-services.js','utf8'),ctx);return {service:ctx.OCRFlowTitleServices,requests,ctx};
}
const response=(data,status=200)=>({ok:status===200,status,text:async()=>JSON.stringify(data)});
test('DeepL Free and Pro use the official request shape and authentication',async()=>{
 const a=fixture(()=>response({translations:[{text:'译名',detected_source_language:'EN'}]}));
 for(const plan of ['free','pro']){
  const result=await a.service.translate('Book title',{service:'deepl',targetLang:'ZH',deeplPlan:plan,deeplApiKey:'DeepL-Auth-Key test-key'});
  const request=a.requests.at(-1);assert.equal(request.url,plan==='free'?'https://api-free.deepl.com/v2/translate':'https://api.deepl.com/v2/translate');assert.equal(request.options.headers.Authorization,'DeepL-Auth-Key test-key');
  assert.deepEqual(JSON.parse(JSON.stringify(request.body)),{text:['Book title'],target_lang:'ZH'});assert.equal(result.text,'译名');
 }
});
test('DeepLX sends one string with auto detection and an optional Bearer token',async()=>{
 const a=fixture(()=>response({code:200,data:'Titre traduit',source_lang:'EN'}));
 for(const token of ['', 'Bearer test-token']){
  const result=await a.service.translate('Book title',{service:'deeplx',targetLang:'FR',deeplxEndpoint:'http://localhost:1188/translate',deeplxToken:token});
  const request=a.requests.at(-1);assert.deepEqual(JSON.parse(JSON.stringify(request.body)),{text:'Book title',source_lang:'auto',target_lang:'FR'});
  assert.equal(request.options.headers.Authorization,token?'Bearer test-token':undefined);assert.equal(result.text,'Titre traduit');
 }
});
test('missing credentials, quota failures, business errors and empty translations are not treated as success',async()=>{
 const a=fixture(()=>response({message:'Quota exceeded'},456));
 await assert.rejects(a.service.translate('Title',{service:'deepl',targetLang:'ZH'}),/API Key/);assert.equal(a.requests.length,0);
 await assert.rejects(a.service.translate('Title',{service:'deepl',targetLang:'ZH',deeplApiKey:'test'}),/456.*Quota/);
 a.ctx.fetch=async()=>response({code:429,message:'Slow down'});await assert.rejects(a.service.translate('Title',{service:'deeplx',targetLang:'FR',deeplxEndpoint:'http://local/translate'}),/Slow down/);
 a.ctx.fetch=async()=>response({code:200,data:''});await assert.rejects(a.service.translate('Title',{service:'deeplx',targetLang:'FR',deeplxEndpoint:'http://local/translate'}),/未返回译文/);
});
test('canceling a title request aborts the service HTTP operation',async()=>{
 const a=fixture((_url,options)=>new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}))),controller=new AbortController();
 const request=a.service.translate('Title',{service:'deepl',targetLang:'ZH',deeplApiKey:'test'},controller.signal);controller.abort();
 await assert.rejects(request);assert(a.requests[0].options.signal.aborted);
});
