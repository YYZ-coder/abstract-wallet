import { useEffect, useRef, useState } from 'react';
import { isAddress } from 'viem';
import type { ObservedOperation, OperationReference } from './services';

export type OperationRecoveryProps = {
  inspectOperation: (reference: OperationReference) => Promise<ObservedOperation>;
  recentOperation?: () => OperationReference | undefined;
};

export function OperationRecovery({ inspectOperation, recentOperation }: OperationRecoveryProps) {
  const [address, setAddress] = useState('');
  const [hash, setHash] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState<ObservedOperation>();
  const [waiting, setWaiting] = useState(false);
  const generation = useRef(0);
  const active = useRef(false);
  const queryTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    setResult(undefined); setError(''); setWaiting(false);
    const recent = recentOperation?.();
    if (recent) {
      setAddress(recent.address); setHash(recent.hash);
      void query(recent);
    }
    return () => { generation.current++; active.current = false; clearTimeout(queryTimer.current); };
  }, [inspectOperation, recentOperation]);

  function invalidateQuery() {
    generation.current++; active.current = false;
    clearTimeout(queryTimer.current);
    setResult(undefined); setError(''); setWaiting(false);
  }

  async function query(next: OperationReference = { chainId: '421614', address: address.trim(), hash: hash.trim() }) {
    if (active.current) return;
    if (next.chainId !== '421614' || !isAddress(next.address) || !/^0x[0-9a-fA-F]{64}$/.test(next.hash)) {
      setResult(undefined);
      setError('请输入有效的查询地址和 32 字节 UserOperation 编号');
      return;
    }
    const current = ++generation.current;
    active.current = true; setWaiting(true); setError(''); setResult(undefined);
    let timeout: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => {
      queryTimer.current = timeout = setTimeout(() => reject(new Error('查询超时，请重试只读查询')), 15000);
    });
    try {
      const observed = await Promise.race([inspectOperation(next), deadline]);
      if (generation.current === current) setResult(observed);
    } catch (failure) {
      if (generation.current === current) setError(failure instanceof Error ? failure.message : '查询失败，请重试');
    } finally {
      clearTimeout(timeout!);
      if (generation.current === current) { active.current = false; setWaiting(false); }
    }
  }
  const operation = result?.operation;
  const status = operation?.confirmation === 'reorged' ? '链发生重组，待重新核实'
    : operation?.execution === 'reverted' ? '执行失败'
    : operation?.execution === 'succeeded' ? operation.confirmation === 'confirmed' ? '交易已确认' : '执行成功，等待确认'
    : operation?.submission === 'rejected' ? '提交被拒绝'
    : operation?.submission === 'unknown' ? '提交结果待核实' : '已受理，等待执行';
  const transactionHash = result?.transactionHash && /^0x[0-9a-fA-F]{64}$/.test(result.transactionHash) ? result.transactionHash : undefined;
  return <section className="operation-recovery" aria-label="查询已提交交易">
    <h2>查询已提交交易</h2>
    <p>只读查询不会恢复签名会话，不会重新发送交易。</p>
    <p className="field-hint">Arbitrum Sepolia · 网络编号 421614</p>
    <form onSubmit={event => { event.preventDefault(); void query(); }}>
      <label>查询地址<input aria-label="查询地址" value={address} onChange={event => { invalidateQuery(); setAddress(event.target.value); }} autoComplete="off" spellCheck={false} /></label>
      <label>UserOperation 编号<input aria-label="UserOperation 编号" value={hash} onChange={event => { invalidateQuery(); setHash(event.target.value); }} autoComplete="off" spellCheck={false} /></label>
      <button type="submit" className="button-secondary" disabled={waiting} aria-busy={waiting}>{waiting ? '正在查询…' : '查询交易状态'}</button>
    </form>
    {waiting && <p role="status">正在查询链上状态，请稍候…</p>}
    {error && <p role="alert">{error}</p>}
    {result && <section className="recovery-result" aria-label="只读查询结果">
      <h3>只读查询结果</h3>
      <p className="address">{result.wallet.address}</p>
      <p>{result.wallet.balance} ETH</p>
      <p>{result.wallet.delegation === 'enabled' ? '原地址已启用智能账户' : result.wallet.delegation === 'undelegated' ? '原地址尚未启用智能账户' : '委托状态待核实'}</p>
      <p className="recovery-status">{status}</p>
      <p className="field-hint">UserOperation 编号</p><p className="operation-hash">{result.reference.hash}</p>
      {transactionHash && <>
        <p className="field-hint">链上交易哈希</p><p className="operation-hash">{transactionHash}</p>
        <a href={`https://sepolia.arbiscan.io/tx/${transactionHash}`} target="_blank" rel="noopener noreferrer">查看链上交易</a>
      </>}
    </section>}
  </section>;
}
