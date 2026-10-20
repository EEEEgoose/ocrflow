var DocFlow;
var chromeHandle;

function log(msg) {
	Zotero.debug("OCRFlow: " + msg);
}

function install() {
	log("Installed OCRFlow");
}

async function startup({ id, version, rootURI }) {
	log("Starting OCRFlow");
	let aomStartup = Cc["@mozilla.org/addons/addon-manager-startup;1"].getService(Ci.amIAddonManagerStartup);
	chromeHandle = aomStartup.registerChrome(Services.io.newURI(rootURI + "manifest.json"), [
		["content", "docflow", "./"]
	]);
	
	Services.scriptloader.loadSubScript(rootURI + 'prompts.js');
	Services.scriptloader.loadSubScript(rootURI + 'docflow.js');
	DocFlow.init({ id, version, rootURI });
	Services.scriptloader.loadSubScript(rootURI + 'markitdown.js');
	Services.scriptloader.loadSubScript(rootURI + 'metadata.js');
	Services.scriptloader.loadSubScript(rootURI + 'workflow.js');
	Services.scriptloader.loadSubScript(rootURI + "outline.js");
	DocFlowOutline.init(DocFlow);
	DocFlow.outline = DocFlowOutline;
	await Zotero.PreferencePanes.register({
		id: "ocrflow-preferences",
		pluginID: id,
		src: "chrome://docflow/content/preferences.xhtml",
		scripts: ["chrome://docflow/content/prompts.js", "chrome://docflow/content/markitdown.js", "chrome://docflow/content/preferences.js"],
		label: "OCRFlow",
		image: "chrome://docflow/content/icon48.png"
	});
	DocFlowOutline.registerReaders();
	DocFlow.addToAllWindows();
	await DocFlow.main();
}

function onMainWindowLoad({ window }) {
	DocFlow.addToWindow(window);
}

function onMainWindowUnload({ window }) {
	DocFlow?.removeFromWindow(window);
}

function shutdown() {
	log("Shutting down OCRFlow");
	DocFlow.parseQueueStopped = true;
	DocFlow.outline?.shutdown();
	DocFlow.parseQueueWindow?.close();
	DocFlow.removeFromAllWindows();
	DocFlow = undefined;
	chromeHandle?.destruct();
	chromeHandle = null;
}

function uninstall() {
	log("Uninstalled OCRFlow");
}
