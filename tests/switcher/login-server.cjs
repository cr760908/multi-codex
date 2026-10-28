const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const [mode, audit] = process.argv.slice(2);
function send(value) {process.stdout.write(JSON.stringify(value)+'\n');}
function save(token) {
  const payload = Buffer.from(JSON.stringify({email:'new@example.test'})).toString('base64url');
  fs.writeFileSync(path.join(process.env.CODEX_HOME,'auth.json'), JSON.stringify({auth_mode:'chatgpt',tokens:{id_token:`h.${payload}.s`,access_token:token,refresh_token:`refresh-${token}`,account_id:'new-workspace'}}));
}
readline.createInterface({input:process.stdin}).on('line', line => {
  const m=JSON.parse(line);
  fs.appendFileSync(audit, JSON.stringify({method:m.method,params:m.params,home:process.env.CODEX_HOME,hasInjectedKey:!!process.env.OPENAI_API_KEY})+'\n');
  if(m.method==='initialize')send({id:m.id,result:{}});
  else if(m.method==='account/login/start') {
    if(mode==='early') {save('initial');send({method:'account/login/completed',params:{loginId:'fixture-login',success:true}});}
    send({id:m.id,result:{type:'chatgpt',loginId:'fixture-login',authUrl:mode==='bad-url'?'https://example.invalid/authorize':'https://auth.openai.com/authorize?state=synthetic'}});
    if(mode!=='early'&&mode!=='wait'&&mode!=='bad-url')setTimeout(()=>{save('initial');send({method:'account/login/completed',params:{loginId:'fixture-login',success:true}});},50);
  } else if(m.method==='account/read') {
    if(m.params.refreshToken)save('refreshed');
    send({id:m.id,result:{account:{type:'chatgpt',email:'new@example.test',planType:'plus'},requiresOpenaiAuth:true}});
  } else if(m.method==='account/login/cancel')send({id:m.id,result:{status:'canceled'}});
  else if(m.id!==undefined)send({id:m.id,error:{code:-32601,message:'unexpected request'}});
});
