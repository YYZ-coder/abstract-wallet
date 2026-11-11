import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import { TestEthFunding } from '../src/TestEthFunding';
import type { TestFundsClaim } from '../src/services';

const address = '0x1111111111111111111111111111111111111111';
const submittedClaim: TestFundsClaim = {claimId:'a'.repeat(32),chainId:'421614',address,amountWei:'1000000000000000',status:'submitted',transactionHash:`0x${'b'.repeat(64)}`};

test('one click requests test ETH and clearly waits without reporting funds or allowing duplicate claims', async () => {
  let resolve!: (claim: TestFundsClaim) => void;
  let claims = 0;
  let refreshed = false;
  render(<TestEthFunding address={address} onRequest={() => {claims++;return new Promise(done => {resolve=done;});}} onStatus={async()=>submittedClaim} onRefresh={()=>{refreshed=true;}} />);
  const button=screen.getByRole('button',{name:'领取测试币'});
  fireEvent.click(button);
  expect(screen.getByRole('button',{name:'正在申请测试币…'})).toBeDisabled();
  expect(screen.getByRole('status')).toHaveTextContent('正在申请 0.001 测试 ETH');
  fireEvent.click(button);
  expect(claims).toBe(1);
  expect(refreshed).toBe(false);
  await act(async()=>{resolve(submittedClaim);});
  expect(screen.getByRole('status')).toHaveTextContent('已提交领取交易，正在等待到账');
  expect(screen.getByRole('button',{name:'等待测试币到账…'})).toBeDisabled();
  expect(screen.queryByText(/领取成功|余额已刷新/)).not.toBeInTheDocument();
  expect(refreshed).toBe(false);
});

test('automatically checks the submitted claim and refreshes the balance only after confirmed receipt', async () => {
  vi.useFakeTimers();
  try{
    let refreshed=false;
    let finishRefresh!:()=>void;
    const queried:string[]=[];
    render(<TestEthFunding address={address} onRequest={async()=>submittedClaim} onStatus={async id=>{queried.push(id);return {...submittedClaim,status:'confirmed'};}} onRefresh={()=>{refreshed=true;return new Promise<void>(done=>{finishRefresh=done;});}}/>);
    await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'领取测试币'}));});
    expect(refreshed).toBe(false);
    await act(async()=>{await vi.advanceTimersByTimeAsync(2000);});
    expect(queried).toEqual(['a'.repeat(32)]);
    expect(refreshed).toBe(true);
    expect(screen.getByRole('status')).toHaveTextContent('测试币已到账，正在刷新余额');
    expect(screen.queryByText(/余额已刷新/)).not.toBeInTheDocument();
    await act(async()=>{finishRefresh();});
    expect(screen.getByRole('status')).toHaveTextContent('已领取 0.001 测试 ETH，余额已刷新');
    expect(screen.getByRole('button',{name:'今日已领取 0.001 ETH'})).toBeDisabled();
    const receipt=screen.getByRole('link',{name:'查看领取交易'});
    expect(receipt).toHaveAttribute('href',`https://sepolia.arbiscan.io/tx/0x${'b'.repeat(64)}`);
  }finally{vi.useRealTimers();}
});

test('offers the next daily claim after twenty-four hours without requiring a page reload',async()=>{
  vi.useFakeTimers();
  try{
    let requests=0;
    render(<TestEthFunding address={address} onRequest={async()=>{requests++;return {...submittedClaim,status:'confirmed'};}} onRefresh={()=>{}}/>);
    await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'领取测试币'}));});
    await act(async()=>{await vi.advanceTimersByTimeAsync(86_399_999);});
    expect(screen.getByRole('button',{name:'今日已领取 0.001 ETH'})).toBeDisabled();
    await act(async()=>{await vi.advanceTimersByTimeAsync(1);});
    const next=screen.getByRole('button',{name:'领取测试币'});
    expect(next).toBeEnabled();
    await act(async()=>{fireEvent.click(next);});
    expect(requests).toBe(2);
    expect(screen.getByRole('status')).toHaveTextContent('余额已刷新');
  }finally{vi.useRealTimers();}
});

test.each(['query failed','confirmation delayed'])('continues the same claim after %s without another disbursement request', async mode=>{
  vi.useFakeTimers();
  try{
    let requests=0;
    let recover=false;
    let refreshed=false;
    const queried:string[]=[];
    render(<TestEthFunding address={address} onRequest={async()=>{requests++;return submittedClaim;}} onStatus={async id=>{queried.push(id);if(recover)return {...submittedClaim,status:'confirmed'};if(mode==='query failed')throw new Error('暂时无法查询领取状态');return {...submittedClaim,status:'unknown'};}} onRefresh={()=>{refreshed=true;}}/>);
    await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'领取测试币'}));});
    await act(async()=>{await vi.advanceTimersByTimeAsync(mode==='query failed'?2000:120000);});
    expect(refreshed).toBe(false);
    expect(screen.queryByText(/余额已刷新/)).not.toBeInTheDocument();
    const resume=screen.getByRole('button',{name:'继续查询到账'});
    expect(resume).toBeEnabled();
    recover=true;
    await act(async()=>{fireEvent.click(resume);});
    expect(requests).toBe(1);
    expect(queried.every(id=>id==='a'.repeat(32))).toBe(true);
    expect(refreshed).toBe(true);
    expect(screen.getByRole('status')).toHaveTextContent('余额已刷新');
  }finally{vi.useRealTimers();}
});

test('offers balance refresh recovery after confirmed disbursement without requesting funds again', async()=>{
  let requests=0;
  let attempts=0;
  render(<TestEthFunding address={address} onRequest={async()=>{requests++;return {...submittedClaim,status:'confirmed'};}} onStatus={async()=>{throw new Error('must not need a new claim query');}} onRefresh={async()=>{attempts++;if(attempts===1)throw new Error('RPC timeout');}}/>);
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'领取测试币'}));});
  expect(screen.getByRole('status')).toHaveTextContent('测试币已发放，余额刷新失败');
  expect(screen.queryByText(/余额已刷新/)).not.toBeInTheDocument();
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'重试刷新余额'}));});
  expect(requests).toBe(1);
  expect(screen.getByRole('status')).toHaveTextContent('余额已刷新');
});

test.each(['claim response','status response'])('ignores the old %s after changing wallet address', async phase=>{
  vi.useFakeTimers();
  try{
    const nextAddress='0x2222222222222222222222222222222222222222';
    let resolve!:(claim:TestFundsClaim)=>void;
    const delayed=new Promise<TestFundsClaim>(done=>{resolve=done;});
    let oldRefreshed=false;
    let nextRefreshed=false;
    const {rerender}=render(<TestEthFunding address={address} onRequest={()=>phase==='claim response'?delayed:Promise.resolve(submittedClaim)} onStatus={()=>delayed} onRefresh={()=>{oldRefreshed=true;}}/>);
    await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'领取测试币'}));});
    if(phase==='status response')await act(async()=>{await vi.advanceTimersByTimeAsync(2000);});
    rerender(<TestEthFunding address={nextAddress} onRequest={async()=>({...submittedClaim,address:nextAddress,claimId:'c'.repeat(32),status:'confirmed'})} onRefresh={()=>{nextRefreshed=true;}}/>);
    expect(screen.getByRole('button',{name:'领取测试币'})).toBeEnabled();
    await act(async()=>{resolve({...submittedClaim,status:'confirmed'});});
    expect(oldRefreshed).toBe(false);
    expect(nextRefreshed).toBe(false);
    expect(screen.queryByText(/余额已刷新/)).not.toBeInTheDocument();
    expect(screen.queryByRole('link',{name:'查看领取交易'})).not.toBeInTheDocument();
    await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'领取测试币'}));});
    expect(nextRefreshed).toBe(true);
    expect(screen.getByRole('status')).toHaveTextContent('余额已刷新');
  }finally{vi.useRealTimers();}
});

test('stops an unfinished claim from refreshing after the wallet view is removed', async()=>{
  let resolve!:(claim:TestFundsClaim)=>void;
  let refreshed=false;
  const {unmount}=render(<TestEthFunding address={address} onRequest={()=>new Promise(done=>{resolve=done;})} onRefresh={()=>{refreshed=true;}}/>);
  fireEvent.click(screen.getByRole('button',{name:'领取测试币'}));
  unmount();
  await act(async()=>{resolve({...submittedClaim,status:'confirmed'});});
  expect(refreshed).toBe(false);
});

test.each([
  ['pending','正在处理领取申请，等待发送'],
  ['unknown','领取结果待核实，正在自动查询'],
  ['failed','领取交易执行失败，未确认到账'],
] as const)('accurately describes a %s claim without claiming success',async(status,message)=>{
  let refreshed=false;
  render(<TestEthFunding address={address} onRequest={async()=>({...submittedClaim,status})} onStatus={async()=>({...submittedClaim,status})} onRefresh={()=>{refreshed=true;}}/>);
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'领取测试币'}));});
  expect(screen.getByRole('status')).toHaveTextContent(message);
  expect(screen.queryByText(/余额已刷新|已领取 0.001/)).not.toBeInTheDocument();
  expect(refreshed).toBe(false);
  if(status==='failed')expect(screen.getByRole('button',{name:'领取未成功'})).toBeDisabled();
});

test('opens network-specific funding instructions for the current original wallet address', async () => {
  render(<TestEthFunding address={address} onRefresh={() => {}} />);
  expect(screen.queryByRole('region')).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: '领取测试币' }));
  const panel = screen.getByRole('region', { name: '领取 Arbitrum Sepolia 测试 ETH' });
  expect(panel).toHaveTextContent(address);
  expect(panel).toHaveTextContent('421614');
  expect(panel).toHaveTextContent('仅用于 Arbitrum Sepolia 测试网');
  expect(panel).toHaveTextContent('计算验证');
  expect(screen.getByRole('link', { name: '打开 OpenFaucet' })).toHaveAttribute('href', 'https://openfaucet.org/arbitrum-sepolia');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('copies exactly the current wallet address without sharing a key', async () => {
  const user = userEvent.setup();
  const copied: string[] = [];
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { copied.push(text); } } });
  render(<TestEthFunding address={address} onRefresh={() => {}} />);
  await user.click(screen.getByRole('button', { name: '领取测试币' }));
  await user.click(screen.getByRole('button', { name: '复制收款地址' }));
  expect(copied).toEqual(['0x1111111111111111111111111111111111111111']);
  expect(await screen.findByRole('status')).toHaveTextContent('收款地址已复制');
});

test.each(['unavailable', 'permission denied'])('offers manual address copying when clipboard is %s', async mode => {
  const user = userEvent.setup();
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: mode === 'unavailable' ? undefined : { writeText: async () => { throw new Error('Not allowed'); } } });
  render(<TestEthFunding address={address} onRefresh={() => {}} />);
  await user.click(screen.getByRole('button', { name: '领取测试币' }));
  await user.click(screen.getByRole('button', { name: '复制收款地址' }));
  expect(await screen.findByRole('status')).toHaveTextContent('无法自动复制，请手动选择并复制上方地址');
  expect(screen.getByText(address)).toBeVisible();
  expect(screen.queryByText('收款地址已复制')).not.toBeInTheDocument();
});

test('refreshes the actual wallet balance only when the user requests it and does not claim funds arrived', async () => {
  let requested = false;
  render(<TestEthFunding address={address} onRefresh={() => { requested = true; }} />);
  await userEvent.click(screen.getByRole('button', { name: '领取测试币' }));
  expect(requested).toBe(false);
  await userEvent.click(screen.getByRole('button', { name: '已领取，刷新余额' }));
  expect(requested).toBe(true);
  expect(screen.queryByText(/已到账|领取成功/)).not.toBeInTheDocument();
});

test('shows an in-progress refresh and prevents another refresh while balance is loading', async () => {
  let requested = false;
  render(<TestEthFunding address={address} onRefresh={() => { requested = true; }} refreshing />);
  await userEvent.click(screen.getByRole('button', { name: '领取测试币' }));
  const refresh = screen.getByRole('button', { name: '正在刷新余额…' });
  expect(refresh).toBeDisabled();
  await userEvent.click(refresh);
  expect(requested).toBe(false);
});

test('uses the newly selected wallet address and clears the previous copy confirmation', async () => {
  const user = userEvent.setup();
  const copied: string[] = [];
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { copied.push(text); } } });
  const nextAddress = '0x2222222222222222222222222222222222222222';
  const { rerender } = render(<TestEthFunding address={address} onRefresh={() => {}} />);
  await user.click(screen.getByRole('button', { name: '领取测试币' }));
  await user.click(screen.getByRole('button', { name: '复制收款地址' }));
  expect(await screen.findByRole('status')).toHaveTextContent('收款地址已复制');
  rerender(<TestEthFunding address={nextAddress} onRefresh={() => {}} />);
  expect(screen.queryByText('收款地址已复制')).not.toBeInTheDocument();
  expect(screen.getByText(nextAddress)).toBeVisible();
  await user.click(screen.getByRole('button', { name: '复制收款地址' }));
  expect(copied).toEqual(['0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222']);
  expect(await screen.findByRole('status')).toHaveTextContent('收款地址已复制');
});

test('lets the user collapse the funding instructions using the same button', async () => {
  render(<TestEthFunding address={address} onRefresh={() => {}} />);
  const toggle = screen.getByRole('button', { name: '领取测试币' });
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await userEvent.click(toggle);
  expect(toggle).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByRole('region', { name: '领取 Arbitrum Sepolia 测试 ETH' })).toBeVisible();
  await userEvent.click(toggle);
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByRole('region', { name: '领取 Arbitrum Sepolia 测试 ETH' })).not.toBeInTheDocument();
});
