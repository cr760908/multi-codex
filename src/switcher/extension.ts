import * as vscode from 'vscode';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { AccountVault, type SavedAccount } from './AccountVault';
import { AccountSwitcher } from './AccountSwitcher';
import { NativeAuth } from './NativeAuth';
import { accountLabel, parseAuth, SwitchError } from './Auth';
import { IsolatedLogin, createLoginPeer } from './IsolatedLogin';
import { QuotaReader, quotaText, windowLabel, type Quota } from './Quota';
import { authFingerprint, QuotaCache, quotaDue, quotaIntervalMs, quotaRetryDelay, quotaWindowOpen, type QuotaTiming } from './QuotaSchedule';
import {BridgeConnection} from './BridgeConnection';
import {isManagedBridge,prepareBridge} from './BridgeInstall';
import {LiveSwitcher} from './LiveSwitcher';
import {CredentialRefresher} from './CredentialRefresh';
import {BridgeFailure} from '../bridge/Proxy';
import {showAccountMenu} from './AccountMenu';

let stopLogin: (() => Promise<void>) | undefined;
let stopQuota: (() => Promise<void>) | undefined;

function workspaceConfigs(): string[] {
  const files = new Set<string>();
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (folder.uri.scheme !== 'file') continue;
    let path = folder.uri.fsPath;
    while (true) {
      files.add(join(path, '.codex', 'config.toml'));
      const parent = dirname(path);
      if (parent === path) break;
      path = parent;
    }
  }
  return [...files];
}

export function activate(context: vscode.ExtensionContext) {
  const native = new NativeAuth(process.env.CODEX_HOME || join(homedir(), '.codex'), workspaceConfigs);
  const vault = new AccountVault(context.secrets);
  const service = new AccountSwitcher(vault, native);
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  status.name = 'Codex 帳號切換';
  status.command = 'multiCodex.accounts';
  let busy = false;
  let disposed = false;
  let loginAbort: AbortController | undefined;
  let pendingLogin: Promise<string | undefined> | undefined;
  stopLogin = async () => {loginAbort?.abort(); await pendingLogin?.catch(() => {});};
  const quotaAbort = new AbortController();
  let quotaPending: Promise<void> | undefined;
  let activatedAt = Date.now();
  const quotaCache = new QuotaCache(join(context.globalStorageUri.fsPath, 'quota-cache.json'));
  const output = vscode.window.createOutputChannel('Codex Accounts', {log: true});
  const helperLog = (line: string) => output.info(line);
  const bridgeLauncher=()=>{
    const path=vscode.workspace.getConfiguration('chatgpt').get<string>('cliExecutable');
    return isManagedBridge(path,context.globalStorageUri.fsPath)?path:undefined;
  };
  function officialCli(){
    const official=vscode.extensions.getExtension('openai.chatgpt');
    const cli=official&&join(official.extensionPath,'bin','windows-x86_64','codex.exe');
    if(process.arch!=='x64'||!cli||!existsSync(cli))throw new SwitchError('請安裝或更新 Windows x64 官方 Codex 擴充套件。');
    return cli;
  }
  const bridge:BridgeConnection=new BridgeConnection(bridgeLauncher,native.home,(id,email)=>live.renewActive(id,email),process.pid,officialCli);
  const live:LiveSwitcher=new LiveSwitcher(vault,native,bridge,raw=>new CredentialRefresher(join(context.globalStorageUri.fsPath,'refresh-temp'),
    home=>createLoginPeer(officialCli(),home,'credential refresh',helperLog)).refresh(raw));
  context.subscriptions.push({dispose:()=>bridge.dispose()});
  function installedBridge(){
    return prepareBridge(join(context.extensionPath,'dist'),context.globalStorageUri.fsPath,context.extension.packageJSON.version,process.execPath,officialCli());
  }
  async function restartManagedBridge(){
    const current=bridgeLauncher();if(disposed||!current)return;
    const launcher=installedBridge();
    if(launcher.toLowerCase()!==current.toLowerCase())await vscode.workspace.getConfiguration('chatgpt').update('cliExecutable',launcher,vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('workbench.action.restartExtensionHost');
  }
  let runtimeUpdate=Promise.resolve();
  let notifiedRuntime:string|undefined;
  function refreshBridgeRuntime(){
    runtimeUpdate=runtimeUpdate.then(async()=>{
      const current=bridgeLauncher();
      if(disposed||!current||process.platform!=='win32'||!vscode.workspace.isTrusted||vscode.env.remoteName)return;
      const cli=officialCli(),expected=process.execPath+'\n'+cli+'\n';
      let previous:string|undefined;
      try{previous=readFileSync(join(dirname(current),'runtime-paths.txt'),'utf8');}catch{}
      const launcher=installedBridge();
      const changed=launcher.toLowerCase()!==current.toLowerCase();
      // A live official extension may react to a configuration change itself.
      // Defer bundle migration until the user explicitly chooses to restart.
      if(changed&&!vscode.extensions.getExtension('openai.chatgpt')?.isActive)await vscode.workspace.getConfiguration('chatgpt').update('cliExecutable',launcher,vscode.ConfigurationTarget.Global);
      const notificationKey=launcher+'\n'+expected;
      if((changed||previous!==expected)&&notifiedRuntime!==notificationKey){
        notifiedRuntime=notificationKey;
        helperLog('Managed bridge runtime updated; running sessions were not restarted.');
        void vscode.window.showInformationMessage('帳號切換橋接已更新。請先完成進行中的工作，再重新啟動擴充以套用；目前工作不會自動中斷。','重新啟動擴充')
          .then(choice=>{if(choice)return restartManagedBridge();})
          .then(undefined,()=>{helperLog('Managed bridge restart failed. Run Enable Seamless Switching to retry.');});
      }
    }).catch(()=>{helperLog('Managed bridge runtime update failed. Run Enable Seamless Switching to retry.');});
    return runtimeUpdate;
  }
  context.subscriptions.push(vscode.extensions.onDidChange(refreshBridgeRuntime));
  void refreshBridgeRuntime();
  // Mirrors the shared QuotaRecord. revision: the shared record this row last wrote or
  // adopted. failures: consecutive failed queries (for backoff). failedAuth: fingerprint
  // of the credentials whose last query failed, to retry once they change.
  interface QuotaRow {item: vscode.StatusBarItem; lastAttempt?: number; revision?: string; failures?: number; failedAuth?: string; quota?: Quota; error?: string}
  const quotaItems = new Map<string, QuotaRow>();
  stopQuota = async () => {quotaAbort.abort(); await quotaPending?.catch(()=>{});};

  function quotaSettings() {
    const config = vscode.workspace.getConfiguration('multiCodex.quota');
    const foregroundMs=quotaIntervalMs(config.get<number>('refreshIntervalMinutes',1));
    const backgroundMs=quotaIntervalMs(config.get<number>('backgroundRefreshIntervalMinutes',3));
    return {enabled:config.get<boolean>('enabled',true),foregroundMs,backgroundMs,
      intervalMs:vscode.window.state.focused?foregroundMs:backgroundMs};
  }

  function clearQuotaItems() {
    for (const row of quotaItems.values()) row.item.dispose();
    quotaItems.clear();
  }

  // Checked before every request, so turning quota off prevents the next account query.
  function quotaTurnedOff() {
    if (quotaSettings().enabled) return false;
    clearQuotaItems();
    return true;
  }

  function shareQuota(id: string, row: QuotaRow, checkedAt: number) {
    const revision = quotaCache.set(id, {checkedAt, quota: row.quota, error: row.error, failures: row.failures, failedAuth: row.failedAuth});
    if (revision) row.revision = revision;
  }

  async function refreshQuotas(force = false) {
    // An automatic pass may skip every account, so a manual refresh runs after it.
    while (quotaPending) {
      if (!force) return quotaPending;
      await quotaPending.catch(() => {});
    }
    if (disposed || busy) return;
    quotaPending = (async () => {
      try {
        boundary();
        if (quotaTurnedOff()) return;
        const currentRaw = native.read();
        let current: ReturnType<typeof parseAuth> | undefined;
        try {current = currentRaw ? parseAuth(currentRaw) : undefined;}
        catch { /* Saved ChatGPT accounts remain queryable during an invalid native login. */ }
        const saved = await vault.list();
        if (current && !saved.some(a=>a.id===current.id)) saved.push({...current,label:current.email});
        for (const [id, row] of quotaItems) {
          if (!saved.some(a=>a.id===id)) {row.item.dispose(); quotaItems.delete(id);}
        }
        for (const [index, account] of saved.entries()) {
          if (disposed || quotaAbort.signal.aborted || busy) break;
          boundary();
          if (quotaTurnedOff()) return;
          const settings = quotaSettings();
          let row = quotaItems.get(account.id);
          if (!row) {
            const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left,98-index/1000);
            item.name = `Codex 額度：${account.email}`;
            item.command = 'multiCodex.accounts';
            row = {item}; quotaItems.set(account.id,row);
          }
          // Adopt what another window (or this window before a reload) wrote, including the
          // result of a query whose claim was already adopted. Never adopt an older attempt:
          // if this window's own writes fail, its in-memory throttle must still hold.
          const shared = quotaCache.get(account.id);
          if (shared && shared.revision !== row.revision && shared.checkedAt >= (row.lastAttempt ?? -Infinity)) {
            Object.assign(row, {lastAttempt: shared.checkedAt, revision: shared.revision, quota: shared.quota, error: shared.error, failures: shared.failures, failedAuth: shared.failedAuth});
          }
          const alias = index < 26 ? String.fromCharCode(65+index) : `${index+1}`;
          const render = () => {
            if (disposed) return;
            const text = row!.quota ? quotaText(row!.quota) + (row!.error ? '（上次）' : '') : row!.error ? '無法取得' : '更新中…';
            row!.item.text = `${account.id===current?.id ? '● ' : ''}${alias}：${text}`;
            const lines = [`${alias}：${account.label}`,account.email,account.id===current?.id ? '目前登入檔的帳號' : '已儲存帳號',`顯示已使用比例；前景每 ${settings.foregroundMs/60000} 分鐘、背景每 ${settings.backgroundMs/60000} 分鐘自動更新。`];
            if (row!.error) lines.push(row!.quota ? '更新失敗，以下為上次成功結果。' : '尚無成功取得的額度。', row!.error);
            if (row!.failures && row!.failures > 1 && row!.lastAttempt !== undefined) {
              lines.push(`連續失敗 ${row!.failures} 次，自動重試延後到 ${new Date(row!.lastAttempt+quotaRetryDelay(settings.intervalMs,row!.failures)).toLocaleString()}。`);
            }
            if (row!.quota) {
              lines.push(`最後成功更新：${new Date(row!.quota.updatedAt).toLocaleString()}`);
              for (const w of row!.quota.windows) lines.push(`${windowLabel(w.minutes)} 重置：${w.resetsAt===null ? '未提供' : new Date(w.resetsAt*1000).toLocaleString()}`);
            }
            lines.push('額度自動更新；點擊開啟帳號清單。');
            row!.item.tooltip = lines.join('\n');
            row!.item.show();
          };
          render();
          const timing: QuotaTiming = {force, focused: vscode.window.state.focused, now: Date.now(), activatedAt, intervalMs: settings.intervalMs, lastAttempt: row.lastAttempt, failures: row.failures};
          if (!quotaWindowOpen(timing)) continue;
          let authHash: string | undefined, checkedAt: number | undefined;
          let release:(()=>void)|undefined;
          try {
            const raw = account.id === current?.id && currentRaw ? currentRaw : await vault.auth(account.id);
            authHash = authFingerprint(raw);
            release=quotaCache.acquire();
            if(!release)continue;
            // SecretStorage is asynchronous: another window can finish a query
            // while we await it. Recheck the shared result under the lease.
            const latest=quotaCache.get(account.id);
            if(latest&&latest.checkedAt>=(row.lastAttempt??-Infinity)){
              Object.assign(row,{lastAttempt:latest.checkedAt,revision:latest.revision,quota:latest.quota,error:latest.error,failures:latest.failures,failedAuth:latest.failedAuth});
            }
            if (!quotaDue({...timing,lastAttempt:row.lastAttempt,failures:row.failures,credentialsChanged: row.failedAuth !== undefined && row.failedAuth !== authHash})) {render();continue;}
            if (quotaTurnedOff()) return;
            // Claim this account first so other windows skip it while the query runs.
            row.lastAttempt = checkedAt = Date.now();
            shareQuota(account.id, row, checkedAt);
            const reader = new QuotaReader();
            row.quota = await reader.read(raw,quotaAbort.signal);
            row.error = undefined; row.failedAuth = undefined; row.failures = undefined;
          } catch (error) {
            // Shutdown or reload interrupted the query; that is not a quota failure.
            if (quotaAbort.signal.aborted) break;
            row.error = error instanceof SwitchError ? error.message : '無法取得額度，請稍後重新整理。';
            row.failedAuth = authHash;
            row.failures = (row.failures ?? 0) + 1;
            // Failures before a request started are throttled like any other attempt.
            row.lastAttempt = checkedAt ??= Date.now();
          }finally{
            if(checkedAt!==undefined)shareQuota(account.id,row,checkedAt);
            release?.();
          }
          if (!disposed) {
            boundary();
            render();
          }
        }
      } catch {
        for (const row of quotaItems.values()) row.item.hide();
      }
    })();
    try {await quotaPending;} finally {quotaPending=undefined;}
  }

  function boundary() {
    if (process.platform !== 'win32' || vscode.env.remoteName) throw new SwitchError('帳號切換目前支援本機 Windows VS Code 視窗。');
    if (!vscode.workspace.isTrusted) throw new SwitchError('請先信任此 VS Code 工作區，再管理 Codex 登入資料。');
    if (vscode.workspace.getConfiguration('chatgpt').get('runCodexInWindowsSubsystemForLinux', false)) {
      throw new SwitchError('官方 Codex 目前使用 WSL；這個版本僅支援 Windows 本機登入資料。');
    }
  }

  function refresh() {
    if (disposed) return;
    try {
      boundary();
      const current = service.current();
      status.text = `$(account) Codex: ${current?.email ?? '未登入'}`;
      status.tooltip = `${current ? '目前登入檔中的帳號：' + current.email : '尚無 ChatGPT 登入資料'}\n${bridgeLauncher()?'點選已儲存帳號即可切換，不重新載入視窗。':'請先從帳號選單啟用免重載切換。'}\n登入是否有效以官方 Codex 介面為準。`;
    } catch (error) {
      status.text = '$(account) Codex: 檢查登入';
      status.tooltip = error instanceof SwitchError ? error.message : '無法讀取 Codex 登入資料，請檢查檔案存取權限。';
    }
    status.show();
    void refreshQuotas();
  }

  async function run(action: () => Promise<unknown>) {
    if (busy) {void vscode.window.showInformationMessage('帳號操作正在進行。'); return;}
    busy = true;
    try {boundary(); await action();}
    catch (error) {
      const bridgeErrors:Record<string,string>={
        'not-enabled':'請先從帳號選單啟用免重載切換。',
        'not-ready':'帳號橋接尚未就緒。首次啟用後請執行 Developer: Restart Extension Host，再開啟官方 Codex。',
        'busy':'Codex 尚有任務或請求進行中，請完成後再切換帳號。',
        'out-of-sync':'官方 Codex 與共用登入檔的身分不同，或憑證不足以核對。請先完成工作並關閉其他共用登入的 Codex，再重新啟動擴充以依登入檔同步，之後重選帳號。',
        'runtime-outdated':'官方 Codex 已更新，但執行中的帳號橋接仍使用舊後端。請先完成工作，再重新啟動擴充以套用更新。',
        'switch-failed':'切換未通過帳號驗證，已還原原本帳號。請重新登入並修復目標帳號。',
        'rollback-failed':'切換中斷，無法確認後端是否已還原。請先核對官方帳號，再重新啟動擴充。',
        'disconnected':'帳號橋接連線中斷，未確認切換成功；請核對官方帳號後重試。',
      };
      const message=error instanceof SwitchError ? error.message : error instanceof BridgeFailure ? bridgeErrors[error.code]??'帳號橋接未完成切換，請核對官方登入狀態。' : '帳號操作失敗，請檢查登入檔案與 VS Code 加密儲存是否可用。';
      if(error instanceof BridgeFailure&&['out-of-sync','runtime-outdated','not-ready'].includes(error.code)){
        const choice=await vscode.window.showErrorMessage(message,'重新啟動擴充');
        if(choice)await restartManagedBridge();
      }else void vscode.window.showErrorMessage(message);
    } finally {busy = false; refresh();}
  }

  async function openNative() {
    if (!vscode.extensions.getExtension('openai.chatgpt')) throw new SwitchError('請先安裝 OpenAI 官方 Codex 擴充套件（openai.chatgpt）。');
    await vscode.commands.executeCommand('chatgpt.openSidebar');
  }

  async function saveCurrent() {
    const account = await service.saveCurrent();
    void vscode.window.showInformationMessage(`已儲存 Codex 帳號：${account.label}`);
  }

  async function enableSeamlessSwitching(){
    const config=vscode.workspace.getConfiguration('chatgpt');
    const current=config.get<string>('cliExecutable');
    if(current&&!isManagedBridge(current,context.globalStorageUri.fsPath))throw new SwitchError('已設定其他自訂 Codex CLI，未覆寫。請先移除該設定，再啟用免重載切換。');
    if(!current)await context.globalState.update('multiCodex.previousCli',{value:config.inspect<string>('cliExecutable')?.globalValue??null});
    const launcher=installedBridge();
    await config.update('cliExecutable',launcher,vscode.ConfigurationTarget.Global);
    const choice=await vscode.window.showInformationMessage('免重載切換已啟用。首次需要重新啟動擴充執行環境（其他擴充也會重新啟動），之後選帳號不會重載視窗。','重新啟動擴充');
    if(choice)await vscode.commands.executeCommand('workbench.action.restartExtensionHost');
  }

  async function disableSeamlessSwitching(){
    if(!bridgeLauncher())throw new SwitchError('目前沒有使用本工具的帳號橋接，未修改設定。');
    const previous=context.globalState.get<{value:string|null}>('multiCodex.previousCli');
    await vscode.workspace.getConfiguration('chatgpt').update('cliExecutable',previous?.value??undefined,vscode.ConfigurationTarget.Global);
    bridge.dispose();
    const choice=await vscode.window.showInformationMessage('已還原官方 Codex 啟動設定，重新啟動擴充後生效。','重新啟動擴充');
    if(choice)await vscode.commands.executeCommand('workbench.action.restartExtensionHost');
  }

  async function loginAccount(expected?: SavedAccount) {
    await bridge.ready();
    const official = vscode.extensions.getExtension('openai.chatgpt');
    if (!official) throw new SwitchError('請先安裝 OpenAI 官方 Codex 擴充套件。');
    if (process.arch !== 'x64') throw new SwitchError('此版本的獨立登入支援 Windows x64。');
    const cli = join(official.extensionPath, 'bin', 'windows-x86_64', 'codex.exe');
    if (!existsSync(cli)) throw new SwitchError('找不到官方 Codex 隨附的登入程式，請更新官方擴充套件。');
    native.read(); // Validate supported configuration before starting any login.
    const login = new IsolatedLogin(join(context.globalStorageUri.fsPath, 'login-temp'), home => createLoginPeer(cli, home, 'login', helperLog));
    loginAbort = new AbortController();
    let raw: string | undefined;
    try {
      raw = await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,cancellable:true,
        title:expected ? `重新登入 ${expected.email}` : '新增 Codex 帳號'}, async (progress, token) => {
        progress.report({message:'請在瀏覽器選擇要登入的帳號；完成後會驗證新憑證。'});
        const cancel = token.onCancellationRequested(() => loginAbort?.abort());
        try {
          if (token.isCancellationRequested) loginAbort!.abort();
          pendingLogin = login.login(url => vscode.env.openExternal(vscode.Uri.parse(url)), loginAbort!.signal);
          return await pendingLogin;
        } finally {cancel.dispose();}
      });
    } finally {pendingLogin = undefined; loginAbort = undefined;}
    if (!raw || disposed) return;
    const fresh = parseAuth(raw);
    if (expected && fresh.id !== expected.id) throw new SwitchError('登入帳號不符，請在瀏覽器選擇要修復的原帳號與工作區。');
    const choice = await vscode.window.showInformationMessage(`已完成登入：${fresh.email}`, {
      modal:true,detail:'套用會保存新憑證並更新官方 Codex 帳號。請先結束執行中的任務，並關閉其他共用登入資料的 Codex 視窗／CLI。取消則不套用這次登入。',
    }, '套用');
    if (!choice || disposed) return;
    // Clear stale quota errors after installing fresh credentials.
    quotaCache.delete(fresh.id);
    await live.installLogin(raw,expected?.id);
    activatedAt=Date.now();
  }

  async function addAccount() {await loginAccount();}

  async function repairAccount() {
    const current = service.current();
    const selected = await vscode.window.showQuickPick((await vault.list()).map(a => ({...accountItem(a,current?.id),picked:a.id===current?.id})), {
      title:'重新登入並修復帳號',placeHolder:'選擇憑證失效的帳號，再於瀏覽器登入同一個帳號',matchOnDescription:true,
    });
    if (selected) await loginAccount(selected.account);
  }

  function accountItem(account: SavedAccount, currentId?: string) {
    return {
      label: `${account.id === currentId ? '$(check)' : '$(account)'} ${account.label}`,
      description: account.email,
      detail: `${account.id === currentId ? '目前登入檔 · ' : ''}帳號／工作區 ${account.accountId}`,
      account,
    };
  }

  async function selectAndSwitch(account: SavedAccount) {
    if (!vscode.extensions.getExtension('openai.chatgpt')) throw new SwitchError('請先安裝 OpenAI 官方 Codex 擴充套件（openai.chatgpt）。');
    await live.switchTo(account.id);
    activatedAt=Date.now();
    void vscode.window.showInformationMessage(`此 VS Code 後端已切換為 ${account.label}。其他視窗或桌面版持有的舊對話不會一起切換；若舊對話仍報原帳號額度不足，請先關閉持有該對話的其他客戶端再重新開啟對話。`);
  }

  async function renameAccount(account:SavedAccount){
    const label=await vscode.window.showInputBox({title:'帳號名稱',value:account.label,validateInput:value=>{
      try{accountLabel(value);return undefined;}catch{return '請輸入 1–80 個字元的名稱。';}
    }});
    if(label!==undefined)await service.rename(account.id,label);
  }

  async function removeAccount(account:SavedAccount){
    const choice=await vscode.window.showWarningMessage(`移除 ${account.label} 的已儲存登入資料？`,{
      modal:true,detail:'這只移除清單中的備份，不會登出官方 Codex。',
    },'移除');
    if(choice==='移除')await service.remove(account.id);
  }

  async function manageAccounts() {
    const selected = await vscode.window.showQuickPick((await vault.list()).map(a => accountItem(a, service.current()?.id)), {
      title: '管理已儲存的 Codex 帳號', placeHolder: '選擇要改名或移除的帳號', matchOnDescription: true,
    });
    if (!selected) return;
    const action = await vscode.window.showQuickPick(['重新登入並修復', '重新命名', '移除已儲存帳號'], {title: selected.account.email});
    if (action === '重新登入並修復') await loginAccount(selected.account);
    else if (action === '重新命名') await renameAccount(selected.account);
    else if (action === '移除已儲存帳號') await removeAccount(selected.account);
  }

  async function accounts() {
    const current = service.current();
    const selected=await showAccountMenu(await vault.list(),current?.id,!!bridgeLauncher());
    if(!selected)return;
    switch(selected.action){
      case 'switch':await selectAndSwitch(selected.account);break;
      case 'repair':await loginAccount(selected.account);break;
      case 'rename':await renameAccount(selected.account);break;
      case 'remove':await removeAccount(selected.account);break;
      case 'save':await saveCurrent();break;
      case 'add':await addAccount();break;
      case 'open':await openNative();break;
      case 'enable':await enableSeamlessSwitching();break;
      case 'disable':await disableSeamlessSwitching();break;
    }
  }

  const commands: Record<string, () => Promise<unknown>> = {accounts, saveAccount: saveCurrent, addAccount, repairAccount, manageAccounts, open: openNative,enableSeamlessSwitching,disableSeamlessSwitching};
  for (const [name, action] of Object.entries(commands)) {
    context.subscriptions.push(vscode.commands.registerCommand(`multiCodex.${name}`, () => run(action)));
  }
  context.subscriptions.push(vscode.commands.registerCommand('multiCodex.switchSavedAccount',(id:string)=>run(async()=>{
    const account=(await vault.list()).find(item=>item.id===id);
    if(!account)throw new SwitchError('找不到此已儲存帳號。');
    await selectAndSwitch(account);
  })));
  context.subscriptions.push(vscode.commands.registerCommand('multiCodex.refreshQuotas',async()=>{
    if (!quotaSettings().enabled) {void vscode.window.showInformationMessage('額度查詢已關閉，可在設定 multiCodex.quota.enabled 重新開啟。'); return;}
    await refreshQuotas(true);
  }));
  const timer = setInterval(refresh, 5000);
  timer.unref();
  context.subscriptions.push(status, output, {dispose: () => {disposed = true; loginAbort?.abort(); quotaAbort.abort(); clearInterval(timer); clearQuotaItems();}},
    vscode.window.onDidChangeWindowState(refresh), vscode.workspace.onDidChangeConfiguration(refresh));
  refresh();
  // Metadata only: never expose auth snapshots through the extension exports.
  return {get currentAccount() {boundary(); return service.current();}, savedAccounts: () => vault.list()};
}

export async function deactivate() {await Promise.all([stopLogin?.(),stopQuota?.()]); stopLogin = undefined; stopQuota = undefined;}
