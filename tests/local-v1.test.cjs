const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const base = "http://127.0.0.1:41835";
function scenario({ completeAt = 15000, failAt = null, queuedOnly = false } = {}) {
	let clock = 0;
	const calls = [], delays = [], statuses = [];
	const prefs = new Map([
		["extensions.docflow.apiMode", "local-v1"],
		["extensions.docflow.cloudLanguage", "arabic"],
		["extensions.docflow.apiBaseURL", base],
		["extensions.docflow.timeoutSec", 120],
		["extensions.docflow.pollIntervalSec", 3],
		["extensions.docflow.modelVersion", "vlm"]
	]);
	const context = {
		URL, Headers, Uint8Array, AbortController, Date: { now: () => clock },
		setTimeout: (fn, ms) => { clock += ms; queueMicrotask(fn); return 1; }, clearTimeout: () => {},
		IOUtils: { read: async () => new Uint8Array([1, 2, 3]) },
		Zotero: {
			getMainWindow: () => ({AbortController}),
			Prefs: { get: key => prefs.get(key), set: (key, value) => prefs.set(key, value) },
			Promise: { delay: async ms => { delays.push(ms); clock += ms; } },
			debug: () => {}, logError: () => {}
		},
		fetch: async (url, options = {}) => {
			calls.push({ url, options });
			let reply;
			if (url.endsWith("/v1/uploads")) {
				reply = { status: "pending", id: "upload-1", upload_url: "/v1/uploads/upload-1/content", upload_method: "PUT", upload_headers: {} };
			}
			else if (url.endsWith("/complete")) {
				reply = { status: "completed", file: { id: "file-1" } };
			}
			else if (url.endsWith("/v1/parse/jobs")) {
				assert(!("language" in JSON.parse(options.body)), "Cloud language must not be sent to local V1");
				reply = { job_id: "job-1", status: "queued", progress: { completed: 0, failed: 0, total: 1 } };
			}
			else if (url.endsWith("/v1/parse/jobs/job-1")) {
				if (failAt !== null && clock >= failAt) {
					reply = { status: "failed", files: [{ status: "failed", error: { message: "CPU parser failed" } }] };
				}
				else if (clock >= completeAt) {
					reply = { status: "completed", progress: { completed: 1, failed: 0, total: 1 }, files: [{ status: "completed", output_files: { zip: { file_id: "zip-1" } } }] };
				}
				else {
					reply = { status: queuedOnly || clock < 10000 ? "queued" : "running", progress: { completed: 0, failed: 0, total: 1 } };
				}
			}
			else if (!url.endsWith("/content")) {
				throw new Error("Unexpected request: " + url);
			}
			return {
				ok: true, text: async () => JSON.stringify(reply),
				arrayBuffer: async () => new Uint8Array([80, 75]).buffer
			};
		}
	};
	vm.createContext(context);
	vm.runInContext(fs.readFileSync("docflow.js", "utf8"), context);
	const plugin = context.DocFlow;
	plugin.extractNoteContentFromMineruZip = async bytes => ({ zipBytes: Array.from(bytes) });
	const attachment = { id: 1, getFilePath: () => "/paper.pdf", getField: () => "Paper" };
	const parse = settings => plugin.parseAttachmentWithMineru(attachment, settings || plugin.getSettings(), {
		onStatus: status => statuses.push(status)
	});
	return { context, plugin, prefs, calls, delays, statuses, attachment, parse };
}

async function run() {
	// Existing 120-second preferences must not shorten the new local job wait.
	const longJob = scenario({ completeAt: 600000 });
	assert.equal(longJob.plugin.getSettings().timeoutMS, 120000);
	assert.equal(longJob.plugin.getSettings().localJobTimeoutMS, 7200000);
	const result = await longJob.parse();
	assert.deepEqual(result.zipBytes, [80, 75]);
	assert(longJob.statuses.some(status => status.mineruState === "queued"));
	assert(longJob.statuses.some(status => status.mineruState === "running"));
	assert(longJob.statuses.some(status => /已完成 0\/1 个文件/.test(status.displayText)));
	assert(longJob.statuses.some(status => /已等待 10 分 0 秒/.test(status.displayText)));
	assert.equal(longJob.prefs.get("extensions.docflow.lastLocalJobID"), "job-1");
	assert(longJob.delays.every(ms => ms === 5000));
	const jobCalls = longJob.calls.filter(call => call.url.endsWith("/v1/parse/jobs"));
	assert.equal(jobCalls.length, 1);
	assert.equal(JSON.parse(jobCalls[0].options.body).tier, "advanced");
	assert.deepEqual(JSON.parse(jobCalls[0].options.body).output_formats, ["zip"]);
	assert.equal(JSON.parse(longJob.calls[0].options.body).bytes, 3);
	assert.equal(longJob.calls[1].options.headers.has("Authorization"), false);
	assert.equal(longJob.calls.at(-1).url, `${base}/v1/files/zip-1/content`);
	assert.equal(longJob.plugin.getSettings().modelVersion, 'advanced');
	for (const tier of ['flash', 'basic', 'standard', 'advanced']) {
		const tierJob = scenario();
		tierJob.prefs.set('extensions.docflow.local.modelVersion', tier);
		await tierJob.parse();
		const submitted = JSON.parse(tierJob.calls.find(call => call.url.endsWith('/v1/parse/jobs')).options.body);
		assert.equal(submitted.tier, tier);
		assert(!('model_version' in submitted));
	}

	const pageJob = scenario();
	const request = pageJob.plugin.requestMineruJSON.bind(pageJob.plugin);
	pageJob.plugin.requestMineruJSON = async options => {
		const job = await request(options);
		if (options.url.endsWith('/v1/parse/jobs/job-1') && job.status === 'running') {
			job.files = [{status: 'running', page_progress: {completed: 128, total: 304, remaining: 176, stage: 'processing'}}];
		}
		return job;
	};
	await pageJob.parse();
	assert(pageJob.statuses.some(status => /已处理 128\/304 页，剩余 176 页/.test(status.displayText)));
	assert.equal(pageJob.calls.filter(call => call.url.endsWith('/v1/parse/jobs')).length, 1);
	assert.match(pageJob.plugin.describeLocalJobProgress({status: 'running', files: [{page_progress: {completed: 304, total: 304, remaining: 0, stage: 'exporting'}}]}, 0), /生成结果/);
	assert.match(pageJob.plugin.describeLocalJobProgress({files: [{page_progress: {completed: 0, total: null, remaining: null, stage: 'preparing'}}]}, 0), /准备文档/);

	// Four-hour configuration allows a job to finish after the two-hour default.
	const book = scenario({ completeAt: 7300000 });
	book.prefs.set("extensions.docflow.localJobTimeoutSec", 14400);
	book.prefs.set("extensions.docflow.pollIntervalSec", 10);
	await book.parse();
	assert(book.delays.every(ms => ms === 10000));

	// Zero removes the client deadline, even beyond the former four-hour maximum.
	const continuous = scenario({ completeAt: 18000000 });
	continuous.prefs.set("extensions.docflow.localJobTimeoutSec", 0);
	assert.equal(continuous.plugin.getSettings().localJobTimeoutMS, 0);
	await continuous.parse();
	assert.equal(continuous.calls.filter(call => call.url.endsWith("/v1/parse/jobs")).length, 1);
	const stopped = scenario({ completeAt: Infinity });
	stopped.prefs.set("extensions.docflow.localJobTimeoutSec", 0);
	stopped.context.Zotero.Promise.delay = async () => { stopped.plugin.parseQueueStopped = true; };
	await assert.rejects(stopped.parse, /客户端已停止等待/);

	// A server failure reports its error immediately, without downloading a ZIP.
	const failed = scenario({ failAt: 10000 });
	await assert.rejects(failed.parse, /CPU parser failed/);
	assert(!failed.calls.some(call => call.url.includes("/v1/files/")));

	// Exhausting the client wait retains the job ID and never cancels the job.
	const waiting = scenario({ completeAt: Infinity, queuedOnly: true });
	let waitError;
	await assert.rejects(waiting.parse, error => {
		waitError = error;
		return error.name === "MineruJobWaitTimeout" && /7200 秒/.test(error.message)
			&& /job-1/.test(error.message) && /queued/.test(error.message) && /未被取消/.test(error.message);
	});
	assert(!waiting.calls.some(call => call.options.method === "DELETE"));
	assert.equal(waiting.calls.filter(call => call.url.endsWith("/v1/parse/jobs")).length, 1);

	// Client wait expiry stays in the dialog queue and remains resumable.
	waiting.plugin.openParseQueueDialog = () => {};
	vm.runInContext(fs.readFileSync('workflow.js', 'utf8'), waiting.context);
	waiting.plugin.collectSourceFiles = () => [waiting.attachment];
	waiting.plugin.parseAttachmentWithMineru = async (_attachment, _settings, options) => {
		options.onStatus({jobID: "job-1", displayText: "queued"});
		throw waitError;
	};
	await waiting.plugin.handleParseCommand({ selectedItems: [] });
	assert.equal(waiting.plugin.parseQueue.length, 1);
	assert.equal(waiting.plugin.parseQueue[0].state, "wait_expired");
	assert.equal(waiting.plugin.parseQueue[0].jobID, "job-1");
	assert.match(waiting.plugin.parseQueue[0].error, /job-1/);
	console.log("PASS: queued/running long waits, 2h/4h limits, server failures and non-failure wait expiry.");
}
run().catch(error => { console.error(error); process.exitCode = 1; });
