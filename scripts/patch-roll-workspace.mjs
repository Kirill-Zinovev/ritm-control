import {readFileSync} from 'node:fs';
import ts from 'typescript';

const root = new URL('../apps-script/stock-gateway/', import.meta.url);
const panel = readFileSync(new URL('RollsV2Panel.html', root), 'utf8');
const workspace = readFileSync(new URL('RollsV2Workspace.gs', root), 'utf8');
const api = readFileSync(new URL('RollsV2PanelApi.gs', root), 'utf8');
const updated = ['r2PanelVersion_', 'r2PanelRanges_', 'r2PanelSelection_', 'r2PanelSelectedOrders_', 'r2PanelReadData_', 'r2PanelPoll'];
function functions(source) {
  const ast = ts.createSourceFile('panel.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  return ast.statements.filter(ts.isFunctionDeclaration).map(n => ({name:n.name.text,start:n.getStart(ast),end:n.end,text:n.getText(ast)}));
}

/** Preserve every existing writer and unrelated file, applying the same UI and selection contract to both books. */
export function patchRollWorkspace(files) {
  for (const name of ['RollsV2Panel','RollsV2PanelApi','RollsV2'])
    if (files.filter(f=>f.name===name).length!==1) throw Error('Missing or ambiguous file: '+name);
  const replacements = new Map(functions(api).filter(f=>updated.includes(f.name)).map(f=>[f.name,f.text]));
  const result = files.map(file => {
    if(file.name==='RollsV2Panel')return {...file,source:panel};
    if(file.name==='RollsV2Workspace')return {...file,source:workspace};
    if(file.name!=='RollsV2PanelApi')return {...file};
    let source = file.source;
    for(const [name,text] of replacements){
      const old=functions(source).filter(f=>f.name===name);
      if(old.length>1)throw Error('Ambiguous function '+name);
      source=old.length?source.slice(0,old[0].start)+text+source.slice(old[0].end):source+'\n'+text+'\n';
    }
    return {...file,source};
  });
  if(!result.some(f=>f.name==='RollsV2Workspace'))result.push({name:'RollsV2Workspace',type:'SERVER_JS',source:workspace});
  return result;
}
