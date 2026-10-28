// Real official binary, synthetic credentials and a loopback-only model API.
// No user's auth.json is read or changed, and no paid inference is performed.
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtempSync,writeFileSync,mkdirSync,readFileSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import assert from 'node:assert/strict';
import {JsonRpcClient} from '../src/protocol/JsonRpcClient';
import {buildEnvironment} from '../src/runtime/EnvBuilder';

async function main(){
  const official=process.env.MULTICODEX_OFFICIAL_EXTENSION;if(!official)throw new Error('Official extension path required');
  const version=JSON.parse(readFileSync('package.json','utf8')).version;
  const temp=realpathSync(tmpdir()),home=mkdtempSync(join(temp,'codex-auth-routing-'));
  const tokens:Record<string,string>={},requests:string[]=[],completed=new Set<string>();
  const server=createServer((req,res)=>{
    req.resume();req.on('end',()=>{
      const alias=Object.entries(tokens).find(([,token])=>req.headers.authorization==='Bearer '+token)?.[0]??'none';
      if(req.url==='/v1/responses')requests.push(alias);
      res.setHeader('Content-Type','application/json');
      if(req.url?.includes('models'))res.end(JSON.stringify({models:[],data:[]}));
      else{res.statusCode=400;res.end(JSON.stringify({error:{message:'Local probe: no inference',type:'invalid_request_error'}}));}
    });
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  writeFileSync(join(home,'config.toml'),`model_provider = "probe"\nmodel = "probe-model"\nchatgpt_base_url = "${base}"\ncli_auth_credentials_store = "file"\n[model_providers.probe]\nname = "Local auth probe"\nbase_url = "${base}/v1"\nwire_api = "responses"\nrequires_openai_auth = true\nsupports_websockets = false\n`);
  const child=spawn(join(official,'bin','windows-x86_64','codex.exe'),['app-server'],{cwd:home,env:buildEnvironment(process.env,home).env,windowsHide:true,stdio:'pipe'});
  const rpc=new JsonRpcClient(child,{timeoutMs:12000});
  rpc.on('notification',m=>{if(m.method==='turn/completed')completed.add((m.params as any).turn.id);});
  const login=async(alias:string)=>{
    const payload=Buffer.from(JSON.stringify({sub:'user-'+alias,exp:4102444800,
      'https://api.openai.com/auth':{chatgpt_account_id:'acct-'+alias,chatgpt_user_id:'user-'+alias,chatgpt_plan_type:'plus'},
      'https://api.openai.com/profile':{email:alias+'@example.test'}})).toString('base64url');
    const token=tokens[alias]=`h.${payload}.s`;
    await rpc.request('account/login/start',{type:'chatgptAuthTokens',accessToken:token,chatgptAccountId:'acct-'+alias,chatgptPlanType:'plus'});
  };
  const start=async()=> (await rpc.request<any>('thread/start',{model:'probe-model',modelProvider:'probe',cwd:home,approvalPolicy:'never',sandbox:'read-only',ephemeral:true})).thread.id;
  const turn=async(threadId:string)=>{
    const result=await rpc.request<any>('turn/start',{threadId,input:[{type:'text',text:'local diagnostic',text_elements:[]}]});
    const deadline=Date.now()+15000;
    while(!completed.has(result.turn.id)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,25));
    assert.ok(completed.has(result.turn.id),'local probe turn did not finish');
  };
  try{
    await rpc.request('initialize',{clientInfo:{name:'local_auth_probe',version},capabilities:{experimentalApi:true}});rpc.notify('initialized');
    await login('a');const existing=await start();await turn(existing);
    await login('b');await turn(existing);await turn(await start());
    await login('a');await turn(existing);
    assert.deepEqual(requests,['a','b','b','a']);
    const report={pass:true,checkedAt:new Date().toISOString(),extensionVersion:version,
      officialVersion:JSON.parse(readFileSync(join(official,'package.json'),'utf8')).version,
      credentials:'synthetic',modelEndpoint:'loopback-only',paidModelRequests:0,
      routedAccounts:requests,existingThreadSwitches:true,newThreadUsesNewAccount:true,
      limitation:'Raw app-server auth routing only; this does not change a conversation owned by another official client.'};
    mkdirSync('docs/validation/evidence',{recursive:true});writeFileSync(`docs/validation/evidence/routing-probe-${version}.json`,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
  }finally{
    await rpc.dispose();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));
    assert.equal(dirname(realpathSync(home)).toLowerCase(),temp.toLowerCase());rmSync(home,{recursive:true,force:true});
  }
}
void main().catch(error=>{console.error(error instanceof Error?error.message:'Routing probe failed');process.exitCode=1;});
