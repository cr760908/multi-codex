import {copyFileSync,existsSync,mkdirSync,readFileSync,renameSync,unlinkSync,writeFileSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {basename,dirname,isAbsolute,join,relative,resolve} from 'node:path';
import {plainDirectory} from '../storage/PathGuard';

const bundle=['bridge-launcher.exe','bridge.cjs'];
export function isManagedBridge(path:string|undefined|null,storage:string){
  if(!path)return false;
  const part=relative(join(storage,'bridge'),resolve(path));
  return !part.startsWith('..')&&!isAbsolute(part)&&basename(path)==='bridge-launcher.exe';
}
export function bundleId(source:string){
  const hash=createHash('sha256');
  for(const name of bundle){const data=readFileSync(join(source,name));hash.update(`${name}:${data.length}\0`).update(data);}
  return hash.digest('hex').slice(0,16);
}
function sameBundle(source:string,folder:string){
  try{return bundle.every(name=>readFileSync(join(source,name)).equals(readFileSync(join(folder,name))));}catch{return false;}
}
export function prepareBridge(source:string,storage:string,runtime:string,cli:string,current?:string){
  if([runtime,cli].some(p=>!isAbsolute(p)||/[\r\n\0]/.test(p)))throw new Error('Invalid runtime paths');
  plainDirectory(storage);
  // Bundles are immutable while a running launcher may hold them open, so each content gets its own
  // folder. Keeping the configured bundle when its bytes match means an upgrade that leaves the bridge
  // unchanged does not move chatgpt.cliExecutable, and so asks for no reload.
  const folder=current&&isManagedBridge(current,storage)&&sameBundle(source,dirname(resolve(current)))
    ?dirname(resolve(current)):join(storage,'bridge',bundleId(source));
  plainDirectory(folder);mkdirSync(folder,{recursive:true});
  for(const name of bundle){
    const target=join(folder,name);
    if(!existsSync(target))copyFileSync(join(source,name),target);
  }
  const file=join(folder,'runtime-paths.txt'),contents=runtime+'\n'+cli+'\n';
  if(!existsSync(file)||readFileSync(file,'utf8')!==contents){
    const temporary=join(folder,`runtime-paths-${randomUUID()}.tmp`);
    try{
      writeFileSync(temporary,contents,{mode:0o600,flag:'wx'});
      renameSync(temporary,file);
    }finally{if(existsSync(temporary))unlinkSync(temporary);}
  }
  return join(folder,'bridge-launcher.exe');
}
export function bridgeDescriptor(launcher:string,hostPid:number){return join(dirname(launcher),'connections',`${hostPid}.json`);}
