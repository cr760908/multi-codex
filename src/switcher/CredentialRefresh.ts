import {mkdtempSync,writeFileSync,readFileSync,realpathSync,rmSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {plainDirectory} from '../storage/PathGuard';
import {JsonRpcClient} from '../protocol/JsonRpcClient';
import {parseAuth,SwitchError} from './Auth';

export class CredentialRefresher {
  constructor(private root:string,private connect:(home:string)=>JsonRpcClient){}
  async refresh(raw:string){
    const expected=parseAuth(raw);plainDirectory(this.root);
    const home=mkdtempSync(join(this.root,'refresh-'));let peer:JsonRpcClient|undefined;
    try{
      writeFileSync(join(home,'config.toml'),'model_provider = "openai"\ncli_auth_credentials_store = "file"\n',{mode:0o600,flag:'wx'});
      writeFileSync(join(home,'auth.json'),raw,{mode:0o600,flag:'wx'});
      peer=this.connect(home);
      await peer.request('initialize',{clientInfo:{name:'codex_account_switcher_refresh',version:'0.3.0'},capabilities:{experimentalApi:false}},8000);peer.notify('initialized');
      const status=await peer.request<any>('getAuthStatus',{includeToken:true,refreshToken:true},8000);
      const fresh=readFileSync(join(home,'auth.json'),'utf8');
      if(parseAuth(fresh).id!==expected.id||status?.authToken!==JSON.parse(fresh).tokens.access_token)throw new Error();
      return fresh;
    }catch{
      // The official helper may have rotated the one-use refresh token before a
      // later response/connection failed. Never delete that newer credential.
      try{
        const fresh=readFileSync(join(home,'auth.json'),'utf8');
        if(parseAuth(fresh).id===expected.id&&JSON.parse(fresh).tokens.refresh_token!==JSON.parse(raw).tokens.refresh_token)return fresh;
      }catch{}
      throw new SwitchError('帳號憑證無法更新，請使用「重新登入並修復帳號」。');
    }
    finally{
      await peer?.dispose();
      const target=realpathSync(home);
      if(dirname(target).toLowerCase()!==resolve(this.root).toLowerCase())throw new SwitchError('登入暫存目錄已變更，未清理。');
      rmSync(target,{recursive:true,force:true,maxRetries:5,retryDelay:100});
    }
  }
}
