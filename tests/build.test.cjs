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
  const version=JSON.parse(fs.readFileSync(path.join(repo,'manifest.json'),'utf8')).version;
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
   for(const file of ['bootstrap.js','workflow.js','preferences.xhtml','vendor/katex/LICENSE'])assert(data.runtime.includes(file));
   assert(!data.runtime.some(file=>file.startsWith('tests/')));
   for(const file of ['README.md','README.zh-CN.md','CHANGELOG.md','VALIDATION.md','docs/DEVELOPMENT.md','.github/workflows/ci.yml','.gitignore','tests/build.test.cjs','build.py'])assert(data.source.includes('ocrflow/'+file),file);
   assert.equal(new Set(data.source).size,data.source.length);
   assert(data.source.every(file=>file.startsWith('ocrflow/')));
   assert(!data.source.some(file=>/\/(?:dist|\.git)\/|\/\.env$|\/scratch\.log$|\.(?:xpi|zip)$/.test(file)));
  }
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
