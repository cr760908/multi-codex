import { test,type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { JsonRpcClient,type RpcOptions,type RpcMessage } from '../../src/protocol/JsonRpcClient';
function fixture(t:TestContext,options:RpcOptions={}){
  const child=spawn(process.execPath,[resolve('tests/protocol/server.mjs')],{stdio:'pipe',windowsHide:true,shell:false});
  const rpc=new JsonRpcClient(child,options);t.after(()=>rpc.dispose());return rpc;
}
test('UTF-8 chunk framing and bundled lines preserve notification order',async t=>{
  const rpc=fixture(t);assert.equal(await rpc.request('utf8'),'中文🙂');
  const events:unknown[]=[];rpc.on('notification',(m:RpcMessage)=>events.push(m.params));
  assert.equal(await rpc.request('batch'),'done');assert.deepEqual(events,[1,2]);
});
test('interleaved bidirectional IDs and unknown request responses',async t=>{
  const rpc=fixture(t,{handleRequest:async m=>m.method==='approval'?{decision:'decline'}:undefined});
  assert.deepEqual(await rpc.request('interleave'),{decision:'decline'});
  assert.deepEqual(await rpc.request('unknown'),{code:-32601,message:'Method not found'});
});
test('late response after timeout cannot complete a different request',async t=>{
  const rpc=fixture(t);await assert.rejects(rpc.request('late',{},30),/timeout/);
  assert.equal(await rpc.request('slow',{},2000),'slow');assert.equal(rpc.pendingCount,0);
});
test('close rejects outstanding work; dispose awaits actual child exit',async t=>{
  const rpc=fixture(t);const a=rpc.request('hang'),b=rpc.request('exit');
  await Promise.all([assert.rejects(a,/closed/),assert.rejects(b,/closed/)]);
  await rpc.dispose();assert.equal(rpc.pendingCount,0);assert.ok(rpc.child.exitCode!==null);
  await assert.rejects(rpc.request('batch'),/closed/);
});
test('dispose closes stdin so a cooperative child exits by itself instead of being terminated',async t=>{
  const rpc=fixture(t);assert.equal(await rpc.request('batch'),'done');
  await rpc.dispose();
  assert.equal(rpc.child.killed,false);assert.equal(rpc.child.exitCode,0);
});
test('a child that ignores EOF is force-killed only after the shutdown grace period',async t=>{
  const rpc=fixture(t,{shutdownGraceMs:300});assert.equal(await rpc.request('ignore-eof'),'ignoring');
  const started=Date.now();await rpc.dispose();
  assert.equal(rpc.child.killed,true);assert.ok(Date.now()-started>=250,'killed before the grace period');
});
test('stderr flooding stays independent of control response',async t=>{
  const rpc=fixture(t);assert.equal(await rpc.request('stderr',{},5000),'drained');assert.ok(rpc.stderrBytes>=4*1024*1024);
});
test('malformed and oversized inbound frames fail closed',async t=>{
  await assert.rejects(fixture(t).request('malformed'),/JSON/);
  await assert.rejects(fixture(t,{maxFrameBytes:1024}).request('oversize'),/frame/);
});
test('bounded outbound requests do not write a rejected payload',async t=>{
  const rpc=fixture(t,{maxFrameBytes:128});await assert.rejects(rpc.request('echo',{text:'x'.repeat(256)}),/frame/);
  assert.equal(rpc.pendingCount,0);assert.equal(await rpc.request('batch'),'done');
});
