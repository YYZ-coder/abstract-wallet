import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { App } from '../src/App';
import { OperationRecovery } from '../src/OperationRecovery';
import type { FinalityEvidence, ObservedOperation, OperationReference, OperationStatus, WalletServices } from '../src/services';

const address='0x1111111111111111111111111111111111111111';
const recipient='0x2222222222222222222222222222222222222222';
const hash=`0x${'a'.repeat(64)}`;
const pending:OperationStatus={hash,submission:'accepted',execution:'unknown',confirmation:'pending'};
const evidence=(stage:FinalityEvidence['stage']):FinalityEvidence=>({policyId:'arbitrum-sepolia-finalized-v1',stage,transactionHash:`0x${'b'.repeat(64)}`,blockNumber:'100',blockHash:`0x${'c'.repeat(64)}`,...(stage==='safe'?{safeBlockNumber:'101',finalizedBlockNumber:'99'}:{}),...(stage==='finalized'?{safeBlockNumber:'102',finalizedBlockNumber:'101'}:{})});
function services(overrides:Partial<WalletServices>={}):WalletServices{return{
 createAccount:async()=>({address,balance:'0.008',delegation:'enabled'}),refresh:async()=>({address,balance:'0.0078',delegation:'enabled'}),
 preview:async()=>({id:'approved',recipient,amount:'0.0001',maxCost:'0.00004',payment:'self'}),
 submit:vi.fn(async()=>pending),status:vi.fn(async()=>pending),cancel:vi.fn(async()=>pending),revoke:async()=>({transactionHash:'0xrevoke',confirmed:false}),...overrides,
};}
async function click(name:string){await act(async()=>{fireEvent.click(screen.getByRole('button',{name}));});}
async function send(){await click('创建测试钱包');await click('转账');await act(async()=>{fireEvent.change(screen.getByLabelText('收款地址'),{target:{value:recipient}});fireEvent.change(screen.getByLabelText('金额（ETH）'),{target:{value:'0.0001'}});});await click('预览交易');await click('确认并签名');}
async function tick(ms:number){await act(async()=>{await vi.advanceTimersByTimeAsync(ms);});}
afterEach(()=>vi.useRealTimers());

test('automatically reads the submitted operation and updates confirmation without signing or resending',async()=>{
 vi.useFakeTimers();const status=vi.fn(async()=>({...pending,execution:'succeeded' as const,confirmation:'confirmed' as const}));const api=services({status});render(<App services={api}/>);await send();
 expect(screen.getByText('已受理，等待执行')).toBeVisible();expect(status).not.toHaveBeenCalled();
 await tick(3000);
 expect(screen.getByText('交易已确认')).toBeVisible();expect(screen.getByLabelText('业务执行')).toHaveTextContent('已执行');expect(screen.getByLabelText('链上确认')).toHaveTextContent('已确认');
 expect(status).toHaveBeenCalledWith(hash);expect(api.submit).toHaveBeenCalledTimes(1);expect(api.cancel).not.toHaveBeenCalled();
 await tick(30000);expect(status).toHaveBeenCalledTimes(1);
});

test('shows L2, safe, unavailable and final confirmation as distinct evidence stages',async()=>{
 vi.useFakeTimers();
 const status=vi.fn()
  .mockResolvedValueOnce({...pending,execution:'succeeded',finality:evidence('l2')})
  .mockResolvedValueOnce({...pending,execution:'succeeded',finality:evidence('safe')})
  .mockResolvedValueOnce({...pending,execution:'succeeded',finality:evidence('unavailable')})
  .mockResolvedValueOnce({...pending,execution:'succeeded',confirmation:'confirmed',finality:evidence('finalized')});
 render(<App services={services({status})}/>);await send();
 await tick(3000);expect(screen.getByText('L2 已执行，等待最终确认')).toBeVisible();
 expect(screen.getByLabelText('链上确认')).toHaveTextContent('等待最终确认');
 await tick(3000);expect(screen.getByText('已安全确认，等待最终确认')).toBeVisible();
 expect(screen.getByLabelText('链上确认')).toHaveTextContent('已安全确认');
 await tick(3000);expect(screen.getByText('L2 已执行，最终确认暂不可用')).toBeVisible();
 expect(screen.getByText('已核实执行结果，最终确认查询暂不可用。系统将自动重试，也可手动刷新。')).toBeVisible();
 expect(screen.getByLabelText('业务执行')).toHaveTextContent('已执行');
 await tick(3000);expect(screen.getByText('交易已最终确认')).toBeVisible();
 expect(screen.getByLabelText('链上确认')).toHaveTextContent('已最终确认');
 expect(screen.getByText('本次转账的父链批次已最终确认，可以继续填写下一笔转账。')).toBeVisible();
});

test('keeps verified execution after read failures and backs off automatically before recovering',async()=>{
 vi.useFakeTimers();
 const executed:OperationStatus={...pending,execution:'succeeded',finality:evidence('l2')};
 const status=vi.fn().mockRejectedValueOnce(new Error('RPC temporarily unavailable')).mockRejectedValueOnce(new Error('RPC temporarily unavailable')).mockRejectedValueOnce(new Error('RPC temporarily unavailable')).mockResolvedValue({...executed,confirmation:'confirmed',finality:evidence('finalized')});
 render(<App services={services({submit:vi.fn(async()=>executed),status})}/>);await send();
 await tick(3000);
 expect(screen.getByRole('alert')).toHaveTextContent('状态更新暂不可用：RPC temporarily unavailable。保留上次已核实结果，系统将自动重试。');
 expect(screen.getByText('L2 已执行，等待最终确认')).toBeVisible();
 expect(screen.getByLabelText('业务执行')).toHaveTextContent('已执行');
 await tick(5999);expect(status).toHaveBeenCalledTimes(1);
 await tick(1);expect(status).toHaveBeenCalledTimes(2);
 await tick(11999);expect(status).toHaveBeenCalledTimes(2);
 await tick(1);expect(status).toHaveBeenCalledTimes(3);
 await tick(29999);expect(status).toHaveBeenCalledTimes(3);
 await tick(1);expect(screen.getByText('交易已最终确认')).toBeVisible();
 expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

const reference:OperationReference={chainId:'421614',address,hash};
function observed(operation:OperationStatus,balance='0.0078'):ObservedOperation{return{
 reference,wallet:{address,balance,delegation:'enabled'},operation,transactionHash:evidence('l2').transactionHash,
};}
test('automatically follows readonly recovery through finality and refreshes its actual balance',async()=>{
 vi.useFakeTimers();
 const inspectOperation=vi.fn()
  .mockResolvedValueOnce(observed({...pending,execution:'succeeded',finality:evidence('l2')}))
  .mockResolvedValueOnce(observed({...pending,execution:'succeeded',finality:evidence('safe')}))
  .mockResolvedValue(observed({...pending,execution:'succeeded',confirmation:'confirmed',finality:evidence('finalized')},'0.0077'));
 await act(async()=>{render(<OperationRecovery inspectOperation={inspectOperation} recentOperation={()=>reference}/>);});
 expect(screen.getByText('L2 已执行，等待最终确认')).toBeVisible();
 await tick(3000);expect(screen.getByText('已安全确认，等待最终确认')).toBeVisible();
 await tick(3000);expect(screen.getByText('交易已最终确认')).toBeVisible();expect(screen.getByText('0.0077 ETH')).toBeVisible();
 expect(screen.getByText('本次转账的父链批次已最终确认，可以继续填写下一笔转账。')).toBeVisible();
 await tick(30000);expect(inspectOperation).toHaveBeenCalledTimes(3);
});

test('serializes manual and automatic reads and continues even when the pending object is unchanged',async()=>{
 vi.useFakeTimers();
 let finish!: (value:OperationStatus)=>void;
 const status=vi.fn().mockImplementationOnce(()=>new Promise<OperationStatus>(resolve=>{finish=resolve;})).mockResolvedValueOnce(pending).mockResolvedValue({...pending,execution:'succeeded',confirmation:'confirmed'});
 render(<App services={services({status})}/>);await send();
 await click('刷新交易状态');
 expect(screen.getByRole('button',{name:'正在查询链上状态…'})).toBeDisabled();
 await tick(12000);expect(status).toHaveBeenCalledTimes(1);
 await act(async()=>{finish(pending);});
 await tick(3000);expect(status).toHaveBeenCalledTimes(2);
 await tick(3000);expect(status).toHaveBeenCalledTimes(3);
 expect(screen.getByText('交易已确认')).toBeVisible();
});

test('keeps checking reorged execution and clears the warning after canonical finality returns',async()=>{
 vi.useFakeTimers();
 const status=vi.fn().mockResolvedValueOnce({...pending,execution:'succeeded',confirmation:'reorged',finality:evidence('l2')}).mockResolvedValue({...pending,execution:'succeeded',confirmation:'confirmed',finality:evidence('finalized')});
 render(<App services={services({status})}/>);await send();
 await tick(3000);expect(screen.getByText('链发生重组，待重新核实')).toBeVisible();
 expect(screen.getByLabelText('业务执行')).toHaveTextContent('待重新核实');
 await tick(3000);expect(screen.getByText('交易已最终确认')).toBeVisible();
 expect(screen.queryByText('链发生重组，待重新核实')).not.toBeInTheDocument();
});

test.each(['account change','unmount'])('discards in-flight automatic reads on %s and stops scheduled work',async(mode)=>{
 vi.useFakeTimers();
 let changed!:()=>void;
 let finish!: (value:OperationStatus)=>void;
 const status=vi.fn(()=>new Promise<OperationStatus>(resolve=>{finish=resolve;}));
 const api=services({status,onWalletChange:listener=>{changed=listener;return()=>{};}});
 const view=render(<App services={api}/>);await send();await tick(3000);
 await act(async()=>{if(mode==='account change')changed();else view.unmount();});
 await act(async()=>{finish({...pending,execution:'succeeded',confirmation:'confirmed',finality:evidence('finalized')});});
 expect(screen.queryByText('交易已最终确认')).not.toBeInTheDocument();
 await tick(30000);expect(status).toHaveBeenCalledTimes(1);expect(api.submit).toHaveBeenCalledTimes(1);
});

test('automatically tracks the signed cancellation without claiming success before finality or signing again',async()=>{
 vi.useFakeTimers();
 const cancellationHash=`0x${'d'.repeat(64)}`;
 const cancellationPending={...pending,hash:cancellationHash};
 const api=services({cancel:vi.fn(async()=>cancellationPending),status:vi.fn(async(value:string):Promise<OperationStatus>=>value===cancellationHash?{...cancellationPending,execution:'succeeded',confirmation:'confirmed',finality:evidence('finalized')}:pending)});
 render(<App services={api}/>);await send();await click('取消待处理交易');await click('签名取消操作');
 expect(screen.getByText('取消处理中')).toBeVisible();
 await tick(3000);expect(screen.getByText('取消已最终确认')).toBeVisible();
 expect(api.status).toHaveBeenCalledWith(cancellationHash);expect(api.cancel).toHaveBeenCalledTimes(1);expect(api.submit).toHaveBeenCalledTimes(1);
});

test('tells the user that pending progress updates automatically and removes the hint when done',async()=>{
 vi.useFakeTimers();
 render(<App services={services({status:vi.fn(async():Promise<OperationStatus>=>({...pending,execution:'succeeded',confirmation:'confirmed'}))})}/>);await send();
 expect(screen.getByText('系统会自动查询交易进度，无需再次签名。')).toBeVisible();
 await tick(3000);expect(screen.queryByText('系统会自动查询交易进度，无需再次签名。')).not.toBeInTheDocument();
});
