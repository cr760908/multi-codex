import {spawn} from 'node:child_process';
import {mkdirSync,existsSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createRequire} from 'node:module';
const {prepareBridge}=createRequire(import.meta.url)('../src/switcher/BridgeInstall.ts');

const official=process.env.MULTICODEX_OFFICIAL_EXTENSION;
if(!official)throw new Error('MULTICODEX_OFFICIAL_EXTENSION is required');
const version=JSON.parse(readFileSync('package.json','utf8')).version;
const root=join(process.env.LOCALAPPDATA,'MultiCodex','official-ui-tests',new Date().toISOString().replace(/[:.]/g,'-'));
for(const part of ['workspace','home','extensions','user-data/User'])mkdirSync(join(root,part),{recursive:true});
const code=join(process.env.LOCALAPPDATA,'Programs','Microsoft VS Code','Code.exe');
const launcher=prepareBridge(resolve('dist'),join(root,'user-data','User','globalStorage','multi-codex-local.multi-codex'),version,code,join(official,'bin','windows-x86_64','codex.exe'));
writeFileSync(join(root,'home','config.toml'),'cli_auth_credentials_store = "file"\n');
writeFileSync(join(root,'user-data','User','settings.json'),JSON.stringify({'multiCodex.quota.enabled':false,'chatgpt.cliExecutable':launcher,'workbench.startupEditor':'none'}));
const receipt=join(root,'receipt.json');
const env={...process.env,CODEX_HOME:join(root,'home'),MULTICODEX_UI_ROOT:root,MULTICODEX_UI_RECEIPT:receipt};delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(code,['--new-window','--user-data-dir',join(root,'user-data'),'--extensions-dir',join(root,'extensions'),
  '--disable-workspace-trust','--skip-welcome','--skip-release-notes','--disable-gpu',
  '--extensionDevelopmentPath='+resolve('.'),'--extensionDevelopmentPath='+official,
  '--extensionTestsPath='+resolve('tests/switcher/official-host.cjs'),join(root,'workspace')],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
let diagnostic='';for(const stream of [child.stdout,child.stderr])stream.on('data',c=>{diagnostic=(diagnostic+c).slice(-4000);});
const deadline=Date.now()+60000;
while(!existsSync(receipt)&&Date.now()<deadline&&child.exitCode===null)await new Promise(r=>setTimeout(r,250));
if(!existsSync(receipt)){child.kill();throw new Error('Official UI probe failed: '+diagnostic);}
const report=JSON.parse(readFileSync(receipt,'utf8'));
writeFileSync(`docs/validation/evidence/official-ui-${version}.json`,JSON.stringify({root,...report},null,2)+'\n');
console.log(JSON.stringify(report));process.exitCode=report.pass?0:1;
