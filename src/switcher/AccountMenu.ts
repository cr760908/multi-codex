import * as vscode from 'vscode';
import type {SavedAccount} from './AccountVault';

type RowAction='switch'|'repair'|'rename'|'remove';
type MenuAction='save'|'add'|'open'|'enable'|'disable';
export type AccountMenuChoice={action:RowAction;account:SavedAccount}|{action:MenuAction};
interface Item extends vscode.QuickPickItem {account?:SavedAccount;action?:MenuAction}

export function showAccountMenu(accounts:SavedAccount[],currentId:string|undefined,bridgeEnabled:boolean):Promise<AccountMenuChoice|undefined>{
  const repair={iconPath:new vscode.ThemeIcon('sync'),tooltip:'重新登入並修復帳號'};
  const rename={iconPath:new vscode.ThemeIcon('edit'),tooltip:'重新命名'};
  const remove={iconPath:new vscode.ThemeIcon('trash'),tooltip:'移除已儲存帳號'};
  const picker=vscode.window.createQuickPick<Item>();
  picker.title='Codex 帳號';picker.placeholder='選擇帳號切換；右側按鈕可修復、改名或移除';picker.matchOnDescription=true;
  picker.items=[...accounts.map(account=>({label:`${account.id===currentId?'$(check)':'$(account)'} ${account.label}`,
    description:account.email,detail:`帳號／工作區 ${account.accountId}`,account,buttons:[repair,rename,remove]})),
    {label:'帳號操作',kind:vscode.QuickPickItemKind.Separator},
    {label:'$(save) 儲存目前帳號',action:'save'},
    {label:'$(add) 新增帳號',action:'add'},
    {label:bridgeEnabled?'$(debug-disconnect) 停用免重載切換':'$(plug) 啟用免重載切換',action:bridgeEnabled?'disable':'enable'},
    {label:'$(comment-discussion) 開啟官方 Codex',action:'open'}];
  return new Promise(resolve=>{
    let done=false;const subscriptions:vscode.Disposable[]=[];
    const finish=(choice?:AccountMenuChoice)=>{
      if(done)return;done=true;resolve(choice);
      for(const subscription of subscriptions)subscription.dispose();
      picker.hide();picker.dispose();
    };
    subscriptions.push(picker.onDidHide(()=>finish()),picker.onDidAccept(()=>{
      const item=picker.selectedItems[0];
      if(item?.account)finish({action:'switch',account:item.account});
      else if(item?.action)finish({action:item.action});
    }),picker.onDidTriggerItemButton(({item,button})=>{
      if(!item.account)return;
      const action=button===repair?'repair':button===rename?'rename':button===remove?'remove':undefined;
      if(action)finish({action,account:item.account});
    }));
    picker.show();
  });
}
