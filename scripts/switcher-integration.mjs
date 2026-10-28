import {spawn} from 'node:child_process';
import {mkdirSync, existsSync, readFileSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';

const runId = new Date().toISOString().replace(/[:.]/g, '-');
const root = join(process.env.LOCALAPPDATA, 'MultiCodex', 'switcher-tests', runId);
for (const part of ['workspace', 'home', 'extensions']) mkdirSync(join(root,part), {recursive:true});
mkdirSync(join(root,'user-data','User'),{recursive:true});
writeFileSync(join(root,'user-data','User','settings.json'),JSON.stringify({'multiCodex.quota.enabled':false}));
const receipt = join(root, 'receipt.json');
const code = process.env.MULTICODEX_TEST_CODE || join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe');
const env = {...process.env, CODEX_HOME:join(root,'home'), MULTICODEX_SWITCH_RECEIPT:receipt};
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(code, ['--new-window', '--user-data-dir',join(root,'user-data'), '--extensions-dir',join(root,'extensions'), '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-gpu', '--extensionDevelopmentPath='+resolve('.'), '--extensionTestsPath='+resolve('tests/switcher/host.cjs'), join(root,'workspace')], {env, windowsHide:true, shell:false, stdio:['ignore','pipe','pipe']});
let diagnostic='',spawnError;
for(const stream of [child.stdout,child.stderr])stream.on('data',data=>{diagnostic=(diagnostic+data.toString()).slice(-32768);});
child.on('error', error => {spawnError=error.code||error.name;});
const deadline = Date.now()+60000;
while (!existsSync(receipt) && Date.now()<deadline && !spawnError && (child.exitCode===null||child.exitCode===0)) await new Promise(r=>setTimeout(r,250));
if (!existsSync(receipt)) {child.kill(); throw new Error(`Switcher Extension Host test failed: ${spawnError||'exit='+child.exitCode}; ${diagnostic||'no startup output'}`);}
const report = JSON.parse(readFileSync(receipt,'utf8'));
mkdirSync('docs/validation/evidence', {recursive:true});
const version=JSON.parse(readFileSync('package.json','utf8')).version;
writeFileSync('docs/validation/evidence/switcher-host-'+version+'.json',JSON.stringify({runId,...report},null,2)+'\n');
console.log(JSON.stringify(report));
process.exitCode = report.pass ? 0 : 1;
