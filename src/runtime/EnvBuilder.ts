const retained=new Set(['PATH','PATHEXT','SYSTEMROOT','WINDIR','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA','PROGRAMFILES','PROGRAMFILES(X86)','PROGRAMDATA','COMSPEC']);
export interface EnvPolicy {key:string;action:'retain'|'remove'|'replace'}
export function buildEnvironment(parent:NodeJS.ProcessEnv,home:string){
  const env:NodeJS.ProcessEnv={};const policy:EnvPolicy[]=[];
  for(const [key,value] of Object.entries(parent)){
    const normalized=key.toUpperCase();
    const action=normalized==='CODEX_HOME'?'replace':retained.has(normalized)?'retain':'remove';
    policy.push({key,action});if(action==='retain'&&value!==undefined)env[normalized]=value;
  }
  env.CODEX_HOME=home;if(!policy.some(p=>p.key.toUpperCase()==='CODEX_HOME'))policy.push({key:'CODEX_HOME',action:'replace'});
  return {env,policy};
}
