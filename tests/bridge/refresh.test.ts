import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,readdirSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {JsonRpcClient} from '../../src/protocol/JsonRpcClient';
import {CredentialRefresher} from '../../src/switcher/CredentialRefresh';

const raw=JSON.stringify({tokens:{id_token:`h.${Buffer.from(JSON.stringify({email:'a@example.test'})).toString('base64url')}.s`,access_token:'old-access',refresh_token:'old-refresh',account_id:'a'}});
for(const wrong of [false,true])test(`isolated credential renewal ${wrong?'rejects the wrong account':'returns rotated credentials'} and removes temporary secrets`,async t=>{
  const root=mkdtempSync(join(tmpdir(),'codex-refresh-test-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const refresher=new CredentialRefresher(root,home=>new JsonRpcClient(spawn(process.execPath,[resolve('tests/bridge/refresh-server.cjs')],{cwd:home,env:{...process.env,CODEX_HOME:home,...wrong?{WRONG_ACCOUNT:'1'}:{}},stdio:'pipe',windowsHide:true})));
  if(wrong)await assert.rejects(refresher.refresh(raw));
  else{const result=JSON.parse(await refresher.refresh(raw));assert.equal(result.tokens.refresh_token,'renewed-refresh');assert.equal(result.tokens.access_token,'renewed-access');}
  assert.deepEqual(readdirSync(root),[]);
});
test('a response failure after refresh cannot discard the rotated credential',async t=>{
  const root=mkdtempSync(join(tmpdir(),'codex-refresh-recover-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const refresher=new CredentialRefresher(root,home=>new JsonRpcClient(spawn(process.execPath,[resolve('tests/bridge/refresh-server.cjs')],{cwd:home,env:{...process.env,CODEX_HOME:home,FAIL_AFTER_REFRESH:'1'},stdio:'pipe',windowsHide:true})));
  const result=JSON.parse(await refresher.refresh(raw));assert.equal(result.tokens.refresh_token,'renewed-refresh');
  assert.deepEqual(readdirSync(root),[]);
});
