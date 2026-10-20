const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

function setup(language='ar-SA') {
  const parent={getField:field=>{assert.equal(field,'language');return language;}};
  const context={btoa,Uint8Array,ArrayBuffer,URL,Headers,
    IOUtils:{read:async()=>Uint8Array.from([1,2])},
    Zotero:{debug:()=>{},Items:{get:()=>parent}},fetch:async()=>({ok:true})};
  vm.createContext(context);vm.runInContext(fs.readFileSync('docflow.js','utf8'),context);
  const plugin=context.DocFlow;
  const attachment={id:1,parentItemID:2,getFilePath:()=>'/test.pdf'};
  const uploads=[];
  plugin.getPDFLibrary=()=>({PDFDocument:{load:async()=>({getPageCount:()=>1})}});
  plugin.requestMineruJSON=async request=>{
    uploads.push(JSON.parse(JSON.stringify(request.body)));
    return {code:0,data:{batch_id:'batch',file_urls:['https://upload.example/content']}};
  };
  plugin.pollMineruExtractResult=async()=>({state:'done',full_zip_url:'https://result.example/result.zip'});
  plugin.downloadParseResultZip=async()=>Uint8Array.from([80,75]);
  plugin.extractNoteContentFromMineruZip=async()=>({markdownText:'converted'});
  return {plugin,attachment,uploads,parent};
}

test('cloud language accepts publication language codes, names and regional variants',()=>{
  const {plugin}=setup();
  for(const [value,expected]of [['ar-SA','arabic'],['Arabic','arabic'],['阿拉伯语','arabic'],['fr-FR','latin'],['法语','latin'],['de','latin'],['Swahili','latin'],['en-GB','en'],['zh-Hant-TW','chinese_cht'],['zh_CN','ch'],['sr-Latn','latin'],['ru','east_slavic']]) {
    assert.equal(plugin.normalizeCloudLanguage(value),expected,value);
  }
  for(const pack of ['ch','ch_server','chinese_cht','en','japan','korean','arabic','latin','cyrillic','east_slavic','devanagari','ta','te','ka','el','th'])assert.equal(plugin.normalizeCloudLanguage(pack),pack);
  for(const value of ['',null,'auto','server','unknown language'])assert.equal(plugin.normalizeCloudLanguage(value),null);
});

test('actual cloud upload requests use parent language for auto and respect manual and server-default choices',async()=>{
  for(const model of ['pipeline','vlm']) for(const [choice,expected]of [['auto','latin'],['arabic','arabic'],['ch','ch'],['server',undefined]]) {
    const {plugin,attachment,uploads,parent}=setup('French');
    await plugin.parseAttachmentWithMineru(attachment,{apiMode:'cloud',apiBaseURL:'https://cloud.example/api/v4',apiToken:'test',modelVersion:model,cloudLanguage:choice});
    assert.equal(uploads.length,1);assert.equal(uploads[0].language,expected);
    if(expected===undefined)assert(!('language' in uploads[0]));
    assert(!('language' in uploads[0].files[0]),'language belongs at the request top level');
    assert.equal(parent.getField('language'),'French','Choosing a language must not rewrite the parent');
  }
});

test('automatic mode omits the field for an unknown language or a file with no parent',async()=>{
  for(const language of ['','not-a-language']) {
    const {plugin,attachment,uploads}=setup(language);
    await plugin.parseAttachmentWithMineru(attachment,{apiMode:'cloud',apiBaseURL:'https://cloud.example',modelVersion:'vlm',cloudLanguage:'auto'});
    assert(!('language' in uploads[0]));
    attachment.parentItemID=null;
    assert.equal(plugin.cloudRecognitionLanguage(attachment,'auto'),null);
    assert.equal(plugin.cloudRecognitionLanguage(attachment,'arabic'),'arabic');
  }
});
