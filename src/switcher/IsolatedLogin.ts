import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { JsonRpcClient, type RpcMessage } from '../protocol/JsonRpcClient';
import { buildEnvironment } from '../runtime/EnvBuilder';
import { plainDirectory } from '../storage/PathGuard';
import { NativeAuth } from './NativeAuth';
import { parseAuth, SwitchError } from './Auth';

// log receives one line at start and one at exit, with the PID so the helper can be
// matched to Windows process traces. It never includes credentials or account names.
export function createLoginPeer(cli: string, home: string, purpose = 'login', log?: (line: string) => void): JsonRpcClient {
  const started = Date.now();
  const child = spawn(cli, ['app-server'], {
    cwd: home, env: buildEnvironment(process.env, home).env,
    shell: false, windowsHide: true, stdio: 'pipe',
  });
  log?.(`codex.exe ${purpose} helper started pid=${child.pid ?? 'none'}`);
  child.once('close', (code, signal) => log?.(`codex.exe ${purpose} helper pid=${child.pid ?? 'none'} exited code=${code} signal=${signal} forced=${child.killed} after ${Date.now() - started}ms`));
  return new JsonRpcClient(child);
}

// The helper owns only this temporary login process. It never logs out a session,
// starts coding work, or opens the official extension's active CODEX_HOME.
export class IsolatedLogin {
  private busy = false;
  constructor(private readonly root: string, private readonly connect: (home: string) => JsonRpcClient) {}

  async login(openBrowser: (url: string) => PromiseLike<boolean>, signal?: AbortSignal): Promise<string | undefined> {
    if (this.busy) throw new SwitchError('另一個登入正在進行。');
    if (signal?.aborted) return;
    this.busy = true;
    let home: string | undefined, peer: JsonRpcClient | undefined;
    let loginId: string | undefined, succeeded = false, timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let listener: ((message: RpcMessage) => void) | undefined;
    const abort = () => {void peer?.dispose();};
    try {
      plainDirectory(this.root);
      home = mkdtempSync(join(this.root, 'login-'));
      writeFileSync(join(home, 'config.toml'), 'model_provider = "openai"\nforced_login_method = "chatgpt"\ncli_auth_credentials_store = "file"\n', {flag:'wx',mode:0o600});
      peer = this.connect(home);
      signal?.addEventListener('abort', abort, {once:true});
      if (signal?.aborted) {abort(); return;}
      timer = setTimeout(() => {timedOut = true; abort();}, 180000);
      await peer.request('initialize', {clientInfo:{name:'codex_account_switcher',version:'0.2.2'},capabilities:{experimentalApi:false}});
      peer.notify('initialized');
      let finish!: (success: boolean) => void;
      const completed = new Promise<boolean>(resolve => {finish = resolve;});
      const early = new Map<string, boolean>();
      listener = message => {
        if (message.method !== 'account/login/completed') return;
        const p = message.params as {loginId?:string;success?:boolean} | undefined;
        if (typeof p?.loginId !== 'string') return;
        if (!loginId) {if (early.size < 16) early.set(p.loginId, p.success === true);}
        else if (p.loginId === loginId) finish(p.success === true);
      };
      peer.on('notification', listener);
      peer.once('closed', () => finish(false));
      const response = await peer.request<{type:string;loginId:string;authUrl:string}>('account/login/start',{type:'chatgpt'});
      if (response.type !== 'chatgpt' || typeof response.loginId !== 'string' || !response.loginId) throw new SwitchError('官方登入沒有回傳有效流程。');
      loginId = response.loginId;
      const url = new URL(response.authUrl);
      if (url.protocol !== 'https:' || !['auth.openai.com','chatgpt.com'].includes(url.hostname) || url.username || url.password || (url.port && url.port !== '443')) throw new SwitchError('官方登入網址不符合預期。');
      if (early.has(loginId)) finish(early.get(loginId)!);
      else if (!peer.isClosed && !signal?.aborted && !await openBrowser(url.href)) throw new SwitchError('無法開啟登入瀏覽器，請重試。');
      succeeded = await completed;
      if (signal?.aborted) return;
      if (timedOut) throw new SwitchError('登入逾時，請重新嘗試。');
      if (!succeeded) throw new SwitchError('登入未完成，請重新嘗試。');
      // Exercise the newly issued refresh token before capturing its latest value.
      const account = await peer.request<{account:{type:string;email:string|null}|null}>('account/read',{refreshToken:true});
      const raw = new NativeAuth(home).read();
      if (!raw || account.account?.type !== 'chatgpt' || account.account.email?.trim().toLowerCase() !== parseAuth(raw).email) throw new SwitchError('無法核對新登入帳號，請重試。');
      return raw;
    } catch (error) {
      if (signal?.aborted) return;
      if (timedOut) throw new SwitchError('登入逾時，請重新嘗試。');
      if (error instanceof SwitchError) throw error;
      throw new SwitchError('官方登入或憑證驗證失敗，請重試；目前帳號保持不變。');
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (peer && listener) peer.off('notification', listener);
      try {
        if (peer && !succeeded && loginId && !peer.isClosed) {
          await peer.request('account/login/cancel', {loginId}, 2000).catch(() => {});
        }
        await peer?.dispose();
        if (home) {
          const resolved = realpathSync(home);
          if (dirname(resolved).toLowerCase() !== resolve(this.root).toLowerCase()) throw new SwitchError('登入暫存目錄已變更，未自動清理。');
          rmSync(resolved, {recursive:true,force:true});
        }
      } finally {this.busy = false;}
    }
  }
}
