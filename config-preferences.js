Object.assign(DocFlowPreferences,{
 configStore(){return Zotero.getMainWindow()?.DocFlow?.config;},
 refreshConfig(){
  const config=this.configStore();if(!config)return;
  const locked=config.state!=='unlocked';
  for(const key of ['services','ai','work','collation','output'])this.$('ocrflow-panel-'+key).inert=locked||!!config.busy;
  this.$('mineru-save-button').disabled=locked||!!config.busy;
  this.$('ocrflow-config-state').textContent=ocrflowText(config.state==='setup'?'尚未设置配置密码；创建后现有配置将转为加密保存':locked?'配置已锁定，请输入配置密码解锁':'配置已解锁；磁盘、导出与同步文件均为密文');
  this.$('ocrflow-config-sync-status').textContent=ocrflowText(config.error||config.syncStatus);
  this.$('ocrflow-config-setup').hidden=config.state!=='setup';this.$('ocrflow-config-unlock').hidden=config.state!=='locked';
  for(const name of ['export','lock','password','publish'])this.$('ocrflow-config-'+name).disabled=locked||!!config.busy;
  for(const name of ['setup','unlock','import','check','apply','pass','confirm','remote','device-save','device-name','backup-limit'])this.$('ocrflow-config-'+name).disabled=!!config.busy;
  this.$('ocrflow-config-sync').disabled=locked||!!config.busy;if(!config.busy)this.$('ocrflow-config-sync').checked=!locked&&!!config.get(config.prefix+'syncEnabled');
  this.$('ocrflow-config-remember').disabled=!Services.logins||!!config.busy;
  try{if(!config.busy)this.$('ocrflow-config-remember').checked=!!config.savedLogin();}catch(_error){}
 },
 async configFile(save){
  const {FilePicker}=ChromeUtils.importESModule('chrome://zotero/content/modules/filePicker.mjs');const picker=new FilePicker();
  picker.init(window,ocrflowText(save?'导出加密配置':'导入加密配置'),save?picker.modeSave:picker.modeOpen);picker.appendFilter(ocrflowText('OCRFlow 配置'),'*.ocrflow-config');
  if(save)picker.defaultString=this.configStore().backupName();return await picker.show()===picker.returnCancel?null:picker.file;
 },
 async applyConfiguration(envelope,password,parents=[],syncPassword=false){
  const config=this.configStore(),preview=await config.inspect(envelope,password);
  if(!Services.prompt.confirm(window,ocrflowText('应用 OCRFlow 配置'),ocrflowText(`将整套替换识别服务、AI 服务商、工作模型与提示词、输出和同步设置：${preview.count} 项设置，${preview.providers} 个 AI 服务商。API Key 不在预览中显示。原配置将保留加密备份。${syncPassword?ocrflowText('同步恢复后，请使用本次输入的配置密码解锁。'):''}是否继续？`)))return;
  await config.apply(envelope,password,parents,syncPassword);this.loadSettings();this.refreshConfig();
 },
 initConfig(){
  if(!this.configStore()||this.configBound)return;this.configBound=true;
  const bind=(name,run)=>this.$('ocrflow-config-'+name).addEventListener('click',async()=>{
   const config=this.configStore();if(config.busy){this.$('ocrflow-config-message').textContent=ocrflowText('另一个配置操作正在进行，请稍候');return;}config.busy=true;
   const button=this.$('ocrflow-config-'+name);this.setButtonBusy(button,true);this.refreshConfig();this.$('ocrflow-config-message').textContent=ocrflowText('处理中…');
   try {await run();this.$('ocrflow-config-message').textContent=ocrflowText('操作完成');}
   catch(error){this.$('ocrflow-config-message').textContent=ocrflowText(error.message||String(error));this.buttonFeedback(button,'error');}
   finally{config.busy=false;this.setButtonBusy(button,false);this.$('ocrflow-config-pass').value='';this.$('ocrflow-config-confirm').value='';this.refreshConfig();}
  });
  const password=()=>this.$('ocrflow-config-pass').value;
  const newPassword=()=>{const value=password();if(value!==this.$('ocrflow-config-confirm').value)throw Error('两次输入的配置密码不一致');return value;};
  const resume=()=>{if(this.initialized){this.loadSettings();this.refreshConfig();}else this.init();this.showSection('config');};
  bind('setup',async()=>{await this.configStore().setup(newPassword());await this.configStore().remember(this.$('ocrflow-config-remember').checked);resume();});
  bind('unlock',async()=>{await this.configStore().unlock(password());await this.configStore().remember(this.$('ocrflow-config-remember').checked);resume();});
  bind('lock',async()=>{await this.configStore().lock();this.remoteConfigurations=null;this.llmProviders=null;this.workSettings={};this.$('ocrflow-config-remote').replaceChildren();for(const field of this.FIELDS){const input=this.$(field.id);if(input){input.value='';input.checked=false;}}for(const node of document.querySelectorAll('.mineru-test-output'))node.textContent='';});
  bind('password',async()=>{await this.configStore().changePassword(newPassword());});
  bind('export',async()=>{const path=await this.configFile(true);if(path)await this.configStore().exportFile(path);});
  bind('import',async()=>{const path=await this.configFile(false);if(path){const envelope=JSON.parse(await IOUtils.readUTF8(path));await this.applyConfiguration(envelope,password()||this.configStore().password);if(!this.initialized)resume();}});
  bind('publish',async()=>{const config=this.configStore();config.set(config.prefix+'syncEnabled',this.$('ocrflow-config-sync').checked);await config.flush();if(config.values[config.prefix+'syncEnabled'])await config.publish();else config.syncStatus='配置同步已关闭；已有云端配置包保留';});
  bind('check',async()=>{const config=this.configStore();this.remoteConfigurations=await config.remote(password()||config.password);const select=this.$('ocrflow-config-remote');select.replaceChildren();
   for(const row of this.remoteConfigurations){const option=document.createElementNS('http://www.w3.org/1999/xhtml','option');option.value=row.record.id;option.textContent=ocrflowText(`${row.record.deviceName||ocrflowText("未知来源")} · ${row.record.createdAt} · ${row.record.id===config.record?.id?'本机当前版本':'可应用版本'}`);select.appendChild(option);}
  });
  bind('apply',async()=>{const row=this.remoteConfigurations?.find(row=>row.record.id===this.$('ocrflow-config-remote').value);if(!row)throw Error('请先检查远端配置并选择一个版本');await this.applyConfiguration(row.envelope,password()||this.configStore().password,this.remoteConfigurations.map(row=>row.record.id),true);if(!this.initialized)resume();});
  this.$('ocrflow-config-remember').addEventListener('change',async()=>{if(this.configStore().state!=='unlocked'||this.configStore().busy)return;try{await this.configStore().remember(this.$('ocrflow-config-remember').checked);}catch(error){this.$('ocrflow-config-message').textContent=ocrflowText(error.message);}this.refreshConfig();});
  const device=this.configStore().deviceInfo();this.$('ocrflow-config-device-name').value=device.name;this.$('ocrflow-config-backup-limit').value=device.limit;
  bind('device-save',async()=>this.configStore().saveDevice(this.$('ocrflow-config-device-name').value,Number(this.$('ocrflow-config-backup-limit').value)));
  this.refreshConfig();
 }
});
