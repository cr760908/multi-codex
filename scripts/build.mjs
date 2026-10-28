import { build } from 'esbuild';
import {spawnSync} from 'node:child_process';
import {join,resolve} from 'node:path';
await build({entryPoints:['src/switcher/extension.ts'],outfile:'dist/extension.cjs',bundle:true,platform:'node',format:'cjs',target:'node20',external:['vscode'],sourcemap:false});
await build({entryPoints:['src/bridge/main.ts'],outfile:'dist/bridge.cjs',bundle:true,platform:'node',format:'cjs',target:'node20',sourcemap:false});
const compiler=join(process.env.WINDIR||'C:\\Windows','Microsoft.NET','Framework64','v4.0.30319','csc.exe');
const result=spawnSync(compiler,['/nologo','/target:winexe','/platform:x64','/optimize+','/out:'+resolve('dist/bridge-launcher.exe'),resolve('src/bridge/Launcher.cs')],{stdio:'inherit',windowsHide:true});
if(result.status!==0)throw new Error('Bridge launcher build failed');
