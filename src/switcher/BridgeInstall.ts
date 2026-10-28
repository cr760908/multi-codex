import {copyFileSync,existsSync,mkdirSync,readFileSync,renameSync,unlinkSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {basename,dirname,isAbsolute,join,relative,resolve} from 'node:path';
import {plainDirectory} from '../storage/PathGuard';

export function isManagedBridge(path:string|undefined|null,storage:string){
  if(!path)return false;
  const part=relative(join(storage,'bridge'),resolve(path));
  return !part.startsWith('..')&&!isAbsolute(part)&&basename(path)==='bridge-launcher.exe';
}
export function prepareBridge(source:string,storage:string,version:string,runtime:string,cli:string){
  if(!/^[\w.-]+$/.test(version)||[runtime,cli].some(p=>!isAbsolute(p)||/[\r\n\0]/.test(p)))throw new Error('Invalid runtime paths');
  plainDirectory(storage);
  const folder=join(storage,'bridge',version);plainDirectory(folder);mkdirSync(folder,{recursive:true});
  for(const name of ['bridge-launcher.exe','bridge.cjs']){
    const target=join(folder,name);
    // Versioned bundles are immutable while a running launcher may hold them open.
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
