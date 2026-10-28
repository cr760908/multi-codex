import * as vscode from 'vscode';
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { NativeAuth } from '../src/switcher/NativeAuth';
import { QuotaReader, quotaText } from '../src/switcher/Quota';

export async function activate() {
  const report: Record<string,unknown>={node:process.version,transport:'https'};
  const native=new NativeAuth(process.env.MULTICODEX_PROBE_AUTH_HOME || join(homedir(),'.codex'));
  try {
    if(process.env.MULTICODEX_PROBE_ALLOW!=='1')throw new Error('Explicit quota probe flag required');
    const raw=native.read();
    if(!raw)throw new Error('no auth');
    const reader=new QuotaReader();
    report.quota=quotaText(await reader.read(raw));
    report.authUnchanged=native.read()===raw;
  } catch(error) {report.error=(error as Error).message;}
  writeFileSync(process.env.MULTICODEX_PROBE_RECEIPT!,JSON.stringify(report));
  await vscode.commands.executeCommand('workbench.action.closeWindow');
}
