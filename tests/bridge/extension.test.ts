import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSync} from 'esbuild';
import {runInNewContext} from 'node:vm';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,copyFileSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {prepareBridge} from '../../src/switcher/BridgeInstall';
import {AccountVault} from '../../src/switcher/AccountVault';
import {JsonRpcClient} from '../../src/protocol/JsonRpcClient';

const compiled=buildSync({entryPoints:['src/switcher/extension.ts'],bundle:true,platform:'node',format:'cjs',external:['vscode'],write:false}).outputFiles[0].text;
function auth(id:string){const encode=(v:unknown)=>Buffer.from(JSON.stringify(v)).toString('base64url');return JSON.stringify({tokens:{id_token:`h.${encode({email:id+'@example.test'})}.s`,access_token:`h.${encode({exp:4102444800,tag:id})}.s`,refresh_token:'refresh-'+id,account_id:id}});}
test('selecting saved accounts through the extension updates the live backend without a reload command or confirmation dialog',async t=>{
  const root=mkdtempSync(join(tmpdir(),'codex-live-ui-')),home=join(root,'home');mkdirSync(home);
  const official=join(root,'official'),cli=join(official,'bin','windows-x86_64','codex.exe');
  mkdirSync(dirname(cli),{recursive:true});copyFileSync(process.execPath,cli);
  const launcher=prepareBridge(resolve('dist'),root,process.execPath,cli);
  const child=spawn(launcher,[resolve('tests/bridge/server.cjs'),'app-server'],{env:{...process.env,CODEX_HOME:home},stdio:'pipe',windowsHide:true});
  const peer=new JsonRpcClient(child,{timeoutMs:5000});
  const secrets=new Map<string,string>();const secretStore={get:async(k:string)=>secrets.get(k),store:async(k:string,v:string)=>{secrets.set(k,v);}};
  const vault=new AccountVault(secretStore);await vault.save(auth('a'));await vault.save(auth('b'));writeFileSync(join(home,'auth.json'),auth('a'));
  await peer.request('initialize',{clientInfo:{name:'fixture',version:'1'}});peer.notify('initialized');
  await peer.request('account/login/start',{type:'chatgptAuthTokens',accessToken:JSON.parse(auth('a')).tokens.access_token,chatgptAccountId:'a'});
  const commands=new Map<string,Function>(),errors:string[]=[],executed:string[]=[],recoveryActions:string[]=[];let selected='b';
  const noop=()=>({dispose(){}});
  let rowAction:string|undefined,deleteChoice:string|undefined;
  const vscode={StatusBarAlignment:{Left:1},QuickPickItemKind:{Separator:-1},ThemeIcon:class{constructor(readonly id:string){}},env:{},
    workspace:{isTrusted:true,workspaceFolders:[],getConfiguration:(section:string)=>({get:(key:string,fallback:unknown)=>section==='chatgpt'&&key==='cliExecutable'?launcher:section==='multiCodex.quota'&&key==='enabled'?false:fallback}),onDidChangeConfiguration:noop},
    extensions:{getExtension:()=>({extensionPath:official}),onDidChange:noop},
    commands:{registerCommand:(id:string,fn:Function)=>{commands.set(id,fn);return noop();},executeCommand:async(id:string)=>{executed.push(id);throw new Error('unexpected command');}},
    window:{state:{focused:true},createOutputChannel:()=>({info(){},dispose(){}}),createStatusBarItem:()=>({show(){},hide(){},dispose(){}}),onDidChangeWindowState:noop,
      createQuickPick:()=>{
        const callbacks:any={};const on=(key:string)=>(fn:Function)=>{callbacks[key]=fn;return{dispose(){delete callbacks[key];}};};
        const picker:any={items:[],selectedItems:[],onDidAccept:on('accept'),onDidHide:on('hide'),onDidTriggerItemButton:on('button'),
          hide(){callbacks.hide?.();},dispose(){},show(){setTimeout(()=>{const item=picker.items.find((o:any)=>o.account?.accountId===selected);
            if(rowAction)callbacks.button({item,button:item.buttons.find((b:any)=>b.iconPath.id===rowAction)});
            else{picker.selectedItems=[item];callbacks.accept();}},0);}};return picker;
      },
      showQuickPick:async(options:any[])=>options.find(o=>o.account?.accountId===selected),showWarningMessage:async()=>deleteChoice,showInputBox:async()=> 'Renamed account',showInformationMessage:async()=>undefined,showErrorMessage:async(message:string,...actions:string[])=>{errors.push(message);recoveryActions.push(...actions);}},
  };
  const context={subscriptions:[] as {dispose():void}[],globalStorageUri:{fsPath:root},secrets:secretStore,globalState:{get:()=>undefined,update:async()=>{}},extensionPath:resolve('.'),extension:{packageJSON:{version:'test'}}};
  const module={exports:{} as any},require=createRequire(resolve('package.json'));
  runInNewContext(compiled,{module,exports:module.exports,Buffer,TextDecoder,AbortController,setTimeout,clearTimeout,setInterval,clearInterval,console,
    process:{platform:process.platform,arch:process.arch,pid:process.pid,execPath:process.execPath,env:{...process.env,CODEX_HOME:home}},require:(name:string)=>name==='vscode'?vscode:require(name)});
  module.exports.activate(context);
  t.after(async()=>{for(const d of context.subscriptions)d.dispose();await module.exports.deactivate();await peer.dispose();rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  // Only deliberate hidden commands: switchSavedAccount takes an argument, refreshQuotas is diagnostic.
  const contributed=JSON.parse(readFileSync('package.json','utf8')).contributes.commands.map((c:{command:string})=>c.command);
  assert.deepEqual([...commands.keys()].filter(id=>!contributed.includes(id)).sort(),['multiCodex.refreshQuotas','multiCodex.switchSavedAccount']);
  for(selected of ['b','a']){
    await commands.get('multiCodex.accounts')!();
    assert.deepEqual(errors,[]);
    assert.equal(JSON.parse(readFileSync(join(home,'auth.json'),'utf8')).tokens.account_id,selected);
    assert.equal((await peer.request<any>('echo')).account,selected);
  }
  assert.deepEqual(executed,[]);
  selected='b';rowAction='edit';await commands.get('multiCodex.accounts')!();
  assert.equal((await vault.list()).find(a=>a.accountId==='b')?.label,'Renamed account');
  rowAction='trash';deleteChoice=undefined;await commands.get('multiCodex.accounts')!();
  assert.equal((await vault.list()).length,2,'cancelled removal must preserve the vault');
  assert.equal((await peer.request<any>('echo')).account,'a','row actions must not switch the active account');
  deleteChoice='移除';await commands.get('multiCodex.accounts')!();assert.equal((await vault.list()).length,1);
  await vault.save(auth('b'));rowAction=undefined;
  writeFileSync(join(home,'auth.json'),auth('c'));selected='b';
  await commands.get('multiCodex.accounts')!();
  assert.equal(errors.length,1);assert.deepEqual(recoveryActions,['重新載入視窗']);
  assert.deepEqual(executed,[]);
  assert.equal(JSON.parse(readFileSync(join(home,'auth.json'),'utf8')).tokens.account_id,'c');
  assert.equal((await peer.request<any>('echo')).account,'a');
});
