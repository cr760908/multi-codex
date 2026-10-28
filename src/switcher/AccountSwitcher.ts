import { AccountVault } from './AccountVault';
import { NativeAuth } from './NativeAuth';
import { parseAuth, SwitchError } from './Auth';

async function reloadWindow(reload: () => PromiseLike<unknown>) {
  try {await reload();}
  catch (error) {
    // VS Code tears down the extension-host RPC during a successful reload.
    // Its pending executeCommand promise then rejects with CancellationError.
    // That is an unknown RPC outcome, not evidence that the reload failed;
    // restoring here would make the new host read the outgoing account again.
    if (error && typeof error === 'object' && 'name' in error && 'message' in error &&
        error.name === 'Canceled' && error.message === 'Canceled') return;
    throw error;
  }
}

export class AccountSwitcher {
  constructor(readonly vault: AccountVault, readonly native: NativeAuth) {}

  current() {
    const raw = this.native.read();
    return raw === undefined ? undefined : parseAuth(raw);
  }

  saveCurrent(label?: string) {
    return this.native.exclusive(async () => {
      const raw = this.native.read();
      if (!raw) throw new SwitchError('請先在官方 Codex 登入，再儲存目前帳號。');
      return this.vault.save(raw, label);
    });
  }

  rename(id: string, label: string) {return this.native.exclusive(() => this.vault.rename(id, label));}
  remove(id: string) {return this.native.exclusive(() => this.vault.remove(id));}

  installLogin(raw: string, reload: () => PromiseLike<unknown>, expectedId?: string) {
    return this.native.exclusive(async () => {
      const fresh = parseAuth(raw);
      if (expectedId && fresh.id !== expectedId) throw new SwitchError('登入帳號不符，請在瀏覽器選擇要修復的原帳號與工作區。');
      const original = this.native.read();
      // Repairing the active identity must not replace a new OAuth session with
      // the revoked outgoing session, as the ordinary same-account path would.
      if (original && parseAuth(original).id !== fresh.id) await this.vault.save(original);
      await this.vault.save(raw);
      this.native.replace(original, raw);
      // A fresh login repairs invalid credentials. Never resurrect that invalid
      // session just because automatic reload is unavailable.
      try {await reloadWindow(reload);}
      catch {throw new SwitchError('新登入已保存並套用，請手動執行 Developer: Reload Window 完成重新載入。');}
    });
  }

  private async reloadOrRestore(target: string, original: string | undefined, reload: () => PromiseLike<unknown>) {
    try {await reloadWindow(reload);}
    catch {
      try {this.native.replace(target, original);}
      catch {throw new SwitchError('重新載入失敗，且登入資料已被其他程序變更；請核對官方 Codex 帳號後手動重新載入。');}
      throw new SwitchError('重新載入失敗，已還原原本登入資料；可重新嘗試切換。');
    }
  }

  switchTo(id: string, reload: () => PromiseLike<unknown>) {
    return this.native.exclusive(async () => {
      const target = await this.vault.auth(id);
      parseAuth(target);
      const original = this.native.read();
      if (original !== undefined) {
        if (parseAuth(original).id === id) {
          await this.vault.save(original);
          if (this.native.read() !== original) throw new SwitchError('登入資料已被其他 Codex 程序變更，請重新選擇帳號。');
          await reloadWindow(reload);
          return;
        }
        // Preserve rotated refresh tokens before replacing the active cache.
        await this.vault.save(original);
      }
      this.native.replace(original, target);
      await this.reloadOrRestore(target, original, reload);
    });
  }
}
