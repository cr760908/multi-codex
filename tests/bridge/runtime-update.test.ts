import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSync} from 'esbuild';
import {runInNewContext} from 'node:vm';
import {createRequire} from 'node:module';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,copyFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {prepareBridge,bundleId} from '../../src/switcher/BridgeInstall';

const compiled=buildSync({entryPoints:['src/switcher/extension.ts'],bundle:true,platform:'node',format:'cjs',external:['vscode'],write:false}).outputFiles[0].text;
const settled=()=>new Promise(resolve=>setImmediate(resolve));
// unchanged: an older release installed the same bridge bytes under its version-named folder.
async function fixture(t:any,custom=false,active=false,unchanged=false){
  const root=mkdtempSync(join(tmpdir(),'codex-runtime-update-'));
  const cli=(version:string)=>join(root,version,'bin','windows-x86_64','codex.exe');
  for(const version of ['official-old','official-new','official-next']){
    mkdirSync(dirname(cli(version)),{recursive:true});writeFileSync(cli(version),'fixture executable');
  }
  let official='official-new';
  let setting='C:\\custom\\codex.exe';
  if(unchanged){
    const legacy=join(root,'bridge','0.3.4');mkdirSync(legacy,{recursive:true});
    for(const name of ['bridge-launcher.exe','bridge.cjs'])copyFileSync(resolve('dist',name),join(legacy,name));
    writeFileSync(join(legacy,'runtime-paths.txt'),`${process.execPath}\n${cli('official-new')}\n`);
    setting=join(legacy,'bridge-launcher.exe');
  }else if(!custom){
    const previous=join(root,'previous-bundle');mkdirSync(previous);
    copyFileSync(resolve('dist','bridge-launcher.exe'),join(previous,'bridge-launcher.exe'));writeFileSync(join(previous,'bridge.cjs'),'// previous bridge');
    setting=prepareBridge(previous,root,process.execPath,cli('official-old'));
  }
  const oldSetting=setting;
  const changes:Function[]=[],executed:string[]=[],notices:string[]=[],updates:string[]=[],errors:string[]=[];
  let confirm:((choice:string)=>void)|undefined;
  const noop=()=>({dispose(){}});
  const vscode={StatusBarAlignment:{Left:1},ConfigurationTarget:{Global:1},env:{},
    workspace:{isTrusted:true,workspaceFolders:[],onDidChangeConfiguration:noop,
      getConfiguration:(section:string)=>({get:(key:string,fallback:unknown)=>section==='chatgpt'&&key==='cliExecutable'?setting:section==='multiCodex.quota'&&key==='enabled'?false:fallback,
        update:async(key:string,value:string)=>{assert.equal(key,'cliExecutable');updates.push(value);setting=value;}})},
    extensions:{getExtension:()=>({extensionPath:join(root,official),isActive:active}),onDidChange:(fn:Function)=>{changes.push(fn);return noop();}},
    commands:{registerCommand:noop,executeCommand:async(id:string)=>{executed.push(id);}},
    window:{state:{focused:true},createOutputChannel:()=>({info(){},dispose(){}}),createStatusBarItem:()=>({show(){},hide(){},dispose(){}}),onDidChangeWindowState:noop,
      showInformationMessage:async(message:string)=>{notices.push(message);return active?new Promise<string>(resolve=>{confirm=resolve;}):undefined;},showErrorMessage:async(message:string)=>{errors.push(message);}}};
  const context={subscriptions:[] as {dispose():void}[],globalStorageUri:{fsPath:root},secrets:{get:async()=>undefined,store:async()=>{}},
    extensionPath:resolve('.'),extension:{packageJSON:{version:'new-switcher'}},globalState:{get:()=>undefined,update:async()=>{}}};
  const module={exports:{} as any},require=createRequire(resolve('package.json'));
  runInNewContext(compiled,{module,exports:module.exports,Buffer,TextDecoder,AbortController,setTimeout,clearTimeout,setInterval,clearInterval,console,
    process:{platform:process.platform,arch:process.arch,pid:process.pid,execPath:process.execPath,env:{CODEX_HOME:root}},require:(name:string)=>name==='vscode'?vscode:require(name)});
  module.exports.activate(context);
  t.after(async()=>{for(const d of context.subscriptions)d.dispose();await module.exports.deactivate();rmSync(root,{recursive:true,force:true});});
  await settled();
  return{root,cli,executed,notices,updates,errors,oldSetting,installed:join(root,'bridge',bundleId(resolve('dist')),'bridge-launcher.exe'),get setting(){return setting;},
    confirm:async()=>{confirm?.('重新載入視窗');await settled();},
    change:async(version:string)=>{official=version;for(const fn of changes)fn();await settled();}};
}

test('activation migrates a managed bridge to the installed bundle and current official CLI without restarting work',async t=>{
  const f=await fixture(t);
  assert.notEqual(f.installed,f.oldSetting);assert.equal(f.setting,f.installed);
  assert.equal(readFileSync(join(dirname(f.setting),'runtime-paths.txt'),'utf8'),`${process.execPath}\n${f.cli('official-new')}\n`);
  assert.deepEqual(f.executed,[]);assert.deepEqual(f.errors,[]);
  assert.equal(f.notices.length,1);
});

test('an upgrade that leaves the bridge bytes unchanged keeps the configured launcher and asks for no reload',async t=>{
  for(const active of [false,true]){
    const f=await fixture(t,false,active,true);
    assert.equal(f.setting,f.oldSetting);
    assert.deepEqual(f.updates,[]);assert.deepEqual(f.notices,[]);assert.deepEqual(f.executed,[]);assert.deepEqual(f.errors,[]);
  }
});

test('official extension changes update runtime paths while preserving the running launcher and avoiding repeated prompts',async t=>{
  const f=await fixture(t);const launcher=f.setting;
  await f.change('official-next');
  assert.equal(f.setting,launcher);
  assert.equal(readFileSync(join(dirname(launcher),'runtime-paths.txt'),'utf8'),`${process.execPath}\n${f.cli('official-next')}\n`);
  const noticeCount=f.notices.length;await f.change('official-next');
  assert.equal(f.notices.length,noticeCount);assert.deepEqual(f.executed,[]);
});

test('activation and extension changes preserve another custom CLI',async t=>{
  const f=await fixture(t,true);await f.change('official-next');
  assert.equal(f.setting,'C:\\custom\\codex.exe');assert.deepEqual(f.updates,[]);assert.deepEqual(f.notices,[]);
});
// Restarting only the extension host while the official webview loads leaves it blank until a window reload.
test('bundle migration defers a live official extension configuration change until the user chooses a window reload',async t=>{
  const f=await fixture(t,false,true);
  assert.equal(f.setting,f.oldSetting);
  assert.deepEqual(f.updates,[]);assert.deepEqual(f.executed,[]);
  await f.change('official-new');assert.equal(f.notices.length,1);
  await f.confirm();
  assert.equal(f.setting,f.installed);
  assert.deepEqual(f.executed,['workbench.action.reloadWindow']);
});
