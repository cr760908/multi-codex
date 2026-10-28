import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { IsolatedLogin, createLoginPeer } from '../src/switcher/IsolatedLogin';

async function main() {
  const cli = process.argv[2];
  if (!cli) throw new Error('Pass official bundled codex.exe');
  const root = mkdtempSync(join(tmpdir(), 'codex-official-login-probe-'));
  try {
    let offeredOfficialLogin = false;
    const login = new IsolatedLogin(root, home => createLoginPeer(cli, home));
    await assert.rejects(login.login(async url => {
      offeredOfficialLogin = ['auth.openai.com', 'chatgpt.com'].includes(new URL(url).hostname);
      return false; // Do not open a browser or authenticate a real user in this probe.
    }), /瀏覽器/);
    assert.equal(offeredOfficialLogin, true);
    assert.deepEqual(readdirSync(root), []);
    console.log(JSON.stringify({pass:true,checks:['official CLI starts isolated OAuth','cancel stops helper and removes temporary home'],realAccountLogin:false}));
  } finally {rmSync(root,{recursive:true,force:true});}
}
main().catch(() => {console.error('Official login probe failed');process.exitCode=1;});
