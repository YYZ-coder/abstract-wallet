import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import { App } from '../src/App';
import type { WalletServices, Preview, OperationStatus } from '../src/services';

// Match exact wording even when typography splits a number and its unit.
const exactText=(expected:string)=>(_content:string,node:Element|null)=>{
  const normalized=(element:Element)=>element.textContent?.replace(/\s+/g,' ').trim();
  return node!==null&&normalized(node)===expected&&!Array.from(node.children).some(child=>normalized(child)===expected);
};

const address='0x1111111111111111111111111111111111111111';
const recipient='0x2222222222222222222222222222222222222222';
const approved:Preview={id:'independent-preview',recipient,amount:'0.001',maxCost:'0.000040',payment:'self'};
const pending:OperationStatus={hash:'0xoperation',submission:'accepted',execution:'unknown',confirmation:'pending'};
function fixture(overrides:Partial<WalletServices>={}):WalletServices{return {
  createAccount:async()=>({address,balance:'0.008',delegation:'enabled'}),
  refresh:async()=>({address,balance:'0.008',delegation:'enabled'}),
  preview:vi.fn(async()=>approved),submit:vi.fn(async()=>pending),status:async()=>pending,
  cancel:async()=>pending,revoke:async()=>({transactionHash:'0xrevoke',confirmed:false}),...overrides,
};}
async function openTransfer(){await userEvent.click(screen.getByRole('button',{name:'创建测试钱包'}));await userEvent.click(await screen.findByRole('button',{name:'转账'}));}
async function fillTransfer(){await userEvent.type(screen.getByLabelText('收款地址'),recipient);await userEvent.type(screen.getByLabelText('金额（ETH）'),'0.001');}

test('home shows the connected account and opens transfer only on explicit action',async()=>{
 const services=fixture();render(<App services={services}/>);
 await userEvent.click(screen.getByRole('button',{name:'创建测试钱包'}));
 expect(await screen.findByText(exactText('0.008 ETH'))).toBeVisible();
 expect(screen.getByText(address,{exact:true})).toBeVisible();
 expect(screen.queryByLabelText('收款地址')).not.toBeInTheDocument();
 await userEvent.click(screen.getByRole('button',{name:'转账'}));
 expect(screen.getByLabelText('收款地址')).toBeVisible();
 expect(services.preview).not.toHaveBeenCalled();expect(services.submit).not.toHaveBeenCalled();
});

test('leaving transfer preserves the draft but discards a late preview approval',async()=>{
 let finish!:(value:Preview)=>void;const services=fixture({preview:vi.fn(()=>new Promise<Preview>(done=>{finish=done;}))});
 render(<App services={services}/>);await openTransfer();await fillTransfer();
 await userEvent.click(screen.getByRole('button',{name:'预览交易'}));
 await userEvent.click(screen.getByRole('button',{name:'返回钱包'}));
 await act(async()=>finish(approved));
 expect(screen.queryByRole('dialog',{name:'确认交易'})).not.toBeInTheDocument();
 await userEvent.click(screen.getByRole('button',{name:'转账'}));
 expect(screen.getByLabelText('收款地址')).toHaveValue(recipient);
 expect(screen.getByLabelText('金额（ETH）')).toHaveValue('0.001');
 expect(screen.queryByRole('button',{name:'确认并签名'})).not.toBeInTheDocument();
 expect(services.submit).not.toHaveBeenCalled();
});

test.each([['self','0.001040'],['sponsored','0.001000']] as const)('review isolates the approved %s transfer and shows its exact maximum spend',async(payment,total)=>{
 const services=fixture({preview:vi.fn(async()=>({...approved,payment}))});render(<App services={services}/>);
 await openTransfer();await fillTransfer();await userEvent.click(screen.getByRole('button',{name:'预览交易'}));
 const review=await screen.findByRole('dialog',{name:'确认交易'});
 expect(screen.queryByLabelText('金额（ETH）')).not.toBeInTheDocument();
 expect(review).toHaveTextContent(address);expect(review).toHaveTextContent(recipient);
 expect(review).toHaveTextContent('Arbitrum Sepolia');
 expect(within(review).getByLabelText('最大支出')).toHaveTextContent(`${total} ETH`);
 expect(within(review).getByLabelText('手续费上限')).toHaveTextContent('0.000040 ETH');
 expect(services.submit).not.toHaveBeenCalled();
 await userEvent.click(within(review).getByRole('button',{name:'返回修改'}));
 expect(screen.getByLabelText('金额（ETH）')).toHaveValue('0.001');
 expect(screen.queryByRole('button',{name:'确认并签名'})).not.toBeInTheDocument();
});

test('fee choices are explicit and sponsorship denial never silently changes to self pay',async()=>{
 const preview=vi.fn(async(draft:any)=>{if(draft.sponsored)throw new Error('赞助额度不足');return approved;});
 render(<App services={fixture({preview})}/>);await openTransfer();await fillTransfer();
 expect(screen.getByRole('radio',{name:'使用 ETH 自付'})).toBeChecked();
 await userEvent.click(screen.getByRole('radio',{name:'申请 Gas 赞助'}));
 expect(screen.getByText('预览时可能需要签署赞助验证，提交时还需确认交易签名。')).toBeVisible();
 await userEvent.click(screen.getByRole('button',{name:'预览交易'}));
 expect(await screen.findByRole('alert')).toHaveTextContent('赞助额度不足');
 expect(screen.getByRole('radio',{name:'申请 Gas 赞助'})).toBeChecked();expect(preview).toHaveBeenCalledTimes(1);
 await userEvent.click(screen.getByRole('radio',{name:'使用 ETH 自付'}));await userEvent.click(screen.getByRole('button',{name:'预览交易'}));
 expect(await screen.findByRole('dialog',{name:'确认交易'})).toBeVisible();
 expect(preview.mock.calls.map(([draft])=>draft.sponsored)).toEqual([true,false]);
});

test('signing locks navigation and approved values until the wallet responds',async()=>{
 let finish!:(value:OperationStatus)=>void;
 const services=fixture({submit:vi.fn(()=>new Promise<OperationStatus>(done=>{finish=done;}))});
 render(<App services={services}/>);await openTransfer();await fillTransfer();
 await userEvent.click(screen.getByRole('button',{name:'预览交易'}));await userEvent.click(await screen.findByRole('button',{name:'确认并签名'}));
 expect(screen.getByRole('navigation',{name:'主导航'})).toBeVisible();
 for(const name of ['资产','活动','设置'])expect(screen.getByRole('button',{name})).toBeDisabled();
 expect(screen.getByRole('button',{name:'返回钱包'})).toBeDisabled();expect(screen.getByRole('button',{name:'返回修改'})).toBeDisabled();
 expect(screen.getByRole('dialog',{name:'确认交易'})).toHaveTextContent('0.001 ETH');
 expect(screen.queryByLabelText('金额（ETH）')).not.toBeInTheDocument();
 await userEvent.click(screen.getByRole('button',{name:'正在签名和提交…'}));expect(services.submit).toHaveBeenCalledTimes(1);
 expect(services.submit).toHaveBeenCalledWith(approved);
 await act(async()=>finish(pending));expect(await screen.findByText('已受理，等待执行')).toBeVisible();
 expect(screen.getByRole('button',{name:'资产'})).toBeEnabled();
});

test('results separate execution from confirmation and activity reopens the same operation without resubmitting',async()=>{
 const status=vi.fn(async()=>({...pending,execution:'succeeded' as const}));const services=fixture({status});render(<App services={services}/>);
 await openTransfer();await fillTransfer();await userEvent.click(screen.getByRole('button',{name:'预览交易'}));await userEvent.click(await screen.findByRole('button',{name:'确认并签名'}));
 expect(await screen.findByLabelText('业务执行')).toHaveTextContent('等待执行');
 expect(screen.getByLabelText('链上确认')).toHaveTextContent('等待确认');
 expect(screen.queryByLabelText('金额（ETH）')).not.toBeInTheDocument();
 await userEvent.click(screen.getByRole('button',{name:'刷新交易状态'}));
 expect(await screen.findByText('执行成功，等待确认')).toBeVisible();
 expect(screen.getByLabelText('业务执行')).toHaveTextContent('已执行');
 expect(screen.getByLabelText('链上确认')).toHaveTextContent('等待确认');
 await userEvent.click(screen.getByRole('button',{name:'返回钱包'}));
 expect(screen.queryByRole('heading',{name:'交易进度'})).not.toBeInTheDocument();
 await userEvent.click(screen.getByRole('button',{name:'活动'}));
 await userEvent.click(screen.getByRole('button',{name:'查看交易详情'}));
 expect(screen.getByText('0xoperation',{exact:true})).toBeVisible();
 expect(screen.getByLabelText('转账收款人')).toHaveTextContent(recipient);
 expect(services.submit).toHaveBeenCalledTimes(1);expect(status).toHaveBeenCalledWith('0xoperation');
});

test.each([false,true])('receive uses the current original address and reports clipboard failure=%s',async(fails)=>{
 const user=userEvent.setup();const writeText=vi.fn(async()=>{if(fails)throw new Error('denied');});
 Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText}});
 render(<App services={fixture()}/>);await user.click(screen.getByRole('button',{name:'创建测试钱包'}));
 await user.click(await screen.findByRole('button',{name:'收款'}));
 const receive=screen.getByRole('dialog',{name:'接收测试 ETH'});expect(receive).toHaveTextContent(address);expect(receive).toHaveTextContent('仅接收 Arbitrum Sepolia 测试 ETH');
 await user.click(within(receive).getByRole('button',{name:'复制收款地址'}));
 expect(writeText).toHaveBeenCalledWith(address);
 expect(within(receive).getByRole(fails?'alert':'status')).toHaveTextContent(fails?'复制失败，请手动复制上方地址':'收款地址已复制');
 await user.click(within(receive).getByRole('button',{name:'关闭收款'}));expect(screen.queryByRole('dialog',{name:'接收测试 ETH'})).not.toBeInTheDocument();
});

test('settings contains account maintenance while the asset home stays focused on transfer and receive',async()=>{
 render(<App services={fixture()}/>);await userEvent.click(screen.getByRole('button',{name:'创建测试钱包'}));
 await screen.findByText(exactText('0.008 ETH'));expect(screen.queryByRole('button',{name:'撤销智能账户'})).not.toBeInTheDocument();
 await userEvent.click(screen.getByRole('button',{name:'设置'}));
 expect(screen.getByRole('heading',{name:'账户设置'})).toBeVisible();expect(screen.getByRole('button',{name:'撤销智能账户'})).toBeEnabled();
 await userEvent.click(screen.getByRole('button',{name:'撤销智能账户'}));
 expect(screen.getByRole('dialog',{name:'确认撤销委托'})).toHaveTextContent('已有 Token 授权不会清除');
 await userEvent.click(screen.getByRole('button',{name:'保留委托'}));await userEvent.click(screen.getByRole('button',{name:'资产'}));
 expect(screen.getByRole('button',{name:'转账'})).toBeEnabled();expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('transfer stepper follows input, review, wallet confirmation and result',async()=>{
 let finish!:(value:OperationStatus)=>void;
 render(<App services={fixture({submit:()=>new Promise(done=>{finish=done;})})}/>);await openTransfer();
 const steps=()=>within(screen.getByRole('navigation',{name:'转账步骤'}));
 expect(steps().getByText('填写信息')).toHaveAttribute('aria-current','step');await fillTransfer();
 await userEvent.click(screen.getByRole('button',{name:'预览交易'}));await screen.findByRole('dialog',{name:'确认交易'});
 expect(steps().getByText('核对交易')).toHaveAttribute('aria-current','step');await userEvent.click(screen.getByRole('button',{name:'确认并签名'}));
 expect(steps().getByText('钱包确认')).toHaveAttribute('aria-current','step');
 await act(async()=>finish(pending));expect(steps().getByText('交易结果')).toHaveAttribute('aria-current','step');
});

test('the account guide starts the same transfer flow using the current original account',async()=>{
 render(<App services={fixture({listWallets:async()=>[{id:'alpha',name:'Alpha'}],connectWallet:async()=>({address,balance:'0.008',delegation:'enabled',connection:{walletId:'alpha',walletName:'Alpha'}})})}/>);
 await userEvent.click(screen.getByRole('button',{name:'连接钱包'}));await userEvent.click(await screen.findByRole('button',{name:'Alpha'}));
 expect(screen.getByRole('button',{name:'开始转账'})).not.toBeVisible();
 await userEvent.click(screen.getByText('账户使用引导'));
 await userEvent.click(screen.getByRole('button',{name:'开始转账'}));expect(screen.getByLabelText('收款地址')).toBeVisible();
});

test('signing also locks test account replacement and returns focus to editable input after a refusal',async()=>{
 let fail!:(reason:Error)=>void;
 render(<App services={fixture({submit:()=>new Promise((_done,reject)=>{fail=reject;})})}/>);
 await openTransfer();await fillTransfer();await userEvent.click(screen.getByRole('button',{name:'预览交易'}));await userEvent.click(await screen.findByRole('button',{name:'确认并签名'}));
 expect(screen.getByRole('button',{name:'创建测试钱包'})).toBeDisabled();
 await act(async()=>fail(new Error('用户取消签名')));expect(screen.getByRole('alert')).toHaveTextContent('用户取消签名');
 expect(screen.queryByText('已受理，等待执行')).not.toBeInTheDocument();
 await userEvent.click(screen.getByRole('button',{name:'返回修改'}));
 expect(screen.getByLabelText('收款地址')).toHaveFocus();expect(screen.getByLabelText('金额（ETH）')).toHaveValue('0.001');
 expect(screen.getByRole('button',{name:'创建测试钱包'})).toBeEnabled();
});

test('an older operation status cannot replace the newer transfer after navigating home',async()=>{
 let finish!:(value:OperationStatus)=>void;let submitted=0;
 render(<App services={fixture({submit:async()=>({...pending,hash:++submitted===1?'0xfirst':'0xsecond'}),status:()=>new Promise(done=>{finish=done;})})}/>);
 await openTransfer();await fillTransfer();await userEvent.click(screen.getByRole('button',{name:'预览交易'}));await userEvent.click(await screen.findByRole('button',{name:'确认并签名'}));
 await userEvent.click(await screen.findByRole('button',{name:'刷新交易状态'}));await userEvent.click(screen.getByRole('button',{name:'返回钱包'}));await userEvent.click(screen.getByRole('button',{name:'转账'}));
 await userEvent.click(screen.getByRole('button',{name:'预览交易'}));await userEvent.click(await screen.findByRole('button',{name:'确认并签名'}));
 expect(await screen.findByText('0xsecond',{exact:true})).toBeVisible();
 await act(async()=>finish({...pending,hash:'0xfirst',execution:'succeeded',confirmation:'confirmed'}));
 expect(screen.getByText('0xsecond',{exact:true})).toBeVisible();expect(screen.queryByText('0xfirst',{exact:true})).not.toBeInTheDocument();
 expect(screen.getByLabelText('业务执行')).toHaveTextContent('等待执行');
});

test('a long on-chain balance is shortened without rounding up and retains the exact balance for inspection',async()=>{
 render(<App services={fixture({createAccount:async()=>({address,balance:'0.0972986323885856',delegation:'enabled'})})}/>);
 await userEvent.click(screen.getByRole('button',{name:'创建测试钱包'}));
 const balance=await screen.findByLabelText('当前账户余额');
 expect(balance).toHaveTextContent('约 0.097298 ETH');expect(balance).toHaveAttribute('title','完整余额：0.0972986323885856 ETH');
 expect(screen.getByText('0.0972986323885856',{exact:false})).toBeVisible();
 await userEvent.click(screen.getByRole('button',{name:'转账'}));
 expect(screen.getByLabelText('转账可用余额')).toHaveTextContent('约 0.097298 ETH');
 expect(screen.getByLabelText('转账可用余额')).toHaveAttribute('title','完整余额：0.0972986323885856 ETH');
});

test('a positive balance below display precision is never presented as zero',async()=>{
 render(<App services={fixture({createAccount:async()=>({address,balance:'0.000000000000000001',delegation:'enabled'})})}/>);
 await userEvent.click(screen.getByRole('button',{name:'创建测试钱包'}));
 expect(await screen.findByLabelText('当前账户余额')).toHaveTextContent('< 0.000001 ETH');
 expect(screen.getByLabelText('当前账户余额')).toHaveAttribute('title','完整余额：0.000000000000000001 ETH');
});

test('a cancellation approved for an old operation cannot survive navigation to a new transfer',async()=>{
 const cancel=vi.fn(async()=>pending);let count=0;render(<App services={fixture({cancel,submit:async()=>({...pending,hash:++count===1?'0xfirst':'0xsecond'})})}/>);
 await openTransfer();await fillTransfer();await userEvent.click(screen.getByRole('button',{name:'预览交易'}));await userEvent.click(await screen.findByRole('button',{name:'确认并签名'}));
 await userEvent.click(await screen.findByRole('button',{name:'取消待处理交易'}));expect(screen.getByRole('dialog',{name:'确认取消交易'})).toBeVisible();
 await userEvent.click(screen.getByRole('button',{name:'返回钱包'}));
 expect(screen.queryByRole('dialog',{name:'确认取消交易'})).not.toBeInTheDocument();
 await userEvent.click(screen.getByRole('button',{name:'转账'}));await userEvent.click(screen.getByRole('button',{name:'预览交易'}));await userEvent.click(await screen.findByRole('button',{name:'确认并签名'}));
 expect(await screen.findByText('0xsecond',{exact:true})).toBeVisible();expect(screen.queryByRole('button',{name:'签名取消操作'})).not.toBeInTheDocument();expect(cancel).not.toHaveBeenCalled();
});

test('a late cancellation result remains attached to its original operation',async()=>{
 let finish!:(value:OperationStatus)=>void;let count=0;
 render(<App services={fixture({cancel:()=>new Promise(done=>{finish=done;}),submit:async()=>({...pending,hash:++count===1?'0xfirst':'0xsecond'})})}/>);
 await openTransfer();await fillTransfer();await userEvent.click(screen.getByRole('button',{name:'预览交易'}));await userEvent.click(await screen.findByRole('button',{name:'确认并签名'}));
 await userEvent.click(await screen.findByRole('button',{name:'取消待处理交易'}));await userEvent.click(screen.getByRole('button',{name:'签名取消操作'}));
 await userEvent.click(screen.getByRole('button',{name:'返回钱包'}));await userEvent.click(screen.getByRole('button',{name:'转账'}));await userEvent.click(screen.getByRole('button',{name:'预览交易'}));await userEvent.click(await screen.findByRole('button',{name:'确认并签名'}));
 await act(async()=>finish({...pending,hash:'0xcancel-first'}));
 expect(screen.getByText('0xsecond',{exact:true})).toBeVisible();expect(screen.queryByText('0xcancel-first',{exact:true})).not.toBeInTheDocument();expect(screen.queryByText('取消处理中')).not.toBeInTheDocument();
});

test('observed execution refreshes the original account delegation and balance from the wallet service',async()=>{
 const refresh=vi.fn(async()=>({address,balance:'0.0065',delegation:'enabled' as const}));
 render(<App services={fixture({createAccount:async()=>({address,balance:'0.008',delegation:'undelegated'}),refresh,status:async()=>({...pending,execution:'succeeded',confirmation:'confirmed'})})}/>);
 await openTransfer();await fillTransfer();await userEvent.click(screen.getByRole('button',{name:'预览交易'}));await userEvent.click(await screen.findByRole('button',{name:'确认并签名'}));
 expect(refresh).not.toHaveBeenCalled();await userEvent.click(await screen.findByRole('button',{name:'刷新交易状态'}));
 expect(await screen.findByText('智能账户已启用')).toBeVisible();
 await userEvent.click(screen.getByRole('button',{name:'返回钱包'}));expect(await screen.findByText(exactText('0.0065 ETH'))).toBeVisible();expect(refresh).toHaveBeenCalledTimes(1);
});
