const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');

test('GitHub release builds keep the manifest version and publish the approved release text verbatim',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ocrflow-release-workflow-'));
 try{
  const version=JSON.parse(fs.readFileSync('manifest.json','utf8')).version;
  fs.mkdirSync(path.join(root,'bin'));fs.mkdirSync(path.join(root,'docs/releases'),{recursive:true});
  fs.writeFileSync(path.join(root,'manifest.json'),JSON.stringify({version}));
  const notes=fs.readFileSync(`docs/releases/v${version}.md`,'utf8');
  fs.writeFileSync(path.join(root,`docs/releases/v${version}.md`),notes);
  fs.writeFileSync(path.join(root,'bin/gh'),`#!/bin/sh\nprintf '%s\\n' v${version} v1.5.6\n`,{mode:0o755});
  fs.writeFileSync(path.join(root,'build.py'),'from pathlib import Path\nimport json,sys\nPath("dist").mkdir()\nPath("build-args.json").write_text(json.dumps(sys.argv[1:]))\n');
  const workflow=fs.readFileSync('.github/workflows/ci.yml','utf8');
  const step=workflow.split('      - name: Build XPI and source archive')[1].split('      - name: Publish Release')[0];
  const script=step.split('        run: |\n')[1].split('\n').map(line=>line.slice(10)).join('\n');
  const result=spawnSync('bash',['-eu','-c',script],{cwd:root,encoding:'utf8',env:{...process.env,PATH:path.join(root,'bin')+path.delimiter+process.env.PATH,RELEASE_BUILD:'true',RUNNER_TEMP:root,GITHUB_ENV:path.join(root,'github-env'),GITHUB_REPOSITORY:'EEEEgoose/ocrflow'}});
  assert.equal(result.status,0,result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,'build-args.json'),'utf8')),['--version',version]);
  assert.equal(fs.readFileSync(path.join(root,'dist/release-notes.md'),'utf8'),notes);
  assert.equal(fs.readFileSync(path.join(root,'github-env'),'utf8'),`RELEASE_VERSION=${version}\n`);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('the sidebar update notice is rewritten for each released version',()=>{
 const version=JSON.parse(fs.readFileSync('manifest.json','utf8')).version,key=tag=>tag.slice(1).split('.').map(Number);
 const tags=spawnSync('git',['tag','--list','v*'],{encoding:'utf8'}).stdout.split('\n').filter(tag=>/^v\d+\.\d+\.\d+$/.test(tag)&&tag!=='v'+version);
 if(!tags.length)return;
 const previous=tags.sort((a,b)=>{const x=key(a),y=key(b);return x[0]-y[0]||x[1]-y[1]||x[2]-y[2];}).at(-1);
 const items=source=>source.match(/for\(let \[label,text\] of (\[\[.*?\]\])\)/)?.[1];
 const current=items(fs.readFileSync('task-sidebar.js','utf8')),old=items(spawnSync('git',['show',previous+':task-sidebar.js'],{encoding:'utf8'}).stdout);
 assert(current);assert.notEqual(current,old,`Update the sidebar notice items for v${version}; they still match ${previous}.`);
});
