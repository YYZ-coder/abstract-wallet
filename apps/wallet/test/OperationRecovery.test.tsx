import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { OperationRecovery } from '../src/OperationRecovery';
import type { ObservedOperation, OperationReference, OperationStatus } from '../src/services';

const address = '0x1111111111111111111111111111111111111111';
const hash = '0xcd10019743b363a6dcc627d97a402066f8300045e73aadfc740ffdab09ba5d6f';
const reference: OperationReference = { chainId: '421614', address, hash };
const observed: ObservedOperation = {
  reference,
  wallet: { address, balance: '0.000783', delegation: 'enabled' },
  operation: { hash, submission: 'accepted', execution: 'unknown', confirmation: 'pending' },
};

function enterReference(nextAddress = address, nextHash = hash) {
  fireEvent.change(screen.getByLabelText('查询地址'), { target: { value: nextAddress } });
  fireEvent.change(screen.getByLabelText('UserOperation 编号'), { target: { value: nextHash } });
}

test('validates a manual public reference and queries the original address read-only on Arbitrum Sepolia', async () => {
  const references: OperationReference[] = [];
  render(<OperationRecovery inspectOperation={async value => { references.push(value); return observed; }} />);
  const section = screen.getByRole('region', { name: '查询已提交交易' });
  expect(section).toHaveTextContent('只读查询不会恢复签名会话，不会重新发送交易');
  fireEvent.click(screen.getByRole('button', { name: '查询交易状态' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('请输入有效的查询地址和 32 字节 UserOperation 编号');
  expect(references).toEqual([]);
  enterReference(address, '0x1234');
  fireEvent.click(screen.getByRole('button', { name: '查询交易状态' }));
  expect(references).toEqual([]);
  enterReference();
  fireEvent.click(screen.getByRole('button', { name: '查询交易状态' }));
  const result = await screen.findByRole('region', { name: '只读查询结果' });
  expect(references).toEqual([{ chainId: '421614', address, hash }]);
  expect(result).toHaveTextContent(address);
  expect(result).toHaveTextContent('0.000783 ETH');
  expect(result).toHaveTextContent('原地址已启用智能账户');
  expect(result).toHaveTextContent('已受理，等待执行');
  expect(within(result).queryByRole('button')).not.toBeInTheDocument();
});

test('automatically restores only the recent public reference and inspects its operation without a signing session', async () => {
  const references: OperationReference[] = [];
  render(<OperationRecovery recentOperation={() => reference} inspectOperation={async value => { references.push(value); return observed; }} />);
  expect(screen.getByLabelText('查询地址')).toHaveValue(address);
  expect(screen.getByLabelText('UserOperation 编号')).toHaveValue(hash);
  expect(await screen.findByRole('region', { name: '只读查询结果' })).toHaveTextContent('0.000783 ETH');
  expect(references).toEqual([{ chainId: '421614', address, hash }]);
  expect(screen.queryByRole('button', { name: /签名|发送|开始转账/ })).not.toBeInTheDocument();
});

test('keeps only the current query, prevents duplicate waiting requests, and allows a clean retry after failure', async () => {
  const nextHash = `0x${'a'.repeat(64)}`;
  const nextObserved = { ...observed, reference: { ...reference, hash: nextHash }, operation: { ...observed.operation, hash: nextHash }, wallet: { ...observed.wallet, balance: '0.009' } };
  let finishOld!: (value: ObservedOperation) => void;
  const references: OperationReference[] = [];
  render(<OperationRecovery inspectOperation={async value => {
    references.push(value);
    if (references.length === 1) return new Promise(done => { finishOld = done; });
    if (references.length === 3) throw new Error('RPC unavailable');
    return nextObserved;
  }} />);
  enterReference();
  const query = screen.getByRole('button', { name: '查询交易状态' });
  act(() => { fireEvent.click(query); fireEvent.click(query); });
  const waiting = screen.getByRole('button', { name: '正在查询…' });
  expect(waiting).toBeDisabled();
  expect(screen.getByRole('status')).toHaveTextContent('正在查询链上状态，请稍候');
  fireEvent.click(waiting);
  expect(references).toHaveLength(1);
  enterReference(address, nextHash);
  fireEvent.click(screen.getByRole('button', { name: '查询交易状态' }));
  expect(await screen.findByRole('region', { name: '只读查询结果' })).toHaveTextContent('0.009 ETH');
  await act(async () => { finishOld(observed); });
  expect(screen.getByRole('region', { name: '只读查询结果' })).toHaveTextContent('0.009 ETH');
  expect(screen.queryByText('0.000783 ETH')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '查询交易状态' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('RPC unavailable');
  expect(screen.queryByRole('region', { name: '只读查询结果' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '查询交易状态' }));
  expect(await screen.findByRole('region', { name: '只读查询结果' })).toHaveTextContent('0.009 ETH');
  expect(references.map(value => value.hash)).toEqual([hash, nextHash, nextHash, nextHash]);
});

test.each(['success', 'failure'])('ignores an old context %s after a new service has returned the current read-only result', async mode => {
  let finishOld!: (value: ObservedOperation) => void;
  let failOld!: (failure: Error) => void;
  const pending = new Promise<ObservedOperation>((resolve, reject) => { finishOld = resolve; failOld = reject; });
  const { rerender } = render(<OperationRecovery inspectOperation={() => pending} />);
  enterReference();
  fireEvent.click(screen.getByRole('button', { name: '查询交易状态' }));
  rerender(<OperationRecovery inspectOperation={async () => ({ ...observed, wallet: { ...observed.wallet, balance: '0.009' } })} />);
  expect(screen.queryByRole('region', { name: '只读查询结果' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '查询交易状态' }));
  expect(await screen.findByRole('region', { name: '只读查询结果' })).toHaveTextContent('0.009 ETH');
  await act(async () => { if (mode === 'success') finishOld(observed); else failOld(new Error('stale failure')); });
  expect(screen.getByRole('region', { name: '只读查询结果' })).toHaveTextContent('0.009 ETH');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('bounds an unresponsive read-only query and ignores its late result after a successful retry', async () => {
  vi.useFakeTimers();
  try {
    let finishOld!: (value: ObservedOperation) => void;
    let requested = 0;
    render(<OperationRecovery inspectOperation={() => ++requested === 1 ? new Promise(done => { finishOld = done; }) : Promise.resolve({ ...observed, wallet: { ...observed.wallet, balance: '0.009' } })} />);
    enterReference();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '查询交易状态' })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect(screen.getByRole('alert')).toHaveTextContent('查询超时，请重试只读查询');
    const retry = screen.getByRole('button', { name: '查询交易状态' });
    expect(retry).toBeEnabled();
    await act(async () => { fireEvent.click(retry); });
    expect(screen.getByRole('region', { name: '只读查询结果' })).toHaveTextContent('0.009 ETH');
    await act(async () => { finishOld(observed); });
    expect(screen.getByRole('region', { name: '只读查询结果' })).toHaveTextContent('0.009 ETH');
    expect(screen.queryByText('0.000783 ETH')).not.toBeInTheDocument();
  } finally { vi.useRealTimers(); }
});

test.each<[OperationStatus['submission'], OperationStatus['execution'], OperationStatus['confirmation'], string]>([
  ['accepted', 'unknown', 'pending', '已受理，等待执行'],
  ['accepted', 'succeeded', 'pending', '执行成功，等待确认'],
  ['accepted', 'succeeded', 'confirmed', '交易已确认'],
  ['accepted', 'succeeded', 'reorged', '链发生重组，待重新核实'],
  ['accepted', 'reverted', 'confirmed', '执行失败'],
  ['rejected', 'unknown', 'pending', '提交被拒绝'],
  ['unknown', 'unknown', 'pending', '提交结果待核实'],
])('distinguishes observed %s/%s/%s and links only an actual transaction hash', async (submission, execution, confirmation, label) => {
  const transactionHash = '0x4ca28aabba7d93ac8856d907408912aa911901e908eddd3e2ff3e5a45a2c65d9';
  const hasTransaction = execution !== 'unknown';
  render(<OperationRecovery recentOperation={() => reference} inspectOperation={async () => ({ ...observed, operation: { hash, submission, execution, confirmation }, ...(hasTransaction ? { transactionHash } : {}) })} />);
  const result = await screen.findByRole('region', { name: '只读查询结果' });
  expect(within(result).getByText(label, { exact: true })).toBeVisible();
  expect(result).toHaveTextContent(hash);
  if (hasTransaction) {
    expect(within(result).getByRole('link', { name: '查看链上交易' })).toHaveAttribute('href', `https://sepolia.arbiscan.io/tx/${transactionHash}`);
    expect(result).toHaveTextContent(transactionHash);
  } else expect(within(result).queryByRole('link', { name: '查看链上交易' })).not.toBeInTheDocument();
  expect(within(result).queryByRole('link', { name: hash })).not.toBeInTheDocument();
});
