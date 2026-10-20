const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const prefs = new Map();
const context = {
  pref: (key, value) => prefs.set(key, value),
  Zotero: {Prefs: {get: key => prefs.get(key), set: (key, value) => prefs.set(key, value)}}
};
vm.createContext(context);
for (const file of ['prompts.js','prefs.js', 'docflow.js', 'preferences.js']) vm.runInContext(fs.readFileSync(file, 'utf8'), context);
const panel = context.DocFlowPreferences, plugin = context.DocFlow;
panel.renderLLMProviders = () => {}; // This fixture renders MinerU controls only.
const prefix = panel.PREF_BRANCH;
// Reproduce an existing installation whose current settings belong to the local server.
prefs.set(prefix + 'apiMode', 'local-v1');
prefs.set(prefix + 'apiBaseURL', 'http://127.0.0.1:41835');
prefs.set(prefix + 'apiToken', '');
prefs.set(prefix + 'modelVersion', 'vlm');
prefs.set(prefix + 'pollIntervalSec', 10);
prefs.set(prefix + 'timeoutSec', 120);
prefs.set(prefix + 'apiKey', 'old-cloud-key');
const inputs = new Map(panel.FIELDS.map(field => [field.id, {value: '', checked: false, disabled: false}]));
const options = Array.from(fs.readFileSync('preferences.xhtml', 'utf8').matchAll(/<menuitem\b([^>]*data-api-mode[^>]*)>/g), match => {
  const attrs = Object.fromEntries(Array.from(match[1].matchAll(/([\w-]+)="([^"]*)"/g), attr => [attr[1], attr[2]]));
  return {hidden: attrs.hidden === 'true', getAttribute: name => attrs[name]};
});
inputs.get('mineru-model-version').querySelectorAll = () => options;
inputs.set('mineru-model-version-label', {textContent: ''});
inputs.set('mineru-cloud-language-help', {textContent: ''});
const visibleOptions = () => options.filter(option => !option.hidden).map(option => option.getAttribute('value'));
panel.$ = id => inputs.get(id);
panel.setStatus = () => {};
require("./preferences-dom.cjs")(context, panel, inputs);
panel.loadSettings();
assert.equal(inputs.get('mineru-model-version').value, 'advanced');
assert.equal(plugin.getSettings().modelVersion, 'advanced');
assert.equal(panel.readCurrentSettings().modelVersion, 'advanced');
assert.deepEqual(visibleOptions(), ['flash', 'basic', 'standard', 'advanced']);
assert.equal(inputs.get('mineru-model-version-label').textContent, '解析档位');
assert.equal(inputs.get('mineru-api-base-url').value, 'http://127.0.0.1:41835');
inputs.get('mineru-api-token').value = ''; // Local anonymous access is intentional.

function switchMode(mode) {
  inputs.get('mineru-api-mode').value = mode;
  panel.switchAPIMode();
  assert.equal(prefs.get(prefix + 'apiMode'), mode);
  assert.equal(panel.readCurrentSettings().apiMode, mode);
  assert.equal(plugin.getSettings().apiMode, mode);
}
switchMode('cloud');
assert.deepEqual(visibleOptions(), ['vlm', 'pipeline']);
assert.equal(inputs.get('mineru-model-version-label').textContent, '模型版本');
assert.equal(inputs.get('mineru-api-base-url').value, 'https://mineru.net/api/v4');
assert.equal(inputs.get('mineru-api-token').value, '');
inputs.get('mineru-api-base-url').value = 'https://cloud.example/api/v4';
inputs.get('mineru-api-token').value = 'Bearer cloud-token';
inputs.get('mineru-model-version').value = 'pipeline';
inputs.get('mineru-poll-interval-sec').value = '7';
inputs.get('mineru-timeout-sec').value = '600';
assert.equal(panel.saveSettings(), true);

switchMode('local-v1');
assert.equal(inputs.get('mineru-api-base-url').value, 'http://127.0.0.1:41835');
assert.equal(inputs.get('mineru-api-token').value, '');
assert.equal(inputs.get('mineru-model-version').value, 'advanced');
assert.equal(inputs.get('mineru-poll-interval-sec').value, '10');
assert.equal(plugin.getSettings().apiToken, '');
assert.equal(panel.readCurrentSettings().apiToken, '');
inputs.get('mineru-api-base-url').value = 'http://127.0.0.1:41836';
inputs.get('mineru-api-token').value = 'local-token';
inputs.get('mineru-timeout-sec').value = '90';
inputs.get('mineru-model-version').value = 'standard';
assert.equal(panel.saveSettings(), true);

switchMode('cloud');
assert.equal(inputs.get('mineru-api-base-url').value, 'https://cloud.example/api/v4');
assert.equal(inputs.get('mineru-api-token').value, 'cloud-token');
assert.equal(plugin.getSettings().timeoutMS, 600000);
assert.equal(plugin.getSettings().pollIntervalMS, 7000);
assert.equal(plugin.getSettings().modelVersion, 'pipeline');
panel.loadedAPIMode = null;
panel.loadSettings();
assert.equal(panel.readCurrentSettings().apiToken, 'cloud-token');
switchMode('local-v1');
assert.equal(plugin.getSettings().apiBaseURL, 'http://127.0.0.1:41836');
assert.equal(plugin.getSettings().apiToken, 'local-token');
assert.equal(plugin.getSettings().timeoutMS, 90000);
assert.equal(plugin.getSettings().localJobTimeoutMS, 7200000);
assert.equal(plugin.getSettings().modelVersion, 'standard');
assert.equal(panel.readCurrentSettings().modelVersion, 'standard');
assert.equal(plugin.getSettings('cloud').apiToken, 'cloud-token');
assert.equal(plugin.getSettings('cloud').apiBaseURL, 'https://cloud.example/api/v4');
inputs.get('mineru-local-job-timeout-sec').value = '0';
assert.equal(panel.saveSettings(), true);
assert.equal(plugin.getSettings().localJobTimeoutMS, 0);
for (const tier of ['flash', 'basic', 'standard', 'advanced']) {
  inputs.get('mineru-model-version').value = tier;
  assert.equal(panel.saveSettings(), true);
  switchMode('cloud');
  assert.equal(plugin.getSettings().modelVersion, 'pipeline');
  switchMode('local-v1');
  assert.equal(inputs.get('mineru-model-version').value, tier);
  assert.equal(plugin.getSettings().modelVersion, tier);
  assert.equal(panel.readCurrentSettings().modelVersion, tier);
}
prefs.set(prefix + 'local.modelVersion', 'pipeline');
panel.loadSettings();
assert.equal(inputs.get('mineru-model-version').value, 'basic');
assert.equal(plugin.getSettings().modelVersion, 'basic');
console.log('PASS: four local tiers, legacy Basic/Advanced choices, mode-specific menus and independently restored API profiles.');
