import { existsSync,lstatSync,mkdirSync,realpathSync } from 'node:fs';
import { dirname,isAbsolute,resolve } from 'node:path';
export function plainDirectory(path:string):string{
  if(!isAbsolute(path))throw new Error('Data path must be absolute');
  const target=resolve(path);let ancestor=target;
  while(!existsSync(ancestor)){const parent=dirname(ancestor);if(parent===ancestor)throw new Error('Data root unavailable');ancestor=parent;}
  if(realpathSync(ancestor).toLowerCase()!==ancestor.toLowerCase()||lstatSync(ancestor).isSymbolicLink())throw new Error('Data path redirected');
  mkdirSync(target,{recursive:true});
  if(realpathSync(target).toLowerCase()!==target.toLowerCase())throw new Error('Data path redirected');
  return target;
}
export function plainFile(path:string){
  if(existsSync(path)){const stat=lstatSync(path);if(stat.isSymbolicLink()||!stat.isFile())throw new Error('Data file redirected or not regular');}
}
