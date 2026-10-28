import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(dir,e.name)) : e.name.endsWith('.test.ts') ? [join(dir,e.name)] : []);
const files=process.argv.length>2 ? process.argv.slice(2) : walk('tests').filter(f=>!f.includes('integration'));
if(!files.length) throw new Error('No tests found');
const result=spawnSync(process.execPath,['--import','tsx','--test',...files],{stdio:'inherit',shell:false,windowsHide:true});
process.exitCode=result.status ?? 1;
