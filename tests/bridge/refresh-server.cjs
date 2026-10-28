const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');
const home=process.env.CODEX_HOME;
readline.createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line);if(m.id===undefined)return;
  let result={};
  if(m.method==='account/read')return process.stdout.write(JSON.stringify({id:m.id,error:{code:-32603,message:'metadata unavailable'}})+'\n');
  if(m.method==='getAuthStatus'){
    const file=path.join(home,'auth.json'),raw=JSON.parse(fs.readFileSync(file,'utf8'));
    const claims=JSON.parse(Buffer.from(raw.tokens.id_token.split('.')[1],'base64url').toString());
    raw.tokens.access_token='renewed-access';raw.tokens.refresh_token='renewed-refresh';
    if(process.env.WRONG_ACCOUNT){raw.tokens.account_id='wrong';raw.tokens.id_token='h.'+Buffer.from(JSON.stringify({email:'wrong@example.test'})).toString('base64url')+'.s';}
    fs.writeFileSync(file,JSON.stringify(raw));
    if(process.env.FAIL_AFTER_REFRESH)return process.stdout.write(JSON.stringify({id:m.id,error:{code:-32603,message:'response failed after rotation'}})+'\n');
    result={authToken:raw.tokens.access_token,authMethod:'chatgpt'};
  }
  process.stdout.write(JSON.stringify({id:m.id,result})+'\n');
});
