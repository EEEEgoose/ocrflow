const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

function setup({enabled=true,token='secret-token',locked=false}={}) {
  const prefs=new Map(Object.entries({apiMode:'cloud',parserService:'mineru','cloud.apiBaseURL':'https://cloud.example/v4','cloud.apiToken':'cloud-token',agentEnabled:enabled,agentToken:token}).map(([key,value])=>['extensions.docflow.'+key,value]));
  const items=new Map(),endpoints={},codes={200:'OK'};
  const context={setTimeout,clearTimeout,Zotero:{Prefs:{get:key=>{if(locked)throw new Error('OCRFlow 配置已锁定，请在“同步功能”中解锁。');return prefs.get(key);}},debug:()=>{},logError:()=>{},getMainWindows:()=>[],
    Server:{Endpoints:endpoints,responseCodes:codes},Libraries:{userLibraryID:1},
    Items:{get:id=>items.get(id),getByLibraryAndKey:(library,key)=>[...items.values()].find(item=>item.libraryID===library&&item.key===key)}}};
  vm.createContext(context);for(const file of ['prompts.js','docflow.js','workflow.js','title-translation.js','agent-api.js'])vm.runInContext(fs.readFileSync(file,'utf8'),context);
  const plugin=context.DocFlow;plugin.version='1.7.0';
  plugin.openParseQueueDialog=()=>{};plugin.refreshParseQueueDialog=()=>{};
  plugin.processParseQueue=()=>new Promise(()=>{}); // A real queue keeps running for minutes.
  const file=(id,name,extra={})=>{const item={id,key:'KEY'+id,libraryID:1,attachmentFilename:name,deleted:false,relatedItems:[],tags:[],isAttachment:()=>true,isRegularItem:()=>false,isNote:()=>false,isFileAttachment:()=>true,isLinkedURLAttachment:()=>false,isPDFAttachment:()=>name.endsWith('.pdf'),getTags:()=>item.tags.map(tag=>({tag})),hasTag:tag=>item.tags.includes(tag),getField:()=>name,...extra};items.set(id,item);return item;};
  plugin.registerAgentEndpoint();
  const Endpoint=endpoints['/ocrflow/mcp'];
  const send=(data,{method='POST',auth='Bearer '+token}={})=>new Endpoint().init({method,headers:auth?{authorization:auth}:{},data});
  const call=async(name,args)=>{const [status,,body]=await send({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}});assert.equal(status,200);const result=JSON.parse(body).result;return {isError:!!result.isError,text:result.content[0].text,data:result.isError?null:JSON.parse(result.content[0].text)};};
  return {plugin,prefs,items,endpoints,codes,file,send,call,Endpoint};
}

test('agent endpoint rejects requests until it is enabled with the matching token',async()=>{
  assert.equal((await setup({enabled:false}).send({jsonrpc:'2.0',id:1,method:'ping'}))[0],403);
  assert.equal((await setup({token:''}).send({jsonrpc:'2.0',id:1,method:'ping'},{auth:'Bearer '}))[0],403);
  const s=setup();
  assert.equal((await s.send({jsonrpc:'2.0',id:1,method:'ping'},{auth:'Bearer wrong'}))[0],401);
  assert.equal((await s.send({jsonrpc:'2.0',id:1,method:'ping'},{auth:null}))[0],401);
  assert.equal((await setup({locked:true}).send({jsonrpc:'2.0',id:1,method:'ping'}))[0],503);
  assert.equal((await s.send(null,{method:'GET'}))[0],405);
  assert.equal(s.Endpoint.prototype.init.length,1);
  assert.equal(s.codes[202],'Accepted');assert.equal(s.codes[200],'OK');
  s.plugin.unregisterAgentEndpoint();assert.equal(s.endpoints['/ocrflow/mcp'],undefined);
});

test('MCP handshake, notifications and tool listing follow the JSON-RPC shape',async()=>{
  const s=setup();
  const [status,type,body]=await s.send({jsonrpc:'2.0',id:7,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'test',version:'1'}}});
  assert.equal(status,200);assert.match(type,/application\/json/);
  const init=JSON.parse(body);assert.equal(init.id,7);assert.equal(init.result.protocolVersion,'2025-03-26');assert.equal(init.result.serverInfo.name,'OCRFlow');assert.ok(init.result.capabilities.tools);
  assert.equal(JSON.parse((await s.send({jsonrpc:'2.0',id:8,method:'initialize',params:{protocolVersion:'1999-01-01'}}))[2]).result.protocolVersion,'2025-11-25');
  assert.equal(await s.send({jsonrpc:'2.0',method:'notifications/initialized'}),202);
  const tools=JSON.parse((await s.send({jsonrpc:'2.0',id:2,method:'tools/list'}))[2]).result.tools;
  assert.deepEqual(Array.from(tools,tool=>tool.name),['ocrflow_run','ocrflow_tasks','ocrflow_cancel','ocrflow_get_result']);
  const run=tools[0].inputSchema.properties;
  assert.deepEqual(Array.from(run.action.enum),['organize','parse','create_parent','fill_metadata','summarize','translate','translate_title','outline']);
  assert.ok(run.service.enum.includes('mineru-cloud'));assert.ok(run.service.enum.includes('default'));
  assert.equal(JSON.parse((await s.send({jsonrpc:'2.0',id:3,method:'nope'}))[2]).error.code,-32601);
});

test('running an action returns new task IDs without waiting for the queue to finish',async()=>{
  const s=setup(),pdf=s.file(1,'scan.pdf');
  const preview=await s.call('ocrflow_run',{action:'parse',items:['KEY1'],service:'mineru-cloud',dryRun:true});
  assert.equal(preview.data.tasks,1);assert.equal(s.plugin.parseQueue.length,0);
  const started=await Promise.race([s.call('ocrflow_run',{action:'parse',items:['KEY1'],service:'mineru-cloud'}),new Promise(resolve=>setTimeout(()=>resolve('blocked'),500))]);
  assert.notEqual(started,'blocked');
  assert.equal(started.data.tasks.length,1);assert.equal(started.data.tasks[0].kind,'parse');assert.equal(started.data.tasks[0].state,'queued');assert.equal(started.data.tasks[0].attachment,'KEY1');assert.equal(started.data.tasks[0].parent,null);
  assert.equal(s.plugin.parseQueue[0].settings.parserService,'mineru');
  assert.ok(!JSON.stringify(started.data).includes('cloud-token'));
  const again=await s.call('ocrflow_run',{action:'parse',items:[String(pdf.id)],service:'mineru-cloud'});
  assert.equal(again.data.tasks.length,0);assert.match(again.data.message,/已在队列/);
  const listed=await s.call('ocrflow_tasks',{});
  assert.deepEqual(Array.from(listed.data.tasks,task=>task.id),[1]);assert.ok(!JSON.stringify(listed.data).includes('cloud-token'));
});

test('action errors, unknown items and bad services come back as tool errors',async()=>{
  const s=setup();s.file(1,'scan.pdf');
  assert.match((await s.call('ocrflow_run',{action:'parse',items:['MISSING']})).text,/找不到条目/);
  assert.match((await s.call('ocrflow_run',{action:'parse',items:['KEY1'],service:'nope'})).text,/未知的识别服务/);
  assert.match((await s.call('ocrflow_run',{action:'summarize',items:['KEY1'],service:'mineru-cloud'})).text,/只有 parse/);
  assert.match((await s.call('ocrflow_run',{action:'explode',items:['KEY1']})).text,/未知操作/);
  const failed=await s.call('ocrflow_run',{action:'summarize',items:['KEY1']});
  assert.ok(failed.isError);assert.match(failed.text,/AI 接口地址/);
  assert.ok((await s.call('ocrflow_nope',{})).isError);
});

test('cancel stops a queued task and reports its state',async()=>{
  const s=setup();s.file(1,'scan.pdf');
  const {data}=await s.call('ocrflow_run',{action:'parse',items:['KEY1']});
  const canceled=await s.call('ocrflow_cancel',{id:data.tasks[0].id});
  assert.ok(['stopping','canceled'].includes(canceled.data.state));
  assert.match((await s.call('ocrflow_cancel',{id:99})).text,/找不到任务/);
});

test('results are read from the recognised Markdown, translation and summary note',async()=>{
  const s=setup(),files=new Map([['/r/scan.md','# Title\n'+'x'.repeat(30)],['/r/scan-zh.md','# 标题']]);
  s.plugin.readSourceMarkdown=async item=>({filePath:item.path,markdown:files.get(item.path)});
  const parent={id:10,key:'PARENT',libraryID:1,deleted:false,relatedItems:[],isAttachment:()=>false,isRegularItem:()=>true,isNote:()=>false,getTags:()=>[],hasTag:()=>false,getAttachments:()=>[1,2,3],getNotes:()=>[4]};
  s.items.set(10,parent);
  const pdf=s.file(1,'scan.pdf',{parentID:10,parentItemID:10,parentItem:parent});
  const md=s.file(2,'scan.md',{parentID:10,parentItemID:10,parentItem:parent,path:'/r/scan.md'});md.tags=['#DocFlow-Parse'];md.relatedItems=['KEY1'];pdf.relatedItems=['KEY2'];
  const zh=s.file(3,'scan-zh.html',{parentID:10,parentItemID:10,parentItem:parent,path:'/r/scan-zh.md',dateAdded:'2026-01-01'});zh.tags=['#DocFlow-Translation'];zh.relatedItems=['KEY2'];
  s.items.set(4,{id:4,key:'NOTE',deleted:false,relatedItems:['KEY1'],hasTag:tag=>tag==='#DocFlow-Summary',getNote:()=>'<p>总结</p>'});
  s.plugin.parentForDocument=item=>item.isRegularItem()?item:item.parentItem||null;
  s.plugin.isMarkdownResult=item=>item.tags?.includes('#DocFlow-Parse');
  const whole=(await s.call('ocrflow_get_result',{item:'PARENT'})).data;
  assert.equal(whole.text.slice(0,7),'# Title');assert.equal(whole.resultItem,'KEY2');assert.equal(whole.attachment,'KEY1');assert.equal(whole.parent,'PARENT');
  const part=await s.call('ocrflow_get_result',{item:'KEY1',offset:2,limit:5});
  assert.equal(part.data.text,'Title');assert.equal(part.data.total,38);
  const zhResult=(await s.call('ocrflow_get_result',{item:'KEY1',kind:'translation'})).data;assert.equal(zhResult.text,'# 标题');assert.equal(zhResult.resultItem,'KEY3');
  assert.equal((await s.call('ocrflow_get_result',{item:'KEY1',kind:'summary'})).data.text,'<p>总结</p>');
  assert.match((await s.call('ocrflow_get_result',{item:'KEY1',kind:'pdf'})).text,/kind/);
});

test('stateless 2026-07-28 clients discover the server and call tools without a handshake',async()=>{
  const s=setup();s.file(1,'scan.pdf');
  const meta={'io.modelcontextprotocol/protocolVersion':'2026-07-28'},modern=(message,headers={'mcp-protocol-version':'2026-07-28'})=>new s.Endpoint().init({method:'POST',headers:{authorization:'Bearer secret-token',...headers},data:{jsonrpc:'2.0',...message}});
  const [status,,body]=await modern({id:1,method:'server/discover',params:{_meta:meta}});
  const discover=JSON.parse(body).result;
  assert.equal(status,200);assert.equal(discover.resultType,'complete');assert.deepEqual(Array.from(discover.supportedVersions),['2026-07-28']);
  assert.ok(discover.capabilities.tools);assert.equal(discover._meta['io.modelcontextprotocol/serverInfo'].name,'OCRFlow');
  const list=JSON.parse((await modern({id:2,method:'tools/list',params:{_meta:meta}}))[2]).result;
  assert.equal(list.resultType,'complete');assert.equal(list.tools.length,4);assert.equal(typeof list.ttlMs,'number');assert.ok(list.cacheScope);
  const called=JSON.parse((await modern({id:3,method:'tools/call',params:{name:'ocrflow_run',arguments:{action:'parse',items:['KEY1'],dryRun:true},_meta:meta}}))[2]).result;
  assert.equal(called.resultType,'complete');assert.equal(JSON.parse(called.content[0].text).tasks,1);
  const old=await modern({id:4,method:'tools/list',params:{_meta:{'io.modelcontextprotocol/protocolVersion':'1900-01-01'}}},{});
  assert.equal(old[0],400);const unsupported=JSON.parse(old[2]).error;
  assert.equal(unsupported.code,-32022);assert.equal(unsupported.data.requested,'1900-01-01');assert.ok(unsupported.data.supported.includes('2026-07-28'));assert.ok(unsupported.data.supported.includes('2025-11-25'));
  assert.equal(JSON.parse((await modern({id:5,method:'tools/list',params:{_meta:meta}},{'mcp-protocol-version':'2025-11-25'}))[2]).error.code,-32020);
  assert.equal(JSON.parse((await modern({id:6,method:'server/discover'}))[2]).error.code,-32602);
  const missing=await modern({id:7,method:'resources/list',params:{_meta:meta}});assert.equal(missing[0],404);assert.equal(JSON.parse(missing[2]).error.code,-32601);
  assert.equal(await modern({method:'notifications/whatever',params:{_meta:meta}}),202);
});

test('settings copy a working setup for each kind of agent client',()=>{
  const context={DocFlowPreferences:{$:id=>({'ocrflow-agent-token':{value:'abc123'}})[id]},Zotero:{Prefs:{get:()=>23119}}};
  vm.createContext(context);vm.runInContext(fs.readFileSync('config-preferences.js','utf8'),context);
  const prefs=context.DocFlowPreferences,url='http://127.0.0.1:23119/ocrflow/mcp',auth='Bearer abc123';
  assert.equal(prefs.agentConfig('claude'),`claude mcp add --transport http ocrflow ${url} --header "Authorization: ${auth}"`);
  assert.equal(prefs.agentConfig('codex'),`[mcp_servers.ocrflow]\nurl = "${url}"\nhttp_headers = { "Authorization" = "${auth}" }`);
  const gemini=JSON.parse(prefs.agentConfig('gemini')).mcpServers.ocrflow;assert.equal(gemini.httpUrl,url);assert.equal(gemini.headers.Authorization,auth);
  const generic=JSON.parse(prefs.agentConfig('generic')).mcpServers.ocrflow;assert.equal(generic.type,'http');assert.equal(generic.url,url);assert.equal(generic.headers.Authorization,auth);
  const stdio=JSON.parse(prefs.agentConfig('stdio')).mcpServers.ocrflow;
  assert.equal(stdio.command,'npx');assert.deepEqual(Array.from(stdio.args),['-y','mcp-remote',url,'--header','Authorization:${OCRFLOW_AUTH}']);assert.equal(stdio.env.OCRFLOW_AUTH,auth);
});
