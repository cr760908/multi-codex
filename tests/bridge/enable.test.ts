import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSync} from 'esbuild';
import {runInNewContext} from 'node:vm';
import {createRequire} from 'node:module';
import {mkdtempSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
const compiled=buildSync({entryPoints:['src/switcher/extension.ts'],bundle:true,platform:'node',format:'cjs',external:['vscode'],write:false}).outputFiles[0].text;
test('enabling seamless switching preserves an existing custom CLI override',async t=>{
  const root=mkdtempSync(join(tmpdir(),'codex-override-test-'));const updates:unknown[]=[],errors:string[]=[],commands=new Map<string,Function>();
  const noop=()=>({dispose(){}});
  const vscode={StatusBarAlignment:{Left:1},env:{},workspace:{isTrusted:true,workspaceFolders:[],onDidChangeConfiguration:noop,
    getConfiguration:(section:string)=>({get:(key:string,fallback:unknown)=>section==='chatgpt'&&key==='cliExecutable'?'C:\\custom\\codex.exe':section==='multiCodex.quota'&&key==='enabled'?false:fallback,update:async(...args:unknown[])=>{updates.push(args);}})},
    extensions:{getExtension:()=>undefined,onDidChange:noop},commands:{registerCommand:(name:string,fn:Function)=>{commands.set(name,fn);return noop();}},
    window:{state:{focused:true},createOutputChannel:()=>({info(){},dispose(){}}),createStatusBarItem:()=>({show(){},dispose(){}}),onDidChangeWindowState:noop,showErrorMessage:async(s:string)=>{errors.push(s);}}};
  const context={subscriptions:[] as {dispose():void}[],globalStorageUri:{fsPath:root},secrets:{get:async()=>undefined,store:async()=>{}}};
  const module={exports:{} as any},require=createRequire(resolve('package.json'));
  runInNewContext(compiled,{module,exports:module.exports,Buffer,TextDecoder,AbortController,setTimeout,clearTimeout,setInterval,clearInterval,console,
    process:{platform:'win32',arch:'x64',env:{CODEX_HOME:root}},require:(name:string)=>name==='vscode'?vscode:require(name)});
  module.exports.activate(context);
  t.after(async()=>{for(const d of context.subscriptions)d.dispose();await module.exports.deactivate();rmSync(root,{recursive:true,force:true});});
  await commands.get('multiCodex.enableSeamlessSwitching')!();
  assert.deepEqual(updates,[]);assert.ok(errors[0].includes('未覆寫'));
});
