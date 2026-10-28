import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSync} from 'esbuild';
import {runInNewContext} from 'node:vm';

const compiled=buildSync({entryPoints:['src/switcher/AccountMenu.ts'],bundle:true,platform:'node',format:'cjs',external:['vscode'],write:false}).outputFiles[0].text;
const account=(id:string)=>({id,email:`${id}@example.test`,accountId:id,label:`Account ${id}`});
function fixture(){
  const callbacks:any={};let picker:any;
  const register=(name:string)=>(fn:Function)=>{callbacks[name]=fn;return{dispose(){delete callbacks[name];}};};
  const vscode={QuickPickItemKind:{Separator:-1},ThemeIcon:class{constructor(readonly id:string){}},window:{createQuickPick:()=>picker={
    items:[],selectedItems:[],shown:false,disposed:false,show(){this.shown=true;},hide(){callbacks.hide?.();},dispose(){this.disposed=true;},
    onDidAccept:register('accept'),onDidHide:register('hide'),onDidTriggerItemButton:register('button'),
  }}};
  const module={exports:{} as any};runInNewContext(compiled,{module,exports:module.exports,require:()=>vscode});
  const open=(count=2)=>module.exports.showAccountMenu(Array.from({length:count},(_,i)=>account(String(i))), '0',true);
  return{open,callbacks,get picker(){return picker;}};
}
test('accepting an account returns only a switch choice and disposes the picker',async()=>{
  const f=fixture(),pending=f.open();f.picker.selectedItems=[f.picker.items[1]];f.callbacks.accept();
  const result=await pending;assert.equal(result.action,'switch');assert.equal(result.account.id,'1');assert.equal(f.picker.disposed,true);
});
test('each account button returns repair, rename or remove without selecting the account',async()=>{
  for(const [icon,action] of [['sync','repair'],['edit','rename'],['trash','remove']]){
    const f=fixture(),pending=f.open(),item=f.picker.items[1];
    f.callbacks.button({item,button:item.buttons.find((b:any)=>b.iconPath.id===icon)});
    const result=await pending;assert.equal(result.action,action);assert.equal(result.account.id,'1');
  }
});
test('the main menu displays all 100 saved accounts and no redundant management or refresh entry',async()=>{
  const f=fixture(),pending=f.open(100);
  assert.equal(f.picker.items.filter((x:any)=>x.account).length,100);
  assert.equal(f.picker.items.some((x:any)=>['manage','refresh'].includes(x.action)),false);
  f.picker.hide();assert.equal(await pending,undefined);assert.equal(f.picker.disposed,true);
});
