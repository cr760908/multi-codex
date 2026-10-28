import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {PassThrough} from 'node:stream';
import {resolve} from 'node:path';
import {AppServerProxy, type AccessIdentity} from '../../src/bridge/Proxy';

const credential=(id:string):AccessIdentity=>({accessToken:`access-${id}`,accountId:id,email:`${id}@example.test`,plan:'plus'});
const rotated=(id:string,revision:string,user=`user-${id}`):AccessIdentity=>({
  ...credential(id),accessToken:`h.${Buffer.from(JSON.stringify({sub:user,revision,
    'https://api.openai.com/auth':{chatgpt_account_id:id,chatgpt_user_id:user}})).toString('base64url')}.s`,
});
const wait=async(check:()=>boolean)=>{for(const until=Date.now()+3000;!check();await new Promise(r=>setTimeout(r,10)))assert.ok(Date.now()<until,'condition timed out');};
async function fixture(t:any,refresh?:(id:string)=>Promise<AccessIdentity>) {
  const child=spawn(process.execPath,[resolve('tests/bridge/server.cjs')],{stdio:'pipe',windowsHide:true});
  const input=new PassThrough(),output=new PassThrough(),messages:any[]=[];
  let buffer='';output.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\n'))>=0){messages.push(JSON.parse(buffer.slice(0,end)));buffer=buffer.slice(end+1);}});
  const proxy=new AppServerProxy(child,input,output,{timeoutMs:1000,refresh});
  t.after(()=>proxy.dispose());
  const send=(id:string,method:string,params:unknown={})=>input.write(JSON.stringify({id,method,params})+'\n');
  send('client-init','initialize',{clientInfo:{name:'fixture',version:'1'}});
  await wait(()=>messages.some(m=>m.id==='client-init'));
  input.write(JSON.stringify({method:'initialized'})+'\n');
  const respond=(id:string,result:unknown)=>input.write(JSON.stringify({id,result})+'\n');
  return {child,proxy,messages,send,respond};
}

test('saved-account A→B→A updates the same server and forwards real account notifications, without internal responses leaking',async t=>{
  const {child,proxy,messages,send}=await fixture(t);const pid=child.pid;
  const result=await proxy.switchAccount(credential('b'),credential('a'));
  assert.equal(result.email,'b@example.test');
  await proxy.switchAccount(credential('a'),credential('b'));
  send('client-echo','echo',{text:'中文漫畫'});
  await wait(()=>messages.some(m=>m.id==='client-echo'));
  assert.deepEqual(messages.filter(m=>m.id).map(m=>m.id),['client-init','client-echo']);
  assert.equal(messages.find(m=>m.id==='client-echo').result.echo.text,'中文漫畫');
  assert.equal(messages.find(m=>m.id==='client-echo').result.account,'a');
  assert.equal(child.pid,pid);
  assert.equal(messages.filter(m=>m.method==='account/updated').length,2);
});

test('an active turn prevents a saved-account switch',async t=>{
  const {proxy,messages,send}=await fixture(t);
  send('start','turn/start');await wait(()=>messages.some(m=>m.method==='turn/started'));
  await assert.rejects(proxy.switchAccount(credential('b'),credential('a')),/busy/);
  send('check','echo');await wait(()=>messages.some(m=>m.id==='check'));
  assert.equal(messages.find(m=>m.id==='check').result.account,'a');
});

test('a mismatched reported account is rolled back before a failure is returned',async t=>{
  const {proxy,messages,send}=await fixture(t);
  await assert.rejects(proxy.switchAccount({...credential('b'),email:'unexpected@example.test'},credential('a')),error=>{
    assert.equal((error as any).restored,true);return true;
  });
  send('check','echo');await wait(()=>messages.some(m=>m.id==='check'));
  assert.equal(messages.find(m=>m.id==='check').result.account,'a');
});

test('a stale native snapshot cannot overwrite a different running account',async t=>{
  const {proxy,messages,send}=await fixture(t);
  await assert.rejects(proxy.switchAccount(credential('b'),credential('c')),/out-of-sync/);
  send('check','echo');await wait(()=>messages.some(m=>m.id==='check'));
  assert.equal(messages.find(m=>m.id==='check').result.account,'a');
});

test('a turn submitted during an account switch is rejected instead of running under the new account',async t=>{
  const {proxy,messages,send}=await fixture(t);
  const switching=proxy.switchAccount({...credential('b'),accessToken:'delayed'},credential('a'));
  send('racing-turn','turn/start');await switching;
  await wait(()=>messages.some(m=>m.id==='racing-turn'));
  assert.ok(messages.find(m=>m.id==='racing-turn').error);
  assert.equal(messages.filter(m=>m.method==='turn/started').length,0);
});

test('backend token renewal uses the controller and does not leak its request to the official UI',async t=>{
  const fresh={...credential('b'),accessToken:'new-b'};
  const {proxy,messages,send}=await fixture(t,async id=>{assert.equal(id,'b');return fresh;});
  await proxy.switchAccount(credential('b'),credential('a'));
  send('refresh-trigger','trigger-refresh');await wait(()=>messages.some(m=>m.id==='refresh-trigger'));
  assert.equal(messages.find(m=>m.id==='refresh-trigger').result.tokenUpdated,true);
  assert.equal(messages.some(m=>m.method==='account/chatgptAuthTokens/refresh'),false);
  await proxy.switchAccount(credential('a'),fresh);
});

test('server-request responses remain live during switching, avoiding a protocol deadlock',async t=>{
  const {proxy,messages,respond}=await fixture(t);
  const switching=proxy.switchAccount({...credential('b'),accessToken:'needs-client-response'},credential('a'));
  await wait(()=>messages.some(m=>m.id==='server-time'));respond('server-time',{currentTimeAt:1});
  assert.equal((await switching).accountId,'b');
});

test('same user and workspace with an externally rotated token can switch accounts',async t=>{
  const {proxy,messages,send}=await fixture(t);
  const old=rotated('a','old'),fresh=rotated('a','fresh');
  send('seed','account/login/start',{type:'chatgptAuthTokens',accessToken:old.accessToken,chatgptAccountId:'a'});
  await wait(()=>messages.some(m=>m.id==='seed'));
  assert.equal((await proxy.switchAccount(credential('b'),fresh)).accountId,'b');
  send('check','echo');await wait(()=>messages.some(m=>m.id==='check'));
  assert.equal(messages.find(m=>m.id==='check').result.account,'b');
});

test('selecting the current account resynchronizes its rotated token instead of verifying the stale token',async t=>{
  const {proxy,messages,send}=await fixture(t);
  const old=rotated('a','old'),fresh=rotated('a','fresh');
  send('seed','account/login/start',{type:'chatgptAuthTokens',accessToken:old.accessToken,chatgptAccountId:'a'});
  await wait(()=>messages.some(m=>m.id==='seed'));
  await proxy.switchAccount(fresh,fresh);
  send('check','getAuthStatus');await wait(()=>messages.some(m=>m.id==='check'));
  assert.equal(messages.find(m=>m.id==='check').result.authToken,fresh.accessToken);
});

test('a failed switch after rotation restores the current file credential for the same account',async t=>{
  const {proxy,messages,send}=await fixture(t);
  const old=rotated('a','old'),fresh=rotated('a','fresh');
  send('seed','account/login/start',{type:'chatgptAuthTokens',accessToken:old.accessToken,chatgptAccountId:'a'});
  await wait(()=>messages.some(m=>m.id==='seed'));
  await assert.rejects(proxy.switchAccount({...credential('b'),email:'wrong@example.test'},fresh),/switch-failed/);
  send('check','getAuthStatus');await wait(()=>messages.some(m=>m.id==='check'));
  assert.equal(messages.find(m=>m.id==='check').result.authToken,fresh.accessToken);
});

test('token rotation cannot bypass user, workspace, email, or missing-claim checks',async t=>{
  const {proxy,messages,send}=await fixture(t);
  const old=rotated('a','old');
  send('seed','account/login/start',{type:'chatgptAuthTokens',accessToken:old.accessToken,chatgptAccountId:'a'});
  await wait(()=>messages.some(m=>m.id==='seed'));
  for(const unsafe of [rotated('a','fresh','another-user'),{...rotated('c','fresh','user-a'),email:'a@example.test'},
    {...rotated('a','fresh'),email:'someone@example.test'},credential('a')]){
    await assert.rejects(proxy.switchAccount(credential('b'),unsafe),/out-of-sync/);
  }
  assert.equal(messages.filter(m=>m.method==='account/updated').length,1);
});

test('token rotation still waits for an active turn to finish',async t=>{
  const {proxy,messages,send}=await fixture(t);
  const old=rotated('a','old'),fresh=rotated('a','fresh');
  send('seed','account/login/start',{type:'chatgptAuthTokens',accessToken:old.accessToken,chatgptAccountId:'a'});
  await wait(()=>messages.some(m=>m.id==='seed'));
  send('start','turn/start');await wait(()=>messages.some(m=>m.method==='turn/started'));
  await assert.rejects(proxy.switchAccount(credential('b'),fresh),/busy/);
  send('stop','turn/interrupt');await wait(()=>messages.some(m=>m.method==='turn/completed'));
  assert.equal((await proxy.switchAccount(credential('b'),fresh)).accountId,'b');
});
test('backend renewal cannot replace the active user with another user in the same workspace',async t=>{
  const {proxy,messages,send}=await fixture(t,async()=>({...credential('b'),email:'another@example.test'}));
  await proxy.switchAccount(credential('b'),credential('a'));
  send('renew','trigger-refresh');await wait(()=>messages.some(m=>m.id==='renew'));
  assert.equal(messages.find(m=>m.id==='renew').result.tokenUpdated,false);
});
