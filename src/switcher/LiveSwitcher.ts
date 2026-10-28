import {AccountVault} from './AccountVault';
import {NativeAuth} from './NativeAuth';
import {parseAuth,SwitchError} from './Auth';
import {BridgeFailure,type AccessIdentity} from '../bridge/Proxy';

export function accessIdentity(raw:string):AccessIdentity{
  const identity=parseAuth(raw),accessToken=JSON.parse(raw).tokens.access_token;
  let plan:string|undefined;
  try{const claims=JSON.parse(Buffer.from(accessToken.split('.')[1],'base64url').toString());const value=claims['https://api.openai.com/auth']?.chatgpt_plan_type;if(typeof value==='string')plan=value;}catch{}
  return{accessToken,accountId:identity.accountId,email:identity.email,plan};
}
function needsRenewal(raw:string){
  try{const token=JSON.parse(raw).tokens.access_token;const exp=JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString()).exp;return typeof exp!=='number'||exp*1000<Date.now()+60000;}catch{return true;}
}
interface LiveBridge {ready():Promise<void>;switchAccount(next:AccessIdentity,previous?:AccessIdentity):Promise<{email:string;accountId:string;pid:number}>}
export class LiveSwitcher {
  constructor(readonly vault:AccountVault,readonly native:NativeAuth,private bridge:LiveBridge,private renew:(raw:string)=>Promise<string>){}
  switchTo(id:string){
    return this.native.exclusive(async()=>{
      await this.bridge.ready();
      const original=this.native.read();
      let target=original&&parseAuth(original).id===id?original:await this.vault.auth(id);
      if(original)await this.vault.save(original);
      if(needsRenewal(target)){
        target=await this.renew(target);
        if(parseAuth(target).id!==id)throw new SwitchError('更新後的帳號不符，已停止切換。');
        await this.vault.save(target);
      }
      return this.activate(target,original);
    });
  }
  installLogin(raw:string,expectedId?:string){
    return this.native.exclusive(async()=>{
      if(expectedId&&parseAuth(raw).id!==expectedId)throw new SwitchError('登入帳號不符，未套用。');
      const original=this.native.read();
      if(original&&parseAuth(original).id!==parseAuth(raw).id)await this.vault.save(original);
      await this.vault.save(raw);
      try{await this.bridge.ready();return await this.activate(raw,original);}
      catch{throw new SwitchError('新登入已安全儲存，但未確認切換完成。請核對官方登入狀態，再從帳號清單選取；必要時重新啟動擴充。');}
    });
  }
  private async activate(target:string,original:string|undefined){
    if(this.native.read()!==original)throw new SwitchError('登入資料已被其他程序變更，請重試。');
    const next=accessIdentity(target),previous=original?accessIdentity(original):undefined;
    const result=await this.bridge.switchAccount(next,previous);
    try{this.native.replace(original,target);}
    catch{
      if(previous){try{await this.bridge.switchAccount(previous,next);}catch{throw new BridgeFailure('rollback-failed',false);}}
      throw new SwitchError('登入檔已被其他程序變更；未覆寫，請核對官方帳號與其他 Codex 視窗。');
    }
    return result;
  }
  renewActive(accountId:string,email:string){
    return this.native.exclusive(async()=>{
      const original=this.native.read();
      if(!original)throw new BridgeFailure('out-of-sync');
      const identity=parseAuth(original);
      if(identity.accountId!==accountId||identity.email!==email.toLowerCase())throw new BridgeFailure('out-of-sync');
      const fresh=await this.renew(original);
      if(parseAuth(fresh).id!==parseAuth(original).id)throw new BridgeFailure('identity-mismatch');
      await this.vault.save(fresh);this.native.replace(original,fresh);return accessIdentity(fresh);
    });
  }
}
