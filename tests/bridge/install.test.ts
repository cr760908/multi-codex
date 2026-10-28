import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {prepareBridge,isManagedBridge} from '../../src/switcher/BridgeInstall';

test('installing the bridge copies a self-contained launcher bundle and records paths without credentials',t=>{
  const root=mkdtempSync(join(tmpdir(),'codex-bridge-install-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const source=join(root,'source'),storage=join(root,'storage');mkdirSync(source);
  writeFileSync(join(source,'bridge-launcher.exe'),'fixture launcher');writeFileSync(join(source,'bridge.cjs'),'fixture script');
  const path=prepareBridge(source,storage,'1.0.0','C:\\Program Files\\Code\\Code.exe','C:\\Codex & test\\codex.exe');
  assert.equal(readFileSync(path,'utf8'),'fixture launcher');
  assert.equal(readFileSync(join(storage,'bridge','1.0.0','runtime-paths.txt'),'utf8'),'C:\\Program Files\\Code\\Code.exe\nC:\\Codex & test\\codex.exe\n');
  assert.equal(isManagedBridge(path,storage),true);
  assert.equal(isManagedBridge(join(storage,'bridge-malicious','bridge-launcher.exe'),storage),false);
});
test('runtime installation refuses line-breaking paths before writing a config',t=>{
  const root=mkdtempSync(join(tmpdir(),'codex-bridge-install-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  assert.throws(()=>prepareBridge(root,root,'1','C:\\Code\nother.exe','C:\\codex.exe'));
});
