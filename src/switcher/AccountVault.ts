import { accountLabel, parseAuth, SwitchError, type AccountIdentity } from './Auth';

export interface SecretStore {get(key: string): PromiseLike<string | undefined>; store(key: string, value: string): PromiseLike<void>}
export interface SavedAccount extends AccountIdentity {label: string}
interface Entry {id: string; label: string; auth: string}
const key = 'multiCodex.nativeAccounts.v1';

export class AccountVault {
  constructor(private readonly secrets: SecretStore) {}

  private async entries(): Promise<Entry[]> {
    const raw = await this.secrets.get(key);
    if (raw === undefined) return [];
    try {
      const data = JSON.parse(raw);
      if (data.version !== 1 || !Array.isArray(data.accounts) || data.accounts.length > 100) throw new Error();
      const seen = new Set<string>();
      for (const entry of data.accounts) {
        if (typeof entry.auth !== 'string' || parseAuth(entry.auth).id !== entry.id || seen.has(entry.id) || accountLabel(entry.label) !== entry.label) throw new Error();
        seen.add(entry.id);
      }
      return data.accounts;
    } catch {
      throw new SwitchError('已儲存帳號的格式無法讀取；原資料已保留。');
    }
  }

  private async write(accounts: Entry[]) {
    await this.secrets.store(key, JSON.stringify({version: 1, accounts}));
  }

  async list(): Promise<SavedAccount[]> {
    return (await this.entries()).map(e => ({...parseAuth(e.auth), label: e.label}));
  }

  async auth(id: string): Promise<string> {
    const entry = (await this.entries()).find(e => e.id === id);
    if (!entry) throw new SwitchError('找不到此已儲存帳號，請重新開啟帳號清單。');
    return entry.auth;
  }

  async save(raw: string, label?: string): Promise<SavedAccount> {
    const identity = parseAuth(raw);
    const entries = await this.entries();
    const existing = entries.find(e => e.id === identity.id);
    const name = accountLabel(label ?? existing?.label ?? (identity.email.length > 80 ? identity.email.slice(0, 77) + '…' : identity.email));
    if (existing) {existing.auth = raw; existing.label = name;}
    else {
      if (entries.length >= 100) throw new SwitchError('已達 100 個儲存帳號上限。');
      entries.push({id: identity.id, label: name, auth: raw});
    }
    await this.write(entries);
    return {...identity, label: name};
  }

  async rename(id: string, label: string) {
    const entries = await this.entries();
    const entry = entries.find(e => e.id === id);
    if (!entry) throw new SwitchError('找不到此已儲存帳號。');
    entry.label = accountLabel(label);
    await this.write(entries);
  }

  async remove(id: string) {
    const entries = await this.entries();
    if (!entries.some(e => e.id === id)) throw new SwitchError('找不到此已儲存帳號。');
    await this.write(entries.filter(e => e.id !== id));
  }
}
