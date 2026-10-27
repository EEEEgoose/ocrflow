const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path').posix;
const {test} = require('node:test');

function setup({mcp=false,reading=false}={}) {
  const items = new Map(), files = new Map(), prefs = new Map(), requests = [], uploads = [], mcpCalls = [];
  let nextID = 1;
  class Item {
    constructor(type = 'attachment') {
      this.id = nextID++; this.key = 'K' + this.id; this.libraryID = 1;
      this.type = type; this.itemTypeID = type; this.fields = {}; this.tags = [];
      this.relatedItems = []; this.creators = []; items.set(this.id, this);
    }
    get parentItemID() {return this.parentID || null;}
    isAttachment() {return this.type === 'attachment';}
    isNote() {return this.type === 'note';}
    isRegularItem() {return !this.isAttachment() && !this.isNote();}
    isPDFAttachment() {return this.isAttachment() && this.attachmentFilename?.endsWith('.pdf');}
    getField(field) {return this.fields[field] || '';}
    setField(field, value) {this.fields[field] = value;}
    setType(type) {this.type = type; this.itemTypeID = type;}
    getCollections() {return [42];}
    setCollections(ids) {this.collections = Array.from(ids);}
    getCreatorsJSON() {return this.creators;}
    setCreators(creators) {this.creators = creators;}
    getTags() {return this.tags.map(tag => ({tag}));}
    hasTag(tag) {return this.tags.includes(tag);}
    addTag(tag) {if (!this.hasTag(tag)) this.tags.push(tag);}
    addRelatedItem(item) {if (this.relatedItems.includes(item.key)) return false; this.relatedItems.push(item.key); return true;}
    getAttachments() {return [...items.values()].filter(item => item.parentID === this.id && item.isAttachment() && !item.deleted).map(item => item.id);}
    getNotes() {return [...items.values()].filter(item => item.parentID === this.id && item.isNote()).map(item => item.id);}
    getFilePath() {return this.path;}
    setNote(text) {this.note = text;}
    loadAllData() {return Promise.resolve();}
    save() {return Promise.resolve(this.id);}
    saveTx() {return this.save();}
    eraseTx() {items.delete(this.id); return Promise.resolve();}
  }
  let reply = () => '学术总结';
  const fetch = async (url, options) => {
    if(url.endsWith('/health')) return {ok:!mcp,status:mcp?404:200,json:async()=>({status:'ok'})};
    if(mcp && url.endsWith('/mcp/')) {
      const payload=JSON.parse(options.body);mcpCalls.push(payload);
      const result=payload.method==='initialize'?{protocolVersion:'2024-11-05',serverInfo:{name:'markitdown'}}:{content:[{type:'text',text:'# MCP converted EPUB'}]};
      return {ok:true,headers:{get:()=>null},text:async()=>JSON.stringify({jsonrpc:'2.0',id:payload.id,result})};
    }
    const payload = JSON.parse(options.body); requests.push({url, payload, signal: options.signal});
    return {ok: true, json: async () => ({choices: [{finish_reason: 'stop', message: {content: await reply(payload)}}]})};
  };
  const win = {AbortController, FormData, Blob, fetch: async (url, options) => {
    uploads.push({url, form: options.body});
    return {ok: true, json: async () => ({markdown: '# 正文\n\n完整文档内容'})};
  }};
  const context = {
    TextDecoder, TextEncoder, Uint8Array, ArrayBuffer, URL, setTimeout, clearTimeout, atob, btoa, fetch,
    PathUtils: {join: path.join, parent: path.dirname, tempDir: '/tmp'},
    IOUtils: {
      exists: async name => files.has(name),
      getChildren: async dir => Array.from(files.keys()).filter(name => path.dirname(name) === dir),
      read: async name => {if (!files.has(name)) throw new Error('missing ' + name); return files.get(name);},
      write: async (name, bytes) => files.set(name, bytes),
      writeUTF8: async (name, text) => files.set(name, new TextEncoder().encode(text)),
      makeDirectory: async () => {}, remove: async () => {}
    },
    Zotero: {
      Item, debug: () => {}, logError: () => {}, getMainWindow: () => win,
      Items: {get: id => items.get(id), getByLibraryAndKey: (library, key) => [...items.values()].find(item => item.libraryID === library && item.key === key)},
      Prefs: {get: key => prefs.get(key), set: (key, value) => prefs.set(key, value)},
      DB: {executeTransaction: fn => fn()},
      ItemTypes: {getID: type => type}, ItemFields: {isValidForType: () => true},
      CreatorTypes: {getID: type => type, isValidForItemType: () => true},
      Attachments: {importFromFile: async options => {
        const item = new Item(); item.parentID = options.parentItemID; item.fields.title = options.title;
        item.attachmentFilename = path.basename(options.file); item.attachmentContentType = options.contentType;
        item.path = '/storage/' + item.key + '/' + item.attachmentFilename;
        files.set(item.path, files.get(options.file)); return item;
      }}
    }
  };
  vm.createContext(context);
  for (const filename of ['prompts.js','docflow.js','markitdown.js','metadata.js','workflow.js','attachment-naming.js','translation-services.js','title-translation.js']) vm.runInContext(fs.readFileSync(filename,'utf8'),context);
  const plugin = context.DocFlow;
  if(!reading)plugin.runOrganizeReadingStages=async task=>{task.state='completed';task.detail='core metadata fixture completed';};
  plugin.openParseQueueDialog = () => {}; plugin.refreshParseQueueDialog = () => {};
  plugin.mathRenderer = require('../vendor/katex/katex.min.js');
  const put = (name, text) => files.set(name, new TextEncoder().encode(text));
  const file = (name, parent) => {
    const item = new Item(); item.attachmentFilename = name; item.fields.title = name;
    item.path = '/source/' + item.key + '/' + name; item.parentID = parent?.id; put(item.path, 'file bytes'); return item;
  };
  const parsed = (original, text) => {
    const result = file(original.key + '.md', items.get(original.parentID)); result.addTag('#DocFlow-Parse');
    original.addRelatedItem(result); result.addRelatedItem(original); put(result.path, text); return result;
  };
  for (const [key,value] of Object.entries({llmApiBaseURL:'https://ai.example/v1',llmModel:'test',parserService:'markitdown',markitdownBaseURL:'http://converter.example',parseGenerateHTML:true})) prefs.set('extensions.docflow.' + key,value);
  return {plugin, context, items, files, prefs, requests, uploads, mcpCalls, file, parsed, put, Item, setReply: fn => reply = fn};
}

function fullFlow() {
 const s=setup({reading:true});
 for(const file of ['document.js','translation.js','task-sidebar.js'])vm.runInContext(fs.readFileSync(file,'utf8'),s.context);
 s.prefs.set('extensions.docflow.translateLanguage','中文');
 s.plugin.outline={generate:async()=>{},storeSource:async()=>{}};
 s.setReply(payload=>payload.response_format ? JSON.stringify({itemType:'book',title:'Full flow book',creators:[{lastName:'Author',creatorType:'author'}]}) : payload.messages[1].content.startsWith('[') ? JSON.stringify(JSON.parse(payload.messages[1].content).map(row=>({...row,text:'译文 '+row.text}))) : '学术总结');
 return s;
}
test('one-click completes all seven stages and saves summary and paragraph-aligned translation',async()=>{
 const s=fullFlow(),pdf=s.file('full.pdf');let outlines=0;s.plugin.outline.generate=async()=>{outlines++};
 await s.plugin.handleOrganizeCommand({selectedItems:[pdf]});const task=s.plugin.parseQueue[0];
 assert.equal(task.state,'completed',task.error);assert.equal(outlines,1);assert.equal(s.uploads.length,1);
 assert.deepEqual(Array.from(task.steps,row=>row.id),['extract','parent','metadata','title','summary','translate','outline']);
 assert(task.steps.every(row=>row.state==='completed'));assert(task.organizeResults.summary.isNote());assert(task.organizeResults.translate.hasTag('#DocFlow-Translation'));
 assert.equal(task.resultAttachment,task.source);assert.equal(task.cancelJobID,null);assert.equal(task.cancelSettings.workKind,'outline');
});
test('one-click continues independent work after outline failure and retries only the failed stage',async()=>{
 const s=fullFlow(),pdf=s.file('retry.pdf');let outlines=0;s.plugin.outline.generate=async()=>{if(++outlines===1)throw Error('controlled outline failure')};
 await s.plugin.handleOrganizeCommand({selectedItems:[pdf]});let task=s.plugin.parseQueue[0];
 assert.equal(task.state,'failed');assert(task.organizeResults.summary);assert(task.organizeResults.translate);
 const calls=s.requests.length,summary=task.organizeResults.summary,translation=task.organizeResults.translate;
 await s.plugin.retryParseQueueTasks([task.id]);assert.equal(task.state,'completed',task.error);
 assert.equal(outlines,2);assert.equal(s.uploads.length,1);assert.equal(s.requests.length,calls);assert.equal(task.organizeResults.summary,summary);assert.equal(task.organizeResults.translate,translation);
});
test('one-click skips a non-PDF outline but still saves summary and translation',async()=>{
 const s=fullFlow(),epub=s.file('full.epub');s.plugin.outline.generate=async()=>{throw Error('not a PDF')};
 await s.plugin.handleOrganizeCommand({selectedItems:[epub]});const task=s.plugin.parseQueue[0];
 assert.equal(task.state,'completed',task.error);assert.equal(task.organizeStages.outline.state,'skipped');assert(task.organizeResults.summary);assert(task.organizeResults.translate);
});
test('canceling one-click summary prevents translation and outline; retry preserves completed OCR',async()=>{
 const s=fullFlow(),pdf=s.file('cancel.pdf');let start,release,outlines=0,translations=0;
 const started=new Promise(resolve=>start=resolve),gate=new Promise(resolve=>release=resolve);
 const summary=s.plugin.runDocumentTask.bind(s.plugin);s.plugin.outline.generate=async()=>{outlines++};
 s.plugin.runDocumentTask=async task=>{start();await gate;task.controller.signal.throwIfAborted();await summary(task)};
 const translate=s.plugin.runTranslationTask.bind(s.plugin);s.plugin.runTranslationTask=async task=>{translations++;return translate(task)};
 const running=s.plugin.handleOrganizeCommand({selectedItems:[pdf]});await started;let task=s.plugin.parseQueue[0];
 assert.equal(task.cancelJobID,null);assert.equal(task.cancelSettings.workKind,'summary');await s.plugin.cancelParseQueueTask(task.id);release();await running;
 assert.equal(task.state,'canceled');assert.equal(translations,0);assert.equal(task.organizeStages.outline,undefined);
 await s.plugin.retryParseQueueTasks([task.id]);assert.equal(task.state,'completed',task.error);assert.equal(outlines,1);assert.equal(s.uploads.length,1);assert.equal(translations,1);
});
test('translation decisions in one-click remain visible and retry updates the child model',async()=>{
 const s=fullFlow();s.plugin.sidebar={views:new Map([[1,{}]])};
 const parent={kind:'organize'},child={kind:'translate',parentTask:parent,controller:new AbortController(),settings:{translateLanguage:'中文'}};
 const waiting=s.plugin.requestTaskDecision(child,{completed:1,total:2,failures:[]});assert.equal(parent.decision,child.decision);
 s.plugin.getTranslationSettings=()=>({translateLanguage:'中文',model:'replacement'});s.plugin.resolveTaskDecision(parent,'retry');assert.equal(await waiting,'retry');assert.equal(child.settings.model,'replacement');assert.equal(parent.displaySettings.model,'replacement');assert.equal(parent.decision,null);assert.equal(child.decision,null);
});
test('retrying an automatic correction save keeps the base attachment and does not reconvert',async()=>{
 const s=setup(),pdf=s.file('ai-save.pdf');s.prefs.set('extensions.docflow.collationAIEnabled',true);let attempts=0,baseID;
 s.plugin.saveAutomaticCollation=async(_task,base)=>{if(!baseID)baseID=base.attachment.id;assert.equal(base.attachment.id,baseID);if(++attempts===1)throw Error('controlled correction save failure');return base;};
 s.setReply(()=>JSON.stringify({itemType:'book',title:'Resume AI edition'}));
 await s.plugin.handleOrganizeCommand({selectedItems:[pdf]});let task=s.plugin.parseQueue[0];assert.equal(task.state,'failed');assert(task.ocrBaseSaved);assert(task.parsedResult);
 const attachments=s.items.size;await s.plugin.retryParseQueueTasks([task.id]);assert.equal(task.state,'completed',task.error);assert.equal(s.uploads.length,1);assert.equal(attempts,2);assert.equal(task.resultAttachment.id,baseID);assert.equal(s.items.size,attachments+1,'only the missing parent is added');
});

test('translation accepts ordinary Markdown and keeps an explicitly selected full text ahead of other results',()=>{
 const s=setup(),parent=new s.Item('book'),original=s.file('book.pdf',parent),generated=s.parsed(original,'OCR TEXT'),plain=s.file('notes.markdown',parent);
 let tasks=s.plugin.collectTranslateTasks([parent,plain]);
 assert.equal(tasks.length,1);assert.equal(tasks[0].mineruSource,plain);
 tasks=s.plugin.collectTranslateTasks([plain]);assert.equal(tasks[0].mineruSource,plain);
 const note=new s.Item('note');note.parentID=parent.id;
 assert.equal(s.plugin.collectTranslateTasks([note])[0].mineruSource,generated);
 generated.deleted=true;
 assert.equal(s.plugin.collectTranslateTasks([parent])[0].mineruSource,plain);
 const html=s.file('ocr.html',parent);html.addTag('#DocFlow-Parse');
 assert.equal(s.plugin.collectTranslateTasks([html])[0].mineruSource,html);
 const unprocessedHTML=s.file('web.html',parent);
 assert.equal(s.plugin.collectTranslateTasks([unprocessedHTML]).length,0);
 const standalone=s.file('standalone.md');assert.equal(s.plugin.collectTranslateTasks([standalone]).length,0);
 const translation=s.file('translated.html',parent);translation.addTag('#DocFlow-Translation');
 assert.equal(s.plugin.collectTranslateTasks([plain]).length,0);
});

test('manual defaults and menu dispatch; file-name action creates only the parent and moves related text', async () => {
  const s = setup();
  const defaults = new Map(); vm.runInNewContext(fs.readFileSync('prefs.js','utf8'),{pref:(key,value)=>defaults.set(key,value)});
  assert.equal(defaults.get('extensions.docflow.autoOutline'),false);
  assert.equal(defaults.get('extensions.docflow.parseGenerateHTML'),true);
  assert.equal(defaults.has('extensions.docflow.autoImport'),false);
  assert.deepEqual(Array.from(s.plugin.getContextMenuDefinitions().slice(0,4), item => item.label),['一键整理','识别文档','建立条目','补全条目']);
  const original = s.file('Smith 2024 History.epub');
  const markdown = s.parsed(original,'SECRET FULL TEXT MUST NOT BE SENT');
  s.setReply(() => JSON.stringify({itemType:'book',title:'History',date:'2024',creators:[{lastName:'Smith',creatorType:'author'}]}));
  await s.plugin.handleDocumentCommand('parent',{selectedItems:[original]});
  assert.equal(s.requests.length,1); assert.equal(s.uploads.length,0);
  const sent = JSON.stringify(s.requests[0].payload); assert(sent.includes('Smith 2024 History.epub')); assert(!sent.includes('SECRET FULL TEXT'));
  const parent = s.items.get(original.parentID); assert.equal(parent.getField('title'),'History');
  assert.deepEqual(parent.collections,[42]); assert.equal(markdown.parentID,parent.id); assert.equal(original.getField('title'),'Smith 2024 History.epub');
  await assert.rejects(() => s.plugin.handleDocumentCommand('parent',{selectedItems:[original]}),/尚无父条目/);
  assert.equal(s.requests.length,1);
});

test('organize creates a parent from extracted content and keeps the source and text together without source links',async()=>{
  for(const related of [true,false]) {
    const s=setup(),original=s.file('download.epub');
    s.prefs.set('extensions.docflow.parseLinkSourcePDF',related);
    s.setReply(payload=>{
      assert.equal(s.uploads.length,1,'the document must be extracted before identifying its parent');
      assert(JSON.stringify(payload).includes('完整文档内容'));
      assert(!JSON.stringify(payload).includes('仅分析上述文件名'));
      return JSON.stringify({itemType:'book',title:'Title on publication page',date:'2024',creators:[{lastName:'Author',creatorType:'author'}]});
    });
    const action=s.plugin.getContextMenuDefinitions().find(item=>item.id==='docflow-organize');
    assert(action);assert.equal(action.label,'一键整理');
    await action.run({selectedItems:[original]});
    const task=s.plugin.parseQueue[0],parent=s.items.get(original.parentID);
    assert.equal(task.kind,'organize');assert.equal(task.state,'completed');
    assert.equal(parent.getField('title'),'Title on publication page');assert.deepEqual(parent.collections,[42]);
    const result=[...s.items.values()].find(item=>item.hasTag('#DocFlow-Parse'));
    assert.equal(result.parentID,parent.id);assert.equal(task.source,result);
    assert.equal(original.relatedItems.includes(result.key),related);
    assert.equal(result.relatedItems.includes(original.key),related);
    assert.equal(s.requests.length,1);assert.equal(parent.getNotes().length,0,'downstream stages are isolated by this fixture');
    await s.plugin.handleOrganizeCommand({selectedItems:[parent,original]});
    assert.equal(s.plugin.parseQueue.length,1);assert.equal(s.uploads.length,1);assert.equal(s.requests.length,1);
  }
});

test('organize reuses Markdown and fills only missing metadata on an existing parent',async()=>{
  const s=setup(),parent=new s.Item('book'),original=s.file('existing.pdf',parent);
  parent.setField('title','Connector title');parent.setField('publisher','Connector publisher');
  parent.setCreators([{lastName:'Existing author',creatorType:'author'}]);
  const markdown=s.parsed(original,'PUBLICATION_PAGE');
  s.setReply(payload=>{
    assert(JSON.stringify(payload).includes('PUBLICATION_PAGE'));
    return JSON.stringify({itemType:'report',title:'Different title',publisher:'Different publisher',ISBN:'9780000000002',
      creators:[{lastName:'Replacement author',creatorType:'author'},{lastName:'New editor',creatorType:'editor'}]});
  });
  await s.plugin.handleOrganizeCommand({selectedItems:[parent,original]});
  assert.equal(s.plugin.parseQueue.length,1);assert.equal(s.plugin.parseQueue[0].state,'completed');
  assert.equal(parent.type,'book');assert.equal(parent.getField('title'),'Connector title');
  assert.equal(parent.getField('publisher'),'Connector publisher');assert.equal(parent.getField('ISBN'),'9780000000002');
  assert.deepEqual(Array.from(parent.creators,creator=>[creator.lastName,creator.creatorType]).sort(),[['Existing author','author'],['New editor','editor']]);
  assert.equal(s.plugin.parseQueue[0].source,markdown);assert.equal(s.uploads.length,0);
  await s.plugin.handleOrganizeCommand({selectedItems:[parent]});
  assert.equal(s.plugin.parseQueue.length,1);assert.equal(s.requests.length,1);
});

test('organize uses an explicitly selected older Markdown and returns to the latest text for the original',async()=>{
  const s=setup(),parent=new s.Item('book'),original=s.file('versions.pdf',parent);
  const old=s.parsed(original,'OLD_PUBLICATION_PAGE'),latest=s.parsed(original,'LATEST_PUBLICATION_PAGE');
  s.setReply(payload=>{
    assert(JSON.stringify(payload).includes('OLD_PUBLICATION_PAGE'));
    assert(!JSON.stringify(payload).includes('LATEST_PUBLICATION_PAGE'));
    return JSON.stringify({title:'Title from chosen text'});
  });
  await s.plugin.handleOrganizeCommand({selectedItems:[old]});
  const task=s.plugin.parseQueue[0];assert.equal(task.state,'completed');assert.equal(task.source,old);
  assert.equal(parent.getField('title'),'Title from chosen text');
  s.setReply(payload=>{
    assert(JSON.stringify(payload).includes('LATEST_PUBLICATION_PAGE'));
    assert(!JSON.stringify(payload).includes('OLD_PUBLICATION_PAGE'));
    return JSON.stringify({title:'Latest title',date:'2024'});
  });
  await s.plugin.handleOrganizeCommand({selectedItems:[original]});
  assert.equal(s.plugin.parseQueue.length,1);assert.equal(task.source,latest);assert.equal(task.state,'completed');
  assert.equal(parent.getField('title'),'Title from chosen text');assert.equal(parent.getField('date'),'2024');
  assert.equal(s.uploads.length,0);
});

test('organize waits for an attachment and continues after the user supplies one',async()=>{
  const s=setup(),parent=new s.Item('book');parent.setField('title','Known bibliography');
  await s.plugin.handleOrganizeCommand({selectedItems:[parent]});
  const waiting=s.plugin.parseQueue[0];assert.equal(waiting.state,'waiting');
  assert.equal(s.requests.length,0);assert.equal(s.uploads.length,0);
  const original=s.file('supplied.pdf',parent);
  s.setReply(()=>JSON.stringify({title:'Known bibliography',publisher:'Publisher from supplied text'}));
  await s.plugin.handleOrganizeCommand({selectedItems:[parent]});
  assert.equal(s.plugin.parseQueue.length,1);assert.equal(waiting.state,'completed');
  assert.equal(waiting.attachment.id,original.id);assert.equal(parent.getField('publisher'),'Publisher from supplied text');
});

test('organize asks for a source when a parent has multiple originals and respects an explicit attachment',async()=>{
  const s=setup(),parent=new s.Item('book'),first=s.file('main.pdf',parent),second=s.file('supplement.pdf',parent);
  parent.setField('title','Book');
  await s.plugin.handleOrganizeCommand({selectedItems:[parent]});
  assert.equal(s.plugin.parseQueue[0].state,'waiting');assert.equal(s.requests.length,0);assert.equal(s.uploads.length,0);
  s.parsed(first,'MAIN_DOCUMENT');s.parsed(second,'SUPPLEMENT_DOCUMENT');
  s.setReply(payload=>{
    assert(JSON.stringify(payload).includes('MAIN_DOCUMENT'));assert(!JSON.stringify(payload).includes('SUPPLEMENT_DOCUMENT'));
    return JSON.stringify({title:'Book',publisher:'Main publisher'});
  });
  await s.plugin.handleOrganizeCommand({selectedItems:[parent,first]});
  assert.equal(s.requests.length,1);assert.equal(s.uploads.length,0);
  assert.equal(parent.getField('publisher'),'Main publisher');
  assert(!s.plugin.parseQueue.some(task=>task.attachment.id===second.id));
});

test('organize waits for an unavailable local file instead of submitting an empty conversion',async()=>{
  const s=setup(),parent=new s.Item('book'),original=s.file('not-downloaded.pdf',parent);
  s.files.delete(original.path);
  await s.plugin.handleOrganizeCommand({selectedItems:[original]});
  const task=s.plugin.parseQueue[0];assert.equal(task.state,'waiting');
  assert.equal(s.requests.length,0);assert.equal(s.uploads.length,0);
  s.put(original.path,'downloaded bytes');s.setReply(()=>JSON.stringify({title:'Downloaded book'}));
  await s.plugin.handleOrganizeCommand({selectedItems:[original]});
  assert.equal(s.plugin.parseQueue.length,1);assert.equal(task.state,'completed');assert.equal(s.uploads.length,1);
});

test('organize offers other Zotero file attachments to the converter and reports its actual unsupported-format error',async()=>{
  const s=setup(),original=s.file('document.odt');
  s.setReply(()=>JSON.stringify({itemType:'document',title:'Open document'}));
  await s.plugin.handleOrganizeCommand({selectedItems:[original]});
  assert.equal(s.plugin.parseQueue[0].state,'completed');assert.equal(s.uploads[0].form.get('file').name,'document.odt');
  const unsupported=s.file('archive.mobi');
  s.plugin.parseAttachmentWithMineru=async attachment=>{
    assert.equal(attachment,unsupported);throw new Error('MarkItDown: unsupported file format mobi');
  };
  await s.plugin.handleOrganizeCommand({selectedItems:[unsupported]});
  assert.equal(s.plugin.parseQueue.at(-1).state,'failed');
  assert.match(s.plugin.parseQueue.at(-1).error,/unsupported file format mobi/);
  assert.equal(unsupported.parentID,undefined);
});

test('organize reuses an unlinked conversion of another file type after the queue is cleared',async()=>{
  const s=setup(),original=s.file('document.odt');
  s.prefs.set('extensions.docflow.parseLinkSourcePDF',false);
  s.setReply(()=>JSON.stringify({itemType:'document',title:'Open document'}));
  await s.plugin.handleOrganizeCommand({selectedItems:[original]});
  assert.equal(s.plugin.parseQueue[0].state,'completed');
  s.plugin.clearParseQueueTasks();
  await s.plugin.handleOrganizeCommand({selectedItems:[s.items.get(original.parentID)]});
  assert.equal(s.plugin.parseQueue[0].state,'completed');
  assert.equal(s.uploads.length,1,'an existing unambiguous Markdown must be reused for every accepted original file type');
  assert.equal([...s.items.values()].filter(item=>item.hasTag('#DocFlow-Parse')).length,1);
});

test('organize resumes a failed metadata step without converting the document again',async()=>{
  const s=setup(),original=s.file('retry.epub');
  s.setReply(()=>{throw new Error('AI unavailable');});
  await s.plugin.handleOrganizeCommand({selectedItems:[original]});
  const task=s.plugin.parseQueue[0];assert.equal(task.state,'failed');assert.match(task.error,/AI unavailable/);
  assert(task.source);assert.equal(original.parentID,undefined);assert.equal(s.uploads.length,1);
  s.setReply(()=>JSON.stringify({itemType:'book',title:'Recovered title'}));
  await s.plugin.retryParseQueueTasks([task.id]);
  assert.equal(task.state,'completed');assert.equal(s.uploads.length,1);
  assert.equal(s.items.get(original.parentID).getField('title'),'Recovered title');
  assert.equal([...s.items.values()].filter(item=>item.hasTag('#DocFlow-Parse')).length,1);
});

test('organize extracts the original when its only existing Markdown is a translation',async()=>{
  const s=setup(),parent=new s.Item('book'),original=s.file('original.epub',parent);
  parent.setField('title','Book');
  const translation=s.file('translated.md',parent);translation.addTag('#DocFlow-Translation');
  s.put(translation.path,'TRANSLATED_TEXT_MUST_NOT_IDENTIFY_THE_ORIGINAL');
  s.setReply(payload=>{
    assert(JSON.stringify(payload).includes('完整文档内容'));
    assert(!JSON.stringify(payload).includes('TRANSLATED_TEXT_MUST_NOT_IDENTIFY_THE_ORIGINAL'));
    return JSON.stringify({title:'Book',publisher:'Original publisher'});
  });
  await s.plugin.handleOrganizeCommand({selectedItems:[parent]});
  assert.equal(s.plugin.parseQueue[0].state,'completed');assert.equal(s.uploads.length,1);
  assert.equal(parent.getField('publisher'),'Original publisher');
});

test('organize continues a pending parse with its original service when the default changes',async()=>{
  const s=setup(),original=s.file('pending.pdf');
  s.prefs.set('extensions.docflow.apiMode','local-v1');
  s.prefs.set('extensions.docflow.parserService','mineru');
  const services=[];
  s.plugin.parseAttachmentWithMineru=async(_attachment,settings,options)=>{
    services.push([settings.apiMode,settings.parserService,options.jobID]);
    if(services.length===1) {
      options.onStatus({jobID:'original-job'});
      const error=new Error('still running');error.name='MineruJobWaitTimeout';throw error;
    }
    return {markdownText:'Publication page'};
  };
  s.setReply(()=>JSON.stringify({itemType:'book',title:'Recovered book'}));
  await s.plugin.handleOrganizeCommand({selectedItems:[original]});
  const task=s.plugin.parseQueue[0];assert.equal(task.state,'wait_expired');
  s.prefs.set('extensions.docflow.apiMode','cloud');s.prefs.set('extensions.docflow.parserService','ai');
  await s.plugin.retryParseQueueTasks([task.id]);
  assert.equal(task.state,'completed');assert.equal(task.jobID,null);
  assert.deepEqual(services,[['local-v1','mineru',null],['local-v1','mineru','original-job']]);
});

test('organize retries a failed attachment save without repeating conversion',async()=>{
  const s=setup(),original=s.file('save-retry.epub'),importer=s.context.Zotero.Attachments.importFromFile;
  let imports=0;s.context.Zotero.Attachments.importFromFile=async options=>{
    if(++imports===1)throw new Error('disk full');
    return importer(options);
  };
  s.setReply(()=>JSON.stringify({itemType:'book',title:'Saved title'}));
  await s.plugin.handleOrganizeCommand({selectedItems:[original]});
  const task=s.plugin.parseQueue[0];assert.equal(task.state,'failed');assert(task.parsedResult);
  assert.equal(s.requests.length,0);
  await s.plugin.retryParseQueueTasks([task.id]);
  assert.equal(task.state,'completed');assert.equal(s.uploads.length,1);assert.equal(s.requests.length,1);
  assert.equal(task.parsedResult,null);
});

test('organize remains cancelable after saving text and resumes without repeating conversion',async()=>{
  const s=setup(),parent=new s.Item('book'),original=s.file('cancel.pdf',parent);
  parent.setField('title','Existing title');
  let started,release;const inFlight=new Promise(resolve=>started=resolve),gate=new Promise(resolve=>release=resolve);
  s.setReply(async()=>{started();await gate;return JSON.stringify({title:'Existing title',publisher:'Must not be saved'});});
  const running=s.plugin.handleOrganizeCommand({selectedItems:[original]});await inFlight;
  const task=s.plugin.parseQueue[0];assert(task.source);assert.equal(task.saving,false);
  await s.plugin.cancelParseQueueTask(task.id);release();await running;
  assert.equal(task.state,'canceled');assert.equal(parent.getField('publisher'),'');assert.equal(s.uploads.length,1);
  s.setReply(()=>JSON.stringify({title:'Existing title',publisher:'Recovered publisher'}));
  await s.plugin.retryParseQueueTasks([task.id]);
  assert.equal(task.state,'completed');assert.equal(s.uploads.length,1);assert.equal(parent.getField('publisher'),'Recovered publisher');
});

test('PDF and EPUB convert full files, preserve their names, and save required formats with source relations', async () => {
  const s = setup(); const parent = new s.Item('book'); parent.setField('title','书籍');
  const pdf = s.file('document.pdf',parent), epub = s.file('book.epub',parent);
  await s.plugin.handleParseCommand({selectedItems:[pdf,epub]});
  assert.deepEqual(Array.from(s.plugin.parseQueue, task => task.state),['completed','completed']);
  assert.equal(s.requests.length,0,'OCR must not start metadata or summary requests');
  assert.equal(s.uploads.length,2); assert.equal(s.uploads[0].form.get('file').name,'document.pdf'); assert.equal(s.uploads[1].form.get('file').name,'book.epub');
  const pdfResult=s.plugin.findDocumentMarkdown(pdf), epubResult=s.plugin.findDocumentMarkdown(epub);
  assert(pdfResult.attachmentFilename.endsWith('.html')); assert(epubResult.attachmentFilename.endsWith('.md'));
  const companion = pdfResult.path.replace(/\.html$/,'.md'); assert(s.files.has(companion));
  assert(new TextDecoder().decode(s.files.get(companion)).includes('完整文档内容'));
  assert(pdfResult.relatedItems.includes(pdf.key)); assert(epubResult.relatedItems.includes(epub.key));
  assert.equal(s.plugin.collectSourceFiles([parent]).length,2,'generated HTML must not be offered for re-OCR');
});

test('metadata reads the selected document Markdown, corrects initial fields and leaves missing fields intact', async () => {
  const s=setup(); const parent=new s.Item('book'); parent.setField('title','filename guess'); parent.setField('ISBN','keep-isbn');
  const a=s.file('first.pdf',parent), b=s.file('second.pdf',parent);
  s.parsed(a,'WRONG_DOCUMENT'); s.parsed(b,'RIGHT_DOCUMENT\nPublisher proof');
  s.setReply(payload => {assert(JSON.stringify(payload).includes('RIGHT_DOCUMENT')); assert(!JSON.stringify(payload).includes('WRONG_DOCUMENT'));
    return JSON.stringify({itemType:'book',title:'Correct title',publisher:'Publisher',ISBN:'',creators:[]});});
  await s.plugin.handleDocumentCommand('metadata',{selectedItems:[b]});
  assert.equal(s.plugin.parseQueue[0].state,'completed'); assert.equal(parent.getField('title'),'Correct title'); assert.equal(parent.getField('ISBN'),'keep-isbn');
  assert.equal(s.uploads.length,0);
});

test('metadata enrichment saves a Chinese title translation in shortTitle and preserves the original title and language',async()=>{
  for(const [language,title,translated] of [
    ['fr','Étude d’un document','文献研究'],['ar','دراسة في التاريخ','历史研究'],['ja','近代日本の思想','近代日本思想']
  ]) {
    const s=setup(),parent=new s.Item('book'),original=s.file('book.pdf',parent);
    parent.setField('title',title);parent.setField('language',language);parent.setField('publisher','keep-publisher');
    s.parsed(original,'Title: '+title+'\nPublication language: '+language);
    s.setReply(payload=>{
      const system=payload.messages[0].content;
      assert(system.includes('shortTitle 必须填写该题名的完整简体中文译名'));
      assert(system.includes('title 必须保留完整原文题名'));assert(system.includes('日文等非中文资料也需要中文译名'));
      return JSON.stringify({itemType:'book',title,shortTitle:translated,language,creators:[]});
    });
    await s.plugin.handleDocumentCommand('metadata',{selectedItems:[original]});
    assert.equal(s.plugin.parseQueue[0].state,'completed');assert.equal(parent.getField('title'),title);
    assert.equal(parent.getField('shortTitle'),translated);assert.equal(parent.getField('language'),language);assert.equal(parent.getField('publisher'),'keep-publisher');
    assert.equal(s.requests.length,1,'translation shares the metadata request');
  }
});

test('Chinese metadata and missing translation results do not erase an existing short title',async()=>{
  for(const language of ['zh-CN','fr']) {
    const s=setup(),parent=new s.Item('book'),original=s.file('book.pdf',parent);
    parent.setField('title',language==='fr'?'Étude d’un document':'文献研究');parent.setField('shortTitle','已有短标题');
    s.parsed(original,'Publication language: '+language);
    s.setReply(payload=>{
      assert(payload.messages[0].content.includes('中文版本不另行翻译题名'));
      return JSON.stringify({title:parent.getField('title'),shortTitle:'',language,creators:[]});
    });
    await s.plugin.handleDocumentCommand('metadata',{selectedItems:[original]});
    assert.equal(s.plugin.parseQueue[0].state,'completed');assert.equal(parent.getField('shortTitle'),'已有短标题');
  }
});

test('later document chunks cannot replace a title translation identified on publication pages',async()=>{
  const s=setup(),parent=new s.Item('book'),original=s.file('long.pdf',parent);
  s.parsed(original,'Étude d’un document\n\n'+'正文分段\n\n'.repeat(9000));
  s.setReply(()=>JSON.stringify(s.requests.length===1?{title:'Étude d’un document',shortTitle:'文献研究',language:'fr'}:{title:'A cited book',shortTitle:'参考文献书名',language:'en'}));
  await s.plugin.handleDocumentCommand('metadata',{selectedItems:[original]});
  assert.equal(s.plugin.parseQueue[0].state,'completed');assert(s.requests.length>1);
  assert.equal(parent.getField('title'),'Étude d’un document');assert.equal(parent.getField('shortTitle'),'文献研究');assert.equal(parent.getField('language'),'fr');
});

test('filename-only parent creation keeps its existing original-language behavior',async()=>{
  const s=setup(),original=s.file('Étude d’un document.pdf');
  s.setReply(payload=>{
    assert(payload.messages[0].content.includes('外文文献保持其原文，不翻译成中文。'));
    assert(!payload.messages[0].content.includes('shortTitle 必须填写该题名的完整简体中文译名'));
    return JSON.stringify({itemType:'book',title:'Étude d’un document',shortTitle:'Étude',language:'fr'});
  });
  await s.plugin.handleDocumentCommand('parent',{selectedItems:[original]});
  const parent=s.items.get(original.parentID);assert.equal(parent.getField('shortTitle'),'Étude');
});

test('missing Markdown and missing parent fail without starting hidden OCR or creating items', async () => {
  const s=setup(); const parent=new s.Item('book'), original=s.file('missing.pdf',parent), independent=s.file('alone.pdf');
  s.parsed(independent,'body');
  await s.plugin.handleDocumentCommand('summary',{selectedItems:[original,independent]});
  assert.deepEqual(Array.from(s.plugin.parseQueue, task => task.state),['failed','failed']);
  assert.match(s.plugin.parseQueue[0].error,/Markdown/); assert.match(s.plugin.parseQueue[1].error,/父条目/);
  assert.equal(s.requests.length,0); assert.equal(s.uploads.length,0); assert.equal(parent.getNotes().length,0);
});

test('long document summaries include the tail and reruns update only the matching note', async () => {
  const s=setup(), parent=new s.Item('book'); const a=s.file('long.pdf',parent), b=s.file('other.pdf',parent);
  s.parsed(a,'FIRST_SECTION\n\n' + '正文 evidence\n\n'.repeat(8000) + 'TAIL_MUST_BE_READ'); s.parsed(b,'OTHER_DOCUMENT');
  s.setReply(payload => JSON.stringify(payload).includes('TAIL_MUST_BE_READ') ? '末尾结论：TAIL_EVIDENCE' : '学术摘要');
  await s.plugin.handleDocumentCommand('summary',{selectedItems:[a]});
  assert.equal(s.plugin.parseQueue.at(-1).state,'completed');
  assert(s.requests.some(({payload}) => JSON.stringify(payload).includes('TAIL_MUST_BE_READ')));
  assert(s.requests.at(-1).payload.messages[1].content.includes('TAIL_EVIDENCE'));
  assert.equal(parent.getNotes().length,1); const firstNote=s.items.get(parent.getNotes()[0]); assert(firstNote.relatedItems.includes(a.key));
  s.setReply(() => 'UPDATED SUMMARY'); await s.plugin.handleDocumentCommand('summary',{selectedItems:[a,b]});
  assert.equal(parent.getNotes().length,2); assert(firstNote.note.includes('UPDATED SUMMARY'));
  assert(s.items.get(parent.getNotes()[1]).relatedItems.includes(b.key));
});

function virtualClock(s) {
 let now=0,next=0;const timers=new Map();
 s.context.setTimeout=(fn,ms)=>{const id=++next;timers.set(id,{fn,at:now+ms});return id};
 s.context.clearTimeout=id=>timers.delete(id);
 return {timers,advance(ms){now+=ms;for(const [id,timer]of [...timers])if(timer.at<=now){timers.delete(id);timer.fn()}}};
}
test('a slow AI summary can finish after the former three-minute deadline',async()=>{
 const s=setup(),clock=virtualClock(s),settings={...s.plugin.getLLMSettings('summary'),providerName:'ECNU',model:'ecnu-max'};let release,signal;
 s.context.fetch=async(_url,options)=>{signal=options.signal;await new Promise(resolve=>release=resolve);return {ok:true,json:async()=>({choices:[{message:{content:'完整总结'}}]})}};
 const request=s.plugin.requestDocumentAI([{role:'user',content:'文献正文'}],settings,new AbortController().signal);
 await Promise.resolve();clock.advance(240000);assert.equal(signal.aborted,false);release();assert.equal(await request,'完整总结');assert.equal(clock.timers.size,0);
});
test('AI request deadlines cover waiting for headers and reading the response body, with an explicit timeout message',async()=>{
 for(const body of [false,true]) {
  const s=setup(),clock=virtualClock(s),settings={...s.plugin.getLLMSettings('summary'),providerName:'ECNU',model:'ecnu-max'};let began;
  const started=new Promise(resolve=>began=resolve);
  s.context.fetch=async(_url,options)=>{const wait=()=>new Promise((_resolve,reject)=>{options.signal.addEventListener('abort',()=>reject(options.signal.reason));began()});return body ? {ok:true,json:wait} : wait()};
  const pending=s.plugin.requestDocumentAI([{role:'user',content:'正文'}],settings,new AbortController().signal);await started;clock.advance(1200000);
  await assert.rejects(pending,error=>error.name==='TimeoutError'&&error.timeoutMS===1200000&&/1200 秒.*ECNU \/ ecnu-max/.test(error.message));assert.equal(clock.timers.size,0);
 }
});
test('manual cancellation stays cancellation and an unexpected abort gets a readable connection error',async()=>{
 const s=setup(),clock=virtualClock(s),controller=new AbortController(),settings=s.plugin.getLLMSettings('summary');
 s.context.fetch=(_url,options)=>new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason)));
 const pending=s.plugin.requestDocumentAI([{role:'user',content:'正文'}],settings,controller.signal);controller.abort();await assert.rejects(pending,{name:'AbortError'});assert.equal(clock.timers.size,0);
 s.context.fetch=async()=>{const error=new Error('The operation was aborted.');error.name='AbortError';throw error};
 await assert.rejects(s.plugin.requestDocumentAI([{role:'user',content:'正文'}],settings),/AI 请求中断.*未收到完整回复/);assert.equal(clock.timers.size,0);
});
test('a timed-out summary saves no incomplete note and can retry from existing full text',async()=>{
 const s=setup(),clock=virtualClock(s),parent=new s.Item('book'),original=s.file('summary.pdf',parent);s.parsed(original,'Full text remains available.');
 let began;const started=new Promise(resolve=>began=resolve),fetch=s.context.fetch;
 s.context.fetch=(_url,options)=>new Promise((_resolve,reject)=>{options.signal.addEventListener('abort',()=>reject(options.signal.reason));began()});
 const running=s.plugin.handleDocumentCommand('summary',{selectedItems:[original]});await started;clock.advance(1200000);await running;
 const task=s.plugin.parseQueue.at(-1);assert.equal(task.state,'failed');assert.match(task.error,/AI 请求超时/);assert.equal(parent.getNotes().length,0);assert.equal(s.uploads.length,0);
 s.context.fetch=fetch;await s.plugin.retryParseQueueTasks([task.id]);assert.equal(task.state,'completed');assert.equal(parent.getNotes().length,1);assert.equal(s.uploads.length,0);
});

test('AI OCR sends image content', async () => {
  const s=setup(); const image=s.file('scan.png'); s.prefs.set('extensions.docflow.parserService','ai');
  s.setReply(payload => {const input=payload.messages[1].content; assert.equal(input[1].type,'image_url'); return 'recognized page';});
  let settings=s.plugin.getSettings();
  const result=await s.plugin.parseAttachmentWithMineru(image,settings,{signal:new AbortController().signal});
  assert(result.markdownText.includes('recognized page')); assert.equal(settings.outputFormat,'html');
});

for (const alreadyOpen of [true,false]) test(`PDF AI OCR ${alreadyOpen?'reuses an open':'opens a new'} Zotero 10 reader and processes every page`, async () => {
  const s=setup(),pdf=s.file('scan.pdf'); let rendered=0,opened=0;
  const canvas={getContext:()=>({}), toDataURL:()=> 'data:image/jpeg;base64,YQ=='};
  const readerRealm=vm.runInNewContext('({Object})');
  let initialized=false,viewReady=false;
  const reader={itemID:pdf.id,_initPromise:Promise.resolve().then(()=>{
    initialized=true;
    reader._internalReader={_primaryView:{initializedPromise:Promise.resolve().then(()=>{viewReady=true;}),_iframeWindow:{...readerRealm,document:{createElement:()=>canvas}}}};
  })};
  s.context.Zotero.Reader={
    _readers:[{itemID:pdf.id,_isTabClosed:true},...(alreadyOpen?[reader]:[])],
    open:async(id,location,options)=>{opened++;assert.equal(id,pdf.id);assert.equal(options.openInBackground,true);return reader;}
  };
  s.plugin.outline={getReaderApp:()=>{
    assert(initialized);assert(viewReady);
    return {pdfDocument:{numPages:3,getPage:async()=>{
      const page={
        getViewport:options=>{assert.equal(Object.getPrototypeOf(options),readerRealm.Object.prototype);return {width:100*options.scale,height:200*options.scale};},
        render:options=>{assert.equal(Object.getPrototypeOf(options),readerRealm.Object.prototype);assert(options.canvasContext);assert(options.viewport);rendered++;return {promise:Promise.resolve()};}
      };
      return alreadyOpen?page:{wrappedJSObject:page};
    }}};
  }};
  s.setReply(()=>`recognized page ${s.requests.length}`);
  const full=await s.plugin.parseWithVision(pdf,s.plugin.getSettings().llmSettings,{signal:new AbortController().signal});
  assert.equal(opened,alreadyOpen?0:1);assert.equal(rendered,3); assert.equal(full.outlinePages.length,3); assert.equal(s.requests.length,3);
  assert.deepEqual(Array.from(full.outlinePages),['recognized page 1','recognized page 2','recognized page 3']);
  assert(full.markdownText.indexOf('recognized page 1')<full.markdownText.indexOf('recognized page 3'));
  assert.equal(canvas.width,0);assert.equal(canvas.height,0);
});

test('canceling a metadata task while AI is in flight prevents field writes', async () => {
  const s=setup(), parent=new s.Item('book'); parent.setField('title','before'); const original=s.file('test.pdf',parent); s.parsed(original,'body');
  let release, started; const gate=new Promise(resolve=>release=resolve), inFlight=new Promise(resolve=>started=resolve);
  s.setReply(async()=>{started(); await gate; return JSON.stringify({title:'must not be written',creators:[]});});
  const running=s.plugin.handleDocumentCommand('metadata',{selectedItems:[original]}); await inFlight;
  await s.plugin.cancelParseQueueTask(s.plugin.parseQueue[0].id); release(); await running;
  assert.equal(parent.getField('title'),'before'); assert.equal(s.plugin.parseQueue[0].state,'canceled');
});

test('source selection uses the latest related text while an explicitly chosen older Markdown is respected', async () => {
  const s=setup(), parent=new s.Item('book'), original=s.file('versioned.pdf',parent);
  const old=s.parsed(original,'OLD_VERSION'), latest=s.parsed(original,'LATEST_VERSION');
  original.relatedItems.reverse();
  assert.equal(s.plugin.findDocumentMarkdown(original),latest);
  s.setReply(payload => {
    const text=JSON.stringify(payload);
    assert(text.includes('OLD_VERSION')); assert(!text.includes('LATEST_VERSION'));
    return JSON.stringify({title:'From chosen old version',creators:[]});
  });
  await s.plugin.handleDocumentCommand('metadata',{selectedItems:[old]});
  assert.equal(s.plugin.parseQueue.at(-1).state,'completed');
  assert.equal(parent.getField('title'),'From chosen old version');
});

test('retrying an EPUB save failure keeps Markdown output and reuses the completed conversion', async () => {
  const s=setup(), original=s.file('retry.epub');
  const importer=s.context.Zotero.Attachments.importFromFile;
  let attempts=0;
  s.context.Zotero.Attachments.importFromFile=async options => {
    if (++attempts===1) throw new Error('disk full');
    return importer(options);
  };
  await s.plugin.handleParseCommand({selectedItems:[original]});
  const task=s.plugin.parseQueue[0]; assert.equal(task.state,'failed'); assert(task.parsedResult);
  await s.plugin.retryParseQueueTasks([task.id]);
  assert.equal(task.state,'completed'); assert.equal(s.uploads.length,1);
  assert(s.plugin.findDocumentMarkdown(original).attachmentFilename.endsWith('.md'));
});

test('HTML and source relations remain optional throughout extraction and saving',async()=>{
  for(const html of [true,false]) for(const related of [true,false]) {
    const s=setup(), parent=new s.Item('book'), original=s.file('optional.pdf',parent);
    s.prefs.set('extensions.docflow.parseGenerateHTML',html);s.prefs.set('extensions.docflow.parseLinkSourcePDF',related);
    await s.plugin.handleParseCommand({selectedItems:[original]});
    assert.equal(s.plugin.parseQueue[0].state,'completed');
    const result=[...s.items.values()].find(item=>item.hasTag('#DocFlow-Parse'));
    assert(result.attachmentFilename.endsWith(html?'.html':'.md'));
    assert.equal(original.relatedItems.includes(result.key),related);assert.equal(result.relatedItems.includes(original.key),related);
  }
});

test('a MarkItDown MCP service receives document bytes as a data URI and saves its Markdown result',async()=>{
  const s=setup({mcp:true}),original=s.file('book.epub');
  await s.plugin.handleParseCommand({selectedItems:[original]});
  assert.equal(s.plugin.parseQueue[0].state,'completed');
  assert.equal(s.uploads.length,0,'MCP conversion must not call the REST upload endpoint');
  const conversion=s.mcpCalls.find(call=>call.method==='tools/call');
  assert.equal(conversion.params.name,'convert_to_markdown');
  assert(conversion.params.arguments.uri.startsWith('data:application/epub+zip;base64,'));
  const markdown=s.plugin.findDocumentMarkdown(original);
  assert((await s.plugin.readSourceMarkdown(markdown)).markdown.includes('MCP converted EPUB'));
});

function oversizedEPUB(s, {failBatch=0,cancel}={}) {
  const original=s.context.fetch,converted=[];
  s.plugin.readEPUBForMarkItDown=async()=>({metadata:'**Title:** Test book',html:'chapter bodies',chapters:2,
    embeddedImages:[{id:'img-1',marker:'docflow-image://img-1',fileName:'cover.jpg',mimeType:'image/jpeg',bytes:Uint8Array.from([1,2,3])}]});
  s.plugin.splitMarkItDownHTML=()=>['<h1>Chapter One</h1>','<h1>Chapter Two</h1>'];
  s.context.fetch=async(url,options={})=>{
    const request=options.body&&JSON.parse(options.body);
    if(request?.method!=='tools/call')return original(url,options);
    const uri=request.params.arguments.uri;
    if(uri.startsWith('data:application/epub+zip;'))return {ok:false,status:413,text:async()=>'Payload Too Large'};
    assert(uri.startsWith('data:text/html;base64,'));
    converted.push(new TextDecoder().decode(Uint8Array.from(atob(uri.split(',')[1]),c=>c.charCodeAt(0))));
    if(cancel)cancel.abort();
    return {ok:true,headers:{get:()=>null},text:async()=>JSON.stringify({id:2,result:{isError:converted.length===failBatch,content:[{type:'text',text:converted.length===failBatch?'conversion failed':`# Chapter ${converted.length}`+(converted.length===1?'\n\n![cover](docflow-image://img-1)':'')}]}})};
  };
  return converted;
}

test('an oversized EPUB switches to ordered HTML batches and saves one complete Markdown attachment',async()=>{
  const s=setup({mcp:true}),original=s.file('large.epub'),converted=oversizedEPUB(s);
  await s.plugin.handleParseCommand({selectedItems:[original]});
  assert.equal(s.plugin.parseQueue[0].state,'completed');assert.equal(converted.length,2);
  assert(converted[0].includes('Chapter One'));assert(converted[1].includes('Chapter Two'));
  const results=[...s.items.values()].filter(item=>item.hasTag('#DocFlow-Parse'));assert.equal(results.length,1);
  const {markdown}=await s.plugin.readSourceMarkdown(results[0]);
  assert(markdown.includes('**Title:** Test book'));assert(markdown.indexOf('# Chapter 1')<markdown.indexOf('# Chapter 2'));
  assert(markdown.includes('![cover](images/image-1.jpg)'));assert([...s.files.keys()].some(name=>name.endsWith('/images/image-1.jpg')));
});

test('a failed EPUB batch fails the task without saving partial content',async()=>{
  const s=setup({mcp:true}),original=s.file('large.epub');oversizedEPUB(s,{failBatch:2});
  await s.plugin.handleParseCommand({selectedItems:[original]});
  assert.equal(s.plugin.parseQueue[0].state,'failed');assert.match(s.plugin.parseQueue[0].error,/conversion failed/);
  assert(![...s.items.values()].some(item=>item.hasTag('#DocFlow-Parse')));
});

test('canceling EPUB batch conversion prevents later requests and partial output',async()=>{
  const s=setup({mcp:true}),original=s.file('large.epub'),controller=new AbortController();
  const converted=oversizedEPUB(s,{cancel:controller});
  await assert.rejects(()=>s.plugin.parseWithMarkItDown(original,s.plugin.getSettings(),{signal:controller.signal}),{name:'AbortError'});
  assert.equal(converted.length,1);assert(![...s.items.values()].some(item=>item.hasTag('#DocFlow-Parse')));
});

test('images converted to PDF also receive the parent document cloud language',async()=>{
  const s=setup(),parent=new s.Item('book'),original=s.file('scan.png',parent);
  parent.setField('language','ar-SA');
  s.plugin.getPDFLibrary=()=>({PDFDocument:{create:async()=>({embedPng:async()=>({width:100,height:100}),addPage:()=>({setSize:()=>{},drawImage:()=>{}}),save:async()=>Uint8Array.from([1,2])})}});
  let language;
  s.plugin.parseAttachmentWithCloud=async(_bytes,_name,_id,settings)=>{language=settings.recognitionLanguage;return {markdownText:'image text'};};
  const result=await s.plugin.parseAttachmentWithMineru(original,{apiMode:'cloud',apiToken:'test',parserService:'mineru',cloudLanguage:'auto'},{});
  assert.equal(language,'arabic');assert.equal(result.markdownText,'image text');
});

test('EPUB tasks snapshot the actual MarkItDown service instead of the default OCR and unrelated cloud profile',async()=>{
 const s=setup(),original=s.file('book.epub');s.prefs.set('extensions.docflow.parserService','mineru');s.prefs.set('extensions.docflow.apiMode','cloud');s.prefs.set('extensions.docflow.marker.apiType','cloud');
 await s.plugin.handleParseCommand({selectedItems:[original]});const task=s.plugin.parseQueue[0];assert.equal(task.state,'completed');assert.equal(task.settings.parserService,'markitdown');assert.equal(task.displaySettings.parserService,'markitdown');assert.equal(task.cancelSettings.parserService,'markitdown');assert.equal(s.prefs.get('extensions.docflow.parserService'),'mineru');assert.equal(s.uploads.length,1);
});

test('one-click translates the original title after metadata with its own service and target language',async()=>{
 const s=fullFlow(),pdf=s.file('title-flow.pdf'),seen=[];
 s.prefs.set('extensions.docflow.titleService','deeplx');s.prefs.set('extensions.docflow.titleLanguage','FR');
 s.setReply(payload=>payload.response_format ? JSON.stringify({itemType:'book',title:'Original title',shortTitle:'Metadata Chinese title',creators:[]}) : payload.messages[1].content.startsWith('[') ? JSON.stringify(JSON.parse(payload.messages[1].content).map(row=>({...row,text:'译文'}))) : 'Summary');
 s.plugin.translateTitleText=async(text,settings)=>{seen.push(['title',text,settings.service,settings.targetLang]);return 'Titre français';};
 const summary=s.plugin.runDocumentTask.bind(s.plugin);s.plugin.runDocumentTask=async task=>{seen.push(['summary']);return summary(task);};
 await s.plugin.handleOrganizeCommand({selectedItems:[pdf]});const task=s.plugin.parseQueue[0],parent=s.items.get(pdf.parentID);
 assert.equal(task.state,'completed',task.error);assert.deepEqual(seen[0],['title','Original title','deeplx','FR']);assert.equal(seen[1][0],'summary');
 assert.equal(parent.getField('title'),'Original title');assert.equal(parent.getField('shortTitle'),'Titre français');assert.equal(task.titleTranslation.text,'Titre français');
 assert.equal(task.organizeStages.title.state,'completed');assert.deepEqual(Array.from(task.steps,row=>row.id),['extract','parent','metadata','title','summary','translate','outline']);
});

test('a failed title stage preserves data, permits later stages and retries without repeating successful stages',async()=>{
 const s=fullFlow(),pdf=s.file('retry-title.pdf');let attempts=0;
 s.plugin.translateTitleText=async()=>{if(++attempts===1)throw Error('Title service unavailable');return 'Recovered title';};
 await s.plugin.handleOrganizeCommand({selectedItems:[pdf]});const task=s.plugin.parseQueue[0],parent=s.items.get(pdf.parentID);
 assert.equal(task.state,'failed');assert.equal(parent.getField('shortTitle'),'');assert.equal(task.organizeStages.title.state,'failed');assert.match(task.error,/翻译标题.*Title service unavailable/);
 assert(task.organizeResults.summary);assert(task.organizeResults.translate);const summary=task.organizeResults.summary,translation=task.organizeResults.translate,calls=s.requests.length;
 await s.plugin.retryParseQueueTasks([task.id]);assert.equal(task.state,'completed',task.error);assert.equal(attempts,2);assert.equal(parent.getField('shortTitle'),'Recovered title');
 assert.equal(s.uploads.length,1);assert.equal(s.requests.length,calls);assert.equal(task.organizeResults.summary,summary);assert.equal(task.organizeResults.translate,translation);
});

test('one-click respects existing short titles and the configured overwrite option',async()=>{
 for(const overwrite of [false,true]) {
  const s=fullFlow(),parent=new s.Item('book');parent.setField('title','Original title');parent.setField('shortTitle','Existing short title');
  const pdf=s.file('existing-title.pdf',parent);s.prefs.set('extensions.docflow.titleOverwrite',overwrite);let calls=0;
  s.plugin.translateTitleText=async text=>{calls++;assert.equal(text,'Original title');return 'New short title';};
  await s.plugin.handleOrganizeCommand({selectedItems:[pdf]});const task=s.plugin.parseQueue[0];assert.equal(task.state,'completed',task.error);
  assert.equal(calls,overwrite?1:0);assert.equal(parent.getField('shortTitle'),overwrite?'New short title':'Existing short title');assert.equal(task.organizeStages.title.state,overwrite?'completed':'skipped');
 }
});
