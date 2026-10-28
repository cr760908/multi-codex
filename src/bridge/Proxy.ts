import {randomUUID} from 'node:crypto';
import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import type {Readable, Writable} from 'node:stream';

export interface AccessIdentity {accessToken:string;accountId:string;email:string;plan?:string}
export class BridgeFailure extends Error {
  constructor(readonly code:string,readonly restored=true){super(code);}
}
export function frames(stream:Readable,limit:number,receive:(message:any)=>void,onError:()=>void) {
  let buffer=Buffer.alloc(0);
  stream.on('data',(chunk:Buffer)=>{
    buffer=Buffer.concat([buffer,chunk]);
    let end:number;
    while((end=buffer.indexOf(10))>=0){
      if(end>limit){onError();return;}
      const frame=buffer.subarray(0,end);buffer=buffer.subarray(end+1);
      if(!frame.length)continue;
      try{const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(frame));if(!value||typeof value!=='object'||Array.isArray(value))throw new Error();receive(value);}catch{onError();return;}
    }
    if(buffer.length>limit)onError();
  });
}
export function validAccess(value:any):value is AccessIdentity {
  return value&&typeof value.accessToken==='string'&&value.accessToken.length>0&&value.accessToken.length<256*1024&&
    typeof value.accountId==='string'&&value.accountId.length>0&&value.accountId.length<1024&&
    typeof value.email==='string'&&value.email.length>0&&value.email.length<1024;
}

export class AppServerProxy {
  private readonly prefix=`multi-codex-${randomUUID()}:`;
  private sequence=0;
  private pending=new Map<string,{resolve:(value:any)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  private clientRequests=new Set<string>();
  private turns=new Set<string>();
  private queue:any[]=[];
  private initId:string|undefined;
  private updated=0;
  private switching=false;
  private refreshing=false;
  private closed=false;
  private owned:AccessIdentity|undefined;
  readonly processClosed:Promise<void>;
  initialized=false;
  private timeoutMs:number;
  constructor(readonly child:ChildProcessWithoutNullStreams,input:Readable,private readonly output:Writable,
    private readonly options:{timeoutMs?:number;refresh?:(accountId:string,email:string)=>Promise<AccessIdentity>}={}) {
    this.timeoutMs=options.timeoutMs??20000;
    this.processClosed=new Promise(resolve=>child.once('close',()=>{this.close();resolve();}));
    frames(input,32*1024*1024,m=>this.fromClient(m),()=>this.fail());
    frames(child.stdout,32*1024*1024,m=>this.fromServer(m),()=>this.fail());
    input.on('end',()=>{void this.dispose();});input.on('error',()=>this.fail());
    child.once('error',()=>this.close());child.stdin.on('error',()=>this.fail());
    child.stdout.once('end',()=>this.close());output.on('error',()=>this.fail());
    // No auth or request payload is written to logs by the bridge.
    child.stderr.resume();
  }
  private key(id:unknown){return `${typeof id}:${String(id)}`;}
  private write(stream:Writable,message:any){
    if(this.closed||stream.destroyed)throw new BridgeFailure('disconnected',false);
    if(stream.writableLength>64*1024*1024)throw new BridgeFailure('backpressure',false);
    stream.write(JSON.stringify(message)+'\n');
  }
  private fromClient(message:any){
    // Responses to backend requests (e.g. time/attestation) must not wait for
    // the account transaction that may itself be waiting for that response.
    if(message.id!==undefined&&!message.method){this.write(this.child.stdin,message);return;}
    if(this.switching){
      if(['turn/start','turn/steer','thread/start','account/login/start','account/logout'].includes(message.method)&&message.id!==undefined){
        this.write(this.output,{id:message.id,error:{code:-32000,message:'Account switch in progress. Retry after it completes.'}});return;
      }
      if(this.queue.length>=128){this.fail();return;}
      this.queue.push(message);return;
    }
    if(message.method==='initialize'){
      this.initId=this.key(message.id);
      message.params={...message.params,capabilities:{...message.params?.capabilities,experimentalApi:true}};
    }
    if(typeof message.method==='string'&&message.id!==undefined)this.clientRequests.add(this.key(message.id));
    this.write(this.child.stdin,message);
  }
  private fromServer(message:any){
    if(message.method==='account/updated')this.updated++;
    if(message.method==='turn/started')this.turns.add(String(message.params?.turn?.id??message.params?.threadId));
    if(message.method==='turn/completed')this.turns.delete(String(message.params?.turn?.id??message.params?.threadId));
    if(message.method==='account/chatgptAuthTokens/refresh'&&message.id!==undefined&&this.owned){void this.refresh(message);return;}
    if(!message.method&&message.id!==undefined){
      const internal=this.pending.get(String(message.id));
      if(internal){
        this.pending.delete(String(message.id));clearTimeout(internal.timer);
        if(message.error)internal.reject(new BridgeFailure('backend-rejected'));
        else internal.resolve(message.result);
        return;
      }
      // Late internal responses must not reach the official client's ID space.
      if(typeof message.id==='string'&&message.id.startsWith(this.prefix))return;
      this.clientRequests.delete(this.key(message.id));
      if(this.key(message.id)===this.initId&&!message.error)this.initialized=true;
    }
    this.write(this.output,message);
  }
  private request(method:string,params:unknown):Promise<any>{
    if(this.closed)return Promise.reject(new BridgeFailure('disconnected',false));
    const id=this.prefix+(++this.sequence);
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new BridgeFailure('timeout',false));},this.timeoutMs);
      this.pending.set(id,{resolve,reject,timer});
      try{this.write(this.child.stdin,{id,method,params});}catch(error){clearTimeout(timer);this.pending.delete(id);reject(error);}
    });
  }
  private async verify(next:AccessIdentity){
    const account=await this.request('account/read',{refreshToken:false});
    const status=await this.request('getAuthStatus',{includeToken:true,refreshToken:false});
    if(account?.account?.email?.toLowerCase()!==next.email.toLowerCase()||status?.authToken!==next.accessToken)throw new BridgeFailure('identity-mismatch');
    return {email:next.email,accountId:next.accountId,pid:this.child.pid};
  }
  private async apply(next:AccessIdentity){
    const before=this.updated;
    const result=await this.request('account/login/start',{type:'chatgptAuthTokens',accessToken:next.accessToken,chatgptAccountId:next.accountId,...next.plan?{chatgptPlanType:next.plan}:{}});
    if(result?.type!=='chatgptAuthTokens')throw new BridgeFailure('unsupported');
    const identity=await this.verify(next);
    const deadline=Date.now()+this.timeoutMs;
    while(this.updated===before){if(this.closed||Date.now()>deadline)throw new BridgeFailure('notification-missing',false);await new Promise(r=>setTimeout(r,20));}
    this.owned=next;return identity;
  }
  private async sameAccount(token:unknown,previous:AccessIdentity){
    // These claims only compare local login snapshots. The backend still
    // performs login, and apply() verifies its resulting account and token.
    const identity=(value:unknown)=>{
      if(typeof value!=='string'||value.length>256*1024||value.split('.').length!==3)return;
      try{
        const claims=JSON.parse(Buffer.from(value.split('.')[1],'base64url').toString('utf8'));
        const auth=claims['https://api.openai.com/auth'];
        const user=auth?.chatgpt_user_id??claims.sub;
        if(typeof user!=='string'||!user||auth?.chatgpt_account_id!==previous.accountId)return;
        return user;
      }catch{return;}
    };
    const current=identity(token),saved=identity(previous.accessToken);
    if(!current||current!==saved)return false;
    const account=await this.request('account/read',{refreshToken:false});
    return account?.account?.type==='chatgpt'&&account.account.email?.toLowerCase()===previous.email.toLowerCase();
  }
  async switchAccount(next:AccessIdentity,previous?:AccessIdentity){
    if(!validAccess(next)||(previous!==undefined&&!validAccess(previous)))throw new BridgeFailure('invalid-request');
    if(!this.initialized||this.closed)throw new BridgeFailure('not-ready');
    if(this.switching||this.refreshing||this.turns.size||this.clientRequests.size)throw new BridgeFailure('busy');
    this.switching=true;
    try{
      const status=await this.request('getAuthStatus',{includeToken:true,refreshToken:false});
      const changed=status?.authToken!==(previous?.accessToken??null);
      if(changed&&(!previous||!await this.sameAccount(status?.authToken,previous)))throw new BridgeFailure('out-of-sync');
      if(!changed&&previous?.accessToken===next.accessToken&&previous.accountId===next.accountId)return await this.verify(next);
      try{return await this.apply(next);}
      catch{
        try{
          if(previous)await this.apply(previous);
          // A signed-out rollback must not delete an auth file another process
          // may have created. Closing this child clears only its in-memory login.
          else{void this.dispose();throw new BridgeFailure('rollback-failed',false);}
        }catch{throw new BridgeFailure('rollback-failed',false);}
        throw new BridgeFailure('switch-failed',true);
      }
    }finally{
      this.switching=false;
      for(const message of this.queue.splice(0)){if(this.closed)break;this.fromClient(message);}
    }
  }
  private async refresh(message:any){
    const previous=this.owned;
    let refreshing=false;
    try{
      if(!previous||!this.options.refresh||this.switching||this.refreshing||message.params?.previousAccountId!==previous.accountId)throw new Error();
      this.refreshing=refreshing=true;
      const next=await this.options.refresh(previous.accountId,previous.email);
      if(!validAccess(next)||next.accountId!==previous.accountId||next.email.toLowerCase()!==previous.email.toLowerCase()||this.owned!==previous)throw new Error();
      this.write(this.child.stdin,{id:message.id,result:{accessToken:next.accessToken,chatgptAccountId:next.accountId,...next.plan?{chatgptPlanType:next.plan}:{}}});
      this.owned=next;
    }catch{if(!this.closed)this.write(this.child.stdin,{id:message.id,error:{code:-32000,message:'Saved account requires reauthentication.'}});}
    finally{if(refreshing)this.refreshing=false;}
  }
  private close(){this.closed=true;for(const entry of this.pending.values()){clearTimeout(entry.timer);entry.reject(new BridgeFailure('disconnected',false));}this.pending.clear();}
  private fail(){void this.dispose();}
  async dispose(){
    this.close();this.child.stdin.end();
    const timer=setTimeout(()=>{if(this.child.exitCode===null)this.child.kill();},5000);
    await this.processClosed;clearTimeout(timer);
  }
}
