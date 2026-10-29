const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path').posix;
function setup(){
 const files=new Map(),imports=[];let serial=0;

 const context={Uint8Array,TextDecoder,TextEncoder,atob,btoa,
  PathUtils:{join:path.join,parent:path.dirname,tempDir:'/tmp'},
  IOUtils:{makeDirectory:async()=>{},writeUTF8:async(p,t)=>files.set(p,new TextEncoder().encode(t)),write:async(p,b)=>files.set(p,b),read:async()=>{throw Error('Original page files must not be read');},remove:async()=>{}},
  Zotero:{debug(){},getMainWindow:()=>{throw Error("Renderer must not measure fonts from boxes");},Reader:{open(){throw Error('Original PDF reader must not be opened');}},Prefs:{get(){}},Attachments:{importFromFile:async options=>{
   imports.push(options);const stored='/storage/'+(++serial)+'/'+path.basename(options.file);files.set(stored,files.get(options.file));
   return {key:'OUT'+serial,getFilePath:async()=>stored,addTag(){},saveTx:async()=>{},eraseTx:async()=>files.delete(stored)};
  }}}
 };
 vm.createContext(context);for(const name of ['docflow.js','workflow.js','document.js','layout.js','recognition.js'])vm.runInContext(fs.readFileSync(name,'utf8'),context,{filename:name});
 const m=context.DocFlow,d=context.OCRFlowDocument;m.documentFileStem=async()=> 'book';const applyTypography=m.applyOriginalTypography.bind(m);m.applyOriginalTypography=async()=>{};m.mathRenderer=require('../vendor/katex/katex.min.js');
 const attachment={id:7,key:'SOURCE',libraryID:1,getFilePath:async()=>'/source/book.pdf',getField:()=> 'Original title',isPDFAttachment:()=>true};
 const result={markdownText:'<!--ocrflow-page:1-->Recognized text\n\n![](images/figure.png)',embeddedImages:[{marker:'docflow-image://img-1',fileName:'figure.png',entryName:'images/figure.png',mimeType:'image/png',bytes:Uint8Array.of(137,80,78,71)}],document:d.fromMineru({pdf_info:[
  {page_size:[600,800],preproc_blocks:[{type:'title',bbox:[30,20,570,40],text:'标题'},
   {type:'text',bbox:[30,60,280,200],lines:[{bbox:[30,60,280,80],spans:[{content:'Left column <&>'}]},{bbox:[30,90,280,110],spans:[{content:'Second line.'}]}]},
   {type:'text',bbox:[320,60,570,80],lines:[{bbox:[320,60,570,80],spans:[{content:'Right column.'}]}]}]},
  {page_size:[800,600],preproc_blocks:[]},
  {page_size:[450,900],preproc_blocks:[{type:'text',bbox:[30,40,400,70],text:'Third page.'},
   {type:'image',bbox:[30,120,200,250],blocks:[{type:'image_body',lines:[{spans:[{type:'image',image_path:'images/figure.png'}]}]}]},
   {type:'table',bbox:[30,300,400,400],lines:[{spans:[{type:'table',html:'<table><tbody><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></tbody></table>'}]}]},
   {type:'interline_equation',bbox:[30,450,400,490],lines:[{bbox:[30,450,400,490],spans:[{type:'interline_equation',content:'x^2+y^2'}]}]}]}
 ]})};
 return {context,m,d,files,imports,attachment,result,applyTypography};
}

test('original-layout output uses visible HTML text, tables and math with only the independently recognized figure image',async()=>{
 for(const imageMode of ['folder','inline']){
  const s=setup();const saved=await s.m.saveResultAsMarkdownAttachment({attachment:s.attachment,parsedResult:s.result,settings:{outputFormat:'html',imageMode,parseLinkSourcePDF:false}});
  const p=await saved.attachment.getFilePath(),html=new TextDecoder().decode(s.files.get(p));
  assert.equal((html.match(/class="ocr-page"/g)||[]).length,3);assert(html.includes('aspect-ratio:800/600'));assert(html.includes('aspect-ratio:450/900'));
  assert(html.includes('left:5%;top:7.5%;width:41.66666666666667%;height:2.5%'));
  assert(html.includes('Left column &lt;&amp;&gt;'));assert(html.includes('<table>'));assert(html.includes('<math'));assert(html.includes('ocr-heading'));
  assert(!html.includes('color:transparent'));assert(!html.includes('ocr-original'));assert(!html.includes('original-page-'));assert(!html.includes('<canvas'));
  assert.equal((html.match(/<img\b/g)||[]).length,1,'Only the source figure is an image');
  assert(s.files.has(p.replace(/\.html$/,'.md')));assert(s.files.has('/storage/1/_ocrflow/document.json'));
  if(imageMode==='folder'){assert(html.includes('src="images/image-1.png"'));assert(s.files.has('/storage/1/images/image-1.png'));}
  else assert(html.includes('src="data:image/png;base64,'));
  assert(![...s.files.keys()].some(key=>key.includes('original-page-')));
 }
});

test('missing position data renders readable content instead of falling back to page screenshots',async()=>{
 const s=setup();delete s.result.document.layout;for(const block of s.result.document.blocks)block.fragments[0].rect=null;
 s.m.normalizeResultImages(s.result);
 const pages=s.m.prepareOriginalLayout(s.result),html=(await s.m.renderOriginalLayout(pages,text=>s.m.renderDocumentBody(text.replace(/docflow-image:\/\/img-1/g,"images/image-1.png")))).body;
 assert(html.includes('ocr-flow'));assert(html.includes('按阅读顺序显示'));assert(html.includes('Left column'));assert(html.includes('Third page.'));
 assert(!html.includes('ocr-original'));assert(!html.includes('data:image/png;base64,'));
});

test('source typography failure leaves no incomplete attachment',async()=>{
 const s=setup();s.m.applyOriginalTypography=async()=>{throw Error('source typography failed');};
 await assert.rejects(s.m.saveResultAsMarkdownAttachment({attachment:s.attachment,parsedResult:s.result,settings:{outputFormat:'html'}}),/source typography failed/);
 assert.equal(s.imports.length,0);
 await s.m.saveResultAsMarkdownAttachment({attachment:s.attachment,parsedResult:s.result,settings:{outputFormat:'md',parseLinkSourcePDF:false}});assert.equal(s.imports.length,1);
});

test('Markdown-layout HTML keeps its existing flowing layout without preparing page positions',async()=>{
 const s=setup();s.m.prepareOriginalLayout=()=>{throw Error('Markdown layout must not prepare positioned content');};
 const saved=await s.m.saveResultAsMarkdownAttachment({attachment:s.attachment,parsedResult:s.result,settings:{outputFormat:'html',htmlLayout:'markdown',parseLinkSourcePDF:false}});
 const p=await saved.attachment.getFilePath(),html=new TextDecoder().decode(s.files.get(p));assert(html.includes('Recognized text'));assert(!html.includes('class="ocr-page"'));assert(s.files.has(p.replace(/\.html$/,'.md')));
});

test('image-source recognition renders its text regions rather than the original scan',()=>{
 const s=setup();const pages=s.m.prepareOriginalLayout(s.result);assert.equal(pages[0].width,600);assert.equal(pages[0].height,800);assert(pages[0].regions.some(region=>region.text==='Left column <&>'));assert(!('image' in pages[0]));
});

test('layout text survives paragraph joins and cloud offsets while image references are remapped with their piece',()=>{
 const s=setup(),doc=s.d.fromMineru({pdf_info:[{page_size:[600,800],preproc_blocks:[{type:'text',bbox:[0,0,20,20],text:'First unfinished'}]},{page_size:[600,800],preproc_blocks:[{type:'text',bbox:[0,0,20,20],text:'continued text.'}]}]});
 assert.equal(s.d.visible(doc).length,1);assert.equal(doc.layout[0].regions[0].text,'First unfinished');assert.equal(doc.layout[1].regions[0].text,'continued text.');
 const piece={index:0,start:5,result:{document:doc,markdownText:s.d.render(doc)}};const first=s.m.mergeCloudParts([piece],7),second=s.m.mergeCloudParts([piece],7);
 assert.deepEqual(Array.from(first.document.layout,p=>p.page),[6,7]);assert.deepEqual(Array.from(second.document.layout,p=>p.page),[6,7]);assert.deepEqual(Array.from(doc.layout,p=>p.page),[1,2]);
 const imagePiece=()=>({document:{pages:[],blocks:[],layout:[{page:1,size:[100,100],regions:[{rect:[0,0,30,30],type:'image',text:'![](docflow-image://img-1)',media:true}]}]},embeddedImages:[{marker:'docflow-image://img-1',fileName:'same.png',bytes:Uint8Array.of(1)}]});
 const merged=s.m.mergeCloudParts([{index:0,start:0,result:imagePiece()},{index:1,start:1,result:imagePiece()}],2);
 assert(merged.document.layout[1].regions[0].text.includes('img-2'));assert(merged.document.layout[0].regions[0].text.includes('img-1'));
});

test('Paddle and Marker retain geometry, table HTML and independent picture references',()=>{
 const s=setup(),paddle=s.d.fromPaddle([{prunedResult:{width:600,height:800,parsing_res_list:[{block_label:'text',block_content:'Paddle',block_bbox:[10,20,300,40]}]}}]);
 assert.equal(paddle.layout[0].regions[0].text,'Paddle');assert.deepEqual(Array.from(paddle.layout[0].size),[600,800]);
 const marker=s.context.OCRFlowLayout.marker({children:[{polygon:[[10,20],[610,20],[610,820],[10,820]],children:[{block_type:'Text',html:'<p>Marker &amp; &#20013;文</p>',bbox:[40,60,300,90]},{block_type:'Table',html:'<table><tr><td>Cell</td></tr></table>',bbox:[40,100,300,200]},{block_type:'Picture',html:'<img src="figure.png">',bbox:[40,220,300,400]}]}]},s.m);
 assert.deepEqual(Array.from(marker[0].size),[600,800]);assert.deepEqual(Array.from(marker[0].regions[0].rect),[30,40,290,70]);assert.equal(marker[0].regions[0].text,'Marker & 中文');assert(marker[0].regions[1].text.includes('<table>'));assert.equal(marker[0].regions[2].text,'![](figure.png)');
});

test('a VLM paragraph stored as one lines entry is rendered as a paragraph rather than a giant compressed line',()=>{
 const s=setup(),doc=s.d.fromMineru({pdf_info:[{page_size:[595,842],preproc_blocks:[{type:'text',bbox:[86,142,508,760],lines:[{bbox:[86,142,508,760],spans:[{content:'段落文字。'.repeat(160)}]}]}]}]});
 assert.equal(doc.layout[0].regions.length,1);assert(!doc.layout[0].regions[0].line);assert.equal(doc.layout[0].regions[0].text.length,800);
 doc.layout[0].regions[0].line=true;assert(!s.m.prepareOriginalLayout({document:doc}).at(0).regions[0].line,'Old saved paragraph snapshots must not be treated as single lines');
});

test('short text in a wide source rectangle keeps its natural glyph proportions',async()=>{
 const s=setup(),pages=[{page:1,width:600,height:800,regions:[{rect:[196,503,381,519],type:'text',text:'作者孟茁',line:true}]}];
 const output=await s.m.renderOriginalLayout(pages,text=>s.m.renderDocumentBody(text));
 assert(output.body.includes('作者孟茁'));assert(!output.body.includes('transform:'));assert(!output.style.includes('scaleX'));
 const narrow=await s.m.renderOriginalLayout([{...pages[0],regions:[{...pages[0].regions[0],rect:[196,503,246,519]}]}],text=>s.m.renderDocumentBody(text));
 const size=html=>Number(html.match(/font-size:([\d.]+)cqw/)[1]);
 assert.equal(size(narrow.body),size(output.body),'Box width must not change the font size');assert.equal(size(output.body),2,'Body fallback is uniformly 12pt');
});

test('PDF typography supplies real sizes, Chinese font families and paragraph line spacing',()=>{
 const s=setup(),layout=s.context.OCRFlowLayout;
 const page={width:600,height:800,regions:[{rect:[30,20,550,60],type:'title',text:'标题'},{rect:[30,80,550,300],type:'text',text:'正文'},{rect:[30,740,550,780],type:'page_footnote',text:'脚注'}]};
 const text={styles:{title:{fontFamily:'sans-serif',ascent:.8},body:{fontFamily:'sans-serif',ascent:.8},note:{fontFamily:'serif',ascent:.8}},items:[
  {str:'标题',fontName:'title',width:40,transform:[18,0,0,18,40,760]},
  {str:'第一行正文内容',fontName:'body',width:180,transform:[12,0,0,12,40,700]},
  {str:'第二行正文内容',fontName:'body',width:180,transform:[12,0,0,12,40,680]},
  {str:'1',fontName:'body',width:4,transform:[6,0,0,6,225,705]},
  {str:'Footnote',fontName:'note',width:50,transform:[9,0,0,9,40,40]}
 ]};
 const fonts={title:{name:'ABCDEE+黑体'},body:{name:'ABCDEE+'+Buffer.from('宋体').toString('latin1')},note:{name:'Times New Roman'}};
 layout.applyTypography(page,text,{width:600,height:800,transform:[1,0,0,-1,0,800]},fonts);
 assert.deepEqual(page.regions.map(region=>region.fontSize),[18,12,9]);assert.equal(page.regions[1].lineHeight,20);
 assert(page.regions[1].fontFamily.includes('宋体'));assert(page.regions[1].fontFamily.includes('Songti SC'));assert(page.regions[0].fontFamily.includes('Heiti SC'));
 assert(page.regions.every(region=>region.fontSource==='pdf'));
});

test('original-layout saving reads native text metadata without rendering page images',async()=>{
 const s=setup(),reader={itemID:7,_initPromise:Promise.resolve(),_internalReader:{_primaryView:{initializedPromise:Promise.resolve(),_iframeWindow:{Object}}}};
 let operators=0;
 s.context.Zotero.Reader._readers=[reader];s.m.applyOriginalTypography=s.applyTypography;
 s.m.outline={getReaderApp:()=>({pdfDocument:{getPage:async()=>({
  getTextContent:async()=>({styles:{f:{fontFamily:'serif',ascent:.8}},items:[{str:'Native source text',fontName:'f',width:200,transform:[12,0,0,12,40,740]}]}),
  getOperatorList:async()=>{operators++;},commonObjs:{has:()=>true,get:()=>({name:'Times New Roman'})},
  getViewport:()=>({width:600,height:800,transform:[1,0,0,-1,0,800]}),render:()=>{throw Error('Page rasterization is forbidden');}
 })}})};
 const pages=[{page:1,width:600,height:800,regions:[{rect:[30,40,550,100],type:'text',text:'Native source text'}]}];
 await s.m.applyOriginalTypography(s.attachment,pages);assert.equal(operators,1);assert.equal(pages[0].regions[0].fontSize,12);
});

test('OCR page coordinate units do not scale the actual PDF font size',()=>{
 const s=setup(),page={width:300,height:400,regions:[{rect:[15,20,275,50],type:'text',text:'Source text'}]};
 const text={styles:{f:{fontFamily:'serif',ascent:.8}},items:[{str:'Source text',fontName:'f',width:150,transform:[12,0,0,12,40,740]}]};
 const viewport={width:600,height:800,transform:[1,0,0,-1,0,800]};
 s.context.OCRFlowLayout.applyTypography(page,text,viewport,{f:{name:'Times New Roman'}});
 assert.equal(page.regions[0].fontSize,12);assert.deepEqual(Array.from(page.regions[0].rect),[30,40,550,100]);
 s.context.OCRFlowLayout.applyTypography(page,text,viewport,{f:{name:'Times New Roman'}});
 assert.equal(page.regions[0].fontSize,12);assert.deepEqual(Array.from(page.regions[0].rect),[30,40,550,100]);
});

test('translation HTML retains its bilingual columns and does not prepare original layout',async()=>{
 const s=setup();s.m.prepareOriginalLayout=()=>{throw Error('translation must not prepare original layout');};
 const item=await s.m.saveDocumentAttachment({libraryID:1,title:'Translation',markdown:'translated',format:'html',tag:'#DocFlow-Translation',pairs:[{id:'b1',source:'Source',translated:'译文'}]});
 const html=new TextDecoder().decode(s.files.get(await item.getFilePath()));assert(html.includes('class="bilingual"'));assert(html.includes('<p>Source</p>'));assert(html.includes('<p>译文</p>'));assert(!html.includes('ocr-page'));
});

test('native baselines retain unequal line gaps and mixed font sizes without changing recognized text',async()=>{
 const s=setup(),page={page:1,width:600,height:800,regions:[{rect:[30,70,550,180],type:'text',text:'Première ligne.\nDeuxième ligne.\nTroisième ligne.'}]};
 const text={styles:{f:{fontFamily:'serif',ascent:.8}},items:[
  {str:'Première ligne.',fontName:'f',width:150,transform:[12,0,0,12,40,700]},
  {str:'Deuxième ligne.',fontName:'f',width:150,transform:[12,0,0,12,40,679]},
  {str:'Troisième ligne.',fontName:'f',width:180,transform:[14,0,0,14,40,650]}
 ]};
 s.context.OCRFlowLayout.applyTypography(page,text,{width:600,height:800,transform:[1,0,0,-1,0,800]},{f:{name:'Times New Roman'}});
 assert.deepEqual(Array.from(page.regions[0].sourceRuns,r=>r.baseline),[100,121,150]);
 assert.deepEqual(Array.from(page.regions[0].sourceRuns,r=>r.fontSize),[12,12,14]);
 let removed=0;
 s.context.Zotero.getMainWindow=()=>({document:{createElementNS:()=>({setAttribute(){},append(){},querySelector(){return null;},querySelectorAll(){return [];},getBoundingClientRect:()=>({top:80}),remove(){removed++;}}),documentElement:{append(node){node.getBoundingClientRect=()=>({top:0});}}}});
 const output=await s.m.renderOriginalLayout([page],t=>s.m.renderDocumentBody(t));
 assert(output.body.includes('data-baseline="100"'));assert(output.body.includes('data-baseline="121"'));assert(output.body.includes('data-baseline="150"'));
 assert(output.body.includes('font-size:2cqw;'));assert(output.body.includes('line-height:2cqw;'));assert(!output.body.includes('line-height:18.333'));
 assert.equal(removed,3,'Baseline measurement nodes are removed for every distinct text run');
 assert(!output.body.includes('transform:'));assert(output.body.includes('Première ligne.'));
});

test('incomplete Arabic native text cannot replace recognized Arabic paragraphs',()=>{
 const s=setup(),page={width:600,height:800,regions:[{rect:[20,50,580,300],type:'text',text:'هذا نص عربي كامل 2020'}]};
 s.context.OCRFlowLayout.applyTypography(page,{styles:{f:{fontFamily:'serif',ascent:.8}},items:[{str:'2020',fontName:'f',width:24,transform:[12,0,0,12,40,700]}]},
  {width:600,height:800,transform:[1,0,0,-1,0,800]},{f:{name:'Times New Roman'}});
 assert(!page.regions[0].sourceRuns);assert.equal(page.regions[0].text,'هذا نص عربي كامل 2020');
});

test('single OCR rows use PDF baselines and do not use ink-box height as line height',()=>{
 const s=setup(),page={width:600,height:800,regions:[{rect:[20,87,580,104],line:true,type:'text',text:'OCR corrected text'}]};
 s.context.OCRFlowLayout.applyTypography(page,{styles:{f:{fontFamily:'serif',ascent:.8}},items:[{str:'Original text',fontName:'f',width:100,transform:[12,0,0,12,40,700]}]},
  {width:600,height:800,transform:[1,0,0,-1,0,800]},{f:{name:'Times New Roman'}});
 assert.equal(page.regions[0].baseline,100);assert(!page.regions[0].sourceRuns);assert.equal(page.regions[0].text,'OCR corrected text');
});

test('Type3 fonts with non-finite ascent still expose French baselines and serif italic styling',()=>{
 const s=setup(),page={width:600,height:800,regions:[{rect:[30,80,550,110],line:true,type:'text',text:'La mémoire de l’Algérie.'}]};
 s.context.OCRFlowLayout.applyTypography(page,{styles:{f:{fontFamily:'sans-serif',ascent:NaN}},items:[{str:'La mémoire de l’Algérie.',fontName:'f',width:180,transform:[12.335,0,0,12.335,40,700]}]},
  {width:600,height:800,transform:[1,0,0,-1,0,800]},{f:{name:'ABCDEE+NotoSerif-Italic'}});
 assert.equal(page.regions[0].fontSize,12.34);assert.equal(page.regions[0].sourceRuns[0].baseline,100);
 assert.equal(page.regions[0].fontFamily,'"NotoSerif-Italic",serif');assert.equal(page.regions[0].italic,true);
 assert(s.context.OCRFlowLayout.fontFamily('B3+SimSun').css.includes('Songti SC'));
});

test('native source glyphs supersede incorrect OCR superscript markup without changing French letters',()=>{
 const s=setup(),page={width:600,height:800,regions:[{rect:[30,80,550,110],line:true,type:'text',text:'En A<sup>f</sup>rique.'}]};
 s.context.OCRFlowLayout.applyTypography(page,{styles:{f:{fontFamily:'serif',ascent:.8}},items:[{str:'En Afrique.',fontName:'f',width:100,transform:[12,0,0,12,40,700]}]},
  {width:600,height:800,transform:[1,0,0,-1,0,800]},{f:{name:'Times New Roman'}});
 assert.equal(page.regions[0].sourceRuns[0].text,'En Afrique.');assert.equal(page.regions[0].sourceRuns[0].baseline,100);
});

function conversionSetup(){
 const s=setup(),io=s.context.IOUtils,links=[];
 const source={id:8,key:'CACHED',libraryID:1,getFilePath:async()=>'/cache/existing.html',getField:()=> 'Existing HTML'};
 s.result.document.source={libraryID:1,key:'SOURCE'};
 s.files.set('/cache/existing.html','untouched HTML');
 s.files.set('/cache/existing.md','Recognized text\n\n![](images/figure.png)');
 s.files.set('/cache/images/figure.png',Uint8Array.of(137,80,78,71));
 s.files.set('/cache/_ocrflow/document.json',JSON.stringify(s.result.document));
 s.files.set('/cache/_ocrflow/raw/engine-a/0-layout.json','cached raw');
 s.files.set('/cache/_ocrflow/collation.json','{"status":"ready"}');
 io.exists=async p=>s.files.has(p);io.read=async p=>{if(!s.files.has(p))throw Error('Missing '+p);const value=s.files.get(p);return typeof value==='string'?new TextEncoder().encode(value):value;};
 io.readUTF8=async p=>new TextDecoder().decode(await io.read(p));
 io.getChildren=async p=>[...new Set([...s.files.keys()].filter(k=>k.startsWith(p+'/')).map(k=>p+'/'+k.slice(p.length+1).split('/')[0]))];
 io.copy=async(from,to)=>{for(const [p,v]of [...s.files])if(p===from||p.startsWith(from+'/'))s.files.set(to+p.slice(from.length),v);};
 s.context.Zotero.Items={getByLibraryAndKey:(_lib,key)=>key==='SOURCE'?s.attachment:null};
 s.m.parentForDocument=()=>null;s.m.linkParseSource=async(a,b)=>links.push([a,b]);
 return {...s,source,links};
}

test('existing recognition converts both HTML layouts offline with distinct names, images and companion Markdown',async()=>{
 const s=conversionSetup(),before=new Map(s.files);let typography=0;
 s.m.applyOriginalTypography=async original=>{assert.equal(original,s.attachment);typography++;};
 for(const htmlLayout of ['original','markdown']){
  const item=await s.m.convertDocumentLayout({source:s.source,htmlLayout});
  const p=await item.getFilePath(),html=new TextDecoder().decode(s.files.get(p));
  assert(path.basename(p).startsWith(htmlLayout==='original'?'OCRFlow_原文布局_':'OCRFlow_MD布局_'));
  assert.equal(html.includes('class="ocr-page"'),htmlLayout==='original');
  assert(html.includes('Recognized text') || html.includes('Left column'));assert(html.includes('<img'));
  const dir=path.dirname(p);assert(s.files.has(dir+'/images/image-1.png'));assert(s.files.has(p.replace(/\.html$/,'.md')));
  const doc=JSON.parse(new TextDecoder().decode(s.files.get(dir+'/_ocrflow/document.json')));
  assert.equal(doc.source.key,'SOURCE');assert.equal(s.files.get(dir+'/_ocrflow/raw/engine-a/0-layout.json'),'cached raw');
  assert.equal(s.files.get(dir+'/_ocrflow/collation.json'),'{"status":"ready"}');
 }
 assert.equal(typography,1);assert.equal(s.links.length,2);assert(s.links.every(([original])=>original===s.attachment));
 for(const [p,value]of before)assert.deepEqual(s.files.get(p),value,'Existing files stay unchanged: '+p);
});

test('legacy results without geometry can convert to Markdown HTML but cannot claim original-page layout',async()=>{
 const s=conversionSetup();s.files.delete('/cache/_ocrflow/document.json');
 await assert.rejects(s.m.convertDocumentLayout({source:s.source,htmlLayout:'original'}),/缺少页面位置数据/);assert.equal(s.imports.length,0);
 const item=await s.m.convertDocumentLayout({source:s.source,htmlLayout:'markdown'});assert(path.basename(await item.getFilePath()).startsWith('OCRFlow_MD布局_'));
});

test('failed metadata copying removes the new conversion while retaining the previous attachment',async()=>{
 const s=conversionSetup();s.context.IOUtils.copy=async()=>{throw Error('copy failed');};
 await assert.rejects(s.m.convertDocumentLayout({source:s.source,htmlLayout:'markdown'}),/copy failed/);
 assert.equal(s.files.get('/cache/existing.html'),'untouched HTML');assert(![...s.files.keys()].some(p=>/^\/storage\/\d+\/OCRFlow_MD布局_.*\.html$/.test(p)));
});
