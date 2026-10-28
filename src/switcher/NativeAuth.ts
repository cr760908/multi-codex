import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse } from 'smol-toml';
import { SwitchError } from './Auth';

function plain(path: string) {
  let ancestor = resolve(path);
  while (!existsSync(ancestor)) {
    // Also catches dangling links, for which existsSync returns false.
    try {if (lstatSync(ancestor).isSymbolicLink()) throw new SwitchError('登入資料路徑不能使用符號連結。');}
    catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new SwitchError('找不到登入資料目錄。');
    ancestor = parent;
  }
  if (realpathSync(ancestor).toLowerCase() !== ancestor.toLowerCase() || lstatSync(ancestor).isSymbolicLink()) {
    throw new SwitchError('登入資料路徑經過重新導向，無法安全切換。');
  }
}

function checkConfig(value: unknown) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'cli_auth_credentials_store' && child !== 'file') {
      throw new SwitchError('目前只支援 file 登入儲存。請先將 Codex 的 cli_auth_credentials_store 設為 "file"，重新載入並登入後再儲存帳號。');
    }
    if (key === 'forced_login_method' && child !== 'chatgpt') throw new SwitchError('Codex 設定限制了登入方式，不能切換 ChatGPT 帳號。');
    if (key === 'forced_chatgpt_workspace_id') throw new SwitchError('Codex 設定已固定 ChatGPT 工作區；此版本不支援在這項限制下切換帳號。');
    checkConfig(child);
  }
}

export class NativeAuth {
  readonly file: string;
  constructor(readonly home: string, private readonly additionalConfigs: string[] | (() => string[]) = []) {
    if (!isAbsolute(home) || /^[\\/]{2}/.test(home)) throw new SwitchError('Codex 登入目錄必須是本機絕對路徑。');
    this.file = join(home, 'auth.json');
  }

  private check() {
    plain(this.home); plain(this.file);
    const configs = typeof this.additionalConfigs === 'function' ? this.additionalConfigs() : this.additionalConfigs;
    for (const file of [join(this.home, 'config.toml'), ...configs]) {
      plain(file);
      if (!existsSync(file)) continue;
      try {checkConfig(parse(readFileSync(file, 'utf8')));}
      catch (error) {
        if (error instanceof SwitchError) throw error;
        throw new SwitchError('無法解析 Codex 設定，請先修正 config.toml。');
      }
    }
  }

  read(): string | undefined {
    this.check();
    if (!existsSync(this.file)) return undefined;
    const stat = lstatSync(this.file);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 256 * 1024) throw new SwitchError('登入資料不是支援的一般檔案。');
    return readFileSync(this.file, 'utf8');
  }

  replace(expected: string | undefined, next: string | undefined) {
    if (this.read() !== expected) throw new SwitchError('登入資料已被其他 Codex 程序變更，請重新選擇帳號。');
    if (next === undefined) {if (expected !== undefined) unlinkSync(this.file); return;}
    const temp = join(this.home, `.multi-codex-auth-${randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
      fd = openSync(temp, 'wx', 0o600);
      writeFileSync(fd, next, 'utf8'); fsyncSync(fd); closeSync(fd); fd = undefined;
      if (this.read() !== expected) throw new SwitchError('登入資料已被其他 Codex 程序變更，請重試。');
      renameSync(temp, this.file);
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (existsSync(temp)) unlinkSync(temp);
    }
  }

  async exclusive<T>(action: () => Promise<T>): Promise<T> {
    this.check();
    mkdirSync(this.home, {recursive: true});
    const lock = join(this.home, '.multi-codex-switch.lock');
    plain(lock);
    if (existsSync(lock)) {
      let stale = false;
      const previous = readFileSync(lock, 'utf8');
      try {
        const pid = JSON.parse(previous).pid;
        if (Number.isSafeInteger(pid) && pid > 0) {
          try {process.kill(pid, 0);} catch (error) {stale = (error as NodeJS.ErrnoException).code === 'ESRCH';}
        }
      } catch {}
      if (stale && readFileSync(lock, 'utf8') === previous) unlinkSync(lock);
    }
    const token = JSON.stringify({pid: process.pid, id: randomUUID()});
    try {writeFileSync(lock, token, {flag: 'wx', mode: 0o600});}
    catch {throw new SwitchError('另一個帳號操作正在進行，請稍後再切換。');}
    try {return await action();}
    finally {if (existsSync(lock) && readFileSync(lock, 'utf8') === token) unlinkSync(lock);}
  }
}
