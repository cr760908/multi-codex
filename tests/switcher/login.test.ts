import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { IsolatedLogin } from '../../src/switcher/IsolatedLogin';
import { JsonRpcClient } from '../../src/protocol/JsonRpcClient';
import { buildEnvironment } from '../../src/runtime/EnvBuilder';

function fixture(t: test.TestContext, mode: string) {
  const root=mkdtempSync(join(tmpdir(),'codex-login-test-')), audit=join(root,'audit.jsonl');
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const login=new IsolatedLogin(join(root,'homes'), home=>new JsonRpcClient(spawn(process.execPath,[resolve('tests/switcher/login-server.cjs'),mode,audit],{
    cwd:home,env:buildEnvironment({...process.env,OPENAI_API_KEY:'must-not-inherit'},home).env,stdio:'pipe',windowsHide:true,
  })));
  return {login,root,audit};
}

for(const mode of ['normal','early'])test(`isolated ${mode} login captures refreshed auth without logout and cleans its home`,async t=>{
  const f=fixture(t,mode); let opened=0;
  const raw=await f.login.login(async url=>{assert.equal(new URL(url).hostname,'auth.openai.com');opened++;return true;});
  assert.ok(raw);assert.equal(JSON.parse(raw).tokens.access_token,'refreshed');
  const calls=readFileSync(f.audit,'utf8').trim().split('\n').map(line=>JSON.parse(line));
  assert.ok(calls.some(c=>c.method==='account/read'&&c.params.refreshToken===true));
  assert.ok(calls.every(c=>c.home.startsWith(join(f.root,'homes'))&&!c.hasInjectedKey));
  assert.ok(calls.every(c=>!['account/logout','thread/start','turn/start'].includes(c.method)));
  assert.deepEqual(readdirSync(join(f.root,'homes')),[]);
  if(mode==='normal')assert.equal(opened,1);
});

test('cancel during browser login disposes process and returns no credentials',async t=>{
  const f=fixture(t,'wait'), controller=new AbortController();
  const raw=await f.login.login(async()=>{controller.abort();return true;},controller.signal);
  assert.equal(raw,undefined);
  assert.deepEqual(readdirSync(join(f.root,'homes')),[]);
});

test('untrusted OAuth URL is never opened and temporary credentials are cleaned',async t=>{
  const f=fixture(t,'bad-url');
  await assert.rejects(f.login.login(async()=>{assert.fail('must not open URL');}),/登入/);
  assert.deepEqual(readdirSync(join(f.root,'homes')),[]);
});

test('browser launch failure returns no credentials',async t=>{
  const f=fixture(t,'wait');
  await assert.rejects(f.login.login(async()=>false),/瀏覽器/);
  assert.deepEqual(readdirSync(join(f.root,'homes')),[]);
});
