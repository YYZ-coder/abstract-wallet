import { useEffect, useRef, useState } from 'react';
import { isAddress } from 'viem';
import { presentOperation } from './operation-presentation';
import { useReadonlyPolling } from './use-readonly-polling';
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
  const [selected, setSelected] = useState<OperationReference>();
  const queryTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const tracking = useReadonlyPolling({
    key: selected ? `${selected.chainId}:${selected.address.toLowerCase()}:${selected.hash}` : undefined,
    terminal: result?.operation.confirmation === 'confirmed' || result?.operation.submission === 'rejected',
    scope: inspectOperation,
    read: async () => {
      let timeout: ReturnType<typeof setTimeout>;
      const deadline = new Promise<never>((_, reject) => {
        queryTimer.current = timeout = setTimeout(() => reject(new Error('查询超时，请重试只读查询')), 15000);
      });
      try { return await Promise.race([inspectOperation(selected!), deadline]); }
      finally { clearTimeout(timeout!); }
    },
    apply: setResult,
  });
  const waiting = tracking.busy;

  useEffect(() => {
    setResult(undefined); setError(''); setSelected(undefined);
    const recent = recentOperation?.();
    if (recent) {
      setAddress(recent.address); setHash(recent.hash);
      if (validReference(recent)) setSelected({...recent});
      else setError('请输入有效的查询地址和 32 字节 UserOperation 编号');
    }
    return () => { clearTimeout(queryTimer.current); };
  }, [inspectOperation, recentOperation]);

  useEffect(() => {
    if (selected) void tracking.refresh();
    return () => { clearTimeout(queryTimer.current); };
  }, [selected]);

  function validReference(next: OperationReference) {
    return next.chainId === '421614' && isAddress(next.address) && /^0x[0-9a-fA-F]{64}$/.test(next.hash);
  }
  function invalidateQuery() {
    setSelected(undefined); setResult(undefined); setError('');
    clearTimeout(queryTimer.current);
  }
  function query(next: OperationReference = { chainId: '421614', address: address.trim(), hash: hash.trim() }) {
    if (waiting) return;
    if (!validReference(next)) {
      setSelected(undefined); setResult(undefined);
      setError('请输入有效的查询地址和 32 字节 UserOperation 编号');
      return;
    }
    setError('');
    if (selected?.address.toLowerCase() === next.address.toLowerCase() && selected.hash === next.hash) {
      void tracking.refresh();
    } else {
      setResult(undefined); setSelected(next);
    }
  }
  const operation = result?.operation;
  const status = operation && presentOperation(operation).title;
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
    {(error||tracking.error) && <p role="alert">{error||tracking.error}{tracking.error&&result&&'。保留上次已核实结果，系统将自动重试。'}</p>}
    {result && <section className="recovery-result" aria-label="只读查询结果">
      <h3>只读查询结果</h3>
      <p className="address">{result.wallet.address}</p>
      <p>{result.wallet.balance} ETH</p>
      <p>{result.wallet.delegation === 'enabled' ? '原地址已启用智能账户' : result.wallet.delegation === 'undelegated' ? '原地址尚未启用智能账户' : '委托状态待核实'}</p>
      <p className="recovery-status" aria-live="polite">{status}</p>
      {operation?.finality&&<p>{presentOperation(operation).message}</p>}
      <p className="field-hint">UserOperation 编号</p><p className="operation-hash">{result.reference.hash}</p>
      {transactionHash && <>
        <p className="field-hint">链上交易哈希</p><p className="operation-hash">{transactionHash}</p>
        <a href={`https://sepolia.arbiscan.io/tx/${transactionHash}`} target="_blank" rel="noopener noreferrer">查看链上交易</a>
      </>}
    </section>}
  </section>;
}
