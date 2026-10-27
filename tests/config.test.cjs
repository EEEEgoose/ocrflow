const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const path=require('node:path').posix;
const prefix='extensions.docflow.',password='native-test-password-2026';
function storage(){return {files:new Map(),items:new Map(),next:1}};
async function setup(name='a',shared=storage()){
 const prefs=new Map([[prefix+'llmApiKey','secret-api-token'],[prefix+'llmModel','test-model'],[prefix+'lastLocalJobID','runtime-job']]);
 const user=new Set(prefs.keys());
 class Item{
  constructor(type='attachment'){this.id=shared.next++;this.key='K'+this.id;this.libraryID=1;this.type=type;this.tags=[];this.fields={};shared.items.set(this.id,this)}
  setField(k,v){this.fields[k]=v} getField(k){return this.fields[k]||''} addTag(tag){if(!this.tags.includes(tag))this.tags.push(tag)}
  isAttachment(){return this.type==='attachment'} isRegularItem(){return !this.isAttachment()} async saveTx(){return this.id}async getFilePath(){return this.path}
 }
 const context={TextEncoder,TextDecoder,Uint8Array,atob,btoa,setTimeout,clearTimeout,Date,
  PathUtils:{join:path.join,tempDir:'/temp'},
  Services:{prefs:{getChildList:()=>[...prefs.keys()],prefHasUserValue:k=>user.has(k),clearUserPref:k=>{user.delete(k);prefs.delete(k)},savePrefFile(){}}},
  IOUtils:{makeDirectory:async p=>shared.files.set(p,'directory'),getChildren:async dir=>[...shared.files.keys()].filter(p=>path.dirname(p)===dir),exists:async p=>shared.files.has(p),readUTF8:async p=>{if(!shared.files.has(p))throw Error('missing');return shared.files.get(p)},writeUTF8:async(p,text)=>shared.files.set(p,text),copy:async(a,b)=>shared.files.set(b,shared.files.get(a)),remove:async p=>shared.files.delete(p)},
  Zotero:{DataDirectory:{dir:'/device-'+name},getMainWindow:()=>({crypto:webcrypto}),Prefs:{get:k=>prefs.get(k),set:(k,v)=>prefs.set(k,v)},Libraries:{userLibraryID:1},Item,
   Items:{getAsync:async ids=>ids.map(id=>shared.items.get(id)),trashTx:async id=>{shared.items.get(id).deleted=true;}},Search:class{addCondition(){}async search(){return [...shared.items.values()].filter(i=>!i.deleted&&i.tags.includes('#DocFlow-Config')).map(i=>i.id)}},
   Attachments:{importFromFile:async options=>{const item=new Item();item.parentID=options.parentItemID;item.attachmentFilename=path.basename(options.file);item.path='/storage/'+item.key+'/'+item.attachmentFilename;shared.files.set(item.path,shared.files.get(options.file));return item}},
   Sync:{Runner:{downloadFile:async()=>false}}
  }
 };
 vm.createContext(context);vm.runInContext(fs.readFileSync('config.js','utf8'),context);
 const c=context.OCRFlowConfig;await c.init({parseQueue:[],parseOptionalJSONObject:raw=>JSON.parse(raw)});return {c,context,prefs,shared};
}
test('encryption migrates settings out of plaintext preferences; export and reopening require the password',async()=>{
 const {c,shared,prefs}=await setup();assert.throws(()=>c.get(prefix+'llmApiKey'),/创建配置密码/);await c.setup(password);
 assert.equal(c.get(prefix+'llmApiKey'),'secret-api-token');assert.equal(prefs.has(prefix+'llmApiKey'),false);assert.equal(prefs.get(prefix+'lastLocalJobID'),'runtime-job');
 const raw=shared.files.get(c.path);assert(!raw.includes('secret-api-token'));assert(!raw.includes('llmApiKey'));assert(!raw.includes(password));
 await c.exportFile('/export.ocrflow-config');assert.equal(shared.files.get('/export.ocrflow-config'),raw);
 await c.lock();assert.throws(()=>c.get(prefix+'llmModel'),/已锁定/);await assert.rejects(c.unlock('wrong password'),/密码错误或配置包已损坏/);assert.equal(c.state,'locked');
 await c.unlock(password);assert.equal(c.get(prefix+'llmModel'),'test-model');
});
test('wrong passwords, tampering and invalid model references leave the current configuration unchanged',async()=>{
 const {c,shared}=await setup();await c.setup(password);const original=shared.files.get(c.path),envelope=JSON.parse(original);
 await assert.rejects(c.apply(envelope,'wrong'),/密码错误/);assert.equal(shared.files.get(c.path),original);
 const bad={...envelope,data:(envelope.data[0]==='A'?'B':'A')+envelope.data.slice(1)};await assert.rejects(c.apply(bad,password),/已损坏/);assert.equal(shared.files.get(c.path),original);
 const record={...c.record,values:{...c.values,[prefix+'llmProviders']:JSON.stringify([{id:'p',llmModel:'m'}]),[prefix+'aiWorkSettings']:JSON.stringify({defaultModel:'missing:1'})}};
 await assert.rejects(c.apply(await c.seal(record,password),password),/工作模型引用无效/);assert.equal(shared.files.get(c.path),original);
});
test('import replaces complete settings, creates an encrypted backup and preserves the local unlock password',async()=>{
 const a=await setup('a'),b=await setup('b');await a.c.setup(password);await b.c.setup('other-export-password');b.c.set(prefix+'marker.cloud.token','datalab-secret');await b.c.flush();
 const before=a.shared.files.get(a.c.path);await a.c.apply(b.c.envelope,'other-export-password');assert.equal(a.c.get(prefix+'marker.cloud.token'),'datalab-secret');const backups=[...a.shared.files].filter(([p])=>p.endsWith('.ocrflow-config')&&p.includes('ocrflow-config-backups/'));assert.equal(backups.length,1);assert.equal((await a.c.open(JSON.parse(backups[0][1]),password)).values[prefix+'llmApiKey'],JSON.parse(JSON.stringify((await a.c.open(JSON.parse(before),password)).values))[prefix+'llmApiKey']);
 await a.c.lock();await a.c.unlock(password);assert.equal(a.c.get(prefix+'marker.cloud.token'),'datalab-secret');
});
test('two devices exchange encrypted Zotero attachments and retain concurrent branches until explicitly resolved',async()=>{
 const shared=storage(),a=await setup('a',shared),b=await setup('b',shared);await a.c.setup(password);a.c.set(prefix+'syncEnabled',true);await a.c.flush();
 const [remote]=await b.c.remote(password);assert(remote);await b.c.apply(remote.envelope,password);
 a.c.set(prefix+'summaryLanguage','English');await a.c.flush();b.c.set(prefix+'summaryLanguage','中文');await b.c.flush();
 const heads=await a.c.remote(password);assert.equal(heads.length,2);assert.equal(a.c.get(prefix+'summaryLanguage'),'English','checking does not overwrite local settings');
 const selected=heads.find(row=>row.record.values[prefix+'summaryLanguage']==='中文');await a.c.apply(selected.envelope,password,heads.map(row=>row.record.id));assert.equal((await a.c.remote(password)).length,1);assert.equal(a.c.get(prefix+'summaryLanguage'),'中文');
 for(const item of shared.items.values())if(item.isAttachment())assert(!shared.files.get(item.path).includes('secret-api-token'));
});
test('changing the password updates local encryption, and locking during an active task is rejected',async()=>{
 const {c}=await setup();await c.setup(password);const old=c.envelope;c.owner.parseQueue=[{active:true}];await assert.rejects(c.lock(),/任务正在运行/);c.owner.parseQueue=[];
 await c.changePassword('replacement-password');await c.lock();await assert.rejects(c.unlock(password),/密码错误/);await c.unlock('replacement-password');assert.equal(c.get(prefix+'llmApiKey'),'secret-api-token');assert((await c.open(old,password)).values[prefix+'llmApiKey']);
});
test('inactive collation model references do not prevent encryption, while active invalid references are rejected',async()=>{
 const {c,prefs}=await setup();prefs.set(prefix+'llmProviders',JSON.stringify([{id:'p',llmModel:'m'}]));prefs.set(prefix+'aiWorkSettings',JSON.stringify({defaultModel:'p:1'}));prefs.set(prefix+'collationAIModel','deleted:2');prefs.set(prefix+'collationAIEnabled',true);prefs.set(prefix+'collationEnabled',false);
 await c.setup(password);assert.equal(c.get(prefix+'collationAIModel'),'deleted:2');const values={...c.values,[prefix+'collationEnabled']:true};assert.throws(()=>c.validate(values),/工作模型引用无效/);
});
test('applying a password-rotated remote revision adopts its password instead of publishing it under the old password',async()=>{
 const shared=storage(),a=await setup('a',shared),b=await setup('b',shared);await a.c.setup(password);a.c.set(prefix+'syncEnabled',true);await a.c.flush();const [first]=await b.c.remote(password);await b.c.apply(first.envelope,password,[],true);
 await a.c.changePassword('rotated-cloud-password');const heads=await b.c.remote('rotated-cloud-password');assert(heads.length);await b.c.apply(heads[0].envelope,'rotated-cloud-password',heads.map(row=>row.record.id),true);
 await b.c.lock();await assert.rejects(b.c.unlock(password),/密码错误/);await b.c.unlock('rotated-cloud-password');assert.equal((await a.c.remote('rotated-cloud-password')).length,1);
});
test('device naming and retention keep ten local backups; renaming, manual exports and password rotation do not bypass the limit',async()=>{
 const a=await setup('retention');await a.c.setup(password);await a.c.saveDevice('Office Mac',10);
 for(let i=0;i<11;i++)await a.c.backupCurrent();
 const backups=()=>[...a.shared.files.keys()].filter(p=>p.includes('/ocrflow-config-backups/')&&p.endsWith('.ocrflow-config'));
 assert.equal(backups().length,10);assert(backups().every(p=>p.includes('Office Mac')));
 await a.c.exportFile('/manual-export.ocrflow-config');const id=a.c.deviceInfo().id;
 await a.c.saveDevice('Renamed Mac',3);assert.equal(a.c.deviceInfo().id,id);assert.equal(backups().length,3);assert(a.c.backupName().includes('Renamed Mac'));
 await a.c.changePassword('new-retention-password');await a.c.backupCurrent();assert.equal(backups().length,3);assert(a.shared.files.has('/manual-export.ocrflow-config'));
 await assert.rejects(a.c.saveDevice('name',0),/正整数/);
});
test('sync retention counts by device identity and does not remove other devices or duplicate the same revision',async()=>{
 const shared=storage(),a=await setup('a',shared),b=await setup('b',shared);await a.c.setup(password);await b.c.setup(password);
 await a.c.saveDevice('Same name',2);await b.c.saveDevice('Same name',10);
 for(let i=0;i<3;i++){a.c.set(prefix+'summaryLanguage','a'+i);await a.c.flush();await a.c.publish();}
 await b.c.publish();const before=[...shared.items.values()].filter(i=>i.isAttachment()&&!i.deleted).length;
 await a.c.publish();assert.equal([...shared.items.values()].filter(i=>i.isAttachment()&&!i.deleted).length,before);
 const rows=await a.c.remote(password);assert(rows.some(r=>r.record.deviceID===b.c.deviceInfo().id));
 assert.equal([...shared.items.values()].filter(i=>i.isAttachment()&&!i.deleted&&JSON.parse(shared.files.get(i.path)).source.deviceID===a.c.deviceInfo().id).length,2);
 const localName=a.c.deviceInfo().name;await a.c.apply(b.c.envelope,password);assert.equal(a.c.deviceInfo().name,localName);assert.notEqual(a.c.deviceInfo().id,b.c.deviceInfo().id);
});
