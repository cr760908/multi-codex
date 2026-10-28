import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,cpSync} from 'node:fs';
import {basename,dirname,join} from 'node:path';
import {tmpdir} from 'node:os';
import {prepareBridge,isManagedBridge,bundleId} from '../../src/switcher/BridgeInstall';

function fixture(t:any){
  const root=mkdtempSync(join(tmpdir(),'codex-bridge-install-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const source=join(root,'source'),storage=join(root,'storage');mkdirSync(source);
  writeFileSync(join(source,'bridge-launcher.exe'),'fixture launcher');writeFileSync(join(source,'bridge.cjs'),'fixture script');
  return {root,source,storage};
}

test('installing the bridge copies a self-contained launcher bundle and records paths without credentials',t=>{
  const {source,storage}=fixture(t);
  const path=prepareBridge(source,storage,'C:\\Program Files\\Code\\Code.exe','C:\\Codex & test\\codex.exe');
  assert.equal(readFileSync(path,'utf8'),'fixture launcher');
  assert.equal(path,join(storage,'bridge',bundleId(source),'bridge-launcher.exe'));
  assert.match(basename(dirname(path)),/^[0-9a-f]{16}$/);
  assert.equal(readFileSync(join(dirname(path),'runtime-paths.txt'),'utf8'),'C:\\Program Files\\Code\\Code.exe\nC:\\Codex & test\\codex.exe\n');
  assert.equal(isManagedBridge(path,storage),true);
  assert.equal(isManagedBridge(join(storage,'bridge-malicious','bridge-launcher.exe'),storage),false);
});
test('bundle folders follow content, so only a changed bridge moves the launcher path',t=>{
  const {root,source,storage}=fixture(t);
  const copy=join(root,'copy');cpSync(source,copy,{recursive:true});
  const first=prepareBridge(source,storage,'C:\\Code.exe','C:\\codex.exe');
  assert.equal(prepareBridge(copy,storage,'C:\\Code.exe','C:\\codex.exe'),first);
  writeFileSync(join(copy,'bridge.cjs'),'changed script');
  const changed=prepareBridge(copy,storage,'C:\\Code.exe','C:\\codex.exe',first);
  assert.notEqual(changed,first);
  assert.equal(readFileSync(join(dirname(changed),'bridge.cjs'),'utf8'),'changed script');
  assert.equal(readFileSync(join(dirname(first),'bridge.cjs'),'utf8'),'fixture script','a running bundle must stay intact');
});
test('a configured bundle with identical bytes is reused, including a folder named by an older release',t=>{
  const {source,storage}=fixture(t);
  const legacy=join(storage,'bridge','0.3.4');cpSync(source,legacy,{recursive:true});
  writeFileSync(join(legacy,'runtime-paths.txt'),'C:\\Code.exe\nC:\\old\\codex.exe\n');
  const current=join(legacy,'bridge-launcher.exe');
  assert.equal(prepareBridge(source,storage,'C:\\Code.exe','C:\\new\\codex.exe',current),current);
  assert.equal(readFileSync(join(legacy,'runtime-paths.txt'),'utf8'),'C:\\Code.exe\nC:\\new\\codex.exe\n');
  writeFileSync(join(legacy,'bridge.cjs'),'older script');
  assert.notEqual(prepareBridge(source,storage,'C:\\Code.exe','C:\\new\\codex.exe',current),current);
});
test('a launcher outside managed storage is never reused',t=>{
  const {root,source,storage}=fixture(t);
  const outside=join(root,'outside');cpSync(source,outside,{recursive:true});
  const current=join(outside,'bridge-launcher.exe');
  assert.equal(prepareBridge(source,storage,'C:\\Code.exe','C:\\codex.exe',current),join(storage,'bridge',bundleId(source),'bridge-launcher.exe'));
});
test('runtime installation refuses line-breaking paths before writing a config',t=>{
  const {root}=fixture(t);
  assert.throws(()=>prepareBridge(root,root,'C:\\Code\nother.exe','C:\\codex.exe'));
});
