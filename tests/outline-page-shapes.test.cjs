const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path').posix;

function setup({reply}={}) {
  const files=new Map(),prompts=[];
  const attachment={id:1,key:'ARABIC',libraryID:1};
  const titles=['الإدارة الاستعمارية','المجتمع الجزائري'];
  const owner={PREF_BRANCH:'extensions.docflow.',getLLMSettings:()=>({apiBaseURL:'https://ai.example/v1',model:'test'}),applyAIContextBudget(){},parseOptionalJSONObject:()=>({}),mergeRequestPayload:payload=>payload};
  const context={PathUtils:{join:path.join,parent:path.dirname},IOUtils:{exists:async key=>files.has(key),readUTF8:async key=>files.get(key),makeDirectory:async()=>{},writeUTF8:async(key,value)=>files.set(key,value)},
    Zotero:{DataDirectory:{dir:'/data'},Prefs:{get:()=>true},Reader:{_readers:[]},PDFWorker:{getFullText:async()=>{throw new Error('Cached OCR text must be reused');}}},
    fetch:async(_url,options)=>{prompts.push(JSON.parse(options.body).messages[1].content);return {ok:true,json:async()=>({choices:[{message:{content:reply ?? JSON.stringify({outline:titles.map((title,index)=>({title,page:index===0?1:3}))})}}]})};}
  };
  vm.createContext(context);vm.runInContext(fs.readFileSync('prompts.js','utf8'),context);vm.runInContext(fs.readFileSync('outline.js','utf8'),context);
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


test('outline parsing repairs invalid JSON backslash escapes without losing document text',()=>{
  const s=setup();
  const reply=String.raw`{"outline":[{"title":"الإدارة الاستعمارية","summary":"公式 \sigma 与 \alpha；字面路径 C:\资料","page":1}]}`;
  assert.throws(()=>JSON.parse(reply),SyntaxError);
  const outline=s.feature.parseAIOutline(reply);
  assert.equal(outline[0].title,s.titles[0]);
  assert.equal(outline[0].summary,String.raw`公式 \sigma 与 \alpha；字面路径 C:\资料`);
  assert.equal(outline[0].page,1);
  assert.equal(s.feature.parseAIOutline('结果：\n```json\n'+reply+'\n```')[0].summary,outline[0].summary);
});

test('outline parsing keeps valid escapes and Unicode intact and still rejects broken JSON structure',()=>{
  const s=setup();
  const title='标题 "A" 与 \\alpha',summary='换行\n制表\t反斜杠\\与斜线/';
  const outline=s.feature.parseAIOutline(JSON.stringify({outline:[{title,summary,page:2}]}));
  assert.equal(outline[0].title,title);assert.equal(outline[0].summary,summary);
  const mixed=JSON.stringify({outline:[{title,summary,page:2}]}).replace('换行',String.raw`\sigma 换行`);
  assert.equal(s.feature.parseAIOutline(mixed)[0].summary,String.raw`\sigma `+summary);
  const unicode=s.feature.parseAIOutline(String.raw`{"outline":[{"title":"\u4F60\u597D","summary":"\university \sigma","page":1}]}`);
  assert.equal(unicode[0].title,'你好');assert.equal(unicode[0].summary,String.raw`\university \sigma`);
  for(const reply of [String.raw`{"outline":[{"title":"\sigma"}`,String.raw`{"outline":[{"title":"章节" "page":1}]}`])assert.throws(()=>s.feature.parseAIOutline(reply),/不是有效 JSON/);
});

test('an outline response with invalid escapes is saved using the existing OCR pages without another AI request',async()=>{
  const reply=String.raw`{"outline":[{"title":"الإدارة الاستعمارية","summary":"解释 \sigma","page":1}]}`;
  const s=setup({reply});
  await s.feature.storeSource(s.attachment,{outlinePages:s.pages,markdownText:'# '+s.titles[0]});
  const outline=await s.feature.generate(s.attachment);
  assert.equal(s.prompts.length,1);assert.equal(outline[0].page,1);
  assert.equal(JSON.parse(s.files.get(s.feature.path(s.attachment))).outline[0].summary,String.raw`解释 \sigma`);
});
