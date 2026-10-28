import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync,unlinkSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {AppServerProxy,BridgeFailure} from './Proxy';
import {ControlPeer} from './ControlPeer';

async function main(){
  const [hostValue,cli,...args]=process.argv.slice(2);
  const hostPid=Number(hostValue);
  if(!Number.isSafeInteger(hostPid)||hostPid<=0||!cli||!existsSync(cli))throw new Error();
  const childEnv={...process.env};delete childEnv.ELECTRON_RUN_AS_NODE;
  const child=spawn(cli,args,{env:childEnv,stdio:'pipe',windowsHide:true});
  child.stderr.pipe(process.stderr);
  if(!args.includes('app-server')){
    process.stdin.pipe(child.stdin);child.stdout.pipe(process.stdout);
    child.on('error',()=>{process.exitCode=1;});child.on('close',code=>{process.exitCode=code??1;});return;
  }
  let controller:ControlPeer|undefined;
  const proxy=new AppServerProxy(child,process.stdin,process.stdout,{refresh:async(accountId,email)=>{
    if(!controller||controller.closed)throw new BridgeFailure('reauthenticate');
    return controller.request('refresh',{accountId,email});
  }});
  const home=resolve(process.env.CODEX_HOME||join(homedir(),'.codex'));
  const folder=join(dirname(process.argv[1]),'connections');mkdirSync(folder,{recursive:true});
  const file=join(folder,`${hostPid}.json`),nonce=randomBytes(32).toString('hex');
  const endpoint=`\\\\.\\pipe\\multi-codex-${hostPid}-${randomUUID()}`;
  const peers=new Set<ControlPeer>();
  const server=createServer(socket=>{
    let authenticated=false;
    const peer=new ControlPeer(socket,async(method,params)=>{
      if(!authenticated){
        const candidate=typeof params?.nonce==='string'?Buffer.from(params.nonce):Buffer.alloc(0);
        const valid=method==='hello'&&candidate.length===64&&timingSafeEqual(candidate,Buffer.from(nonce))&&typeof params?.home==='string'&&resolve(params.home).toLowerCase()===home.toLowerCase();
        if(!valid)throw new BridgeFailure('unauthorized');
        if(controller&&!controller.closed)throw new BridgeFailure('already-connected');
        authenticated=true;controller=peer;return {version:1,pid:child.pid,home};
      }
      if(method==='status')return{ready:proxy.initialized,pid:child.pid};
      if(method==='switch')return proxy.switchAccount(params?.next,params?.previous);
      throw new BridgeFailure('unknown-method');
    });
    peers.add(peer);socket.once('close',()=>{peers.delete(peer);if(controller===peer)controller=undefined;});
    const timer=setTimeout(()=>{if(!authenticated)peer.close();},2000);timer.unref();socket.once('close',()=>clearTimeout(timer));
  });
  try{
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(endpoint,resolve);});
    writeFileSync(file,JSON.stringify({version:1,endpoint,nonce,hostPid,bridgePid:process.pid,home,cli:resolve(cli)}),{mode:0o600});
    await proxy.processClosed;
  }finally{
    for(const peer of peers)peer.close();if(server.listening)server.close();
    await proxy.dispose();
    try{if(JSON.parse(readFileSync(file,'utf8')).nonce===nonce)unlinkSync(file);}catch{}
  }
  process.exitCode=child.exitCode??1;
}
void main().catch(()=>{process.stderr.write('Codex account bridge could not start. Disable seamless switching to restore the bundled runtime.\n');process.exitCode=1;});
