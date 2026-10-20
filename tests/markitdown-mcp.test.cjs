const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

function fixture({rest=false,missingTool=false}={}) {
  const calls=[];
  const context={fetch:async(url,options={})=>{
    calls.push({url,options});
    if(url.endsWith('/health'))return {ok:rest,status:rest?200:404,json:async()=>({status:'ok'})};
    const request=JSON.parse(options.body);
    let result;
    if(request.method==='initialize')result={protocolVersion:'2024-11-05',serverInfo:{name:'markitdown',version:'1.8.1'}};
    if(request.method==='tools/list')result={tools:missingTool?[]:[{name:'convert_to_markdown',inputSchema:{properties:{uri:{type:'string'}}}}]};
    return {ok:true,status:200,headers:{get:key=>key==='mcp-session-id'?'test-session':key==='content-type'?'application/json':null},text:async()=>JSON.stringify({jsonrpc:'2.0',id:request.id,result})};
  }};
  vm.createContext(context);vm.runInContext(fs.readFileSync('markitdown.js','utf8'),context);
  return {service:context.OCRFlowMarkItDown,calls,context};
}

test('an existing REST service keeps its health check and is identified without MCP requests',async()=>{
  const {service,calls}=fixture({rest:true});
  const result=await service.testConnection('http://service.example/');
  assert.equal(result.interface,'HTTP REST');assert.equal(calls.length,1);assert.equal(calls[0].url,'http://service.example/health');
});

test('a root URL returning 404 negotiates MCP and verifies the conversion tool',async()=>{
  const {service,calls}=fixture();const signal=new AbortController().signal;
  const result=await service.testConnection('http://service.example',signal);
  assert.equal(result.interface,'MCP');assert.equal(result.endpoint,'http://service.example/mcp/');
  assert.deepEqual(calls.slice(1).map(call=>JSON.parse(call.options.body).method),['initialize','notifications/initialized','tools/list']);
  assert.equal(calls[2].options.headers['MCP-Protocol-Version'],'2024-11-05');
  assert.equal(calls[2].options.headers['Mcp-Session-Id'],'test-session');
  assert(calls.every(call=>call.options.signal===signal));
});

test('a complete MCP endpoint is accepted directly and a different MCP tool server is not called MarkItDown',async()=>{
  const full=fixture();await full.service.testConnection('http://service.example/mcp/');
  assert(!full.calls.some(call=>call.url.endsWith('/health')));
  const other=fixture({missingTool:true});
  await assert.rejects(()=>other.service.testConnection('http://service.example/mcp'),/convert_to_markdown/);
});

test('MCP HTTP responses can carry their matching JSON-RPC result as SSE',async()=>{
  const {service,context}=fixture();
  context.fetch=async()=>({ok:true,headers:{get:key=>key==='content-type'?'text/event-stream':null},text:async()=>'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\nevent: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"tools":[]}}\n\n'});
  const result=await service.rpc({endpoint:'http://service.example/mcp/'},'tools/list',{});
  assert.equal(result.tools.length,0);
});

test('MCP HTTP failures preserve status for oversized-document handling',async()=>{
  const {service,context}=fixture();
  context.fetch=async()=>({ok:false,status:413,text:async()=>'Payload Too Large: Message exceeds maximum size'});
  await assert.rejects(()=>service.convert({endpoint:'http://service.example/mcp/'},'data:application/epub+zip;base64,YQ=='),error=>error.status===413&&error.message.includes('Payload Too Large'));
});
