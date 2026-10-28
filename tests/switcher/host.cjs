const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
function auth(email) {
  const payload = Buffer.from(JSON.stringify({email})).toString('base64url');
  return JSON.stringify({auth_mode:'chatgpt',tokens:{id_token:`h.${payload}.s`,access_token:'synthetic-access',refresh_token:'synthetic-refresh',account_id:email}});
}
exports.run = async () => {
  const report = {pass:false, vscodeVersion:vscode.version, checks:[]};
  try {
    const extension = vscode.extensions.getExtension('multi-codex-local.multi-codex');
    assert.ok(extension);
    report.extensionVersion=extension.packageJSON.version;
    const api = await extension.activate();
    const commands = await vscode.commands.getCommands(true);
    for (const name of ['accounts','saveAccount','addAccount','repairAccount','manageAccounts','open','refreshQuotas','enableSeamlessSwitching','disableSeamlessSwitching']) assert.ok(commands.includes(`multiCodex.${name}`), name);
    assert.equal(extension.packageJSON.contributes.views, undefined);
    report.checks.push('native account commands registered; custom chat and task views removed');
    const file = path.join(process.env.CODEX_HOME, 'auth.json');
    fs.writeFileSync(file, auth('first@example.test'));
    await vscode.commands.executeCommand('multiCodex.saveAccount');
    fs.writeFileSync(file, auth('second@example.test'));
    await vscode.commands.executeCommand('multiCodex.saveAccount');
    const accounts = await api.savedAccounts();
    assert.deepEqual(accounts.map(a => a.email).sort(), ['first@example.test','second@example.test']);
    assert.ok(!JSON.stringify(accounts).includes('synthetic-refresh'));
    assert.equal(api.currentAccount.email, 'second@example.test');
    assert.equal(fs.readFileSync(file, 'utf8'), auth('second@example.test'));
    report.checks.push('save commands persist two accounts using real VS Code SecretStorage and expose metadata only');
    report.pass = true;
  } catch (error) {report.error = error.message;}
  fs.writeFileSync(process.env.MULTICODEX_SWITCH_RECEIPT, JSON.stringify(report,null,2));
  if (!report.pass) throw new Error(report.error);
};
