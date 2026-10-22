const fs = require('node:fs');
module.exports = function completePreferenceDOM(context, panel, inputs) {
  const make = () => ({value:'',checked:false,disabled:false,hidden:false,textContent:'',children:[],attributes:{},listeners:{},localName:'input',
    setAttribute(name,value){this.attributes[name]=value;},addEventListener(name,listener){this.listeners[name]=listener;},
    querySelectorAll(){return [];},replaceChildren(){this.children=[];},appendChild(child){this.children.push(child);}});
  for (const match of fs.readFileSync('preferences.xhtml','utf8').matchAll(/\bid="([^"]+)"/g)) if (!inputs.has(match[1])) {
    const input=make(), field=panel.FIELDS.find(f=>f.id===match[1]);
    if (field) input.value=String(context.Zotero.Prefs.get(panel.PREF_BRANCH+field.pref) ?? field.defaultValue ?? (field.type==='int'?1:''));
    inputs.set(match[1],input);
  }
  for(const [id,input] of inputs) {
    input.id=id;
    input.replaceChildren ||= function(){this.children=[];};
    input.appendChild ||= function(child){(this.children ||= []).push(child);};
  }
  context.document={createElementNS:()=>make()};
  panel.llmProviders ||= [{id:'provider-0'}];
  return inputs;
};
