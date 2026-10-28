import {randomUUID} from 'node:crypto';
import type {Socket} from 'node:net';
import {BridgeFailure,frames} from './Proxy';

export class ControlPeer {
  private pending=new Map<string,{resolve:(value:any)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  private active=0;
  closed=false;
  constructor(readonly socket:Socket,private handler:(method:string,params:any)=>Promise<unknown>,private timeoutMs=30000){
    frames(socket,1024*1024,m=>{
      if(typeof m.id!=='string'){this.close();return;}
      if(typeof m.method==='string'){void this.receive(m);return;}
      const pending=this.pending.get(m.id);if(!pending)return;
      this.pending.delete(m.id);clearTimeout(pending.timer);
      if(m.error)pending.reject(new BridgeFailure(typeof m.error.code==='string'?m.error.code:'control-failed',m.error.restored===true));
      else pending.resolve(m.result);
    },()=>this.close());
    socket.on('error',()=>this.close());socket.on('close',()=>this.close());socket.on('end',()=>this.close());
  }
  private send(message:unknown){
    const data=JSON.stringify(message)+'\n';
    if(this.closed||Buffer.byteLength(data)>1024*1024||this.socket.writableLength>2*1024*1024)throw new BridgeFailure('disconnected',false);
    this.socket.write(data);
  }
  request<T=any>(method:string,params:unknown={}):Promise<T>{
    if(this.closed||this.pending.size>=16)return Promise.reject(new BridgeFailure('disconnected',false));
    const id=randomUUID();
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new BridgeFailure('timeout',false));},this.timeoutMs);
      this.pending.set(id,{resolve,reject,timer});
      try{this.send({id,method,params});}catch(error){clearTimeout(timer);this.pending.delete(id);reject(error);}
    });
  }
  private async receive(message:any){
    if(++this.active>16){this.close();return;}
    try{const result=await this.handler(message.method,message.params);if(!this.closed)this.send({id:message.id,result:result??null});}
    catch(error){if(!this.closed){try{this.send({id:message.id,error:{code:error instanceof BridgeFailure?error.code:'control-failed',restored:error instanceof BridgeFailure&&error.restored}});}catch{this.close();}}}
    finally{this.active--;}
  }
  close(){
    if(this.closed)return;this.closed=true;this.socket.destroy();
    for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new BridgeFailure('disconnected',false));}this.pending.clear();
  }
}
