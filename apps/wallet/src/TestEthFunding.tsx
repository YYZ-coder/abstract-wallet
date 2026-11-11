import { useEffect, useId, useRef, useState } from 'react';
import type { TestFundsClaim } from './services';

export type TestEthFundingProps = {
  address: string;
  onRefresh: () => void | Promise<void>;
  refreshing?: boolean;
  onRequest?: () => Promise<TestFundsClaim>;
  onStatus?: (claimId: string) => Promise<TestFundsClaim>;
};

export function TestEthFunding({ address, onRefresh, refreshing = false, onRequest, onStatus }: TestEthFundingProps) {
  const [open, setOpen] = useState(false);
  const [copyNotice, setCopyNotice] = useState<{ address: string; message: string }>();
  const panelId = useId();
  const [claim, setClaim] = useState<TestFundsClaim>();
  const [claiming, setClaiming] = useState(false);
  const [received, setReceived] = useState(false);
  const [claimMessage, setClaimMessage] = useState('');
  const requestActive = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const context = useRef(0);

  useEffect(() => {
    requestActive.current = false;
    setClaim(undefined); setClaiming(false); setReceived(false); setClaimMessage('');
    return () => { context.current++; clearTimeout(timer.current); };
  }, [address]);

  function pause(message: string, generation: number) {
    if (generation !== context.current) return;
    requestActive.current = false;
    setClaiming(false);
    setClaimMessage(message);
  }

  async function observeClaim(result: TestFundsClaim, pollsLeft = 60, generation = context.current): Promise<void> {
    if (generation !== context.current) return;
    setClaim(result);
    if (result.status === 'confirmed') {
      setClaimMessage('测试币已到账，正在刷新余额…');
      try {
        await onRefresh();
        if (generation === context.current) {
          setReceived(true);
          setClaimMessage('已领取 0.001 测试 ETH，余额已刷新');
          timer.current=setTimeout(()=>{
            if(generation!==context.current)return;
            requestActive.current=false;
            setClaim(undefined);setClaiming(false);setReceived(false);setClaimMessage('');
          },86_400_000);
        }
      } catch {
        pause('测试币已发放，余额刷新失败。请重试刷新余额，无需再次领取。', generation);
      }
      return;
    }
    if (result.status === 'failed') {
      setClaimMessage('领取交易执行失败，未确认到账。可使用其他领取方式，或稍后联系维护者。');
      return;
    }
    if (pollsLeft === 0) {
      pause('暂未核实到账，请继续查询同一笔领取；不会重复发币。', generation);
      return;
    }
    setClaimMessage(result.status === 'pending' ? '正在处理领取申请，等待发送…'
      : result.status === 'unknown' ? '领取结果待核实，正在自动查询…'
      : '已提交领取交易，正在等待到账…');
    if (onStatus) {
      timer.current = setTimeout(() => {
        void onStatus(result.claimId)
          .then(next => observeClaim(next, pollsLeft - 1, generation))
          .catch(error => pause(error instanceof Error ? error.message : '查询暂时失败，请稍后重试', generation));
      }, 2000);
    }
  }

  async function requestFunds() {
    if (!onRequest || requestActive.current) return;
    const generation = context.current;
    requestActive.current = true;
    setClaiming(true);
    setClaimMessage('正在申请 0.001 测试 ETH，请稍候…');
    try {
      const result = claim?.status === 'confirmed' ? claim
        : claim && onStatus ? await onStatus(claim.claimId) : await onRequest();
      await observeClaim(result, 60, generation);
    } catch (error) {
      pause(error instanceof Error ? error.message : '领取暂时失败，请重试', generation);
    }
  }

  const claimLabel = received ? '今日已领取 0.001 ETH'
    : claim?.status === 'failed' ? '领取未成功'
    : claiming ? (claim ? '等待测试币到账…' : '正在申请测试币…')
    : claim?.status === 'confirmed' ? '重试刷新余额'
    : claim ? '继续查询到账' : '领取测试币';
  async function copyAddress() {
    try { await navigator.clipboard.writeText(address); setCopyNotice({ address, message: '收款地址已复制' }); }
    catch { setCopyNotice({ address, message: '无法自动复制，请手动选择并复制上方地址' }); }
  }
  return <>
    <button type="button" className="funding-button" disabled={claiming} aria-expanded={onRequest?undefined:open} aria-controls={onRequest?undefined:panelId} onClick={() => onRequest?void requestFunds():setOpen(value => !value)}>{claimLabel}</button>
    {onRequest&&<button type="button" className="button-quiet" aria-expanded={open} aria-controls={panelId} onClick={()=>setOpen(value=>!value)}>其他领取方式</button>}
    {claimMessage&&<p className="funding-progress" role="status">{claimMessage}</p>}
    {claim?.transactionHash&&<a className="funding-receipt" href={`https://sepolia.arbiscan.io/tx/${claim.transactionHash}`} target="_blank" rel="noopener noreferrer">查看领取交易</a>}
    {open && <section id={panelId} className="funding-panel" aria-label="领取 Arbitrum Sepolia 测试 ETH">
      <h3>领取 Arbitrum Sepolia 测试 ETH</h3>
      <p>仅用于 Arbitrum Sepolia 测试网（网络编号 421614）。请把测试币领取到下面这个钱包地址。</p>
      <p className="funding-address">{address}</p>
      <button type="button" onClick={() => void copyAddress()}>复制收款地址</button>
      {copyNotice?.address === address && <p role="status">{copyNotice.message}</p>}
      <p>OpenFaucet 可能需要计算验证或人工验证，领取需要一定时间；是否到账以刷新后的余额为准。</p>
      <div className="funding-actions">
        <a href="https://openfaucet.org/arbitrum-sepolia" target="_blank" rel="noopener noreferrer">打开 OpenFaucet</a>
        <button type="button" onClick={onRefresh} disabled={refreshing} aria-busy={refreshing}>{refreshing ? '正在刷新余额…' : '已领取，刷新余额'}</button>
      </div>
    </section>}
  </>;
}
