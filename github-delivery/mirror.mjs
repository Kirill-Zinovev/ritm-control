import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(import.meta.url);
const repository = resolve(dirname(script), '..');
const remote = 'https://github.com/Kirill-Zinovev/ritm-control.git';
const branch = 'refs/heads/main';
const manifestPath = 'github-delivery/sources.json';
const projects = new Map([
  ['appgprj_6ac6187dc23881918cdefb7a80f20654', { name:'РИТМ', prefix:'' }],
  ['appgprj_6af6c13756ec8191992b26eb98acf27d', { name:'РИТМ Сборка', prefix:'assembly-v2/' }],
  ['appgprj_6b0143cd02748191b7a104b5c4dbf30c', { name:'РИТМ Печать', prefix:'printing/' }],
]);
const env = { ...process.env, GIT_TERMINAL_PROMPT:'0' };
for (const key of ['GIT_DIR','GIT_INDEX_FILE','GIT_WORK_TREE','GIT_COMMON_DIR','GIT_PREFIX','GIT_CONFIG_COUNT','GIT_CONFIG_PARAMETERS'])
  delete env[key];

function gitResult(cwd, args, options = {}) {
  const result = spawnSync('git', args, {
    cwd, env:{...env,...options.env}, input:options.input, encoding:'utf8', maxBuffer:48*1024*1024,
    windowsHide:true,
  });
  if (result.error) throw new Error('Не удалось запустить Git.');
  return result;
}

function git(cwd, args, options) {
  const result=gitResult(cwd,args,options);
  if (result.status!==0) throw new Error('Git не выполнил ' + args[0] + '. Проверьте доступ и состояние репозитория.');
  return result.stdout;
}

const show = (cwd, ref) => git(cwd,['show',ref]);
const head = (cwd, ref='HEAD') => git(cwd,['rev-parse','--verify',ref]).trim();
const digest = (data) => git(repository,['hash-object','-w','--stdin'],{input:data}).trim();
function tree(cwd, ref) {
  return git(cwd,['ls-tree','-rz',ref]).split('\0').filter(Boolean).map(line=>{
    const [header,path]=line.split('\t'), [mode,type,hash]=header.split(' ');
    return {mode,type,hash,path};
  });
}

function openSource(path) {
  const cwd=resolve(path);
  const commit=head(cwd);
  const id=JSON.parse(show(cwd,commit+':.openai/hosting.json')).project_id;
  const project=projects.get(id);
  if (!project || cwd.toLowerCase()===repository.toLowerCase()) throw new Error('Укажите отдельный checkout одного из трёх Sites.');
  return {id,cwd,commit,...project};
}

function projectTree(source) {
  const entries=tree(source.cwd,source.commit);
  const forbidden=entries.find(({path,type,mode})=>type!=='blob' || !['100644','100755'].includes(mode) ||
    /(^|\/)(node_modules|dist|\.wrangler|\.git|\.sites-runtime|\.checks)(\/|$)|(^|\/)\.env(?:$|\.(?!example$)[^/]+)|\.(sqlite\d*|db|pem|pfx|p12|key|zip|tar|gz|bak)$/i.test(path) ||
    /(^|\/)(credentials?|service[-_]?account)[^/]*\.json$/i.test(path) ||
    (/\.sql$/i.test(path) && !/(^|\/)drizzle\//.test(path)) ||
    (!source.prefix && /^(assembly-v2|printing|github-delivery)\//.test(path)));
  if (forbidden) throw new Error('В исходниках есть файл вне области публикации: ' + forbidden.path);
  const secrets=gitResult(source.cwd,['grep','-I','-l','-E',
    '-e','BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY',
    '-e','(gh[pousr]_|github_pat_|sk-proj-|AIza|xox[baprs]-)[A-Za-z0-9_-]{15,}',
    '-e','/rest/[0-9]+/[A-Za-z0-9_-]{12,}/', source.commit]);
  if (![0,1].includes(secrets.status)) throw new Error('Не удалось проверить исходники перед отправкой.');
  const fixed=new Map();
  for (const ref of secrets.stdout.trim().split(/\r?\n/).filter(Boolean)) {
    const path=ref.slice(source.commit.length+1);
    const data=show(source.cwd,ref);
    const urlPattern=/\/rest\/\d+\/([A-Za-z0-9_-]{12,})(?=\/)/g;
    // This test generates its own key in memory. Allow only its literal PEM wrapper.
    const keyCheck=path==='tests/cloud-migration.test.mjs'
      ? data.replace('-----BEGIN PRIVATE KEY-----\\n'+'$'+'{key}\\n-----END PRIVATE KEY-----','') : data;
    if (!path.startsWith('tests/') || /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|(?:gh[pousr]_|github_pat_|sk-proj-|AIza|xox[baprs]-)[A-Za-z0-9_-]{15,}/.test(keyCheck))
      throw new Error('Возможный секрет в файле ' + path + '. Отправка остановлена.');
    const tokens=[...new Set([...data.matchAll(urlPattern)].map(match=>match[1]))];
    if (!tokens.length && keyCheck!==data) continue;
    if (!tokens.length) throw new Error('Проверьте тестовый файл ' + path + '.');
    const fixture=tokens.reduce((text,token,index)=>text.split(token).join('fixtureWebhookToken'+(index+1)),data);
    fixed.set(path,digest(fixture));
  }
  git(repository,['fetch','--quiet','--no-tags','--no-write-fetch-head',source.cwd,source.commit]);
  return entries.map(entry=>({...entry,path:source.prefix+entry.path,hash:fixed.get(entry.path)||entry.hash}));
}

function originHead() {
  const value=git(repository,['ls-remote','--exit-code','origin',branch]).trim().split(/\s+/)[0];
  if(!/^[a-f0-9]{40}$/.test(value)) throw new Error('Не удалось сверить ветку main на GitHub.');
  return value;
}

function sync(paths, dryRun) {
  if (git(repository,['remote','get-url','origin']).trim()!==remote) throw new Error('Не подтверждён репозиторий ritm-control.');
  const sources=paths.map(openSource);
  if(!sources.length || new Set(sources.map(source=>source.id)).size!==sources.length) throw new Error('Укажите по одному checkout на приложение.');
  const updates=sources.map(source=>({source,entries:projectTree(source)}));
  const tmp=mkdtempSync(join(tmpdir(),'ritm-github-index-'));
  const index=join(tmp,'index');
  try {
    for(let attempt=0;attempt<3;attempt++) {
      git(repository,['fetch','--quiet','--no-tags','origin',branch]);
      const base=head(repository,'FETCH_HEAD');
      const manifest=gitResult(repository,['show',base+':'+manifestPath]);
      const versions=manifest.status===0 ? JSON.parse(manifest.stdout) : {};
      for(const {source} of updates) {
        const previous=versions[source.id];
        if(previous && previous!==source.commit &&
          gitResult(source.cwd,['merge-base','--is-ancestor',previous,source.commit]).status!==0)
          throw new Error(source.name + ' · текущий коммит не продолжает уже отправленную версию.');
        versions[source.id]=source.commit;
      }
      const replacing=path=>updates.some(({source})=>source.prefix
        ? path.startsWith(source.prefix)
        : !/^(assembly-v2|printing|github-delivery)\//.test(path));
      const entries=tree(repository,base).filter(entry=>entry.path!==manifestPath && !replacing(entry.path));
      entries.push(...updates.flatMap(update=>update.entries),{mode:'100644',hash:digest(JSON.stringify(versions,null,2)+'\n'),path:manifestPath});
      const options={env:{GIT_INDEX_FILE:index}};
      git(repository,['read-tree','--empty'],options);
      git(repository,['update-index','-z','--index-info'],{...options,input:entries.map(entry=>entry.mode+' '+entry.hash+'\t'+entry.path+'\0').join('')});
      const next=git(repository,['write-tree'],options).trim();
      const names=sources.map(source=>source.name).join(', ');
      if(next===head(repository,base+'^{tree}')) { console.log(names + ' · GitHub уже актуален ' + base); return; }
      const summary=git(repository,['diff','--shortstat',base+'^{tree}',next]).trim();
      if(dryRun) { console.log(names + ' · ' + summary); return; }
      const commit=git(repository,['-c','user.name=Codex','-c','user.email=codex@users.noreply.github.com',
        'commit-tree',next,'-p',base,'-m','Синхронизация исходников · '+names,
        '-m',sources.map(source=>source.name+' '+source.commit).join('\n')]).trim();
      const pushed=gitResult(repository,['push','origin',commit+':'+branch]);
      const actual=originHead();
      if(actual===commit) { console.log(names + ' · GitHub main ' + commit + ' · ' + summary); return; }
      if(pushed.status!==0 && actual===base) throw new Error('GitHub отклонил отправку в main.');
    }
    throw new Error('Ветка GitHub меняется параллельно. Повторите синхронизацию.');
  } finally {
    if(existsSync(index)) unlinkSync(index);
    rmdirSync(tmp);
  }
}

function install(paths) {
  if(!paths.length) throw new Error('Укажите checkout Sites для установки.');
  const shellQuote=value=>"'"+value.replaceAll('\\','/').replaceAll("'","'\\''")+"'";
  const marker='# RITM public GitHub mirror';
  for(const path of paths) {
    const source=openSource(path);
    if(gitResult(source.cwd,['config','--get','core.hooksPath']).status===0)
      throw new Error(source.name + ' · сохраните существующий core.hooksPath и подключите запуск mirror.mjs вручную.');
    const hook=git(source.cwd,['rev-parse','--path-format=absolute','--git-path','hooks/post-commit']).trim();
    const body=['#!/bin/sh',marker,
      shellQuote(process.execPath)+' '+shellQuote(script)+' sync '+shellQuote(source.cwd),''].join('\n');
    if(existsSync(hook) && !readFileSync(hook,'utf8').includes(marker))
      throw new Error(source.name + ' · существующий post-commit сохранён.');
    mkdirSync(dirname(hook),{recursive:true});
    writeFileSync(hook,body,{mode:0o755});
    console.log(source.name + ' · post-commit подключён');
  }
}

try {
  const [action,...paths]=process.argv.slice(2);
  if(action==='install') install(paths);
  else if(action==='sync' || action==='plan') sync(paths,action==='plan');
  else throw new Error('Использование: node github-delivery/mirror.mjs install|plan|sync <checkout Sites> [...]');
} catch(error) {
  console.error('GitHub RITM · '+error.message);
  process.exitCode=1;
}
