import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAuth } from '../../src/switcher/Auth';
import { AccountVault } from '../../src/switcher/AccountVault';
import { NativeAuth } from '../../src/switcher/NativeAuth';
import { AccountSwitcher } from '../../src/switcher/AccountSwitcher';

export function auth(email: string, token = 'initial', accountId = email): string {
  const payload = Buffer.from(JSON.stringify({email, sub: email, 'https://api.openai.com/auth': {chatgpt_account_id: accountId}})).toString('base64url');
  return JSON.stringify({auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: {id_token: `header.${payload}.signature`, access_token: `access-${token}`, refresh_token: `refresh-${token}`, account_id: accountId}, last_refresh: '2026-09-08T00:00:00Z'});
}

function fixture(t: test.TestContext) {
  const home = mkdtempSync(join(tmpdir(), 'codex-switch-test-'));
  t.after(() => rmSync(home, {recursive: true, force: true}));
  let secret: string | undefined;
  const storage = {get: async (_key: string) => secret, store: async (_key: string, value: string) => { secret = value; }};
  const vault = new AccountVault(storage);
  const native = new NativeAuth(home);
  const service = new AccountSwitcher(vault, native);
  const put = (raw: string) => writeFileSync(join(home, 'auth.json'), raw);
  return {home, vault, native, service, storage, put, raw: () => readFileSync(join(home, 'auth.json'), 'utf8')};
}

test('the vault lists 100 accounts, rejects a 101st, and still permits updating an existing account',async t=>{
  const f=fixture(t);
  for(let i=0;i<100;i++)await f.vault.save(auth(`account-${i}@example.test`));
  assert.equal((await f.vault.list()).length,100);
  await assert.rejects(f.vault.save(auth('overflow@example.test')),/100/);
  await f.vault.save(auth('account-0@example.test','rotated'));
  assert.equal((await f.vault.list()).length,100);
});

test('A→B→A preserves native refresh tokens and settings, and only requests same-window reload', async t => {
  const f = fixture(t);
  writeFileSync(join(f.home, 'config.toml'), 'model = "example"\ncli_auth_credentials_store = "file"\n');
  f.put(auth('a@example.test')); const a = await f.service.saveCurrent('Personal');
  f.put(auth('b@example.test')); const b = await f.service.saveCurrent('Work');
  let reloads = 0;
  await f.service.switchTo(a.id, async () => {reloads++;});
  assert.equal(f.raw(), auth('a@example.test'));
  f.put(auth('a@example.test', 'rotated'));
  await f.service.switchTo(b.id, async () => {reloads++;});
  assert.equal(f.raw(), auth('b@example.test'));
  await f.service.switchTo(a.id, async () => {reloads++;});
  assert.equal(f.raw(), auth('a@example.test', 'rotated'));
  assert.equal(reloads, 3);
  assert.equal(readFileSync(join(f.home, 'config.toml'), 'utf8'), 'model = "example"\ncli_auth_credentials_store = "file"\n');
  assert.deepEqual((await f.vault.list()).map(x => x.label), ['Personal', 'Work']);
  assert.ok(!(JSON.stringify(await f.vault.list())).includes('refresh-'));
});

test('failed reload restores the original auth file and retains saved accounts', async t => {
  const f = fixture(t); f.put(auth('a@example.test')); const a = await f.service.saveCurrent();
  f.put(auth('b@example.test'));
  await assert.rejects(f.service.switchTo(a.id, async () => {throw new Error('reload failed');}), /還原/);
  assert.equal(f.raw(), auth('b@example.test'));
  assert.equal((await f.vault.list()).length, 2);
});

test('VS Code shutdown cancellation retains the selected auth for the reloaded extension host', async t => {
  const f = fixture(t); f.put(auth('a@example.test')); const a = await f.service.saveCurrent();
  f.put(auth('b@example.test'));
  await f.service.switchTo(a.id, async () => {
    const canceled = new Error('Canceled'); canceled.name = 'Canceled'; throw canceled;
  });
  assert.equal(f.raw(), auth('a@example.test'));
  assert.equal((await f.vault.list()).length, 2);
  // The old host must release the switch lock even though its reload RPC was canceled.
  await new NativeAuth(f.home).exclusive(async () => {});
});

test('rollback never overwrites credentials changed by another client', async t => {
  const f = fixture(t); f.put(auth('a@example.test')); const a = await f.service.saveCurrent();
  f.put(auth('b@example.test'));
  await assert.rejects(f.service.switchTo(a.id, async () => {f.put(auth('c@example.test')); throw new Error('failed');}), /其他/);
  assert.equal(f.raw(), auth('c@example.test'));
});

test('switch from signed out can roll back to no auth file', async t => {
  const f = fixture(t); f.put(auth('a@example.test')); const a = await f.service.saveCurrent();
  rmSync(join(f.home, 'auth.json'));
  await assert.rejects(f.service.switchTo(a.id, async () => {throw new Error('failed');}), /還原/);
  assert.equal(existsSync(join(f.home, 'auth.json')), false);
});

test('concurrent file changes while saving outgoing auth abort the switch', async t => {
  const f = fixture(t); f.put(auth('a@example.test')); const a = await f.service.saveCurrent();
  f.put(auth('b@example.test'));
  const original = f.storage.store;
  f.storage.store = async (key, value) => {await original(key, value); f.put(auth('c@example.test'));};
  await assert.rejects(f.service.switchTo(a.id, async () => {assert.fail('must not reload');}), /變更/);
  assert.equal(f.raw(), auth('c@example.test'));
});

test('secret storage failures and unknown schema leave native auth untouched', async t => {
  const f = fixture(t); f.put(auth('a@example.test')); const a = await f.service.saveCurrent();
  f.put(auth('b@example.test'));
  f.storage.store = async () => {throw new Error('storage locked');};
  await assert.rejects(f.service.switchTo(a.id, async () => {assert.fail();}));
  assert.equal(f.raw(), auth('b@example.test'));
  f.storage.get = async () => '{"version":999,"accounts":[]}';
  await assert.rejects(f.vault.list(), /格式/);
  assert.equal(f.raw(), auth('b@example.test'));
});

test('file storage checks parse TOML correctly and refuse keyring or malformed configuration', t => {
  const f = fixture(t); f.put(auth('a@example.test'));
  for (const config of ['cli_auth_credentials_store = "keyring"', 'cli_auth_credentials_store = "auto"', '"cli_auth_credentials_store" = \'keyring\'', '[profiles.work]\ncli_auth_credentials_store = "keyring"', 'broken = [']) {
    writeFileSync(join(f.home, 'config.toml'), config);
    assert.throws(() => f.native.read(), /設定|file/);
  }
  writeFileSync(join(f.home, 'config.toml'), '# cli_auth_credentials_store = "keyring"\ncli_auth_credentials_store = "file"');
  assert.equal(f.native.read(), auth('a@example.test'));
});

test('exclusive lock prevents another window from entering credential operations', async t => {
  const f = fixture(t); f.put(auth('a@example.test'));
  await f.native.exclusive(async () => {
    await assert.rejects(new NativeAuth(f.home).exclusive(async () => {}), /切換/);
  });
  await f.service.saveCurrent();
  assert.equal((await f.vault.list()).length, 1);
});

test('invalid auth does not expose raw credentials and account identity includes workspace', () => {
  for (const raw of ['secret-token-invalid-json', '{}', JSON.stringify({OPENAI_API_KEY: 'secret-api-key'}), auth('bad\nemail')]) {
    assert.throws(() => parseAuth(raw), error => error instanceof Error && !error.message.includes('secret-'));
  }
  assert.notEqual(parseAuth(auth('a@example.test', 'x', 'workspace-1')).id, parseAuth(auth('a@example.test', 'x', 'workspace-2')).id);
});

test('rename and remove affect only the selected saved account, never the active login', async t => {
  const f = fixture(t); f.put(auth('a@example.test')); const a = await f.service.saveCurrent();
  await f.service.rename(a.id, 'Renamed');
  assert.equal((await f.vault.list())[0].label, 'Renamed');
  await f.service.remove(a.id);
  assert.deepEqual(await f.vault.list(), []);
  assert.equal(f.raw(), auth('a@example.test'));
  await assert.rejects(f.service.switchTo(a.id, async () => {assert.fail();}), /找不到/);
});

test('reselecting current account preserves its refreshed auth instead of restoring a stale snapshot', async t => {
  const f = fixture(t); f.put(auth('a@example.test')); const a = await f.service.saveCurrent();
  f.put(auth('a@example.test', 'rotated'));
  await f.service.switchTo(a.id, async () => {});
  assert.equal(f.raw(), auth('a@example.test', 'rotated'));
  assert.equal(await f.vault.auth(a.id), auth('a@example.test', 'rotated'));
});

test('reselecting current account refuses a concurrent login change before reload', async t => {
  const f = fixture(t); f.put(auth('a@example.test')); const a = await f.service.saveCurrent();
  const original = f.storage.store;
  f.storage.store = async (key, value) => {await original(key, value); f.put(auth('b@example.test'));};
  await assert.rejects(f.service.switchTo(a.id, async () => {assert.fail('must not reload wrong account');}), /變更/);
  assert.equal(f.raw(), auth('b@example.test'));
});

test('hard-linked auth and a keyring override in added workspace configuration are refused', t => {
  const f = fixture(t); f.put(auth('a@example.test'));
  linkSync(join(f.home, 'auth.json'), join(f.home, 'linked.json'));
  assert.throws(() => f.native.read(), /一般檔案/);
  rmSync(join(f.home, 'linked.json'));
  const extra = join(f.home, 'workspace.toml');
  writeFileSync(extra, 'cli_auth_credentials_store = "keyring"');
  const configs: string[] = [];
  const native = new NativeAuth(f.home, () => configs);
  assert.equal(native.read(), auth('a@example.test'));
  configs.push(extra);
  assert.throws(() => native.read(), /file/);
});

test('a valid long email cannot corrupt the encrypted account vault', async t => {
  const f = fixture(t); const email = 'a'.repeat(60) + '@' + 'b'.repeat(30) + '.test';
  f.put(auth(email)); const a = await f.service.saveCurrent();
  assert.ok(a.label.length <= 80);
  assert.equal((await f.vault.list())[0].email, email);
  await f.service.switchTo(a.id, async () => {});
  await f.service.remove(a.id);
  assert.deepEqual(await f.vault.list(), []);
});

test('managed workspace restriction refuses switching before changing login or saving accounts', async t => {
  const f = fixture(t); f.put(auth('a@example.test')); const a = await f.service.saveCurrent();
  f.put(auth('b@example.test'));
  writeFileSync(join(f.home, 'config.toml'), 'forced_chatgpt_workspace_id = "b@example.test"');
  await assert.rejects(f.service.switchTo(a.id, async () => {assert.fail('must not reload');}), /工作區/);
  assert.equal(f.raw(), auth('b@example.test'));
  assert.equal((await f.vault.list()).length, 1);
});

test('fresh login replaces revoked auth even when repairing the currently selected account', async t => {
  const f = fixture(t); f.put(auth('a@example.test', 'revoked'));
  const a = await f.service.saveCurrent('Personal');
  await f.service.installLogin(auth('a@example.test', 'fresh-login'), async () => {}, a.id);
  assert.equal(f.raw(), auth('a@example.test', 'fresh-login'));
  assert.equal(await f.vault.auth(a.id), auth('a@example.test', 'fresh-login'));
  assert.equal((await f.vault.list())[0].label, 'Personal');
});

test('login for the wrong account cannot replace the selected repair target', async t => {
  const f = fixture(t); f.put(auth('a@example.test', 'revoked')); const a = await f.service.saveCurrent();
  await assert.rejects(f.service.installLogin(auth('b@example.test'), async () => {assert.fail();}, a.id), /帳號不符/);
  assert.equal(f.raw(), auth('a@example.test', 'revoked'));
  assert.equal((await f.vault.list()).length, 1);
});

test('installing another fresh login preserves outgoing credentials without logging out', async t => {
  const f = fixture(t); f.put(auth('a@example.test', 'rotated'));
  await f.service.installLogin(auth('b@example.test', 'fresh-login'), async () => {});
  const a = (await f.vault.list()).find(a => a.email === 'a@example.test')!;
  assert.equal(await f.vault.auth(a.id), auth('a@example.test', 'rotated'));
  assert.equal(f.raw(), auth('b@example.test', 'fresh-login'));
});

test('reload failure after repair retains fresh auth, so retry cannot resurrect revoked credentials', async t => {
  const f = fixture(t); f.put(auth('a@example.test','revoked')); const a = await f.service.saveCurrent();
  await assert.rejects(f.service.installLogin(auth('a@example.test','fresh-login'), async () => {throw new Error('reload unavailable');}, a.id), /手動/);
  assert.equal(f.raw(), auth('a@example.test','fresh-login'));
  await f.service.switchTo(a.id, async () => {});
  assert.equal(await f.vault.auth(a.id), auth('a@example.test','fresh-login'));
});
