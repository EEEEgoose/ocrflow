const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {PDFDocument, PDFName} = require('../vendor/pdf-lib/pdf-lib.min.js');
const bundle = fs.readFileSync('vendor/pdf-lib/pdf-lib.min.js', 'utf8');
const base = 'https://cloud.example/api/v4';

async function runCase(pageCount, expectedCounts, failPart = null, language = "arabic") {
  const source = await PDFDocument.create();
  const image = await source.embedPng(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXXsAAAAASUVORK5CYII=', 'base64'));
  for (let index = 0; index < pageCount; index++) {
    source.addPage([300 + index, 800]).drawImage(image, {x: 10, y: 10, width: 100, height: 100});
  }
  const sourceBytes = await source.save();
  // IOUtils can return a typed array from a different script compartment.
  const ioContext = vm.createContext({sourceBytes});
  const ioBytes = vm.runInContext('Uint8Array.from(sourceBytes)', ioContext);
  assert.equal(ioBytes instanceof Uint8Array, false);
  const events = [], submitted = [], statuses = [];
  let current = null, finished = true, libraryLoads = 0;
  const context = {
    URL, Headers, Uint8Array, ArrayBuffer, setTimeout, btoa,
    IOUtils: {read: async () => ioBytes},
    Zotero: {Promise: {delay: async () => {}}, debug: () => {}, Items: {get: () => ({getField: () => "ar-SA"})}},
    Services: {scriptloader: {loadSubScript: (url, scope) => {
      assert(url.endsWith('vendor/pdf-lib/pdf-lib.min.js'));
      libraryLoads++;
      vm.createContext(scope);
      vm.runInContext(bundle, scope);
    }}},
    fetch: async (url, options = {}) => {
      let reply;
      if (url === base + '/file-urls/batch') {
        assert(finished, 'A later segment was submitted before the previous result finished');
        finished = false;
        const body = JSON.parse(options.body);
        const index = submitted.length + 1;
        assert.equal(body.files.length, 1);
        if (language === "server") assert(!("language" in body));
        else assert.equal(body.language, "arabic", "Each PDF segment must receive the resolved cloud language");
        current = {index, file: body.files[0], polls: 0};
        submitted.push(current);
        events.push('submit-' + index);
        reply = {code: 0, data: {batch_id: 'batch-' + index, file_urls: ['https://upload.example/' + index]}};
      }
      else if (url.startsWith('https://upload.example/')) {
        const pdf = await PDFDocument.load(new Uint8Array(options.body));
        current.pages = pdf.getPageCount();
        current.widths = pdf.getPages().map(page => page.getWidth());
        assert(pdf.getPages().every(page => page.node.Resources().lookup(PDFName.of('XObject')).keys().length > 0), 'A copied page lost its scanned image');
        current.bytes = options.body;
        events.push('upload-' + current.index);
        assert.equal(options.method, 'PUT');
      }
      else if (url === base + '/extract-results/batch/batch-' + current.index) {
        current.polls++;
        const state = current.index === failPart ? 'failed' : current.polls === 1 ? 'running' : 'done';
        events.push(state + '-' + current.index);
        reply = {code: 0, data: {extract_result: [{data_id: current.file.data_id, state,
          full_zip_url: 'https://result.example/' + current.index, err_msg: state === 'failed' ? 'Test server failure' : ''}]}};
      }
      else if (url === 'https://result.example/' + current.index) {
        events.push('download-' + current.index);
      }
      else throw new Error('Unexpected request: ' + url);
      return {ok: true, status: 200, text: async () => JSON.stringify(reply),
        arrayBuffer: async () => Uint8Array.from([current.index]).buffer};
    }
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync('docflow.js', 'utf8'), context);
  const plugin = context.DocFlow;
  plugin.rootURI = 'plugin://mineru/';
  plugin.markdownToHTML = async markdown => ({html: markdown});
  plugin.extractNoteContentFromMineruZip = async bytes => {
    assert.equal(bytes[0], current.index);
    events.push('extract-' + current.index);
    finished = true;
    return {
      markdownText: `Part ${current.index}: ![one](docflow-image://img-1) ![ten](docflow-image://img-10) <img src="docflow-image://img-1">`,
      embeddedImages: Array.from({length: 10}, (_, index) => ({
        id: 'img-' + (index + 1), marker: 'docflow-image://img-' + (index + 1),
        fileName: 'same-' + index + '.png', bytes: Uint8Array.from([current.index, index])
      })),
      outlinePages: current.widths.map(width => 'page-' + (width - 299)),
      outlineHeadings: [{title: 'Part ' + current.index, page: 1, level: 1}]
    };
  };
  const parse = () => plugin.parseAttachmentWithMineru({id: 1, parentItemID: 2, getFilePath: () => '/book.pdf'}, {
    apiMode: 'cloud', apiBaseURL: base, apiToken: 'cloud-token', modelVersion: 'vlm', cloudLanguage: language, timeoutMS: 60000, pollIntervalMS: 1
  }, {onStatus: status => statuses.push(status)});
  if (failPart) {
    await assert.rejects(parse, error => /Test server failure/.test(error.message) && /第 2\/3 段/.test(error.message));
    assert.equal(submitted.length, failPart);
    return;
  }
  const result = await parse();
  assert.equal(libraryLoads, 1);
  assert.deepEqual(submitted.map(part => part.pages), expectedCounts);
  assert.deepEqual(submitted.flatMap(part => part.widths), Array.from({length: pageCount}, (_, index) => 300 + index));
  assert.equal(result.embeddedImages.length, expectedCounts.length * 10);
  assert.deepEqual(Array.from(result.outlinePages), Array.from({length: pageCount}, (_, index) => 'page-' + (index + 1)));
  assert.deepEqual(Array.from(result.outlineHeadings, heading => heading.page), expectedCounts.map((_, index) => index * 199 + 1));
  if (pageCount <= 200) {
    assert.equal(submitted[0].file.name, 'book.pdf');
    assert.equal(submitted[0].bytes, ioBytes);
  }
  else {
    let start = 1;
    for (const [index, part] of submitted.entries()) {
      assert.equal(part.file.name, `book-pages-${start}-${start + part.pages - 1}.pdf`);
      assert(result.markdownText.includes(`Part ${index + 1}: ![one](docflow-image://img-${index * 10 + 1}) ![ten](docflow-image://img-${index * 10 + 10})`));
      assert(result.markdownText.includes(`<img src="docflow-image://img-${index * 10 + 1}">`));
      if (index > 0) assert(events.indexOf('submit-' + (index + 1)) > events.indexOf('extract-' + index));
      start += part.pages;
    }
    assert.equal(new Set(result.embeddedImages.map(image => image.marker)).size, result.embeddedImages.length);
    assert(statuses.some(status => status.displayText.includes(`第 ${expectedCounts.length}/${expectedCounts.length} 段`)));
  }
  assert.equal((await PDFDocument.load(sourceBytes)).getPageCount(), pageCount);
}
async function run() {
  await runCase(200, [200]);
  await runCase(201, [199, 2]);
  await runCase(304, [199, 105], null, "auto");
  await runCase(2, [2], null, "server");
  await runCase(399, [199, 199, 1]);
  await runCase(399, [199, 199, 1], 2);
  console.log('PASS: real PDF page copying, 200-page boundary, sequential cloud tasks, ordered merged text/images and stop on failed segment.');
}
run().catch(error => {console.error(error); process.exitCode = 1;});
