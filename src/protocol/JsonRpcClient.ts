import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
export type RpcId=number|string;
export interface RpcMessage { id?:RpcId; method?:string; params?:unknown; result?:unknown; error?:{code?:number;message?:string;data?:unknown} }
export interface RpcOptions {
  maxFrameBytes?:number;timeoutMs?:number;maxPending?:number;maxQueuedBytes?:number;shutdownGraceMs?:number;
  handleRequest?:(message:RpcMessage)=>Promise<unknown>|unknown;
  log?:(direction:'in'|'out',message:RpcMessage)=>void;
}
export class RpcError extends Error {
  constructor(public readonly code:number,public readonly data?:unknown){super(`RPC error (${code})`);this.name='RpcError';}
}
interface Pending {resolve:(value:unknown)=>void;reject:(error:unknown)=>void;timer:ReturnType<typeof setTimeout>}
export class JsonRpcClient extends EventEmitter {
  private pending=new Map<number,Pending>();private sequence=0;private buffer:Buffer=Buffer.alloc(0);private closed=false;
  readonly processClosed:Promise<void>;stderrBytes=0;
  readonly maxFrameBytes:number;readonly timeoutMs:number;readonly shutdownGraceMs:number;
  constructor(readonly child:ChildProcessWithoutNullStreams,private readonly options:RpcOptions={}) {
    super();this.maxFrameBytes=options.maxFrameBytes??8*1024*1024;this.timeoutMs=options.timeoutMs??20000;this.shutdownGraceMs=options.shutdownGraceMs??5000;
    this.processClosed=new Promise(resolve=>child.once('close',()=>resolve()));
    child.stdout.on('data',(chunk:Buffer)=>this.read(chunk));
    child.stderr.on('data',(chunk:Buffer)=>{this.stderrBytes+=chunk.length;});
    child.once('error',()=>this.close(new Error('process spawn failed')));
    child.once('close',()=>this.close(new Error('connection closed')));
    child.stdout.once('end',()=>this.close(new Error('connection closed')));
    child.stdin.on('error',()=>this.close(new Error('connection closed')));
  }
  get pendingCount(){return this.pending.size;}
  get isClosed(){return this.closed;}
  private send(message:RpcMessage){
    if(this.closed)throw new Error('connection closed');
    const encoded=JSON.stringify(message)+'\n';const bytes=Buffer.byteLength(encoded);
    if(bytes>this.maxFrameBytes)throw new Error('outbound frame exceeds limit');
    if(this.child.stdin.writableLength+bytes>(this.options.maxQueuedBytes??16*1024*1024))throw new Error('outbound queue exceeds limit');
    this.options.log?.('out',message);this.child.stdin.write(encoded);
  }
  request<T=unknown>(method:string,params:unknown={},timeout=this.timeoutMs):Promise<T>{
    return new Promise<T>((resolve,reject)=>{
      if(this.closed){reject(new Error('connection closed'));return;}
      if(this.pending.size>=(this.options.maxPending??128)){reject(new Error('pending request limit'));return;}
      const id=++this.sequence;
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('request timeout'));},timeout);
      this.pending.set(id,{resolve:value=>resolve(value as T),reject,timer});
      try{this.send({id,method,params});}catch(error){clearTimeout(timer);this.pending.delete(id);reject(error);}
    });
  }
  notify(method:string,params?:unknown){this.send({method,...(params===undefined?{}:{params})});}
  private read(chunk:Buffer){
    if(this.closed)return;this.buffer=Buffer.concat([this.buffer,chunk]);let newline:number;
    while((newline=this.buffer.indexOf(10))>=0){
      if(newline>this.maxFrameBytes){this.close(new Error('frame exceeds limit'));return;}
      const frame=this.buffer.subarray(0,newline);this.buffer=this.buffer.subarray(newline+1);if(!frame.length)continue;
      let message:RpcMessage;
      try{
        const value:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(frame));
        if(value===null||typeof value!=='object'||Array.isArray(value))throw new Error();
        message=value as RpcMessage;
        if('id' in message&&!(typeof message.id==='string'||(typeof message.id==='number'&&Number.isSafeInteger(message.id))))throw new Error();
      }catch{this.close(new Error('invalid JSON frame'));return;}
      try{this.options.log?.('in',message);}catch{this.close(new Error('diagnostic write failed'));return;}
      if(typeof message.method==='string'){
        if('id' in message)void this.serverRequest(message);else this.emit('notification',message);
      }else if(typeof message.id==='number'){
        const pending=this.pending.get(message.id);if(!pending)continue;
        clearTimeout(pending.timer);this.pending.delete(message.id);
        if('error' in message)pending.reject(new RpcError(typeof message.error?.code==='number'?message.error.code:-32603,message.error?.data));
        else if('result' in message)pending.resolve(message.result);else pending.reject(new Error('invalid RPC response'));
      }
    }
    if(this.buffer.length>this.maxFrameBytes)this.close(new Error('frame exceeds limit'));
  }
  private async serverRequest(message:RpcMessage){
    try{
      const result=await this.options.handleRequest?.(message);
      this.send(result===undefined?{id:message.id,error:{code:-32601,message:'Method not found'}}:{id:message.id,result});
    }catch{
      if(!this.closed)try{this.send({id:message.id,error:{code:-32603,message:'Request handler failed'}});}catch{this.close(new Error('connection closed'));}
    }
  }
  private close(error:Error){
    if(this.closed)return;this.closed=true;this.buffer=Buffer.alloc(0);
    for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(error);}this.pending.clear();
    this.shutdown();this.emit('closed',error);
  }
  // Closing stdin lets the child exit on its own. TerminateProcess can cut off its
  // in-flight LSASS calls (Schannel TLS), which preceded an LSASS crash on Windows,
  // so force-kill only a child that ignores EOF.
  private shutdown(){
    try{this.child.stdin.end();}catch{}
    if(this.child.exitCode!==null||this.child.signalCode!==null)return;
    const timer=setTimeout(()=>{try{this.child.kill();}catch{}},this.shutdownGraceMs);
    void this.processClosed.then(()=>clearTimeout(timer));
  }
  dispose(){this.close(new Error('connection closed'));return this.processClosed;}
}
