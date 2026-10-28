import {build} from 'esbuild';
import {spawn} from 'node:child_process';
import {mkdirSync,writeFileSync,existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
if(!process.argv.includes('--current-access-token'))throw new Error('Explicit current-account probe flag required');
const root=join(process.env.LOCALAPPDATA,'MultiCodex','quota-diagnostic',Date.now().toString());
const harness=join(root,'harness');
mkdirSync(harness,{recursive:true});
writeFileSync(join(harness,'package.json'),JSON.stringify({name:'quota-diagnostic',publisher:'multi-codex-local',version:'0.0.1',engines:{vscode:'^1.100.0'},activationEvents:['onStartupFinished'],main:'./extension.cjs'}));
await build({entryPoints:['scripts/quota-host-diagnostic.ts'],outfile:join(harness,'extension.cjs'),bundle:true,platform:'node',format:'cjs',external:['vscode']});
const receipt=join(root,'receipt.json');
const env={...process.env,MULTICODEX_PROBE_ALLOW:'1',MULTICODEX_PROBE_RECEIPT:receipt,MULTICODEX_PROBE_AUTH_HOME:process.env.CODEX_HOME};
delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(join(process.env.LOCALAPPDATA,'Programs','Microsoft VS Code','Code.exe'),['--new-window','--user-data-dir',join(root,'user'),'--extensions-dir',join(root,'extensions'),'--extensionDevelopmentPath='+harness,'--disable-workspace-trust','--skip-welcome','--disable-gpu'],{env,windowsHide:true,stdio:'ignore'});
const deadline=Date.now()+45000;
while(!existsSync(receipt)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,250));
if(!existsSync(receipt)){child.kill();throw new Error('No diagnostic receipt');}
console.log(readFileSync(receipt,'utf8'));
