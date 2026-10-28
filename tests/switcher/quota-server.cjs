const readline = require('node:readline');
let account;
// Optional artificial latency (ms) for rate-limit reads, so tests can observe a query in flight.
const delay = Number(process.argv[2]) || 0;
const send = value => process.stdout.write(JSON.stringify(value)+'\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line);
  if (!('id' in m)) return;
  if (m.method==='initialize') return send({id:m.id,result:{}});
  if (m.method==='account/login/start' && m.params.type==='chatgptAuthTokens') {
    account=m.params.chatgptAccountId;
    return send({id:m.id,result:{type:'chatgptAuthTokens'}});
  }
  if (m.method==='account/rateLimits/read' && account) {
    return setTimeout(()=>{
      if (account==='broken') return send({id:m.id,error:{code:401,message:'Expired'}});
      send({id:m.id,result:{accountId:account,rateLimits:{
        primary:{usedPercent:account==='a'?20:65,windowDurationMins:300,resetsAt:1900000000},
        secondary:{usedPercent:account==='a'?40:80,windowDurationMins:10080,resetsAt:1900500000},
      }}});
    },delay);
  }
  send({id:m.id,error:{code:-32601,message:'Unexpected call'}});
});
