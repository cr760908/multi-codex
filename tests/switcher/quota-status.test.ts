import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';
import {createServer, request} from 'node:http';
import {once} from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const compiled=buildSync({entryPoints:['src/switcher/extension.ts'],bundle:true,platform:'node',format:'cjs',external:['vscode'],write:false}).outputFiles[0].text;
function auth(id:string,renewal='') {return JSON.stringify({tokens:{id_token:`h.${Buffer.from(JSON.stringify({email:`${id}@example.test`})).toString('base64url')}.s`,access_token:`access-${id}${renewal}`,refresh_token:'never-send',account_id:id}});}
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function until(check:()=>boolean,message:string) {
  for (const deadline=Date.now()+5000; !check(); await sleep(20)) if (Date.now()>deadline) assert.fail(message);
}

// One simulated machine: a shared Codex home, SecretStorage and extension global storage,
// with a controllable clock. Each openWindow() call is a separate VS Code window.
async function machine(t:TestContext) {
  const root=mkdtempSync(join(tmpdir(),'codex-quota-status-'));
  const home=join(root,'home'), storage=join(root,'storage');
  mkdirSync(home);
  const secrets=new Map<string,string>();
  const requests:{done:boolean}[]=[];
  let spawnCount=0;
  const logs:string[]=[];
  // Settings under multiCodex.quota, changeable mid-test; HTTP latency and dispatch hook.
  const config:Record<string,unknown>={};
  const helper={delayMs:0,fail:false,onRequest:undefined as undefined|(()=>void)};
  const server=createServer((req,res)=>{
    const id=String(req.headers['chatgpt-account-id']);
    assert.equal(req.method,'GET');assert.equal(req.url,'/backend-api/wham/usage');
    assert.ok(!JSON.stringify(req.headers).includes('never-send'));
    const timer=setTimeout(()=>{
      if(id==='broken'||helper.fail){res.writeHead(401);res.end('{}');return;}
      res.end(JSON.stringify({rate_limit:{primary_window:{used_percent:id==='a'?20:65,limit_window_seconds:18000,reset_at:1900000000},secondary_window:{used_percent:id==='a'?40:80,limit_window_seconds:604800,reset_at:1900600000}}}));
    },helper.delayMs);
    res.once('close',()=>clearTimeout(timer));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const clock={now:1_000_000};
  class FakeDate extends Date {static now() {return clock.now;}}
  const cleanups:(()=>Promise<void>)[]=[];
  t.after(async()=>{for (const cleanup of cleanups) await cleanup();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));rmSync(root,{recursive:true,force:true});assert.equal(spawnCount,0,'quota refresh must never start a child process');});
  function openWindow() {
    const commands=new Map<string,()=>Promise<unknown>>();
    const statuses:any[]=[];
    const state={focused:true};
    let tick=()=>{};
    const noop=()=>({dispose(){}});
    const vscode={
      StatusBarAlignment:{Left:1}, env:{},
      workspace:{isTrusted:true,workspaceFolders:[],getConfiguration:()=>({get:(k:string,fallback:unknown)=>k in config?config[k]:fallback}),onDidChangeConfiguration:noop},
      window:{
        state,
        createOutputChannel:()=>({info:(line:string)=>{logs.push(line);},dispose(){}}),
        createStatusBarItem:()=>{const item={text:'',tooltip:'',visible:false,disposed:false,show(){this.visible=true;},hide(){this.visible=false;},dispose(){this.disposed=true;this.visible=false;}};statuses.push(item);return item;},
        onDidChangeWindowState:noop,showInformationMessage:async()=>undefined,showErrorMessage:async()=>undefined,
      },
      extensions:{getExtension:()=>undefined,onDidChange:noop},
      commands:{registerCommand:(name:string,fn:()=>Promise<unknown>)=>{commands.set(name,fn);return noop();}},
    };
    const context={subscriptions:[] as {dispose():void}[],globalStorageUri:{fsPath:storage},secrets:{get:async(k:string)=>secrets.get(k),store:async(k:string,v:string)=>{secrets.set(k,v);}}};
    const module={exports:{} as any};
    const require=createRequire(resolve('package.json'));
    runInNewContext(compiled,{module,exports:module.exports,Buffer,TextDecoder,AbortController,URL,setTimeout,clearTimeout,console,Date:FakeDate,
      setInterval:(fn:()=>void)=>{tick=fn;return {unref(){}};},clearInterval:()=>{},
      process:{platform:'win32',arch:'x64',env:{...process.env,CODEX_HOME:home}},
      require:(name:string)=>name==='vscode'?vscode:name==='node:child_process'?{spawn:()=>{spawnCount++;throw new Error('quota subprocess forbidden');}}:name==='node:https'?{request:(url:URL,options:any,callback:any)=>{
        assert.equal(String(url),'https://chatgpt.com/backend-api/wham/usage');
        const entry={done:false};requests.push(entry);
        const req=request({hostname:'127.0.0.1',port:(server.address() as any).port,path:url.pathname,...options,agent:false},(res)=>{res.once('end',()=>{entry.done=true;});res.once('close',()=>{entry.done=true;});callback(res);});
        helper.onRequest?.();return req;
      }}:require(name),
    });
    cleanups.push(async()=>{for (const d of context.subscriptions) d.dispose(); await module.exports.deactivate();});
    const api=module.exports.activate(context);
    return {api,commands,state,tick:()=>tick(),visible:()=>statuses.filter(s=>s.visible&&!s.disposed)};
  }
  return {home,requests,logs,config,helper,clock,openWindow};
}

test('status displays both account quotas, marks current, and recovers from per-account failure without auth changes', async t => {
  const {home,openWindow}=await machine(t);
  const a=auth('a'), b=auth('b');
  const {api,commands,visible}=openWindow();
  await commands.get('multiCodex.refreshQuotas')!();
  writeFileSync(join(home,'auth.json'),a);
  await commands.get('multiCodex.saveAccount')!();
  await commands.get('multiCodex.refreshQuotas')!();
  writeFileSync(join(home,'auth.json'),b);
  await commands.get('multiCodex.saveAccount')!();
  await commands.get('multiCodex.refreshQuotas')!();
  assert.ok(visible().some(s=>s.text==='A：5h 20%／Week 40%'),JSON.stringify(visible()));
  assert.ok(visible().some(s=>s.text==='● B：5h 65%／Week 80%'),JSON.stringify(visible()));
  assert.ok(visible().some(s=>s.tooltip.includes('Week 重置：')));
  assert.equal(readFileSync(join(home,'auth.json'),'utf8'),b);
  assert.equal((await api.savedAccounts()).length,2);

  writeFileSync(join(home,'auth.json'),auth('broken'));
  await commands.get('multiCodex.refreshQuotas')!();
  assert.ok(visible().some(s=>s.text==='● C：無法取得'));
  assert.ok(visible().some(s=>s.text==='A：5h 20%／Week 40%'));
  writeFileSync(join(home,'auth.json'),b);
  await commands.get('multiCodex.refreshQuotas')!();
  assert.ok(!visible().some(s=>s.text.includes('C：')));
  assert.ok(visible().some(s=>s.text==='● B：5h 65%／Week 80%'));
  for (const unsupported of ['{',JSON.stringify({OPENAI_API_KEY:'synthetic-key'})]) {
    writeFileSync(join(home,'auth.json'),unsupported);
    await commands.get('multiCodex.refreshQuotas')!();
    assert.ok(visible().some(s=>s.text==='A：5h 20%／Week 40%'));
    assert.ok(visible().some(s=>s.text==='B：5h 65%／Week 80%'));
    assert.equal(readFileSync(join(home,'auth.json'),'utf8'),unsupported);
  }
});

test('automatic quota refresh uses five-second startup and one/three-minute focus intervals without manual refresh', async t => {
  const {home,requests,logs,clock,openWindow}=await machine(t);
  const one=openWindow();
  writeFileSync(join(home,'auth.json'),auth('a'));
  await one.commands.get('multiCodex.saveAccount')!();
  writeFileSync(join(home,'auth.json'),auth('b'));
  await one.commands.get('multiCodex.saveAccount')!();
  await sleep(300);
  assert.equal(requests.length,0,'no HTTP request may start during the startup delay');

  clock.now+=4999;one.tick();await sleep(80);assert.equal(requests.length,0);
  clock.now+=1;one.tick();
  await until(()=>requests.length===2&&requests.every(r=>r.done),'startup query did not run at five seconds');
  assert.ok(requests.every(r=>r.done));
  assert.equal(logs.length,0,'quota transport must not log credentials or response bodies');

  // A second window (or the window reloaded by an account switch) reuses the shared result.
  const two=openWindow();
  await until(()=>two.visible().some(s=>s.text==='A：5h 20%／Week 40%'),'second window did not show cached quota');
  clock.now+=59000;
  one.tick(); two.tick();
  await sleep(300);
  assert.equal(requests.length,2,'results younger than the interval must not be queried again');

  clock.now+=1000;one.tick();
  await until(()=>requests.length===4&&requests.every(r=>r.done),'foreground refresh did not run after one minute');
  one.state.focused=false; two.state.focused=false;
  clock.now+=179000;
  one.tick(); two.tick();
  await sleep(300);
  assert.equal(requests.length,4,'background refresh ran before three minutes');
  clock.now+=1000;one.tick();two.tick();
  await until(()=>requests.length>=6&&requests.every(c=>c.done),'background refresh did not run after three minutes');
  assert.equal(requests.length,6,'simultaneous background windows queried the same accounts twice');
  assert.ok(requests.every(r=>r.done));
  two.state.focused=true;
  two.tick();
  await sleep(300);
  assert.equal(requests.length,6,'another window must reuse the fresh shared result');
});

test('turning quota off during a pass stops before the next HTTP request starts', async t => {
  const {home,requests,config,helper,openWindow}=await machine(t);
  const one=openWindow();
  writeFileSync(join(home,'auth.json'),auth('a'));
  await one.commands.get('multiCodex.saveAccount')!();
  writeFileSync(join(home,'auth.json'),auth('b'));
  await one.commands.get('multiCodex.saveAccount')!();
  helper.onRequest=()=>{config.enabled=false;};
  await one.commands.get('multiCodex.refreshQuotas')!();
  assert.equal(requests.length,1,'a HTTP request started after quota was turned off');
  assert.ok(!one.visible().some(s=>s.text.includes('：')),JSON.stringify(one.visible()));
});

test('other windows adopt the final result of a query they saw start, including its backoff', async t => {
  const {home,requests,clock,helper,config,openWindow}=await machine(t);
  config.refreshIntervalMinutes=10;config.backgroundRefreshIntervalMinutes=10;
  writeFileSync(join(home,'auth.json'),auth('broken'));
  const one=openWindow(), two=openWindow();
  two.state.focused=false;
  helper.delayMs=400;
  // Window two looks while one's HTTP request runs, so it first sees only the claim.
  helper.onRequest=()=>{setTimeout(()=>two.tick(),100);};
  clock.now+=31000;
  one.tick();
  await until(()=>requests.length===1&&requests[0].done&&one.visible().some(s=>s.text==='● A：無法取得'),'first query did not finish');
  two.tick();
  await until(()=>two.visible().some(s=>s.text==='● A：無法取得'),'second window kept the claim instead of the result');

  clock.now+=10*60000;
  one.tick();
  await until(()=>requests.length===2&&requests[1].done,'second query did not run');
  await until(()=>one.visible().some(s=>s.tooltip.includes('連續失敗 2 次')),'first window did not record two failures');
  helper.onRequest=undefined;
  // Two failures in a row: the next automatic query waits 20 minutes in every window.
  one.state.focused=false; two.state.focused=true;
  clock.now+=10*60000+1000;
  two.tick();
  await sleep(300);
  assert.equal(requests.length,2,'second window ignored the backoff');
  clock.now+=10*60000;
  two.tick();
  await until(()=>requests.length===3,'backoff never expired');
});

test('changed credentials retry at once even after a reload during backoff', async t => {
  const {home,requests,clock,openWindow}=await machine(t);
  writeFileSync(join(home,'auth.json'),auth('broken'));
  const one=openWindow();
  clock.now+=31000;
  one.tick();
  await until(()=>requests.length===1&&one.visible().some(s=>s.text==='● A：無法取得'),'query did not fail');
  // Reload: a new extension host without the previous window's memory.
  one.state.focused=false;
  const reloaded=openWindow();
  await until(()=>reloaded.visible().some(s=>s.text==='● A：無法取得'),'reloaded window did not show the cached failure');
  writeFileSync(join(home,'auth.json'),auth('broken','-renewed'));
  clock.now+=31000;
  reloaded.tick();
  await until(()=>requests.length===2,'renewed credentials waited for the backoff');
  const cache=readFileSync(join(home,'..','storage','quota-cache.json'),'utf8');
  assert.ok(!/access-|never-send|renewed/.test(cache),cache);
});

test('a failed refresh keeps last successful values visibly stale with their original time',async t=>{
  const {home,helper,openWindow}=await machine(t);writeFileSync(join(home,'auth.json'),auth('a'));
  const one=openWindow();await one.commands.get('multiCodex.refreshQuotas')!();
  const before=one.visible().find(s=>s.text==='● A：5h 20%／Week 40%');assert.ok(before);
  const stamp=before.tooltip.match(/最後成功更新：[^\n]+/)[0];helper.fail=true;
  await one.commands.get('multiCodex.refreshQuotas')!();
  const stale=one.visible().find(s=>s.text.includes('5h 20%／Week 40%')&&s.text.includes('上次'));assert.ok(stale);
  assert.ok(stale.tooltip.includes(stamp));assert.match(stale.tooltip,/更新失敗/);
  helper.fail=false;await one.commands.get('multiCodex.refreshQuotas')!();
  assert.ok(one.visible().some(s=>s.text==='● A：5h 20%／Week 40%'));
});
