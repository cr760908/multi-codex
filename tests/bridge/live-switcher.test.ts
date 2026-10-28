import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {AccountVault} from '../../src/switcher/AccountVault';
import {NativeAuth} from '../../src/switcher/NativeAuth';
import {LiveSwitcher} from '../../src/switcher/LiveSwitcher';
import {BridgeFailure} from '../../src/bridge/Proxy';

function auth(id:string,access='fresh'){
  const encode=(v:unknown)=>Buffer.from(JSON.stringify(v)).toString('base64url');
  return JSON.stringify({tokens:{id_token:`h.${encode({email:id+'@example.test'})}.s`,access_token:`h.${encode({exp:4102444800,tag:access})}.s`,refresh_token:'refresh-'+id,account_id:id}});
}
async function fixture(t:any){
  const home=mkdtempSync(join(tmpdir(),'codex-live-switch-'));t.after(()=>rmSync(home,{recursive:true,force:true}));
  const store=new Map<string,string>();const vault=new AccountVault({get:async k=>store.get(k),store:async(k,v)=>{store.set(k,v);}});
  const native=new NativeAuth(home);writeFileSync(join(home,'auth.json'),auth('a','a'));
  const a=await vault.save(auth('a','a')),b=await vault.save(auth('b','b'));
  const calls:any[]=[];const bridge={ready:async()=>{},switchAccount:async(next:any,previous:any)=>{calls.push({next,previous});return{email:next.email,accountId:next.accountId,pid:1};}};
  const live=new LiveSwitcher(vault,native,bridge,async raw=>raw);
  return{home,vault,native,live,bridge,calls,a,b};
}
test('selecting a saved account updates backend then native file, preserving outgoing credentials',async t=>{
  const f=await fixture(t);await f.live.switchTo(f.b.id);
  assert.equal(JSON.parse(f.native.read()!).tokens.account_id,'b');
  assert.equal(f.calls[0].next.accountId,'b');assert.equal(f.calls[0].previous.accountId,'a');
  assert.equal(await f.vault.auth(f.a.id),auth('a','a'));
});
test('a rejected backend switch leaves the native account unchanged',async t=>{
  const f=await fixture(t);f.bridge.switchAccount=async()=>{throw new BridgeFailure('switch-failed',true);};
  await assert.rejects(f.live.switchTo(f.b.id),/switch-failed/);
  assert.equal(f.native.read(),auth('a','a'));
});
test('concurrent native file changes trigger backend rollback without overwriting the other writer',async t=>{
  const f=await fixture(t);const original=f.bridge.switchAccount;
  f.bridge.switchAccount=async(next,previous)=>{const result=await original(next,previous);if(next.accountId==='b')writeFileSync(join(f.home,'auth.json'),auth('c'));return result;};
  await assert.rejects(f.live.switchTo(f.b.id));
  assert.equal(JSON.parse(readFileSync(join(f.home,'auth.json'),'utf8')).tokens.account_id,'c');
  assert.deepEqual(f.calls.map(c=>c.next.accountId),['b','a']);
});
test('unknown-account renewal cannot change credentials',async t=>{
  const f=await fixture(t);await assert.rejects(f.live.renewActive('b','b@example.test'));
  assert.equal(f.native.read(),auth('a','a'));
});
test('renewal rejects another user sharing the same workspace before touching credentials',async t=>{
  const f=await fixture(t);
  const raw=JSON.parse(auth('a'));
  raw.tokens.id_token=`h.${Buffer.from(JSON.stringify({email:'another@example.test'})).toString('base64url')}.s`;
  const external=JSON.stringify(raw);writeFileSync(join(f.home,'auth.json'),external);
  await assert.rejects(f.live.renewActive('a','a@example.test'),/out-of-sync/);
  assert.equal(f.native.read(),external);
});
