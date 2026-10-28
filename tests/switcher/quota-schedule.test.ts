import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authFingerprint, QuotaCache, quotaDue, quotaIntervalMs, quotaRetryDelay, quotaWindowOpen, QUOTA_STARTUP_DELAY_MS } from '../../src/switcher/QuotaSchedule';

const minute = 60000;
const base = {force: false, focused: true, activatedAt: 0, intervalMs: 10 * minute, credentialsChanged: false};

test('automatic queries start after five seconds in either focus state and respect the selected interval', () => {
  const later = QUOTA_STARTUP_DELAY_MS + 1;
  assert.equal(quotaWindowOpen({...base, now: 4999}), false);
  assert.equal(quotaWindowOpen({...base, now: 5000}), true);
  assert.equal(quotaWindowOpen({...base, now: 5000, focused: false}), true);
  assert.equal(quotaWindowOpen({...base, now: later}), true);
  assert.equal(quotaDue({...base, now: later}), true);
  assert.equal(quotaDue({...base, now: later, lastAttempt: later - 9 * minute}), false);
  assert.equal(quotaDue({...base, now: later, lastAttempt: later - 10 * minute}), true);
  assert.equal(quotaDue({...base, now: later, focused: false}), true);
  assert.equal(quotaDue({...base, now: later, lastAttempt: later + 60 * minute}), true, 'clock moved back');
});

test('changed credentials after a failure retry early; manual refresh always runs', () => {
  const now = QUOTA_STARTUP_DELAY_MS + minute;
  assert.equal(quotaDue({...base, now, lastAttempt: now - 1000, credentialsChanged: true}), true);
  assert.equal(quotaDue({...base, now: 0, focused: false, lastAttempt: 0, force: true}), true);
  assert.equal(quotaWindowOpen({...base, now: 0, focused: false, force: true}), true);
});

test('consecutive failures back off exponentially up to six hours instead of retrying at a fixed rate', () => {
  const interval = 10 * minute, now = QUOTA_STARTUP_DELAY_MS + 24 * 60 * minute;
  assert.equal(quotaRetryDelay(interval, 0), interval);
  assert.equal(quotaRetryDelay(interval, 1), interval);
  assert.equal(quotaRetryDelay(interval, 2), 2 * interval);
  assert.equal(quotaRetryDelay(interval, 3), 4 * interval);
  assert.equal(quotaRetryDelay(interval, 50), 6 * 60 * minute);
  assert.equal(quotaRetryDelay(1440 * minute, 5), 1440 * minute, 'backoff never shortens a long interval');
  assert.equal(quotaDue({...base, now, lastAttempt: now - 30 * minute, failures: 3}), false);
  assert.equal(quotaDue({...base, now, lastAttempt: now - 40 * minute, failures: 3}), true);
  assert.equal(quotaDue({...base, now, lastAttempt: now - minute, failures: 9, credentialsChanged: true}), true, 'repaired credentials retry at once');
});

test('interval setting is clamped so polling cannot become aggressive', () => {
  assert.equal(quotaIntervalMs(undefined), minute);
  assert.equal(quotaIntervalMs(1), minute);
  assert.equal(quotaIntervalMs(0), minute);
  assert.equal(quotaIntervalMs(30), 30 * minute);
  assert.equal(quotaIntervalMs(100000), 1440 * minute);
  assert.equal(quotaIntervalMs(Number.NaN), minute);
});

test('shared cache round-trips results across instances and tolerates corruption', t => {
  const root = mkdtempSync(join(tmpdir(), 'codex-quota-cache-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const file = join(root, 'storage', 'quota-cache.json');
  const quota = {windows: [{minutes: 300, usedPercent: 20, resetsAt: 1900000000}], updatedAt: 1000};
  const failedAuth = authFingerprint('credentials');
  const a = new QuotaCache(file).set('a', {checkedAt: 1000, quota});
  const b = new QuotaCache(file).set('b', {checkedAt: 2000, quota, error: '無法取得額度', failures: 3, failedAuth});
  const other = new QuotaCache(file);
  assert.deepEqual(other.get('a'), {checkedAt: 1000, revision: a, quota});
  assert.deepEqual(other.get('b'), {checkedAt: 2000, revision: b, quota, error: '無法取得額度', failures: 3, failedAuth});
  // A result written with the same start time as its claim is still a new revision.
  const claim = other.set('a', {checkedAt: 3000});
  const result = other.set('a', {checkedAt: 3000, quota});
  assert.ok(claim && result && claim !== result);
  assert.equal(new QuotaCache(file).get('a')?.revision, result);
  other.delete('a');
  assert.equal(new QuotaCache(file).get('a'), undefined);
  assert.deepEqual(readdirSync(join(root, 'storage')), ['quota-cache.json']);
  for (const bad of ['{', JSON.stringify({version: 1, accounts: {a: {checkedAt: 'x'}}}), JSON.stringify({version: 1, accounts: {a: {checkedAt: 1, quota: {windows: [{usedPercent: -1}], updatedAt: 1}}}})]) {
    writeFileSync(file, bad);
    assert.equal(other.get('a'), undefined);
  }
});

test('shared cache stores only quota metadata, never credentials', t => {
  const root = mkdtempSync(join(tmpdir(), 'codex-quota-cache-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const file = join(root, 'quota-cache.json');
  const raw = JSON.stringify({tokens: {access_token: 'secret-access', refresh_token: 'secret-refresh'}});
  new QuotaCache(file).set('id', {checkedAt: 1, quota: {windows: [{minutes: 300, usedPercent: 1, resetsAt: null}], updatedAt: 1}, failedAuth: authFingerprint(raw), access_token: 'secret'} as any);
  const stored = readFileSync(file, 'utf8');
  assert.ok(!stored.includes('secret'), stored);
  assert.match(JSON.parse(stored).accounts.id.failedAuth, /^[0-9a-f]{16}$/);
});
test('query leases serialize windows and recover a stale incomplete lock after a crash',t=>{
  const root=mkdtempSync(join(tmpdir(),'codex-quota-lease-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const cache=new QuotaCache(join(root,'quota-cache.json'));
  const release=cache.acquire();assert.ok(release);assert.equal(cache.acquire(),undefined);release();
  const lock=join(root,'.quota-query.lock');writeFileSync(lock,'');
  assert.equal(cache.acquire(),undefined,'an in-progress lock write must not be removed');
  const old=new Date(Date.now()-120000);utimesSync(lock,old,old);
  const recovered=cache.acquire();assert.ok(recovered,'a crashed partial write must not disable quota forever');recovered();
});
