const vscode=require('vscode'),fs=require('fs'),path=require('path');
exports.run=async()=>{
  const report={pass:false,vscodeVersion:vscode.version,auth:'isolated signed-out profile',modelRequests:0};
  try{
    const official=vscode.extensions.getExtension('openai.chatgpt');
    const switcher=vscode.extensions.getExtension('multi-codex-local.multi-codex');
    if(!official||!switcher)throw new Error('Both development extensions must be loaded');
    report.officialVersion=official.packageJSON.version;report.extensionVersion=switcher.packageJSON.version;
    await switcher.activate();await official.activate();await vscode.commands.executeCommand('chatgpt.openSidebar');
    const root=path.join(process.env.MULTICODEX_UI_ROOT,'user-data','logs');
    const deadline=Date.now()+45000;
    while(Date.now()<deadline){
      if(fs.existsSync(root))for(const session of fs.readdirSync(root)){
        const folder=path.join(root,session);if(!fs.statSync(folder).isDirectory())continue;
        for(const window of fs.readdirSync(folder).filter(n=>/^window\d+$/.test(n))){
          const log=path.join(folder,window,'exthost','openai.chatgpt','Codex.log');if(!fs.existsSync(log))continue;
          const text=fs.readFileSync(log,'utf8');
          if(text.includes('renderer_ready_timeout'))throw new Error('Official renderer timed out');
          // Signed-out profiles do not necessarily emit the sampled app_start
          // telemetry span. Mounted routes are the actual renderer lifecycle event.
          if(text.includes('[startup][renderer] app routes mounted')&&text.includes('Initialize received')){
            report.rendererReady=true;report.rendererEvidence='app routes mounted';report.backendInitialized=true;
            report.bridgeConfigured=/bridge-launcher\.exe$/.test(vscode.workspace.getConfiguration('chatgpt').get('cliExecutable'));
            report.pass=report.bridgeConfigured;break;
          }
        }
      }
      if(report.pass)break;await new Promise(r=>setTimeout(r,250));
    }
    if(!report.pass)throw new Error('No successful official renderer startup was observed');
  }catch(error){report.error=error.message;}
  fs.writeFileSync(process.env.MULTICODEX_UI_RECEIPT,JSON.stringify(report,null,2));
  if(!report.pass)throw new Error(report.error);
};
