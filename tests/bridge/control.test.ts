import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,connect,type AddressInfo,type Socket} from 'node:net';
import {ControlPeer} from '../../src/bridge/ControlPeer';

async function pair(t:any){
  const server=createServer();server.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
  const accepted=new Promise<Socket>(r=>server.once('connection',r));
  const client=connect((server.address() as AddressInfo).port,'127.0.0.1');const remote=await accepted;
  t.after(()=>{client.destroy();remote.destroy();server.close();});return{client,remote};
}
test('control requests in both directions do not cross-resolve IDs',async t=>{
  const {client,remote}=await pair(t);
  const a=new ControlPeer(client,async(method,value)=>({method,value}));
  const b=new ControlPeer(remote,async(method,value)=>({method,value}));
  assert.deepEqual(await Promise.all([a.request('one',{n:1}),b.request('two',{n:2})]),[{method:'one',value:{n:1}},{method:'two',value:{n:2}}]);
  a.close();b.close();
});
test('control errors expose a stable code, not the handler secret',async t=>{
  const {client,remote}=await pair(t);const a=new ControlPeer(client,async()=>{});
  new ControlPeer(remote,async()=>{throw new Error('secret-value-must-not-leak');});
  await assert.rejects(a.request('switch',{}),e=>{assert.equal((e as Error).message,'control-failed');return true;});a.close();
});
test('closing a control socket rejects outstanding requests',async t=>{
  const {client,remote}=await pair(t);const a=new ControlPeer(client,async()=>{});
  const pending=a.request('waiting',{});remote.destroy();await assert.rejects(pending,/disconnected/);a.close();
});
test('an oversized control frame closes the connection and rejects pending work',async t=>{
  const {client,remote}=await pair(t);const peer=new ControlPeer(client,async()=>{});
  const pending=peer.request('waiting',{});remote.write(Buffer.alloc(1024*1024+1,120));
  await assert.rejects(pending,/disconnected/);assert.equal(peer.closed,true);
});
