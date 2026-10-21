const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');

test('a standalone checkout builds installable and clean source archives in default or explicit output directories',()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'ocrflow-build-'));
 try{
  const original=path.resolve(__dirname,'..'),repo=path.join(temp,'repo');
  fs.cpSync(original,repo,{recursive:true,filter:file=>!path.relative(original,file).split(path.sep).some(part=>['.git','dist','node_modules','__pycache__'].includes(part))});
  fs.writeFileSync(path.join(repo,'.env'),'DUMMY_PRIVATE_SETTING=not-for-release');
  fs.mkdirSync(path.join(repo,'.git'));fs.writeFileSync(path.join(repo,'.git','config'),'not-for-release');
  fs.writeFileSync(path.join(repo,'scratch.log'),'not-for-release');
  fs.writeFileSync(path.join(repo,'vendor','private-setting.json'),'not-for-installation');
  fs.writeFileSync(path.join(repo,'locale','scratch.log'),'not-for-installation');
  const baseVersion=JSON.parse(fs.readFileSync(path.join(repo,'manifest.json'),'utf8')).version;
  const version=baseVersion+'.1';
  for(const directory of [null,path.join(temp,'custom-output')]){
   const result=spawnSync('python3',['build.py',...(directory?['--output-dir',directory]:[])],{cwd:repo,encoding:'utf8'});
   assert.equal(result.status,0,result.stderr);
   const output=directory||path.join(repo,'dist');
   const xpi=path.join(output,`ocrflow-${version}.xpi`),source=path.join(output,`ocrflow-${version}-source.zip`);
   assert(fs.existsSync(xpi));assert(fs.existsSync(source));
   const inspected=spawnSync('python3',['-c',
    'import json,sys,zipfile\nwith zipfile.ZipFile(sys.argv[1]) as x, zipfile.ZipFile(sys.argv[2]) as s:\n print(json.dumps({"runtime":x.namelist(),"source":s.namelist(),"manifest":json.loads(x.read("manifest.json"))}))',xpi,source],{encoding:'utf8'});
   assert.equal(inspected.status,0,inspected.stderr);
   const data=JSON.parse(inspected.stdout);
   assert.equal(data.manifest.version,version);assert.equal(data.manifest.applications.zotero.id,'docflow@egooose.local');
   for(const file of ['bootstrap.js','prompts.js','workflow.js','preferences.xhtml','vendor/katex/katex.min.js','vendor/katex/LICENSE','vendor/pdf-lib/pdf-lib.min.js','vendor/pdf-lib/LICENSE.md','vendor/paper-outline/LICENSE'])assert(data.runtime.includes(file),file);
   assert(!data.runtime.some(file=>/^(tests\/|docs\/|\.github\/)|README|private-setting|scratch\.log/.test(file)));
   assert(data.runtime.includes('sidebar-icon.svg'));
   assert(data.runtime.includes('menu-icons/ocr.svg'));
   assert(data.runtime.filter(file=>file.endsWith('.svg')).every(file=>file==='sidebar-icon.svg'||file.startsWith('menu-icons/')),'only runtime vectors belong in the installation');
   for(const file of ['README.md','README.zh-CN.md','CHANGELOG.md','VALIDATION.md','docs/DEVELOPMENT.md','.github/workflows/ci.yml','.gitignore','tests/build.test.cjs','build.py'])assert(data.source.includes('ocrflow/'+file),file);
   assert.equal(new Set(data.source).size,data.source.length);
   assert(data.source.every(file=>file.startsWith('ocrflow/')));
   assert(!data.source.some(file=>/\/(?:dist|\.git)\/|\/\.env$|\/scratch\.log$|\.(?:xpi|zip)$/.test(file)));
   assert(!data.source.includes('ocrflow/vendor/private-setting.json'));
   assert.equal(data.manifest.applications.zotero.update_url,'https://github.com/EEEEgoose/ocrflow/releases/latest/download/updates.json');
   const updates=JSON.parse(fs.readFileSync(path.join(output,'updates.json'),'utf8'));
   const update=updates.addons[data.manifest.applications.zotero.id].updates[0];
   assert.equal(update.version,version);
   assert.equal(update.update_link,`https://github.com/EEEEgoose/ocrflow/releases/download/v${version}/ocrflow-${version}.xpi`);
   assert.deepEqual(update.applications.zotero,{strict_min_version:'10.0',strict_max_version:'10.0.*'});
  }
  const second=spawnSync('python3',['build.py'],{cwd:repo,encoding:'utf8'});
  assert.equal(second.status,0,second.stderr);
  assert(fs.existsSync(path.join(repo,'dist',`ocrflow-${baseVersion}.2.xpi`)));
  const releaseVersion=baseVersion+'.12';
  const release=spawnSync('python3',['build.py','--version',releaseVersion],{cwd:repo,encoding:'utf8'});
  assert.equal(release.status,0,release.stderr);
  for(const [filename,entry] of [[`ocrflow-${releaseVersion}.xpi`,'manifest.json'],[`ocrflow-${releaseVersion}-source.zip`,'ocrflow/manifest.json']]){
   const inspected=spawnSync('python3',['-c','import json,sys,zipfile\nwith zipfile.ZipFile(sys.argv[1]) as z: print(json.loads(z.read(sys.argv[2]))["version"])',path.join(repo,'dist',filename),entry],{encoding:'utf8'});
   assert.equal(inspected.status,0,inspected.stderr);
   assert.equal(inspected.stdout.trim(),releaseVersion);
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(repo,'dist','updates.json'),'utf8')).addons['docflow@egooose.local'].updates[0].version,releaseVersion);
  assert.equal(JSON.parse(fs.readFileSync(path.join(repo,'manifest.json'),'utf8')).version,baseVersion,'release builds must not modify the checkout');
  const next=spawnSync('python3',['build.py'],{cwd:repo,encoding:'utf8'});
  assert.equal(next.status,0,next.stderr);
  assert(fs.existsSync(path.join(repo,'dist',`ocrflow-${baseVersion}.13.xpi`)));
  assert.equal(JSON.parse(fs.readFileSync(path.join(repo,'dist','updates.json'),'utf8')).addons['docflow@egooose.local'].updates[0].version,baseVersion+'.13');
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
