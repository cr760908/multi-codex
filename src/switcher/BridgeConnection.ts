import {connect} from 'node:net';
import {readFileSync,statSync} from 'node:fs';
import {resolve} from 'node:path';
import {ControlPeer} from '../bridge/ControlPeer';
import {BridgeFailure,type AccessIdentity} from '../bridge/Proxy';
import {bridgeDescriptor} from './BridgeInstall';

export class BridgeConnection {
  private peer:ControlPeer|undefined;
  private connecting:Promise<ControlPeer>|undefined;
  private connectedLauncher:string|undefined;
  private connectedCli:string|undefined;
  constructor(private launcher:()=>string|undefined,private readonly home:string,
    private readonly renew:(accountId:string,email:string)=>Promise<AccessIdentity>,private readonly hostPid=process.pid,
    private readonly expectedCli?:()=>string){}
  private checkRuntime(cli:unknown){
    if(this.expectedCli&&(typeof cli!=='string'||resolve(cli).toLowerCase()!==resolve(this.expectedCli()).toLowerCase()))throw new BridgeFailure('runtime-outdated');
  }
  private async open(){
    const path=this.launcher();if(!path)throw new BridgeFailure('not-enabled');
    if(this.peer&&!this.peer.closed){
      if(this.connectedLauncher===resolve(path).toLowerCase()){this.checkRuntime(this.connectedCli);return this.peer;}
      this.peer.close();
    }
    if(this.connecting)return this.connecting;
    this.connecting=this.create();
    try{return await this.connecting;}finally{this.connecting=undefined;}
  }
  private async create(){
    const path=this.launcher();if(!path)throw new BridgeFailure('not-enabled');
    let descriptor:any;
    try{
      const file=bridgeDescriptor(path,this.hostPid);if(statSync(file).size>4096)throw new Error();
      descriptor=JSON.parse(readFileSync(file,'utf8'));
      if(descriptor.version!==1||descriptor.hostPid!==this.hostPid||typeof descriptor.endpoint!=='string'||
        !/^\\\\\.\\pipe\\multi-codex-\d+-[a-f0-9-]{36}$/.test(descriptor.endpoint)||
        !/^[a-f0-9]{64}$/.test(descriptor.nonce)||typeof descriptor.home!=='string'||resolve(descriptor.home).toLowerCase()!==resolve(this.home).toLowerCase())throw new Error();
    }catch{throw new BridgeFailure('not-ready');}
    this.checkRuntime(descriptor.cli);
    const socket=connect(descriptor.endpoint);
    const peer=new ControlPeer(socket,async(method,params)=>{
      if(method!=='refresh'||typeof params?.accountId!=='string'||typeof params?.email!=='string')throw new BridgeFailure('unknown-method');
      return this.renew(params.accountId,params.email);
    },180000);
    try{
      await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new BridgeFailure('not-ready')),2000);socket.once('connect',()=>{clearTimeout(timer);resolve();});socket.once('error',()=>{clearTimeout(timer);reject(new BridgeFailure('not-ready'));});});
      await peer.request('hello',{nonce:descriptor.nonce,home:this.home});
      const status=await peer.request('status');if(!status.ready)throw new BridgeFailure('not-ready');
      this.connectedLauncher=resolve(path).toLowerCase();this.connectedCli=descriptor.cli;
      this.peer=peer;return peer;
    }catch(error){peer.close();throw error;}
  }
  async switchAccount(next:AccessIdentity,previous?:AccessIdentity){return(await this.open()).request<{email:string;accountId:string;pid:number}>('switch',{next,previous});}
  async ready(){await this.open();}
  dispose(){this.peer?.close();}
}
