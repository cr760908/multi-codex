import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createServer, request, type RequestListener, type ClientRequest} from 'node:http';
import {once} from 'node:events';
import {parseQuota, quotaText, QuotaReader} from '../../src/switcher/Quota';

const raw = JSON.stringify({tokens:{id_token:'h.'+Buffer.from(JSON.stringify({email:'b@example.test'})).toString('base64url')+'.s',access_token:'access-b',refresh_token:'secret-refresh',account_id:'account-b'}});
const apiQuota = {rate_limit:{primary_window:{used_percent:65,limit_window_seconds:18000,reset_at:1900000000},secondary_window:{used_percent:80,limit_window_seconds:604800,reset_at:1900600000}}};
async function fixture(t:TestContext, handler:RequestListener, timeoutMs=10000) {
  const server=createServer(handler);server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
  const urls:string[]=[], requests:ClientRequest[]=[];
  const transport=(url:URL,options:any,callback:any)=>{
    urls.push(String(url));const req=request({hostname:'127.0.0.1',port:(server.address() as any).port,path:url.pathname,...options,agent:false},callback);requests.push(req);return req;
  };
  return {reader:new QuotaReader(transport,timeoutMs),urls,requests};
}

test('API quota windows use seconds and reset_at without inventing absent windows',()=>{
  const q=parseQuota(apiQuota);assert.equal(quotaText(q),'5h 65%／Week 80%');assert.equal(q.windows[0].resetsAt,1900000000);
  assert.equal(quotaText(parseQuota({rate_limit:{primary_window:{used_percent:0,limit_window_seconds:18000}}})),'5h 0%');
  for(const data of [{},{rate_limit:{primary_window:{used_percent:'65'}}},{rate_limit:{primary_window:{used_percent:20,limit_window_seconds:0}}},{rate_limit:{primary_window:{used_percent:20,reset_at:'tomorrow'}}}])assert.throws(()=>parseQuota(data));
});

test('quota reads send one GET with the selected account only and no refresh credential',async t=>{
  let received=false;
  const {reader,urls}=await fixture(t,(req,res)=>{
    assert.equal(req.method,'GET');assert.equal(req.url,'/backend-api/wham/usage');
    assert.equal(req.headers.authorization,'Bearer access-b');assert.equal(req.headers['chatgpt-account-id'],'account-b');
    assert.ok(!JSON.stringify(req.headers).includes('secret-refresh'));received=true;res.end(JSON.stringify(apiQuota));
  });
  assert.equal(quotaText(await reader.read(raw)),'5h 65%／Week 80%');assert.equal(received,true);
  assert.deepEqual(urls,['https://chatgpt.com/backend-api/wham/usage']);
});

test('HTTP failures and redirects never retry, follow Location, or expose response secrets',async t=>{
  for(const status of [302,401,403,429,500]){
    const {reader,urls}=await fixture(t,(_req,res)=>{res.writeHead(status,{Location:'https://example.invalid/secret-refresh'});res.end('secret-refresh access-b');});
    await assert.rejects(reader.read(raw),(e:any)=>{assert.ok(!/secret-refresh|access-b|example.invalid/.test(e.message));assert.match(e.message,status===401||status===403?/登入|驗證/:status===429?/頻繁|稍後/:/無法取得/);return true;});
    assert.equal(urls.length,1);
  }
});

test('malformed, mismatched and oversized API responses fail without leaking their body',async t=>{
  for(const body of ['not JSON secret-refresh',JSON.stringify({account_id:'another',...apiQuota}),JSON.stringify({}), ' '.repeat(1024*1024+1)]){
    const {reader,urls}=await fixture(t,(_req,res)=>res.end(body));
    await assert.rejects(reader.read(raw),(e:any)=>{assert.ok(!/secret-refresh|another/.test(e.message));return true;});
    assert.equal(urls.length,1);
  }
});

test('quota deadline bounds the entire response even when bytes keep arriving',async t=>{
  const {reader,requests}=await fixture(t,(_req,res)=>{res.writeHead(200);const timer=setInterval(()=>res.write(' '),20);res.once('close',()=>clearInterval(timer));},150);
  const started=Date.now();await assert.rejects(reader.read(raw),/逾時/);assert.ok(Date.now()-started<2000);assert.equal(requests[0].destroyed,true);
});

test('cancellation prevents a pre-aborted request and closes an in-flight request',async t=>{
  let accepted!:()=>void;const seen=new Promise<void>(r=>accepted=r);
  const {reader,urls,requests}=await fixture(t,()=>accepted());
  await assert.rejects(reader.read(raw,AbortSignal.abort()));assert.equal(urls.length,0);
  const abort=new AbortController();const result=reader.read(raw,abort.signal);const rejected=assert.rejects(result,/取消/);
  // A bounded wait also lets the old, process-based reader fail without hanging this test.
  await Promise.race([seen,rejected]);abort.abort();await rejected;assert.equal(requests[0].destroyed,true);
});

test('a truncated response fails promptly instead of waiting for the next poll',async t=>{
  let accepted=false;
  const {reader}=await fixture(t,(_req,res)=>{accepted=true;res.writeHead(200,{'Content-Length':'500'});res.write('{');setTimeout(()=>res.destroy(),20);});
  const started=Date.now();await assert.rejects(reader.read(raw),/無法取得/);assert.ok(Date.now()-started<2000);
  assert.equal(accepted,true);
});

test('used quota uses actual window duration, including reversed and missing windows', () => {
  const quota = parseQuota({rateLimits:{primary:{usedPercent:40,windowDurationMins:10080,resetsAt:1900000000},secondary:{usedPercent:20,windowDurationMins:300,resetsAt:1800000000}}});
  assert.equal(quotaText(quota), '5h 20%／Week 40%');
  assert.equal(quota.windows[0].resetsAt,1900000000);
  assert.equal(quotaText(parseQuota({rateLimits:{primary:{usedPercent:100,windowDurationMins:10080,resetsAt:null}}})), 'Week 100%');
});

test('prefers codex bucket and does not invent quota from missing or invalid data', () => {
  assert.equal(quotaText(parseQuota({rateLimits:{primary:{usedPercent:0,windowDurationMins:300}},rateLimitsByLimitId:{codex:{primary:{usedPercent:75,windowDurationMins:300,resetsAt:null}}}})), '5h 75%');
  for (const value of [null, {}, {rateLimits:{primary:{usedPercent:'20',windowDurationMins:300}}}, {rateLimits:{primary:{usedPercent:-1,windowDurationMins:300}}}]) assert.throws(()=>parseQuota(value));
  assert.equal(quotaText(parseQuota({rateLimits:{primary:{usedPercent:110,windowDurationMins:60,resetsAt:null}}})), '1h 110%');
});
