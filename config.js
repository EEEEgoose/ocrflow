// Encrypted configuration owned by the main plugin scope, never by a preferences window.
var OCRFlowConfig = {
 prefix:'extensions.docflow.', state:'setup', values:null, password:null, dirty:false, serial:Promise.resolve(), syncStatus:'尚未启用配置同步',
 isRuntime(key){return ['lastLocalJobID'].includes(key.slice(this.prefix.length));},
 async init(owner){
  this.owner=owner;this.path=PathUtils.join(Zotero.DataDirectory.dir,'ocrflow-config.enc');
  this.crypto=Zotero.getMainWindow()?.crypto||Services.appShell.hiddenDOMWindow.crypto;
  this.state=await IOUtils.exists(this.path)?'locked':'setup';
  if(this.state==='locked') {
   try {const login=this.savedLogin();if(login)await this.unlock(login.password);}catch(_error){this.state='locked';}
  }
 },
 get(key,global=true){
  if(!key.startsWith(this.prefix)||this.isRuntime(key))return Zotero.Prefs.get(key,global);
  if(this.state==='locked')throw Error('OCRFlow 配置已锁定，请在“配置与同步”中解锁。');
  if(this.state==='setup')throw Error('请先在“配置与同步”创建配置密码，将现有设置转为加密保存。');
  return Object.hasOwn(this.values,key)?this.values[key]:undefined;
 },
 set(key,value,global=true){
  if(!key.startsWith(this.prefix)||this.isRuntime(key))return Zotero.Prefs.set(key,value,global);
  if(this.state!=='unlocked')throw Error('请先在“配置与同步”设置配置密码并解锁，再保存配置。');
  if(!['string','number','boolean'].includes(typeof value))throw Error('不支持的配置值类型');
  if(this.values[key]===value)return;
  this.values[key]=value;this.dirty=true;
 },
 legacy(){
  const values={};
  for(const key of Services.prefs.getChildList(this.prefix))if(!this.isRuntime(key)) {
   const value=Zotero.Prefs.get(key,true);if(value!==undefined)values[key]=value;
  }
  return values;
 },
 validate(values){
  if(!values||typeof values!=='object'||Array.isArray(values))throw Error('配置包内容无效');
  for(const [key,value]of Object.entries(values))if(!key.startsWith(this.prefix)||this.isRuntime(key)||!['string','number','boolean'].includes(typeof value)||typeof value==='number'&&!Number.isInteger(value))throw Error('配置包包含不支持的设置');
  const providers=JSON.parse(values[this.prefix+'llmProviders']||'[]'),work=JSON.parse(values[this.prefix+'aiWorkSettings']||'{}');
  if(!Array.isArray(providers)||providers.length>5||!work||typeof work!=='object'||Array.isArray(work))throw Error('服务商或工作配置无效');
  if(providers.length) {
   const index=values[this.prefix+'llmProviderIndex']??0;if(!Number.isInteger(index)||index<0||index>=providers.length)throw Error('服务商选择位置无效');
   const ids=new Set();for(const provider of providers){if(!provider.id||ids.has(provider.id))throw Error('服务商标识缺失或重复');ids.add(provider.id);}
   const collation=values[this.prefix+'collationEnabled'];
   for(const selected of [work.defaultModel,...Object.values(work).filter(v=>v&&typeof v==='object').map(v=>v.model),collation&&values[this.prefix+'collationAIEnabled']?values[this.prefix+'collationAIModel']:null,...['A','B'].map(s=>{const v=values[this.prefix+'collation'+s];return collation&&v?.startsWith('ai:')?v.slice(3):null;})].filter(v=>v&&v!=='default')) {
    const split=selected.lastIndexOf(':'),provider=providers.find(p=>p.id===selected.slice(0,split)),slot=selected.slice(split+1);
    if(!provider||!['1','2'].includes(slot))throw Error('配置包中的工作模型引用无效');
   }
  }
  for(const key of ['summaryRequestJSON','translateRequestJSON'])if(values[this.prefix+key]){const parsed=JSON.parse(values[this.prefix+key]);if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error('请求参数必须为 JSON 对象');}
 },
 bytes(value){return Uint8Array.from(atob(value),c=>c.charCodeAt(0));},
 base64(value){let text='';for(const byte of value)text+=String.fromCharCode(byte);return btoa(text);},
 async key(password,salt){
  const source=await this.crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveKey']);
  return this.crypto.subtle.deriveKey({name:'PBKDF2',hash:'SHA-256',salt,iterations:600000},source,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
 },
 async seal(record,password){
  const salt=this.crypto.getRandomValues(new Uint8Array(16)),iv=this.crypto.getRandomValues(new Uint8Array(12));
  const encrypted=await this.crypto.subtle.encrypt({name:'AES-GCM',iv},await this.key(password,salt),new TextEncoder().encode(JSON.stringify(record)));
  return {format:'ocrflow-config',version:1,kdf:'PBKDF2-SHA256-600000',cipher:'AES-256-GCM',salt:this.base64(salt),iv:this.base64(iv),data:this.base64(new Uint8Array(encrypted))};
 },
 async open(envelope,password){
  if(envelope?.format!=='ocrflow-config'||envelope.version!==1||envelope.kdf!=='PBKDF2-SHA256-600000'||envelope.cipher!=='AES-256-GCM')throw Error('不支持的配置包格式或版本');
  let record;
  try {
   const salt=this.bytes(envelope.salt),iv=this.bytes(envelope.iv);if(salt.length!==16||iv.length!==12)throw Error('Invalid parameters');
   const plain=await this.crypto.subtle.decrypt({name:'AES-GCM',iv},await this.key(password,salt),this.bytes(envelope.data));record=JSON.parse(new TextDecoder().decode(plain));
  }catch(_error){throw Error('配置密码错误或配置包已损坏，当前配置未更改。');}
  if(!record.id||!Array.isArray(record.parents))throw Error('配置版本信息无效');this.validate(record.values);return record;
 },
 newRecord(values,parents=[]){return {id:this.crypto.randomUUID(),parents:[...new Set(parents.filter(Boolean))],createdAt:new Date().toISOString(),values:JSON.parse(JSON.stringify(values))};},
 async write(envelope){await IOUtils.writeUTF8(this.path,JSON.stringify(envelope),{tmpPath:this.path+'.tmp'});},
 async setup(password){
  if(this.state!=='setup')throw Error('配置密码已经设置');if(password.length<10)throw Error('配置密码至少 10 个字符');
  const values=this.legacy();this.validate(values);const record=this.newRecord(values),envelope=await this.seal(record,password);
  await this.write(envelope);this.values=values;this.record=record;this.envelope=envelope;this.password=password;this.state='unlocked';this.dirty=false;
  this.clearLegacy();
 },
 clearLegacy(){for(const key of Services.prefs.getChildList(this.prefix))if(!this.isRuntime(key)&&Services.prefs.prefHasUserValue(key))Services.prefs.clearUserPref(key);Services.prefs.savePrefFile(null);},
 async unlock(password){
  const envelope=JSON.parse(await IOUtils.readUTF8(this.path)),record=await this.open(envelope,password);
  this.envelope=envelope;this.record=record;this.values=record.values;this.password=password;this.state='unlocked';this.dirty=false;
  this.syncStatus=this.values[this.prefix+'syncEnabled']?'配置同步已启用；远端版本需检查并应用':'配置同步已关闭';
 },
 async flush(){
  const work=async()=>{
   if(this.state!=='unlocked'||!this.dirty)return;
   const record=this.newRecord(this.values,[this.record.id]),envelope=await this.seal(record,this.password);
   await this.write(envelope);this.record=record;this.envelope=envelope;this.error=null;
   this.dirty=JSON.stringify(this.values)!==JSON.stringify(record.values);
   if(record.values[this.prefix+'syncEnabled'])try{await this.publish(envelope,record);}catch(error){this.syncStatus='本机已加密保存；同步发布失败：'+error.message;}
  };
  this.serial=this.serial.catch(()=>{}).then(work);return this.serial;
 },
 schedule(){if(this.state!=='unlocked'||!this.dirty)return;clearTimeout(this.timer);this.timer=setTimeout(()=>{this.flush().catch(error=>{this.error=error.message;});},250);},
 async lock(){
  if(this.owner.parseQueue.some(task=>task.active))throw Error('任务正在运行，请结束后再锁定配置。');
  await this.flush();this.password=null;this.values=null;this.record=null;this.envelope=null;this.state='locked';
 },
 savedLogin(){return Services.logins?.findLogins('chrome://docflow',null,'OCRFlow Configuration').find(login=>login.username==='vault');},
 async remember(enabled){
  if(!Services.logins){if(enabled)throw Error('本机未提供安全凭据存储');return;}
  const old=this.savedLogin();if(old)Services.logins.removeLogin(old);
  if(enabled){const login=Cc['@mozilla.org/login-manager/loginInfo;1'].createInstance(Ci.nsILoginInfo);login.init('chrome://docflow',null,'OCRFlow Configuration','vault',this.password,'','');await Services.logins.addLoginAsync(login);}
 },
 async changePassword(password){
  if(password.length<10)throw Error('配置密码至少 10 个字符');await this.flush();
  const envelope=await this.seal(this.record,password);await this.write(envelope);const remembered=!!this.savedLogin();this.password=password;this.envelope=envelope;await this.remember(remembered);
  if(this.values[this.prefix+'syncEnabled']) {this.dirty=true;await this.flush();}
 },
 async exportFile(path){if(this.state!=='unlocked')throw Error('请先解锁配置');await this.flush();await IOUtils.writeUTF8(path,JSON.stringify(this.envelope));},
 async inspect(envelope,password){const record=await this.open(envelope,password);return {record,count:Object.keys(record.values).length,providers:JSON.parse(record.values[this.prefix+'llmProviders']||'[]').length};},
 async apply(envelope,password,parents=[],syncPassword=false){
  const record=await this.open(envelope,password);if(this.state==='locked')throw Error('请先解锁本机配置，或在新设备首次导入配置。');
  if(this.state==='unlocked'){await this.flush();await IOUtils.copy(this.path,this.path+'.backup',{noOverwrite:false});}
  const remembered=!!this.savedLogin(),localPassword=syncPassword?password:this.password||password,merged=this.newRecord(record.values,[this.record?.id,record.id,...parents]);
  const sealed=await this.seal(merged,localPassword);await this.write(sealed);
  this.values=merged.values;this.record=merged;this.envelope=sealed;this.password=localPassword;this.state='unlocked';this.dirty=false;this.clearLegacy();
  if(remembered)await this.remember(true);
  if(this.values[this.prefix+'syncEnabled'])try{await this.publish(sealed,merged);}catch(error){this.syncStatus='本机配置已应用；同步发布失败：'+error.message;}
 },
 async syncItems(){
  const search=new Zotero.Search();search.libraryID=Zotero.Libraries.userLibraryID;search.addCondition('tag','is','#DocFlow-Config');return (await Zotero.Items.getAsync(await search.search())).filter(item=>!item.deleted);
 },
 async publish(envelope=this.envelope,record=this.record){
  this.syncStatus='等待 Zotero 文件同步；本机保存成功不表示云端已完成';
  const items=await this.syncItems();let parent=items.find(item=>item.isRegularItem());
  if(!parent){parent=new Zotero.Item('computerProgram');parent.libraryID=Zotero.Libraries.userLibraryID;parent.setField('title','OCRFlow 配置同步');parent.addTag('#DocFlow-Config');await parent.saveTx();}
  if(items.some(item=>item.isAttachment()&&item.attachmentFilename===record.id+'.ocrflow-config'))return;
  const path=PathUtils.join(PathUtils.tempDir,record.id+'.ocrflow-config');await IOUtils.writeUTF8(path,JSON.stringify(envelope));
  try{const attachment=await Zotero.Attachments.importFromFile({file:path,parentItemID:parent.id,title:'OCRFlow 加密配置 · '+record.createdAt,contentType:'application/octet-stream'});attachment.addTag('#DocFlow-Config');await attachment.saveTx();}finally{await IOUtils.remove(path,{ignoreAbsent:true});}
 },
 async remote(password=this.password){
  if(!password)throw Error('请先输入远端配置的解密密码');
  const records=[];let unavailable=0;
  for(const item of (await this.syncItems()).filter(item=>item.isAttachment())) {
   let path=await item.getFilePath();
   if(!path||!await IOUtils.exists(path)){try{await Zotero.Sync.Runner.downloadFile(item);path=await item.getFilePath();}catch(_error){unavailable++;continue;}}
   if(!path||!await IOUtils.exists(path)){unavailable++;continue;}
   try {const envelope=JSON.parse(await IOUtils.readUTF8(path)),record=await this.open(envelope,password);if(!records.some(row=>row.record.id===record.id))records.push({record,envelope,item});}
   catch(_error){unavailable++;}
  }
  const parents=new Set(records.flatMap(row=>row.record.parents));
  const heads=records.filter(row=>!parents.has(row.record.id));
  this.syncStatus=unavailable?`${unavailable} 个配置包未下载、密码不同或不可读取；已显示可读取版本`:`发现 ${heads.length} 个配置版本，请选择后应用`;
  return heads;
 }
};
