import { createHash } from 'node:crypto';

export class SwitchError extends Error {}
export interface AccountIdentity {id: string; email: string; accountId: string}

// JWT claims identify a locally saved login; they are not proof of server authentication.
export function parseAuth(raw: string): AccountIdentity {
  try {
    if (Buffer.byteLength(raw) > 256 * 1024) throw new Error();
    const value = JSON.parse(raw);
    if (!value || value.OPENAI_API_KEY || (value.auth_mode && value.auth_mode !== 'chatgpt')) throw new Error();
    const tokens = value.tokens;
    for (const key of ['id_token', 'access_token', 'refresh_token', 'account_id']) {
      if (typeof tokens?.[key] !== 'string' || !tokens[key].trim()) throw new Error();
    }
    const parts = tokens.id_token.split('.');
    if (parts.length !== 3) throw new Error();
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const email = (claims.email ?? claims['https://api.openai.com/profile']?.email)?.trim().toLowerCase();
    if (typeof email !== 'string' || email.length > 254 || !/^[^\s@\x00-\x1f\x7f]+@[^\s@\x00-\x1f\x7f]+$/.test(email)) throw new Error();
    const accountId: string = tokens.account_id;
    if (accountId.length > 256 || /[\x00-\x1f\x7f]/.test(accountId)) throw new Error();
    const claimId = claims['https://api.openai.com/auth']?.chatgpt_account_id;
    if (claimId !== undefined && claimId !== accountId) throw new Error();
    return {id: createHash('sha256').update(`${accountId}\0${email}`).digest('hex'), email, accountId};
  } catch {
    throw new SwitchError('登入資料格式不支援，請先在官方 Codex 使用 ChatGPT 帳號登入。');
  }
}

export function accountLabel(value: string): string {
  const label = value.trim();
  if (!label || label.length > 80 || /[\x00-\x1f\x7f]/.test(label)) throw new SwitchError('名稱需為 1–80 個字元，不能包含控制字元。');
  return label;
}
