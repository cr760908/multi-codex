import {build} from 'esbuild';
import {spawn} from 'node:child_process';
import {mkdirSync,writeFileSync,existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
const root=join(process.env.LOCALAPPDATA,'MultiCodex','reload-probe',new Date().toISOString().replace(/[:.]/g,'-'));
const harness=join(root,'harness');
for(const dir of ['harness','home','workspace','extensions'])mkdirSync(join(root,dir),{recursive:true});
writeFileSync(join(harness,'package.json'),JSON.stringify({name:'switch-reload-probe',publisher:'multi-codex-local',version:'0.0.1',engines:{vscode:'^1.100.0'},activationEvents:['onStartupFinished'],main:'./extension.cjs'}));
await build({entryPoints:['tests/switcher/reload-probe.ts'],outfile:join(harness,'extension.cjs'),bundle:true,platform:'node',format:'cjs',target:'node20',external:['vscode']});
const env={...process.env,CODEX_HOME:join(root,'home')}; delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(process.env.MULTICODEX_TEST_CODE || join(process.env.LOCALAPPDATA,'Programs','Microsoft VS Code','Code.exe'),['--new-window','--user-data-dir',join(root,'user-data'),'--extensions-dir',join(root,'extensions'),'--extensionDevelopmentPath='+harness,'--disable-workspace-trust','--skip-welcome','--skip-release-notes','--disable-gpu',join(root,'workspace')],{env,windowsHide:true,stdio:'ignore'});
const receipt=join(root,'home','reload-receipt.json'),deadline=Date.now()+45000;
while(!existsSync(receipt)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,250));
if(!existsSync(receipt)){child.kill();throw new Error('Reload probe timed out');}
const report=JSON.parse(readFileSync(receipt,'utf8'));
console.log(JSON.stringify(report));
writeFileSync('docs/validation/evidence/switcher-reload-probe.json',JSON.stringify(report,null,2)+'\n');
if(!report.pass)process.exitCode=1;
