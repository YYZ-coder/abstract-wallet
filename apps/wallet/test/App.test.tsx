import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import { App } from '../src/App';
import type { WalletServices, Preview } from '../src/services';


// Match exact wording even when typography splits a number and its unit.
const exactText=(expected:string)=>(_content:string,node:Element|null)=>{
  const normalized=(element:Element)=>element.textContent?.replace(/\s+/g,' ').trim();
  return node!==null&&normalized(node)===expected&&!Array.from(node.children).some(child=>normalized(child)===expected);
};

const address = '0x1111111111111111111111111111111111111111';
const services: WalletServices = {
  createAccount: async () => ({ address, balance: '0.02', delegation: 'undelegated' }),
  refresh: async () => ({ address, balance: '0.02', delegation: 'undelegated' }),
  preview: async () => { throw new Error('Not used in this behavior'); },
  submit: async () => { throw new Error('Not used in this behavior'); },
  status: async () => { throw new Error('Not used in this behavior'); },
  cancel: async () => { throw new Error('Not used in this behavior'); },
  revoke: async () => { throw new Error('Not used in this behavior'); },
};

// Navigate through the public wallet flow; transition expectations remain independent.
async function openTransfer(){
  if(!screen.queryByLabelText('收款地址'))await userEvent.click(await screen.findByRole('button',{name:'转账'}));
}
async function openSettings(){
  await userEvent.click(within(screen.getByRole('navigation',{name:'主导航'})).getByRole('button',{name:'设置'}));
}
// Existing transition tests use a valid transfer draft; validation has its own public behavior cases.
async function requestPreview(){
  await openTransfer();
  const recipientField=await screen.findByLabelText('收款地址');
  const amountField=screen.getByLabelText('金额（ETH）');
  if(!(recipientField as HTMLInputElement).value)await userEvent.type(recipientField,address);
  if(!(amountField as HTMLInputElement).value)await userEvent.type(amountField,'0.001');
  await userEvent.click(screen.getByRole('button',{name:'预览交易'}));
}

test('recovers a submitted operation as a separate read-only result without recreating or replacing the signing wallet', async () => {
  const recoveredAddress = '0x2222222222222222222222222222222222222222';
  const hash = '0xcd10019743b363a6dcc627d97a402066f8300045e73aadfc740ffdab09ba5d6f';
  const reference = { chainId: '421614' as const, address: recoveredAddress, hash };
  let created = 0;
  render(<App services={{
    ...services,
    createAccount: async () => { created++; return { address, balance: '0.02', delegation: 'undelegated' }; },
    recentOperation: () => reference,
    inspectOperation: async () => ({ reference, wallet: { address: recoveredAddress, balance: '0.000783', delegation: 'enabled' }, operation: { hash, submission: 'accepted', execution: 'succeeded', confirmation: 'pending' } }),
  }} />);
  const result = await screen.findByRole('region', { name: '只读查询结果' });
  expect(result).toHaveTextContent(recoveredAddress);
  expect(result).toHaveTextContent('执行成功，等待确认');
  expect(created).toBe(0);
  expect(screen.queryByLabelText('收款地址')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '撤销智能账户' })).not.toBeInTheDocument();
  expect(within(result).queryByRole('button', { name: /签名|转账|撤销/ })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: '创建测试钱包' }));
  expect(await screen.findByText(address, { exact: true })).toBeVisible();
  await openTransfer();
  expect(screen.getByLabelText('收款地址')).toBeVisible();
  await userEvent.click(within(screen.getByRole('navigation',{name:'主导航'})).getByRole('button',{name:'活动'}));
  const retainedResult=screen.getByRole('region', { name: '只读查询结果' });
  expect(retainedResult).toHaveTextContent(recoveredAddress);
  expect(within(retainedResult).queryByRole('button',{name:/签名|转账|撤销/})).not.toBeInTheDocument();
  await userEvent.click(within(screen.getByRole('navigation',{name:'主导航'})).getByRole('button',{name:'资产'}));
  expect(screen.getByText(address,{exact:true})).toBeVisible();
  expect(created).toBe(1);
});

test('helps a user without an injected wallet copy this page and explains the next step',async()=>{
  let copied='';Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async(value:string)=>{copied=value;}}});
  render(<App services={{...services,listWallets:async()=>[],connectWallet:async()=>{throw new Error('unused');}}}/>);
  await userEvent.click(screen.getByRole('button',{name:'连接钱包'}));
  await userEvent.click(await screen.findByRole('button',{name:'复制页面地址'}));
  expect(copied).toBe(window.location.href);
  expect(await screen.findByText('地址已复制。在安装钱包扩展的浏览器中粘贴打开，再点击连接钱包。')).toBeVisible();
});
test.each(['unavailable','permission denied'])('gives manual page-copy instructions when the clipboard is %s',async mode=>{
  const original=Object.getOwnPropertyDescriptor(navigator,'clipboard');
  const user=userEvent.setup();
  Object.defineProperty(navigator,'clipboard',{configurable:true,value:mode==='unavailable'?undefined:{writeText:async()=>{throw new DOMException('Write permission denied','NotAllowedError');}}});
  try{
    render(<App services={{...services,listWallets:async()=>[],connectWallet:async()=>{throw new Error('unused');}}}/>);
    await user.click(screen.getByRole('button',{name:'连接钱包'}));
    await user.click(await screen.findByRole('button',{name:'复制页面地址'}));
    expect(await screen.findByRole('alert')).toHaveTextContent('复制失败，请手动复制浏览器地址栏中的地址');
    expect(screen.queryByText('地址已复制。在安装钱包扩展的浏览器中粘贴打开，再点击连接钱包。')).not.toBeInTheDocument();
  }finally{
    if(original)Object.defineProperty(navigator,'clipboard',original);else Reflect.deleteProperty(navigator,'clipboard');
  }
});
test('guides an unavailable wallet to recheck instead of displaying a dead transfer form',async()=>{
  render(<App services={{...services,listWallets:async()=>[{id:'alpha',name:'Alpha Wallet'}],connectWallet:async()=>({address,balance:'0.04',delegation:'undelegated',connection:{walletId:'alpha',walletName:'Alpha Wallet'},availability:{canSubmit:false,canRevoke:false,reason:'缺少7702授权能力'}}),refresh:async()=>({address,balance:'0.04',delegation:'enabled',connection:{walletId:'alpha',walletName:'Alpha Wallet'},availability:{canSubmit:true,canRevoke:false}})}}/>);
  await userEvent.click(screen.getByRole('button',{name:'连接钱包'}));await userEvent.click(await screen.findByRole('button',{name:'Alpha Wallet'}));
  expect(screen.queryByLabelText('收款地址')).not.toBeInTheDocument();
  expect(screen.getByRole('button',{name:'转账'})).toBeDisabled();
  await userEvent.click(screen.getByRole('button',{name:'重新检查账户'}));
  await openTransfer();
  expect(await screen.findByLabelText('收款地址')).toBeVisible();
  expect(within(screen.getByRole('navigation',{name:'转账步骤'})).getByText('填写信息')).toHaveAttribute('aria-current','step');
});
test('shows preparation progress and prevents duplicate preview requests while waiting',async()=>{
  let resolve!:(value:Preview)=>void;const pending=new Promise<Preview>(done=>resolve=done);let requested=0;
  render(<App services={{...services,preview:async()=>{requested++;return pending;}}}/>);
  await userEvent.click(screen.getByRole('button',{name:'创建测试钱包'}));
  await openTransfer();
  await userEvent.type(await screen.findByLabelText('收款地址'),address);await userEvent.type(screen.getByLabelText('金额（ETH）'),'0.001');
  await userEvent.click(screen.getByRole('button',{name:'预览交易'}));
  expect(await screen.findByText('正在检查交易和费用，请稍候…')).toBeVisible();
  expect(screen.getByRole('button',{name:'正在准备预览…'})).toBeDisabled();
  await userEvent.click(screen.getByRole('button',{name:'正在准备预览…'}));expect(requested).toBe(1);
  await act(async()=>resolve({recipient:address,amount:'0.001',maxCost:'0.0002',payment:'self',id:'ready-preview'}));
  expect(await screen.findByRole('dialog',{name:'确认交易'})).toBeVisible();
});
test('explains wallet signature waiting and locks the approved transfer while submitting',async()=>{
  let resolve!:(value:any)=>void;const pending=new Promise(done=>resolve=done);
  render(<App services={{...services,listWallets:async()=>[{id:'alpha',name:'Alpha Wallet'}],connectWallet:async()=>({address,balance:'0.02',delegation:'enabled',connection:{walletId:'alpha',walletName:'Alpha Wallet'}}),preview:async()=>({recipient:address,amount:'0.001',maxCost:'0.0002',payment:'self',id:'signing-preview'}),submit:async()=>pending as any}}/>);
  await userEvent.click(screen.getByRole('button',{name:'连接钱包'}));await userEvent.click(await screen.findByRole('button',{name:'Alpha Wallet'}));
  await openTransfer();
  await userEvent.type(await screen.findByLabelText('收款地址'),address);await userEvent.type(screen.getByLabelText('金额（ETH）'),'0.001');await userEvent.click(screen.getByRole('button',{name:'预览交易'}));await userEvent.click(await screen.findByRole('button',{name:'确认并签名'}));
  expect(await screen.findByText('请在钱包中确认签名，完成后会自动提交。')).toBeVisible();
  expect(screen.getByRole('button',{name:'正在签名和提交…'})).toBeDisabled();
  expect(within(screen.getByRole('dialog',{name:'确认交易'})).getByText(exactText('0.001 ETH'),{exact:true})).toBeVisible();
  expect(screen.getByRole('button',{name:'返回修改'})).toBeDisabled();
  expect(screen.queryByLabelText('金额（ETH）')).not.toBeInTheDocument();
  await act(async()=>resolve({hash:'0xsent',submission:'accepted',execution:'unknown',confirmation:'pending'}));
  expect(await screen.findByText('已受理，等待执行')).toBeVisible();
});
test('offers faucet funding for a newly created empty account and reads the balance again after claiming',async()=>{
  render(<App services={{...services,createAccount:async()=>({address,balance:'0',delegation:'undelegated'}),refresh:async()=>({address,balance:'0.05',delegation:'undelegated'})}}/>);
  await userEvent.click(screen.getByRole('button',{name:'创建测试钱包'}));expect(await screen.findByText(exactText('0 ETH'))).toBeVisible();
  await userEvent.click(screen.getByRole('button',{name:'领取测试币'}));
  expect(screen.getByRole('region',{name:'领取 Arbitrum Sepolia 测试 ETH'})).toHaveTextContent(address);
  expect(screen.getByRole('link',{name:'打开 OpenFaucet'})).toHaveAttribute('href','https://openfaucet.org/arbitrum-sepolia');
  await userEvent.click(screen.getByRole('button',{name:'已领取，刷新余额'}));expect(await screen.findByText(exactText('0.05 ETH'))).toBeVisible();
});
test('claims test ETH with one click and automatically displays the refreshed current balance',async()=>{
  let requested=false;
  render(<App services={{...services,createAccount:async()=>({address,balance:'0',delegation:'undelegated'}),requestTestFunds:async()=>{requested=true;return {claimId:'a'.repeat(32),chainId:'421614',address,amountWei:'1000000000000000',status:'confirmed',transactionHash:`0x${'b'.repeat(64)}`};},testFundsStatus:async()=>{throw new Error('not needed for already verified receipt');},refresh:async()=>({address,balance:'0.001',delegation:'undelegated'})}}/>);
  await userEvent.click(screen.getByRole('button',{name:'创建测试钱包'}));
  expect(await screen.findByText(exactText('0 ETH'))).toBeVisible();
  await userEvent.click(screen.getByRole('button',{name:'领取测试币'}));
  expect(await screen.findByText(exactText('0.001 ETH'))).toBeVisible();
  expect(requested).toBe(true);
  expect(screen.getByRole('status')).toHaveTextContent('已领取 0.001 测试 ETH，余额已刷新');
  expect(screen.queryByRole('region',{name:'领取 Arbitrum Sepolia 测试 ETH'})).not.toBeInTheDocument();
});
test('does not replace the current wallet with an old automatic balance refresh after switching accounts',async()=>{
  const nextAddress='0x2222222222222222222222222222222222222222';
  let created=0;
  let finishRefresh!:(value:any)=>void;
  render(<App services={{...services,createAccount:async()=>({address:++created===1?address:nextAddress,balance:'0',delegation:'undelegated'}),requestTestFunds:async()=>({claimId:'a'.repeat(32),chainId:'421614',address,amountWei:'1000000000000000',status:'confirmed',transactionHash:`0x${'b'.repeat(64)}`}),refresh:()=>new Promise(done=>{finishRefresh=done;})}}/>);
  await userEvent.click(screen.getByRole('button',{name:'创建测试钱包'}));
  await userEvent.click(await screen.findByRole('button',{name:'领取测试币'}));
  expect(await screen.findByRole('status')).toHaveTextContent('正在刷新余额');
  await userEvent.click(screen.getByRole('button',{name:'创建测试钱包'}));
  expect(await screen.findByText(nextAddress)).toBeVisible();
  await act(async()=>{finishRefresh({address,balance:'0.001',delegation:'undelegated'});});
  expect(screen.getByText(nextAddress)).toBeVisible();
  expect(screen.queryByText(address)).not.toBeInTheDocument();
});
test('rejects an automatic balance refresh for a different account instead of showing successful funding',async()=>{
  render(<App services={{...services,createAccount:async()=>({address,balance:'0',delegation:'undelegated'}),requestTestFunds:async()=>({claimId:'a'.repeat(32),chainId:'421614',address,amountWei:'1000000000000000',status:'confirmed',transactionHash:`0x${'b'.repeat(64)}`}),refresh:async()=>({address:'0x2222222222222222222222222222222222222222',balance:'0.001',delegation:'undelegated'})}}/>);
  await userEvent.click(screen.getByRole('button',{name:'创建测试钱包'}));
  await userEvent.click(await screen.findByRole('button',{name:'领取测试币'}));
  expect(await screen.findByText(address)).toBeVisible();
  expect(screen.getByRole('status')).toHaveTextContent('测试币已发放，余额刷新失败');
  expect(screen.queryByText(exactText('0.001 ETH'))).not.toBeInTheDocument();
});
test.each([false,true])('coordinates manual and automatic refreshes so an old same-address balance cannot win (manual first: %s)',async manualFirst=>{
  const finish:Array<(value:any)=>void>=[];
  render(<App services={{...services,createAccount:async()=>({address,balance:'0',delegation:'undelegated'}),requestTestFunds:async()=>({claimId:'a'.repeat(32),chainId:'421614',address,amountWei:'1000000000000000',status:'confirmed',transactionHash:`0x${'b'.repeat(64)}`}),refresh:()=>new Promise(done=>{finish.push(done);})}}/>);
  await userEvent.click(screen.getByRole('button',{name:'创建测试钱包'}));
  const manual=await screen.findByRole('button',{name:'刷新余额'});
  if(manualFirst)await userEvent.click(manual);
  await userEvent.click(screen.getByRole('button',{name:'领取测试币'}));
  expect(await screen.findByRole('status')).toHaveTextContent('正在刷新余额');
  expect(manual).toBeDisabled();
  await userEvent.click(manual);
  expect(finish).toHaveLength(manualFirst?2:1);
  await act(async()=>{finish.at(-1)!({address,balance:'0.001',delegation:'undelegated'});});
  expect(await screen.findByText(exactText('0.001 ETH'))).toBeVisible();
  if(manualFirst)await act(async()=>{finish[0]({address,balance:'0',delegation:'undelegated'});});
  expect(screen.getByText(exactText('0.001 ETH'))).toBeVisible();
  expect(screen.queryByText(exactText('0 ETH'))).not.toBeInTheDocument();
});
test('times out a hanging automatic balance refresh and safely retries the balance without requesting more funds',async()=>{
  let requested=0,reads=0;
  let finishOld!:(value:any)=>void;
  render(<App services={{...services,createAccount:async()=>({address,balance:'0',delegation:'undelegated'}),requestTestFunds:async()=>{requested++;return {claimId:'a'.repeat(32),chainId:'421614',address,amountWei:'1000000000000000',status:'confirmed',transactionHash:`0x${'b'.repeat(64)}`};},refresh:()=>++reads===1?new Promise(done=>{finishOld=done;}):Promise.resolve({address,balance:'0.001',delegation:'undelegated'})}}/>);
  await userEvent.click(screen.getByRole('button',{name:'创建测试钱包'}));
  await screen.findByText(exactText('0 ETH'));
  vi.useFakeTimers();
  try{
    await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'领取测试币'}));});
    expect(screen.getByRole('status')).toHaveTextContent('正在刷新余额');
    await act(async()=>{await vi.advanceTimersByTimeAsync(15000);});
    expect(screen.getByRole('status')).toHaveTextContent('测试币已发放，余额刷新失败');
    await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'重试刷新余额'}));});
    expect(screen.getByText(exactText('0.001 ETH'))).toBeVisible();
    expect(requested).toBe(1);
    await act(async()=>{finishOld({address,balance:'0',delegation:'undelegated'});});
    expect(screen.getByText(exactText('0.001 ETH'))).toBeVisible();
    expect(screen.queryByText(exactText('0 ETH'))).not.toBeInTheDocument();
  }finally{vi.useRealTimers();}
});
test('ignores an older refresh timeout while the newer automatic balance read is still pending',async()=>{
  let reads=0,finishLatest!:(value:any)=>void;
  render(<App services={{...services,createAccount:async()=>({address,balance:'0',delegation:'undelegated'}),requestTestFunds:async()=>({claimId:'a'.repeat(32),chainId:'421614',address,amountWei:'1000000000000000',status:'confirmed',transactionHash:`0x${'b'.repeat(64)}`}),refresh:()=>++reads===1?new Promise(()=>{}):new Promise(done=>{finishLatest=done;})}}/>);
  await userEvent.click(screen.getByRole('button',{name:'创建测试钱包'}));await screen.findByText(exactText('0 ETH'));
  vi.useFakeTimers();
  try{
    await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'刷新余额'}));await vi.advanceTimersByTimeAsync(1000);});
    await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'领取测试币'}));});
    await act(async()=>{await vi.advanceTimersByTimeAsync(14000);});
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('正在刷新余额');
    await act(async()=>{finishLatest({address,balance:'0.001',delegation:'undelegated'});});
    expect(screen.getByText(exactText('0.001 ETH'))).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  }finally{vi.useRealTimers();}
});
test('explains invalid transfer fields before requesting a preview and clears the errors after correction',async()=>{
  const drafts:any[]=[];render(<App services={{...services,preview:async draft=>{drafts.push(draft);return{...draft,maxCost:'0.0002',payment:'self',id:'validated'};}}}/>);
  await userEvent.click(screen.getByRole('button',{name:'创建测试钱包'}));await openTransfer();await userEvent.click(await screen.findByRole('button',{name:'预览交易'}));
  expect(await screen.findByText('请输入有效的收款地址。')).toBeVisible();expect(screen.getByText('请输入大于 0 的金额，最多支持 18 位小数。')).toBeVisible();
  expect(screen.getByLabelText('收款地址')).toHaveAttribute('aria-invalid','true');expect(drafts).toEqual([]);
  await userEvent.type(screen.getByLabelText('收款地址'),address);await userEvent.type(screen.getByLabelText('金额（ETH）'),'0.001');
  await userEvent.click(screen.getByRole('button',{name:'预览交易'}));expect(await screen.findByRole('dialog',{name:'确认交易'})).toBeVisible();
  expect(drafts).toEqual([{recipient:address,amount:'0.001',sponsored:false}]);expect(screen.queryByText('请输入有效的收款地址。')).not.toBeInTheDocument();
});
test('keeps an unknown account out of the transfer step even if availability is optimistic',async()=>{
  render(<App services={{...services,listWallets:async()=>[{id:'alpha',name:'Alpha Wallet'}],connectWallet:async()=>({address,balance:'0.02',delegation:'unknown',connection:{walletId:'alpha',walletName:'Alpha Wallet'},availability:{canSubmit:true,canRevoke:false}})}}/>);
  await userEvent.click(screen.getByRole('button',{name:'连接钱包'}));await userEvent.click(await screen.findByRole('button',{name:'Alpha Wallet'}));
  expect(await screen.findByText('先核对账户状态')).toBeVisible();expect(screen.queryByLabelText('收款地址')).not.toBeInTheDocument();
});
test('lets the user return from review to edit without signing or losing the draft',async()=>{
  let signed=false;render(<App services={{...services,preview:async draft=>({...draft,maxCost:'0.0002',payment:'self',id:'edit-review'}),submit:async()=>{signed=true;throw new Error('Not expected');}}}/>);
  await userEvent.click(screen.getByRole('button',{name:'创建测试钱包'}));await requestPreview();
  await userEvent.click(await screen.findByRole('button',{name:'返回修改'}));
  expect(screen.queryByRole('dialog',{name:'确认交易'})).not.toBeInTheDocument();expect(screen.getByLabelText('收款地址')).toHaveValue(address);expect(screen.getByLabelText('金额（ETH）')).toHaveValue('0.001');expect(signed).toBe(false);
});
test('explains the next step after submission and shows status refresh progress',async()=>{
  let resolve!:(value:any)=>void;const pending=new Promise(done=>resolve=done);
  render(<App services={{...services,preview:async draft=>({...draft,maxCost:'0.0002',payment:'self',id:'status-guide'}),submit:async()=>({hash:'0xworkflow',submission:'accepted',execution:'unknown',confirmation:'pending'}),status:async()=>pending as any}}/>);
  await userEvent.click(screen.getByRole('button',{name:'创建测试钱包'}));await requestPreview();await userEvent.click(await screen.findByRole('button',{name:'确认并签名'}));
  expect(await screen.findByText('交易已提交。点击“刷新交易状态”查看执行结果。')).toBeVisible();
  await userEvent.click(screen.getByRole('button',{name:'刷新交易状态'}));expect(await screen.findByRole('button',{name:'正在查询链上状态…'})).toBeDisabled();
  await act(async()=>resolve({hash:'0xworkflow',submission:'accepted',execution:'succeeded',confirmation:'confirmed'}));expect(await screen.findByText('交易已确认')).toBeVisible();
});
test('prioritizes reorg guidance over a previously observed successful execution',async()=>{
  render(<App services={{...services,preview:async draft=>({...draft,maxCost:'0.0002',payment:'self',id:'reorg-guidance'}),submit:async()=>({hash:'0xreorged',submission:'accepted',execution:'succeeded',confirmation:'reorged'})}}/>);
  await userEvent.click(screen.getByRole('button',{name:'创建测试钱包'}));await requestPreview();await userEvent.click(await screen.findByRole('button',{name:'确认并签名'}));
  expect(await screen.findByText('链发生重组，待重新核实')).toBeVisible();
  expect(screen.getByText('链发生重组，原执行结果需要重新核实。请刷新交易状态后再决定下一步。')).toBeVisible();
  expect(screen.queryByText('转账已执行，正在等待链上确认。你可以刷新查看进度。')).not.toBeInTheDocument();
  expect(screen.getByRole('button',{name:'刷新交易状态'})).toBeEnabled();
});

test('connects the explicitly selected external wallet and displays its account without importing a key', async () => {
  render(<App services={{ ...services,
    listWallets: async () => [{ id: 'alpha', name: 'Alpha Wallet' }, { id: 'beta', name: 'Beta Wallet' }],
    connectWallet: async id => { if (id !== 'beta') throw new Error('Wrong wallet selected'); return { address, balance: '0.04', delegation: 'undelegated', connection: { walletId: 'beta', walletName: 'Beta Wallet' } }; },
  }} />);
  await userEvent.click(screen.getByRole('button', { name: '连接钱包' }));
  expect(await screen.findByRole('dialog', { name: '选择钱包' })).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: 'Beta Wallet' }));
  expect(await screen.findByText(address)).toBeVisible();
  expect(screen.getByText(exactText('0.04 ETH'))).toBeVisible();
  await openSettings();
  expect(screen.getByText('已连接 Beta Wallet')).toBeVisible();
  expect(screen.queryByRole('dialog', { name: '选择钱包' })).not.toBeInTheDocument();
});

test('keeps wallet selection pending until approval and exposes a rejected connection for retry', async () => {
  let reject!: (error: Error) => void;
  const pending = new Promise<never>((_resolve, fail) => { reject = fail; });
  render(<App services={{ ...services, listWallets: async () => [{ id: 'alpha', name: 'Alpha Wallet' }, { id: 'beta', name: 'Beta Wallet' }], connectWallet: async () => pending }} />);
  await userEvent.click(screen.getByRole('button', { name: '连接钱包' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Alpha Wallet' }));
  expect(screen.getByRole('button', { name: 'Alpha Wallet' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Beta Wallet' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '等待钱包确认' })).toBeDisabled();
  expect(screen.getByRole('status')).toHaveTextContent('正在连接 Alpha Wallet');
  expect(screen.queryByText(address)).not.toBeInTheDocument();
  await act(async () => reject(new Error('用户取消连接')));
  expect(await screen.findByRole('alert')).toHaveTextContent('用户取消连接');
  expect(screen.getByRole('button', { name: 'Alpha Wallet' })).toBeEnabled();
});

test.each(['preview', 'operation'] as const)('clears %s and every approval when the connected wallet context changes', async stage => {
  let changed = () => {};
  render(<App services={{ ...services,
    listWallets: async () => [{ id: 'alpha', name: 'Alpha Wallet' }],
    connectWallet: async () => ({ address, balance: '0.04', delegation: 'enabled', connection: { walletId: 'alpha', walletName: 'Alpha Wallet' } }),
    onWalletChange: listener => { changed = listener; return () => {}; },
    preview: async () => ({ recipient: address, amount: '0.001', maxCost: '0.0002', payment: 'self', id: 'old-context' }),
    submit: async () => ({ hash: '0xold-context', submission: 'accepted', execution: 'unknown', confirmation: 'pending' }),
  }} />);
  await userEvent.click(screen.getByRole('button', { name: '连接钱包' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Alpha Wallet' }));
  await requestPreview();
  if (stage === 'operation') {
    await userEvent.click(await screen.findByRole('button', { name: '确认并签名' }));
    await userEvent.click(await screen.findByRole('button', { name: '取消待处理交易' }));
    await openSettings();
    await userEvent.click(screen.getByRole('button', { name: '撤销智能账户' }));
  }
  await act(async () => changed());
  expect(screen.queryAllByText(address)).toHaveLength(0);
  expect(screen.queryByText('0xold-context')).not.toBeInTheDocument();
  expect(screen.queryAllByRole('dialog')).toHaveLength(0);
  expect(screen.queryByRole('button', { name: '确认并签名' })).not.toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent('钱包账户或网络已变化，请重新连接');
});

test.each(['connect', 'preview', 'submit', 'refresh', 'cancel', 'revoke'] as const)('ignores a late %s result from the invalidated wallet', async stage => {
  let changed = () => {};
  let resolve!: (value: any) => void;
  const pending = new Promise<any>(done => { resolve = done; });
  const snapshot = { address, balance: '0.04', delegation: 'enabled' as const, connection: { walletId: 'alpha', walletName: 'Alpha Wallet' } };
  const preview: Preview = { recipient: address, amount: '0.001', maxCost: '0.0002', payment: 'self', id: 'late-preview' };
  const operation = { hash: '0xstale', submission: 'accepted' as const, execution: 'unknown' as const, confirmation: 'pending' as const };
  render(<App services={{ ...services,
    listWallets: async () => [{ id: 'alpha', name: 'Alpha Wallet' }],
    connectWallet: async () => stage === 'connect' ? pending : snapshot,
    onWalletChange: listener => { changed = listener; return () => {}; },
    preview: async () => stage === 'preview' ? pending : preview,
    submit: async () => stage === 'submit' ? pending : operation,
    refresh: async () => pending,
    cancel: async () => pending,
    revoke: async () => pending,
  }} />);
  await userEvent.click(screen.getByRole('button', { name: '连接钱包' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Alpha Wallet' }));
  if (stage === 'refresh') await userEvent.click(await screen.findByRole('button', { name: '刷新余额' }));
  if (['preview', 'submit', 'cancel'].includes(stage)) await requestPreview();
  if (['submit', 'cancel'].includes(stage)) await userEvent.click(await screen.findByRole('button', { name: '确认并签名' }));
  if (stage === 'cancel') {
    await userEvent.click(await screen.findByRole('button', { name: '取消待处理交易' }));
    await userEvent.click(screen.getByRole('button', { name: '签名取消操作' }));
  }
  if (stage === 'revoke') {
    await openSettings();
    await userEvent.click(await screen.findByRole('button', { name: '撤销智能账户' }));
    await userEvent.click(screen.getByRole('button', { name: '确认撤销' }));
  }
  await act(async () => changed());
  await act(async () => resolve(stage === 'connect' || stage === 'refresh' ? snapshot : stage === 'preview' ? preview : stage === 'revoke' ? { transactionHash: '0xstale', confirmed: true } : operation));
  expect(screen.queryAllByText(address)).toHaveLength(0);
  expect(screen.queryByText('0xstale')).not.toBeInTheDocument();
  expect(screen.queryAllByRole('dialog')).toHaveLength(0);
  expect(screen.getByRole('alert')).toHaveTextContent('钱包账户或网络已变化，请重新连接');
});

test.each([
  [false, '当前钱包暂不支持所需签名'],
  [true, '当前钱包不支持原生撤销'],
] as const)('shows signer limits and permits transfers only when supported=%s', async (canSubmit, reason) => {
  render(<App services={{ ...services, listWallets: async () => [{ id: 'alpha', name: 'Alpha Wallet' }], connectWallet: async () => ({ address, balance: '0.04', delegation: 'enabled', connection: { walletId: 'alpha', walletName: 'Alpha Wallet' }, availability: { canSubmit, canRevoke: false, reason } }) }} />);
  await userEvent.click(screen.getByRole('button', { name: '连接钱包' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Alpha Wallet' }));
  expect(await screen.findByText(reason)).toBeVisible();
  if (canSubmit) { await openTransfer(); expect(screen.getByRole('button', { name: '预览交易' })).toBeEnabled(); }
  else { expect(screen.getByRole('button', { name: '转账' })).toBeDisabled(); expect(screen.queryByRole('button', { name: '预览交易' })).not.toBeInTheDocument(); }
  await openSettings();
  expect(screen.getByRole('button', { name: '撤销智能账户' })).toBeDisabled();
});

test('disconnects the external wallet and removes its preview without claiming revocation', async () => {
  render(<App services={{ ...services,
    listWallets: async () => [{ id: 'alpha', name: 'Alpha Wallet' }],
    connectWallet: async () => ({ address, balance: '0.04', delegation: 'enabled', connection: { walletId: 'alpha', walletName: 'Alpha Wallet' } }),
    disconnectWallet: async () => {},
    preview: async () => ({ recipient: address, amount: '0.001', maxCost: '0.0002', payment: 'self', id: 'disconnect-preview' }),
  }} />);
  await userEvent.click(screen.getByRole('button', { name: '连接钱包' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Alpha Wallet' }));
  await requestPreview();
  await openSettings();
  await userEvent.click(screen.getByRole('button', { name: '断开连接' }));
  expect(await screen.findByRole('status')).toHaveTextContent('已断开连接；链上委托不会自动撤销');
  expect(screen.queryAllByText(address)).toHaveLength(0);
  expect(screen.queryAllByRole('dialog')).toHaveLength(0);
  expect(screen.queryByText('撤销已确认')).not.toBeInTheDocument();
});

test('does not restore the previous wallet preview after explicitly connecting another wallet', async () => {
  let resolve!: (value: Preview) => void;
  const pending = new Promise<Preview>(done => { resolve = done; });
  const second = '0x2222222222222222222222222222222222222222';
  render(<App services={{ ...services,
    listWallets: async () => [{ id: 'alpha', name: 'Alpha Wallet' }, { id: 'beta', name: 'Beta Wallet' }],
    connectWallet: async id => ({ address: id === 'alpha' ? address : second, balance: '0.04', delegation: 'undelegated', connection: { walletId: id, walletName: id === 'alpha' ? 'Alpha Wallet' : 'Beta Wallet' } }),
    preview: async () => pending,
  }} />);
  await userEvent.click(screen.getByRole('button', { name: '连接钱包' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Alpha Wallet' }));
  await requestPreview();
  await openSettings();
  await userEvent.click(screen.getByRole('button', { name: '切换钱包' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Beta Wallet' }));
  expect(await screen.findByText(second)).toBeVisible();
  await act(async () => resolve({ recipient: address, amount: '0.001', maxCost: '0.0002', payment: 'self', id: 'old-preview' }));
  expect(screen.queryAllByText(address)).toHaveLength(0);
  expect(screen.queryByRole('dialog', { name: '确认交易' })).not.toBeInTheDocument();
});

test('offers external connection first and hides private key tools until explicitly expanded', async () => {
  render(<App services={{ ...services, listWallets: async () => [], connectWallet: async () => { throw new Error('unused'); }, importAccount: async () => ({ address, balance: '0', delegation: 'undelegated' }) }} />);
  expect(screen.getByRole('button', { name: '连接钱包' })).toBeVisible();
  const tools = screen.getByText('开发测试工具');
  expect(screen.getByLabelText('测试账户私钥')).not.toBeVisible();
  await userEvent.click(tools);
  expect(screen.getByLabelText('测试账户私钥')).toBeVisible();
  expect(screen.getByRole('button', { name: '创建测试钱包' })).toBeVisible();
});

test('explains missing wallets and lets the user discover an installed wallet again or close the picker', async () => {
  let available = false;
  render(<App services={{ ...services, listWallets: async () => available ? [{ id: 'alpha', name: 'Alpha Wallet' }] : [], connectWallet: async () => { throw new Error('unused'); } }} />);
  await userEvent.click(screen.getByRole('button', { name: '连接钱包' }));
  expect(await screen.findByText('未发现可连接钱包，请在已安装钱包的浏览器中打开此页面。')).toBeVisible();
  available = true;
  await userEvent.click(screen.getByRole('button', { name: '重新检测钱包' }));
  expect(await screen.findByRole('button', { name: 'Alpha Wallet' })).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: '关闭选择' }));
  expect(screen.queryByRole('dialog', { name: '选择钱包' })).not.toBeInTheDocument();
});

test('does not restore an outdated preview when the user edits the transfer during preparation', async () => {
  let resolve!: (value: Preview) => void;
  const pending = new Promise<Preview>(done => { resolve = done; });
  render(<App services={{ ...services, preview: async () => pending }} />);
  await userEvent.click(screen.getByRole('button', { name: '创建测试钱包' }));
  await requestPreview();
  await userEvent.clear(screen.getByLabelText('金额（ETH）'));
  await userEvent.type(screen.getByLabelText('金额（ETH）'), '0.002');
  await act(async () => resolve({ recipient: address, amount: '0.001', maxCost: '0.0002', payment: 'self', id: 'outdated-draft' }));
  expect(screen.queryByRole('dialog', { name: '确认交易' })).not.toBeInTheDocument();
  expect(screen.getByLabelText('金额（ETH）')).toHaveValue('0.002');
});

test('shows account creation failure and allows retry', async () => {
  render(<App services={{ ...services, createAccount: async () => { throw new Error('网络暂不可用'); } }} />);
  await userEvent.click(screen.getByRole('button', { name: '创建测试钱包' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('网络暂不可用');
  expect(screen.getByRole('button', { name: '创建测试钱包' })).toBeEnabled();
});

test('imports an existing test key without retaining it in the visible form and refreshes balance', async () => {
  let imported = '';
  render(<App services={{ ...services, importAccount: async (key) => { imported = key; return { address, balance: '0.02', delegation: 'undelegated' }; }, refresh: async () => ({ address, balance: '0.03', delegation: 'enabled' }) }} />);
  const input = screen.getByLabelText('测试账户私钥');
  expect(input).toHaveAttribute('type', 'password');
  await userEvent.type(input, 'fixture-only-key');
  await userEvent.click(screen.getByRole('button', { name: '导入测试账户' }));
  expect(await screen.findByText(address)).toBeVisible();
  expect(imported).toBe('fixture-only-key');
  expect(input).toHaveValue('');
  await userEvent.click(screen.getByRole('button', { name: '刷新余额' }));
  expect(await screen.findByText(exactText('0.03 ETH'))).toBeVisible();
  expect(screen.getByText('智能账户已启用')).toBeVisible();
});

test('shows the created test account and its chain scoped asset balance', async () => {
  render(<App services={services} />);
  await userEvent.click(screen.getByRole('button', { name: '创建测试钱包' }));
  expect(await screen.findByText(address)).toBeVisible();
  expect(screen.getByText(exactText('0.02 ETH'))).toBeVisible();
  expect(screen.getByText('未启用智能账户')).toBeVisible();
  expect(screen.getByText('Arbitrum Sepolia')).toBeVisible();
});

test('previews the exact recipient and sends only the approved preview', async () => {
  const preview: Preview = { recipient: '0x2222222222222222222222222222222222222222', amount: '0.001', maxCost: '0.0002', payment: 'self', id: 'preview-1' };
  let sent: Preview | undefined;
  render(<App services={{ ...services, preview: async () => preview, submit: async (p) => { sent = p; return { hash: '0xabc', submission: 'accepted', execution: 'unknown', confirmation: 'pending' }; } }} />);
  await userEvent.click(screen.getByRole('button', { name: '创建测试钱包' }));
  await openTransfer();
  await userEvent.type(await screen.findByLabelText('收款地址'), preview.recipient);
  await userEvent.type(screen.getByLabelText('金额（ETH）'), '0.001');
  await requestPreview();
  expect(await screen.findByRole('dialog', { name: '确认交易' })).toHaveTextContent(preview.recipient);
  expect(within(screen.getByRole('dialog',{name:'确认交易'})).getByLabelText('手续费上限')).toHaveTextContent(/^0\.0002 ETH$/);
  expect(sent).toBeUndefined();
  await userEvent.click(screen.getByRole('button', { name: '确认并签名' }));
  expect(await screen.findByText('0xabc')).toBeVisible();
  expect(sent).toEqual(preview);
  expect(screen.getByText('已受理，等待执行')).toBeVisible();
});

test('keeps a rejected signature as a visible error without an admitted operation', async () => {
  render(<App services={{ ...services, preview: async () => ({ recipient: address, amount: '0.001', maxCost: '0.0002', payment: 'self', id: 'rejected-preview' }), submit: async () => { throw new Error('用户取消签名'); } }} />);
  await userEvent.click(screen.getByRole('button', { name: '创建测试钱包' }));
  await requestPreview();
  await userEvent.click(await screen.findByRole('button', { name: '确认并签名' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('用户取消签名');
  expect(screen.queryByText('已受理，等待执行')).not.toBeInTheDocument();
});

test('invalidates the old approval when the transfer amount changes', async () => {
  render(<App services={{ ...services, preview: async () => ({ recipient: address, amount: '0.001', maxCost: '0.0002', payment: 'self', id: 'old-preview' }) }} />);
  await userEvent.click(screen.getByRole('button', { name: '创建测试钱包' }));
  await requestPreview();
  expect(await screen.findByRole('dialog', { name: '确认交易' })).toBeVisible();
  await userEvent.click(screen.getByRole('button',{name:'返回修改'}));
  await userEvent.clear(screen.getByLabelText('金额（ETH）'));
  await userEvent.type(screen.getByLabelText('金额（ETH）'), '0.002');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '确认并签名' })).not.toBeInTheDocument();
});

test.each([
  ['reverted', 'confirmed', 'accepted', '执行失败'],
  ['unknown', 'pending', 'unknown', '提交结果待核实'],
  ['succeeded', 'pending', 'accepted', '执行成功，等待确认'],
  ['succeeded', 'confirmed', 'accepted', '交易已确认'],
  ['succeeded', 'reorged', 'accepted', '链发生重组，待重新核实'],
] as const)('shows %s and %s independently of admission', async (execution, confirmation, submission, label) => {
  render(<App services={{ ...services, createAccount: async () => ({ address, balance: '0.02', delegation: 'enabled' }), refresh: async () => ({ address, balance: '0.02', delegation: 'enabled' }), preview: async () => ({ recipient: address, amount: '0.001', maxCost: '0.0002', payment: 'self', id: 'state-preview' }), submit: async () => ({ hash: '0xstatus', execution, confirmation, submission }) }} />);
  await userEvent.click(screen.getByRole('button', { name: '创建测试钱包' }));
  await requestPreview();
  await userEvent.click(await screen.findByRole('button', { name: '确认并签名' }));
  if(label==='执行失败')expect(await screen.findByLabelText('业务执行')).toHaveTextContent(/^执行失败$/);
  else expect(await screen.findByText(label)).toBeVisible();
  expect(screen.getByText('智能账户已启用')).toBeVisible();
});

test('refreshes an admitted operation using observed execution and confirmation', async () => {
  render(<App services={{ ...services, preview: async () => ({ recipient: address, amount: '0.001', maxCost: '0.0002', payment: 'self', id: 'refresh-preview' }), submit: async () => ({ hash: '0xrefresh', submission: 'accepted', execution: 'unknown', confirmation: 'pending' }), status: async () => ({ hash: '0xrefresh', submission: 'accepted', execution: 'succeeded', confirmation: 'confirmed' }) }} />);
  await userEvent.click(screen.getByRole('button', { name: '创建测试钱包' }));
  await requestPreview();
  await userEvent.click(await screen.findByRole('button', { name: '确认并签名' }));
  await userEvent.click(await screen.findByRole('button', { name: '刷新交易状态' }));
  expect(await screen.findByText('交易已确认')).toBeVisible();
});

test('asks for a new cancellation approval and keeps it pending until observed confirmation', async () => {
  let canceled: string | undefined;
  render(<App services={{ ...services, preview: async () => ({ recipient: address, amount: '0.001', maxCost: '0.0002', payment: 'self', id: 'cancel-preview' }), submit: async () => ({ hash: '0xoriginal', submission: 'accepted', execution: 'unknown', confirmation: 'pending' }), cancel: async (hash) => { canceled = hash; return { hash: '0xcancel', submission: 'accepted', execution: 'unknown', confirmation: 'pending' }; } }} />);
  await userEvent.click(screen.getByRole('button', { name: '创建测试钱包' }));
  await requestPreview();
  await userEvent.click(await screen.findByRole('button', { name: '确认并签名' }));
  await userEvent.click(await screen.findByRole('button', { name: '取消待处理交易' }));
  expect(await screen.findByRole('dialog', { name: '确认取消交易' })).toBeVisible();
  expect(canceled).toBeUndefined();
  await userEvent.click(screen.getByRole('button', { name: '签名取消操作' }));
  expect(await screen.findByText('取消处理中')).toBeVisible();
  expect(canceled).toBe('0xoriginal');
  expect(screen.getByText('0xoriginal')).toBeVisible();
  expect(screen.queryByText('取消已确认')).not.toBeInTheDocument();
});

test('refreshes the cancellation hash before claiming cancellation confirmed', async () => {
  const hashes: string[] = [];
  render(<App services={{ ...services, preview: async () => ({ recipient: address, amount: '0.001', maxCost: '0.0002', payment: 'self', id: 'cancel-refresh' }), submit: async () => ({ hash: '0xoriginal', submission: 'accepted', execution: 'unknown', confirmation: 'pending' }), cancel: async () => ({ hash: '0xcancel', submission: 'accepted', execution: 'unknown', confirmation: 'pending' }), status: async hash => { hashes.push(hash); return { hash, submission: 'accepted', execution: 'succeeded', confirmation: 'confirmed' }; } }} />);
  await userEvent.click(screen.getByRole('button', { name: '创建测试钱包' }));
  await requestPreview();
  await userEvent.click(await screen.findByRole('button', { name: '确认并签名' }));
  await userEvent.click(await screen.findByRole('button', { name: '取消待处理交易' }));
  await userEvent.click(await screen.findByRole('button', { name: '签名取消操作' }));
  await userEvent.click(await screen.findByRole('button', { name: '刷新取消状态' }));
  expect(await screen.findByText('取消已确认')).toBeVisible();
  expect(hashes).toEqual(['0xcancel']);
});

test('requires approval for revocation and does not clear delegation before readback confirmation', async () => {
  let revoked = false;
  render(<App services={{ ...services, createAccount: async () => ({ address, balance: '0.02', delegation: 'enabled' }), revoke: async () => { revoked = true; return { transactionHash: '0xrevoke', confirmed: false }; } }} />);
  await userEvent.click(screen.getByRole('button', { name: '创建测试钱包' }));
  await openSettings();
  await userEvent.click(await screen.findByRole('button', { name: '撤销智能账户' }));
  expect(await screen.findByRole('dialog', { name: '确认撤销委托' })).toHaveTextContent('已有 Token 授权不会清除');
  expect(revoked).toBe(false);
  await userEvent.click(screen.getByRole('button', { name: '确认撤销' }));
  expect(await screen.findByText('撤销待确认')).toBeVisible();
  expect(screen.getByText('智能账户已启用')).toBeVisible();
  expect(revoked).toBe(true);
});

test('keeps sponsorship denial visible until the user explicitly selects self pay', async () => {
  const choices: boolean[] = [];
  render(<App services={{ ...services, preview: async (draft) => { choices.push(draft.sponsored); if (draft.sponsored) throw new Error('赞助额度不足，请选择自付'); return { recipient: address, amount: '0.001', maxCost: '0.0002', payment: 'self', id: 'self-after-denial' }; } }} />);
  await userEvent.click(screen.getByRole('button', { name: '创建测试钱包' }));
  await openTransfer();
  await userEvent.click(await screen.findByRole('radio', { name: '申请 Gas 赞助' }));
  await requestPreview();
  expect(await screen.findByRole('alert')).toHaveTextContent('赞助额度不足');
  expect(choices).toEqual([true]);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('radio', { name: '使用 ETH 自付' }));
  await requestPreview();
  expect(within(await screen.findByRole('dialog',{name:'确认交易'})).getByLabelText('手续费上限')).toHaveTextContent(/^0\.0002 ETH$/);
  expect(choices).toEqual([true, false]);
});
