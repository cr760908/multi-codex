// Explicit, read-only live-account probe: access token only; no model calls or token renewal.
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync,realpathSync,rmSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {tmpdir,homedir} from 'node:os';
import assert from 'node:assert/strict';
import {prepareBridge} from '../src/switcher/BridgeInstall';
import {BridgeConnection} from '../src/switcher/BridgeConnection';
import {accessIdentity} from '../src/switcher/LiveSwitcher';
import {JsonRpcClient} from '../src/protocol/JsonRpcClient';
import {buildEnvironment} from '../src/runtime/EnvBuilder';

async function main(){
  if(!process.argv.includes('--current-access-token'))throw new Error('Explicit --current-access-token required');
  const official=process.env.MULTICODEX_OFFICIAL_EXTENSION;if(!official)throw new Error('Set MULTICODEX_OFFICIAL_EXTENSION');
  const file=join(process.env.CODEX_HOME||join(homedir(),'.codex'),'auth.json');
  const original=readFileSync(file,'utf8'),identity=accessIdentity(original);
  const version=JSON.parse(readFileSync('package.json','utf8')).version;
  const tempRoot=realpathSync(tmpdir()),root=mkdtempSync(join(tempRoot,'multi-codex-live-bridge-')),home=join(root,'home');mkdirSync(home);
  writeFileSync(join(home,'config.toml'),'model_provider = "openai"\ncli_auth_credentials_store = "file"\n');
  const code=process.env.MULTICODEX_TEST_CODE||join(process.env.LOCALAPPDATA!,'Programs','Microsoft VS Code','Code.exe');
  const cli=join(official,'bin','windows-x86_64','codex.exe');
  const launcher=prepareBridge(resolve('dist'),root,code,cli);
  const child=spawn(launcher,['app-server'],{cwd:home,env:buildEnvironment(process.env,home).env,stdio:'pipe',windowsHide:true});
  const peer=new JsonRpcClient(child,{timeoutMs:20000});
  const bridge=new BridgeConnection(()=>launcher,home,async()=>{throw new Error('Renewal is excluded from this probe');},process.pid,()=>cli);
  const notifications:string[]=[];peer.on('notification',m=>{notifications.push(m.method!);});
  try{
    await peer.request('initialize',{clientInfo:{name:'multi_codex_bridge_validation',version},capabilities:{experimentalApi:true}});peer.notify('initialized');
    const switched=await bridge.switchAccount(identity);
    const account=await peer.request<any>('account/read',{refreshToken:false});
    const again=await bridge.switchAccount(identity,identity);
    assert.equal(account.account?.email?.toLowerCase(),identity.email);assert.equal(switched.pid,again.pid);
    assert.ok(notifications.includes('account/login/completed'));assert.ok(notifications.includes('account/updated'));
    assert.equal(readFileSync(file,'utf8'),original);assert.equal(existsSync(join(home,'auth.json')),false);
    const report={pass:true,checkedAt:new Date().toISOString(),extensionVersion:version,officialVersion:JSON.parse(readFileSync(join(official,'package.json'),'utf8')).version,
      realAccountMatched:true,backendPidUnchanged:true,accountUpdateForwarded:true,originalAuthUnchanged:true,refreshTokenProvided:false,modelRequests:0,
      limitations:['One real account only; A-to-B-to-A uses synthetic fixtures','Official webview rendering and natural token expiry are not verified by this probe']};
    mkdirSync('docs/validation/evidence',{recursive:true});writeFileSync(`docs/validation/evidence/live-bridge-${version}.json`,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
  }finally{
    bridge.dispose();await peer.dispose();
    const target=realpathSync(root);assert.equal(dirname(target).toLowerCase(),tempRoot.toLowerCase());
    assert.ok(target.toLowerCase().startsWith(join(tempRoot,'multi-codex-live-bridge-').toLowerCase()));rmSync(target,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
}
void main().catch(error=>{console.error(error instanceof Error?error.name:'Probe failed');process.exitCode=1;});
