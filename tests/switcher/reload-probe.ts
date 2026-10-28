import * as vscode from 'vscode';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AccountVault } from '../../src/switcher/AccountVault';
import { NativeAuth } from '../../src/switcher/NativeAuth';
import { AccountSwitcher } from '../../src/switcher/AccountSwitcher';
function auth(email: string, token = 'synthetic-access') {
  const payload = Buffer.from(JSON.stringify({email})).toString('base64url');
  return JSON.stringify({auth_mode:'chatgpt',tokens:{id_token:`h.${payload}.s`,access_token:token,refresh_token:'synthetic-refresh',account_id:email}});
}
export async function activate(context: vscode.ExtensionContext) {
  const home = process.env.CODEX_HOME!;
  const report = join(home, 'reload-receipt.json');
  const service = new AccountSwitcher(new AccountVault(context.secrets), new NativeAuth(home));
  try {
    const stage = context.globalState.get<number>('stage', 0);
    if (stage > 0) {
      const current = service.current();
      const expected = stage === 2 ? 'second@example.test' : 'first@example.test';
      if (current?.email !== expected) throw new Error(`Unexpected synthetic account at reload ${stage}`);
      if (stage !== 2 && JSON.parse(readFileSync(join(home,'auth.json'),'utf8')).tokens.access_token !== 'synthetic-repaired') throw new Error('Repaired credentials were lost');
      if (stage < 3) {
        const nextEmail = stage === 1 ? 'second@example.test' : 'first@example.test';
        const next = (await service.vault.list()).find(a => a.email === nextEmail)!;
        await context.globalState.update('stage', stage + 1);
        await service.switchTo(next.id, () => vscode.commands.executeCommand('workbench.action.reloadWindow'));
      } else {
        writeFileSync(report, JSON.stringify({pass:true,reloads:3,check:'same-account repair and A→B→A retain fresh auth through real window reloads'}));
        await vscode.commands.executeCommand('workbench.action.closeWindow');
      }
      return;
    }
    writeFileSync(join(home, 'auth.json'), auth('first@example.test'));
    const first = await service.saveCurrent();
    writeFileSync(join(home, 'auth.json'), auth('second@example.test'));
    await service.saveCurrent();
    writeFileSync(join(home, 'auth.json'), auth('first@example.test'));
    await context.globalState.update('stage', 1);
    await service.installLogin(auth('first@example.test','synthetic-repaired'), async () => {
      try {await vscode.commands.executeCommand('workbench.action.reloadWindow');}
      catch(error) {
        writeFileSync(join(home,'reload-command-error.json'),JSON.stringify({name:(error as Error).name,message:(error as Error).message}));
        throw error;
      }
    }, first.id);
  } catch (error) {
    writeFileSync(report, JSON.stringify({pass:false,error:error instanceof Error?error.message:'failed'}));
  }
}
