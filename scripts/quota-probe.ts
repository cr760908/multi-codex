// Read-only smoke probe: prints quota and an auth-integrity boolean, never tokens.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { NativeAuth } from '../src/switcher/NativeAuth';
import { QuotaReader, quotaText } from '../src/switcher/Quota';

async function main() {
  if (!process.argv.includes('--current-access-token')) throw new Error('Explicit current-account probe flag required');
  const native=new NativeAuth(process.env.CODEX_HOME || join(homedir(),'.codex'));
  const raw=native.read();
  if (!raw) throw new Error('No native ChatGPT login');
  const quota=await new QuotaReader().read(raw);
  const authUnchanged=native.read()===raw;
  console.log(JSON.stringify({quota:quotaText(quota),authUnchanged,transport:'https'}));
  if (!authUnchanged) throw new Error('Auth changed during probe');
}
main().catch(()=>{console.error('Quota probe failed; no credentials were printed.');process.exitCode=1;});
