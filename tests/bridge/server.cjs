const readline = require('node:readline');
let account = 'a', token = 'access-a', refreshClient, loginFinish;
const send = m => process.stdout.write(JSON.stringify(m)+'\n');
readline.createInterface({input:process.stdin}).on('line', line => {
  const m=JSON.parse(line), reply=result=>send({id:m.id,result});
  if(m.id==='server-refresh'&&!m.method){token=m.result?.accessToken;send({id:refreshClient,result:{tokenUpdated:typeof token==='string'}});return;}
  if(m.id==='server-time'&&!m.method){loginFinish();return;}
  if(m.method==='trigger-refresh'){refreshClient=m.id;send({id:'server-refresh',method:'account/chatgptAuthTokens/refresh',params:{previousAccountId:account,reason:'unauthorized'}});return;}
  if(m.method==='initialize') return reply({userAgent:'fixture'});
  if(m.method==='initialized') return;
  if(m.method==='account/login/start') {
    if(m.params.accessToken==='rejected') return send({id:m.id,error:{code:-32000,message:'fixture rejected'}});
    account=m.params.chatgptAccountId; token=m.params.accessToken;
    const finish=()=>{reply({type:'chatgptAuthTokens'});send({method:'account/login/completed',params:{loginId:null,success:true,error:null}});send({method:'account/updated',params:{authMode:'chatgptAuthTokens',planType:'plus'}});};
    if(token==='needs-client-response'){loginFinish=finish;send({id:'server-time',method:'currentTime/read',params:{}});}
    else if(token==='delayed')setTimeout(finish,100);else finish();
    return;
  }
  if(m.method==='account/read') return reply({account:{type:'chatgpt',email:account+'@example.test',planType:'plus'}});
  if(m.method==='getAuthStatus') return reply({authToken:token,authMethod:'chatgptAuthTokens'});
  if(m.method==='turn/start') {reply({turn:{id:'turn-1',status:'inProgress'}});send({method:'turn/started',params:{threadId:'thread-1',turn:{id:'turn-1'}}});return;}
  if(m.method==='turn/interrupt') {reply({});send({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1'}}});return;}
  reply({echo:m.params,account,pid:process.pid});
});
