import { existsSync, lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { plainDirectory, plainFile } from '../storage/PathGuard';
import type { Quota, QuotaWindow } from './Quota';

// The first pass waits five seconds; each caller selects the foreground or
// background interval. Windows reuse shared results instead of polling per tick.
export const QUOTA_STARTUP_DELAY_MS = 5000;
const DEFAULT_MINUTES = 1, MIN_MINUTES = 1, MAX_MINUTES = 1440, MAX_BACKOFF_MS = 6 * 60 * 60000;

export function quotaIntervalMs(minutes: unknown): number {
  const value = typeof minutes === 'number' && Number.isFinite(minutes) ? minutes : DEFAULT_MINUTES;
  return Math.min(Math.max(value, MIN_MINUTES), MAX_MINUTES) * 60000;
}

// After consecutive failures wait 1, 2, 4, … intervals, capped at six hours
// (or the interval itself when that is longer), so a broken helper is not
// restarted at a fixed rate.
export function quotaRetryDelay(intervalMs: number, failures = 0): number {
  if (failures <= 1) return intervalMs;
  return Math.min(intervalMs * 2 ** Math.min(failures - 1, 16), Math.max(MAX_BACKOFF_MS, intervalMs));
}

export interface QuotaTiming {force: boolean; focused: boolean; now: number; activatedAt: number; intervalMs: number; lastAttempt?: number; failures?: number}

export function quotaWindowOpen(t: QuotaTiming): boolean {
  return t.force || t.now >= t.activatedAt + QUOTA_STARTUP_DELAY_MS;
}

export function quotaDue(t: QuotaTiming & {credentialsChanged: boolean}): boolean {
  if (t.force) return true;
  if (!quotaWindowOpen(t)) return false;
  // A last attempt in the future means the clock moved back; do not stall until it catches up.
  return t.credentialsChanged || t.lastAttempt === undefined || t.lastAttempt > t.now || t.now - t.lastAttempt >= quotaRetryDelay(t.intervalMs, t.failures);
}

// A short fingerprint of saved credentials: enough to notice that they changed,
// useless for recovering them.
export function authFingerprint(raw: string): string {
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

// checkedAt: when the latest query started (a claim and its result share it).
// revision: changes on every write, so a window that saw the claim still adopts the result.
// failedAuth: fingerprint of the credentials whose last query failed.
export interface QuotaRecord {checkedAt: number; revision: string; quota?: Quota; error?: string; failures?: number; failedAuth?: string}
interface CacheFile {version: 1; accounts: Record<string, QuotaRecord>}
const MAX_ENTRIES = 100, MAX_BYTES = 256 * 1024;

function finite(value: unknown): value is number {return typeof value === 'number' && Number.isFinite(value);}
function nullableInt(value: unknown, min: number) {return value === null || (Number.isSafeInteger(value) && (value as number) >= min);}

function validWindow(value: unknown): value is QuotaWindow {
  const w = value as QuotaWindow;
  return !!w && typeof w === 'object' && nullableInt(w.minutes, 1) && finite(w.usedPercent) && w.usedPercent >= 0 && nullableInt(w.resetsAt, 0);
}

function record(value: unknown): QuotaRecord | undefined {
  const r = value as QuotaRecord;
  if (!r || typeof r !== 'object' || !finite(r.checkedAt) || typeof r.revision !== 'string' || !/^[0-9a-f-]{36}$/.test(r.revision)) return;
  if (r.failedAuth !== undefined && (typeof r.failedAuth !== 'string' || !/^[0-9a-f]{16}$/.test(r.failedAuth))) return;
  if (r.error !== undefined && (typeof r.error !== 'string' || r.error.length > 500)) return;
  if (r.failures !== undefined && !(Number.isSafeInteger(r.failures) && r.failures > 0 && r.failures <= 1000)) return;
  const q = r.quota;
  if (q !== undefined && (!q || !finite(q.updatedAt) || !Array.isArray(q.windows) || !q.windows.length || q.windows.length > 4 || !q.windows.every(validWindow))) return;
  return {checkedAt: r.checkedAt, revision: r.revision,
    ...(q ? {quota: {windows: q.windows.map(w => ({minutes: w.minutes, usedPercent: w.usedPercent, resetsAt: w.resetsAt})), updatedAt: q.updatedAt}} : {}),
    ...(r.error !== undefined ? {error: r.error} : {}),
    ...(r.failures ? {failures: r.failures} : {}),
    ...(r.failedAuth !== undefined ? {failedAuth: r.failedAuth} : {})};
}

// Quota results shared by every VS Code window of this profile, so opening or
// reloading a window does not query again. Holds no credentials (only the short
// fingerprint above). Failures to read
// or write only cost an extra query later; callers still throttle in memory.
export class QuotaCache {
  constructor(private readonly file: string) {}

  // Serialize HTTP queries across extension hosts. The request itself has a
  // ten-second deadline; a one-minute lease recovers after a crashed window.
  acquire(): (()=>void)|undefined {
    const lock=join(dirname(this.file),'.quota-query.lock');
    plainDirectory(dirname(this.file));plainFile(lock);
    if(existsSync(lock)){
      try{
        const prior=readFileSync(lock,'utf8');let created=lstatSync(lock).mtimeMs;
        try{const value=JSON.parse(prior);if(typeof value.at==='number'&&Number.isFinite(value.at))created=value.at;}catch{}
        if(Date.now()-created<60000)return;
        if(readFileSync(lock,'utf8')===prior)unlinkSync(lock);
      }catch{return;}
    }
    const owner=JSON.stringify({at:Date.now(),nonce:randomUUID()});
    try{writeFileSync(lock,owner,{flag:'wx',mode:0o600});}
    catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')return;throw error;}
    return()=>{try{if(readFileSync(lock,'utf8')===owner)unlinkSync(lock);}catch{}};
  }

  private load(): Record<string, QuotaRecord> {
    try {
      if (!existsSync(this.file)) return {};
      const stat = lstatSync(this.file);
      if (!stat.isFile() || stat.size > MAX_BYTES) return {};
      const data = JSON.parse(readFileSync(this.file, 'utf8')) as CacheFile;
      if (data?.version !== 1 || !data.accounts || typeof data.accounts !== 'object') return {};
      const accounts: Record<string, QuotaRecord> = {};
      for (const [id, value] of Object.entries(data.accounts)) {
        const valid = record(value);
        if (valid) accounts[id] = valid;
      }
      return accounts;
    } catch {return {};}
  }

  private save(accounts: Record<string, QuotaRecord>): boolean {
    const kept = Object.entries(accounts).sort(([, a], [, b]) => b.checkedAt - a.checkedAt).slice(0, MAX_ENTRIES);
    let temp: string | undefined;
    try {
      plainDirectory(dirname(this.file));
      plainFile(this.file);
      temp = join(dirname(this.file), `.quota-cache-${randomUUID()}.tmp`);
      writeFileSync(temp, JSON.stringify({version: 1, accounts: Object.fromEntries(kept)}), {flag: 'wx', mode: 0o600});
      renameSync(temp, this.file);
      temp = undefined;
      return true;
    } catch {
      // Another window may hold the file briefly; the in-memory throttle still applies.
      return false;
    } finally {
      if (temp) try {unlinkSync(temp);} catch {}
    }
  }

  get(id: string): QuotaRecord | undefined {return this.load()[id];}

  // Returns the new revision, or undefined when the record could not be written.
  set(id: string, value: Omit<QuotaRecord, 'revision'>): string | undefined {
    const valid = record({...value, revision: randomUUID()});
    if (!valid) return;
    const accounts = this.load();
    accounts[id] = valid;
    return this.save(accounts) ? valid.revision : undefined;
  }

  delete(id: string) {
    const accounts = this.load();
    if (!(id in accounts)) return;
    delete accounts[id];
    this.save(accounts);
  }
}
