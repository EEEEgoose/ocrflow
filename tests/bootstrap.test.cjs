const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

test('manifest includes the fields Zotero requires to accept an installation', () => {
  const manifest=JSON.parse(fs.readFileSync('manifest.json','utf8'));
  for (const field of ['id','update_url','strict_max_version']) {
    assert(manifest.applications?.zotero?.[field], 'Missing applications.zotero.' + field);
  }
  assert.equal(new URL(manifest.applications.zotero.update_url).protocol,'https:');
  for(const size of [16,48,96]) {
    const file=manifest.icons[size];assert.equal(file,`icon${size}.png`);
    const data=fs.readFileSync(file);
    assert.equal(data.subarray(1,4).toString(),'PNG');
    assert.equal(data.readUInt32BE(16),size);assert.equal(data.readUInt32BE(20),size);
  }
});

test('installation entrypoint loads all modules and registers DocFlow menus without processing imports', async () => {
  const manifest=JSON.parse(fs.readFileSync('manifest.json','utf8'));
  const registered=[],loaded=[],panes=[],listeners=[];
  let removed=false, paneRegistered=false;
  const context={
    clearTimeout,
    PathUtils:{join:(...parts)=>parts.join("/")},IOUtils:{exists:async()=>false},
    Cc:{'@mozilla.org/addons/addon-manager-startup;1':{getService:()=>({registerChrome:()=>({destruct:()=>{removed=true;}})})}},
    Ci:{amIAddonManagerStartup:{}},
    Services:{io:{newURI:uri=>uri},scriptloader:{loadSubScript:uri=>{loaded.push(uri);vm.runInContext(fs.readFileSync(uri,'utf8'),context);}}},
    Zotero:{debug:()=>{},logError:error=>{throw error;},getMainWindows:()=>[],getMainWindow:()=>({crypto:require("node:crypto").webcrypto}),DataDirectory:{dir:"/isolated-test"},
      PreferencePanes:{register:async options=>{await Promise.resolve();panes.push(options);paneRegistered=true;}},
      MenuManager:{registerMenu:options=>{assert(paneRegistered,'Startup must await preference pane registration');registered.push(options);},unregisterMenu:()=>{}},
      Reader:{_readers:[],registerEventListener:(...args)=>listeners.push(args),unregisterEventListener:()=>{}},
      Notifier:{registerObserver:()=>{throw new Error('Import observers must not be installed');}}
    },
    fetch:()=>{throw new Error('Startup must not call services');}
  };
  vm.createContext(context);vm.runInContext(fs.readFileSync('bootstrap.js','utf8'),context);
  await context.startup({id:manifest.applications.zotero.id,version:manifest.version,rootURI:''});
  assert.deepEqual(loaded,['locale/en-US/ui.js','localization.js','prompts.js','docflow.js','config.js','markitdown.js','marker.js','datalab.js','metadata.js','workflow.js','translation-services.js','title-translation.js','document.js','paddleocr.js','ocr-sources.js','translation.js','collation.js','task-sidebar.js','outline.js']);
  assert.equal(panes[0].label,'OCRFlow');assert.equal(registered[0].menus[0].label,'OCRFlow');
  assert.equal(panes[0].id,'ocrflow-preferences');
  for(const uri of [panes[0].src,panes[0].image,...panes[0].scripts,...(panes[0].stylesheets || [])]) {
    assert.equal(new URL(uri,'jar:file:///profile/extensions/ocrflow.xpi!/').href,uri);
    assert(uri.startsWith('chrome://docflow/content/'));
  }
  assert.equal(registered[0].menus[0].menus.filter(menu=>menu.menuType!=="separator").length,10);assert.equal(context.DocFlow.parseQueue.length,0);
  assert.equal(listeners[0][0],'renderToolbar');
  await context.shutdown();assert(removed);assert.equal(context.DocFlow,undefined);
  assert.doesNotThrow(()=>context.onMainWindowUnload({window:{}}));
});
