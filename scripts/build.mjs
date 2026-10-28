import { build } from 'esbuild';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
await build({entryPoints:['src/switcher/extension.ts'],outfile:'dist/extension.cjs',bundle:true,platform:'node',format:'cjs',target:'node20',external:['vscode'],sourcemap:false});
await build({entryPoints:['src/bridge/main.ts'],outfile:'dist/bridge.cjs',bundle:true,platform:'node',format:'cjs',target:'node20',sourcemap:false});
const compiler=join(process.env.WINDIR||'C:\\Windows','Microsoft.NET','Framework64','v4.0.30319','csc.exe');
const options=['/nologo','/target:winexe','/platform:x64','/optimize+'],source=resolve('src/bridge/Launcher.cs');
const launcher=resolve('dist/bridge-launcher.exe'),stamp=resolve('dist/bridge-launcher.stamp');
// This csc cannot build deterministically. Keep the launcher while its source and options are unchanged,
// so the installed bridge bundle, keyed by content, survives a rebuild without asking for a reload.
const key=createHash('sha256').update(JSON.stringify(options)).update(readFileSync(source)).digest('hex');
if(!existsSync(launcher)||!existsSync(stamp)||readFileSync(stamp,'utf8')!==key){
  const result=spawnSync(compiler,[...options,'/out:'+launcher,source],{stdio:'inherit',windowsHide:true});
  if(result.status!==0)throw new Error('Bridge launcher build failed');
  writeFileSync(stamp,key);
}
