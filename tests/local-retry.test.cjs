const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const base = 'http://127.0.0.1:41835';
const complete = {status: 'completed', files: [{status: 'completed', output_files: {zip: {file_id: 'output'}}}]};
async function check(existingStatus) {
  const calls = [];
  let reads = 0, polls = 0;
  const context = {
    URL, Headers, Uint8Array,
    IOUtils: {read: async () => {reads++; return Uint8Array.from([1, 2]);}},
    Zotero: {Promise: {delay: async () => {}}, Prefs: {set: () => {}}, debug: () => {}},
    fetch: async (url, options = {}) => {
      calls.push({url, options});
      let status = 200, reply;
      if (url.endsWith('/jobs/job-old')) {
        polls++;
        if (existingStatus === 'missing') {status = 404; reply = {error: 'not found'};}
        else if (existingStatus === 'network') {status = 503; reply = {error: 'unavailable'};}
        else reply = polls > 1 ? complete : existingStatus === 'completed' ? complete : {status: existingStatus};
      }
      else if (url.endsWith('/v1/uploads')) reply = {status: 'completed', file: {id: 'input'}};
      else if (url.endsWith('/v1/parse/jobs')) reply = {...complete, job_id: 'job-new'};
      else if (!url.endsWith('/v1/files/output/content')) throw new Error('Unexpected URL ' + url);
      return {ok: status === 200, status, text: async () => JSON.stringify(reply), arrayBuffer: async () => Uint8Array.from([80, 75]).buffer};
    }
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync('docflow.js', 'utf8'), context);
  const plugin = context.DocFlow;
  plugin.extractNoteContentFromMineruZip = async () => ({markdownText: 'done'});
  const parse = () => plugin.parseAttachmentWithMineru({getFilePath: () => '/paper.pdf'}, {
    apiMode: 'local-v1', apiBaseURL: base, apiToken: '', modelVersion: 'basic', pollIntervalMS: 5000, localJobTimeoutMS: 60000
  }, {jobID: 'job-old'});
  if (existingStatus === 'network') await assert.rejects(parse, /503/);
  else assert.equal((await parse()).markdownText, 'done');
  const posts = calls.filter(call => call.options.method === 'POST');
  if (['failed', 'canceled', 'missing'].includes(existingStatus)) {
    assert.equal(reads, 1); assert.equal(posts.length, 2);
  }
  else {assert.equal(reads, 0); assert.equal(posts.length, 0);}
}
async function run() {
  for (const status of ['queued', 'running', 'completed', 'failed', 'canceled', 'missing', 'network']) await check(status);
  console.log('PASS: resume pending/completed local jobs; resubmit terminal/missing jobs; no resubmission on query network errors.');
}
run().catch(error => {console.error(error); process.exitCode = 1;});
