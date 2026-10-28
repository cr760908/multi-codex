import { request, type RequestOptions } from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { parseAuth, SwitchError } from './Auth';

export interface QuotaWindow {minutes: number | null; usedPercent: number; resetsAt: number | null}
export interface Quota {windows: QuotaWindow[]; updatedAt: number}
type QuotaRequest = (url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest;
const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const MAX_RESPONSE_BYTES = 1024 * 1024;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function parseQuota(value: unknown): Quota {
  const response = record(value);
  const buckets = record(response.rateLimitsByLimitId);
  const bucket = record(buckets.codex ?? response.rate_limit ?? response.rateLimits);
  const windows: QuotaWindow[] = [];
  for (const value of [bucket.primary_window ?? bucket.primary, bucket.secondary_window ?? bucket.secondary]) {
    if (value == null) continue;
    const w = record(value), used = w.used_percent ?? w.usedPercent;
    const seconds = w.limit_window_seconds;
    if (seconds != null && (typeof seconds !== 'number' || !Number.isSafeInteger(seconds) || seconds <= 0 || seconds % 60 !== 0)) throw new Error('Invalid quota window');
    const minutes = typeof seconds === 'number' ? seconds / 60 : w.windowDurationMins;
    const resetsAt = w.reset_at ?? w.resetsAt;
    if (typeof used !== 'number' || !Number.isFinite(used) || used < 0) throw new Error('Invalid quota');
    if (minutes != null && (typeof minutes !== 'number' || !Number.isSafeInteger(minutes) || minutes <= 0)) throw new Error('Invalid quota window');
    if (resetsAt != null && (typeof resetsAt !== 'number' || !Number.isSafeInteger(resetsAt) || resetsAt < 0 || resetsAt > 8640000000000)) throw new Error('Invalid quota reset');
    windows.push({minutes: minutes as number | null ?? null, usedPercent: used, resetsAt: resetsAt as number | null ?? null});
  }
  if (!windows.length) throw new Error('Quota unavailable');
  return {windows, updatedAt: Date.now()};
}

export function windowLabel(minutes: number | null): string {
  if (minutes === 10080) return 'Week';
  if (minutes === null) return '額度';
  return minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
}

export function quotaText(quota: Quota): string {
  return [...quota.windows].sort((a,b)=>(a.minutes ?? Infinity)-(b.minutes ?? Infinity))
    .map(w=>`${windowLabel(w.minutes)} ${w.usedPercent}%`).join('／');
}

// Fixed-origin HTTPS only. No redirects, credential renewal or subprocess fallback.
// The endpoint is undocumented; reject unknown responses and retain cached results.
export class QuotaReader {
  constructor(private readonly transport: QuotaRequest = request, private readonly timeoutMs = 10000) {}

  async read(raw: string, signal?: AbortSignal): Promise<Quota> {
    if (signal?.aborted) throw new SwitchError('額度查詢已取消。');
    const identity = parseAuth(raw), accessToken: string = JSON.parse(raw).tokens.access_token;
    return new Promise<Quota>((resolve, reject) => {
      let req: ClientRequest | undefined, response: IncomingMessage | undefined;
      let settled = false;
      const finish = (error?: string, quota?: Quota) => {
        if (settled) return;
        settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (error) {
          response?.destroy(); req?.destroy();
          reject(new SwitchError(error));
        } else resolve(quota!);
      };
      const failed = () => finish('無法取得額度：連線失敗或回應格式不支援，請稍後重試。');
      const abort = () => finish('額度查詢已取消。');
      // A wall-clock deadline also covers DNS/TLS and slow streaming responses.
      const timer = setTimeout(() => finish('額度查詢逾時，請稍後重試。'), this.timeoutMs);
      signal?.addEventListener('abort', abort, {once: true});
      try {
        req = this.transport(new URL(USAGE_URL), {method: 'GET', headers: {
          Authorization: 'Bearer ' + accessToken, 'ChatGPT-Account-Id': identity.accountId,
          Accept: 'application/json', 'User-Agent': 'multi-codex-account-switcher',
        }}, res => {
          response = res;
          res.on('error', failed); res.on('aborted', failed);
          if (settled) {res.destroy(); return;}
          if (res.statusCode === 401 || res.statusCode === 403) {
            finish('額度查詢未通過驗證（HTTP ' + res.statusCode + '），請檢查登入或使用「重新登入並修復帳號」。'); return;
          }
          if (res.statusCode === 429) {finish('額度查詢過於頻繁（HTTP 429），請稍後再試。'); return;}
          if (res.statusCode !== 200) {failed(); return;}
          const chunks: Buffer[] = []; let bytes = 0;
          res.on('data', (chunk: Buffer) => {
            if (settled) return;
            bytes += chunk.length;
            if (bytes > MAX_RESPONSE_BYTES) {failed(); return;}
            chunks.push(chunk);
          });
          res.on('end', () => {
            if (settled) return;
            try {
              const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              const reportedId = record(value).account_id ?? record(value).accountId;
              if (reportedId != null && reportedId !== identity.accountId) throw new Error();
              finish(undefined, parseQuota(value));
            } catch {failed();}
          });
          res.on('close', () => {if (!res.complete) failed();});
        });
        req.on('error', failed);
        if (signal?.aborted) {abort(); return;}
        req.end();
      } catch {failed();}
    });
  }
}
