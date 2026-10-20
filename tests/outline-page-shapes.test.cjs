const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path').posix;

function setup() {
  const files=new Map(),prompts=[];
  const attachment={id:1,key:'ARABIC',libraryID:1};
  const titles=['الإدارة الاستعمارية','المجتمع الجزائري'];
  const owner={PREF_BRANCH:'extensions.docflow.',getLLMSettings:()=>({apiBaseURL:'https://ai.example/v1',model:'test'}),parseOptionalJSONObject:()=>({}),mergeRequestPayload:payload=>payload};
  const context={PathUtils:{join:path.join,parent:path.dirname},IOUtils:{exists:async key=>files.has(key),readUTF8:async key=>files.get(key),makeDirectory:async()=>{},writeUTF8:async(key,value)=>files.set(key,value)},
    Zotero:{DataDirectory:{dir:'/data'},Prefs:{get:()=>true},Reader:{_readers:[]},PDFWorker:{getFullText:async()=>{throw new Error('Cached OCR text must be reused');}}},
    fetch:async(_url,options)=>{prompts.push(JSON.parse(options.body).messages[1].content);return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({outline:titles.map((title,index)=>({title,page:index===0?1:3}))})}}]})};}
  };
  vm.createContext(context);vm.runInContext(fs.readFileSync('outline.js','utf8'),context);
  const feature=context.DocFlowOutline;feature.init(owner);
  const pages=[{page:1,text:titles[0]+'\nنص الصفحة الأولى'},{page:2,text:''},{page:3,text:titles[1]+'\nنص الصفحة الثالثة'}];
  return {feature,attachment,pages,titles,files,prompts};
}

test('an existing object-shaped AI OCR cache can generate an Arabic outline without re-reading the PDF',async()=>{
  const s=setup();s.files.set(s.feature.path(s.attachment),JSON.stringify({pages:s.pages,headings:[],outline:[]}));
  const outline=await s.feature.generate(s.attachment);
  assert.deepEqual(Array.from(outline,entry=>entry.page),[1,3]);
  assert(s.prompts[0].includes(s.titles[0]));assert(s.prompts[0].includes('PDF 第 3 页'));assert(!s.prompts[0].includes('[object Object]'));
  assert.deepEqual(JSON.parse(s.files.get(s.feature.path(s.attachment))).pages,s.pages.map(page=>page.text));
});

test('storing OCR page objects preserves blank pages and locates Markdown headings against their text',async()=>{
  const s=setup();await s.feature.storeSource(s.attachment,{outlinePages:s.pages,markdownText:'# '+s.titles[0]+'\n\n## '+s.titles[1]});
  const data=await s.feature.load(s.attachment);
  assert.deepEqual(Array.from(data.pages),s.pages.map(page=>page.text));
  assert.deepEqual(Array.from(data.headings,entry=>entry.page),[1,3]);
});
