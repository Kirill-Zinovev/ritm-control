import { readFileSync } from 'node:fs';
import ts from 'typescript';

const version = '2026-11-12.5';
const panel = readFileSync(new URL('../apps-script/stock-gateway/RollsV2Panel.html', import.meta.url), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
const api = readFileSync(new URL('../apps-script/stock-gateway/RollsV2PanelApi.gs', import.meta.url), 'utf8');

function declaration(source, name, optional = false) {
  const ast = ts.createSourceFile('panel.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const matches = ast.statements.filter(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  if (matches.length === 0 && optional) return null;
  if (matches.length !== 1) throw new Error('Expected one panel function: ' + name);
  const node = matches[0];
  return { start:node.getStart(ast), end:node.end, text:node.getText(ast) };
}

function replaceDeclaration(source, name, replacement) {
  const current = declaration(source, name, true);
  return current ? source.slice(0,current.start) + replacement + source.slice(current.end) : source + '\n' + replacement + '\n';
}

export function patchRollPanelReadability(source) {
  return source.replace(/<style>([\s\S]*?)<\/style>/,(_,css)=>'<style>'+css
    .replace(/font-size:(?:8|9|10|11)px/g,'font-size:12px').replace('font:13px Arial','font:14px Arial')
    .replace(/#(?:718096|72809a|7b879d|8b96a9)/g,'#50627a')
    .replace(/#(?:5b6ee1|556ee6)/g,'#4053bc').replace(/#b06b00/g,'#8a5100')
    .replace(/#15204408/g,'#00000008').replace(/#15204430/g,'#00000030')+'</style>');
}

// Apply the already-tested read transport to the existing main panel without replacing its writers.
// Callers must back up, compare the current source and verify every file after saving.
export function patchRollPanelTransport(files) {
  for (const name of ['RollsV2Panel','RollsV2PanelApi']) {
    if (files.filter(f=>f.name===name).length !== 1) throw new Error('Missing or ambiguous project file: '+name);
  }
  return files.map(file => {
    let source = file.source;
    if (file.name === 'RollsV2PanelApi') {
      for (const name of ['r2PanelSerializable_','r2PanelReadFailure_','r2PanelData','r2PanelPoll']) source = replaceDeclaration(source,name,declaration(api,name).text);
      source = replaceDeclaration(source,'r2PanelVersion_',`function r2PanelVersion_() { return '${version}'; }`);
    } else if (file.name === 'RollsV2Panel') {
      const match = source.match(/<script>([\s\S]*?)<\/script>/);
      if (!match) throw new Error('Panel script not found');
      let script = match[1];
      for (const name of ['panelRead','server','pollSelection','hydrateSelection','refreshAudit','refreshAuditWhenIdle','load']) script = replaceDeclaration(script,name,declaration(panel,name).text);
      if (!/var panelVersion='[^']+';/.test(script)) throw new Error('Panel version not found');
      script = script.replace(/var panelVersion='[^']+';/,`var panelVersion='${version}';`);
      script = script.replace(/setInterval\(pollSelection,\d+\)/,'setInterval(pollSelection,1200)');
      source = patchRollPanelReadability(source.slice(0,match.index) + '<script>' + script + '</script>' + source.slice(match.index+match[0].length));
    }
    return {...file,source};
  });
}
