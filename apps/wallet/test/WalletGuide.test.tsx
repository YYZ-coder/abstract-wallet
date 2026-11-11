import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test } from 'vitest';
import { WalletGuide, type WalletGuideProps } from '../src/WalletGuide';

const noop = () => {};
const defaults: WalletGuideProps = { onConnect: noop, onRefresh: noop, onSwitch: noop, onStartTransfer: noop };

test('starts with the connection step and gives one clear next action without requesting it automatically', async () => {
  let action = '';
  render(<WalletGuide {...defaults} onConnect={() => { action = 'connect'; }} />);
  expect(screen.getByRole('heading', { name: '先连接你的钱包' })).toBeVisible();
  const steps = within(screen.getByRole('navigation', { name: '使用步骤' })).getAllByRole('listitem');
  expect(steps).toHaveLength(3);
  expect(steps[0]).toHaveAttribute('aria-current', 'step');
  expect(steps[0]).toHaveTextContent('连接钱包');
  expect(steps[1]).toHaveTextContent('检查账户');
  expect(steps[2]).toHaveTextContent('开始转账');
  expect(action).toBe('');
  await userEvent.click(screen.getByRole('button', { name: '连接钱包' }));
  expect(action).toBe('connect');
});

test('explains the wallet approval while connecting and prevents another request', async () => {
  let action = '';
  render(<WalletGuide {...defaults} connecting onConnect={() => { action = 'connect'; }} />);
  expect(screen.getByRole('status')).toHaveTextContent('请在钱包中确认连接');
  expect(screen.getByRole('button', { name: '等待钱包确认' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: '连接钱包' })).not.toBeInTheDocument();
  expect(action).toBe('');
});

test('explains an unsupported first activation and provides a check or wallet change without a fake enable action', async () => {
  let action = '';
  render(<WalletGuide {...defaults} wallet={{ address: '0x1111111111111111111111111111111111111111', balance: '0.02', delegation: 'undelegated', connection: { walletId: 'external', walletName: 'My Wallet' }, availability: { canSubmit: false, canRevoke: false } }} onRefresh={() => { action = 'refresh'; }} onSwitch={() => { action = 'switch'; }} />);
  expect(screen.getByRole('heading', { name: '钱包已连接，还不能开始转账' })).toBeVisible();
  expect(screen.getByText('当前版本尚不能为这个钱包完成首次 7702 授权。你的原地址保持不变。')).toBeVisible();
  const steps = within(screen.getByRole('navigation', { name: '使用步骤' })).getAllByRole('listitem');
  expect(steps[1]).toHaveAttribute('aria-current', 'step');
  expect(screen.queryByRole('button', { name: '开始转账' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '启用智能账户' })).not.toBeInTheDocument();
  expect(action).toBe('');
  await userEvent.click(screen.getByRole('button', { name: '重新检查账户' }));
  expect(action).toBe('refresh');
  await userEvent.click(screen.getByRole('button', { name: '选择其他钱包' }));
  expect(action).toBe('switch');
});

test('guides an eligible original account to the transfer form only after an explicit action', async () => {
  let action = '';
  render(<WalletGuide {...defaults} wallet={{ address: '0x1111111111111111111111111111111111111111', balance: '0.02', delegation: 'enabled', connection: { walletId: 'external', walletName: 'My Wallet' }, availability: { canSubmit: true, canRevoke: false } }} onStartTransfer={() => { action = 'transfer'; }} />);
  expect(screen.getByRole('heading', { name: '账户已就绪' })).toBeVisible();
  const steps = within(screen.getByRole('navigation', { name: '使用步骤' })).getAllByRole('listitem');
  expect(steps[2]).toHaveAttribute('aria-current', 'step');
  expect(screen.getByText('接下来填写收款地址和金额，再预览并确认。')).toBeVisible();
  expect(action).toBe('');
  await userEvent.click(screen.getByRole('button', { name: '开始转账' }));
  expect(action).toBe('transfer');
});

test('keeps an unknown account at the check step even if a stale availability flag says usable', async () => {
  render(<WalletGuide {...defaults} wallet={{ address: '0x1111111111111111111111111111111111111111', balance: '0.02', delegation: 'unknown', availability: { canSubmit: true, canRevoke: false } }} />);
  expect(screen.getByRole('heading', { name: '先核对账户状态' })).toBeVisible();
  expect(screen.getByText('还不能确认这个地址的智能功能状态。请重新检查后再操作。')).toBeVisible();
  expect(screen.getByRole('button', { name: '重新检查账户' })).toBeVisible();
  expect(screen.queryByRole('button', { name: '开始转账' })).not.toBeInTheDocument();
  const steps = within(screen.getByRole('navigation', { name: '使用步骤' })).getAllByRole('listitem');
  expect(steps[1]).toHaveAttribute('aria-current', 'step');
});

test('lets a browser-held test account prepare its first transfer without claiming chain activation already happened', async () => {
  let action = '';
  render(<WalletGuide {...defaults} wallet={{ address: '0x1111111111111111111111111111111111111111', balance: '0.02', delegation: 'undelegated' }} onStartTransfer={() => { action = 'transfer'; }} />);
  expect(screen.getByRole('heading', { name: '测试账户已准备好' })).toBeVisible();
  expect(screen.getByText('首笔转账会包含智能功能授权。填写地址和金额后，先查看交易预览。')).toBeVisible();
  expect(screen.queryByText('账户已就绪')).not.toBeInTheDocument();
  expect(action).toBe('');
  await userEvent.click(screen.getByRole('button', { name: '开始转账' }));
  expect(action).toBe('transfer');
});

test('names the selected wallet while waiting so the user can find the right approval window', () => {
  render(<WalletGuide {...defaults} connecting connectingWalletName="Alpha Wallet" />);
  expect(screen.getByRole('status')).toHaveTextContent('正在连接 Alpha Wallet');
  expect(screen.getByRole('status')).toHaveTextContent('请在钱包中确认连接');
});

test('keeps an enabled account with unsupported operation signing at the check step', () => {
  render(<WalletGuide {...defaults} wallet={{ address: '0x1111111111111111111111111111111111111111', balance: '0.02', delegation: 'enabled', connection: { walletId: 'external', walletName: 'My Wallet' }, availability: { canSubmit: false, canRevoke: false, reason: '当前钱包不支持此操作签名，请在支持的钱包中重新连接。' } }} />);
  expect(screen.getByRole('heading', { name: '钱包已连接，还不能开始转账' })).toBeVisible();
  expect(screen.getByText('当前钱包不支持此操作签名，请在支持的钱包中重新连接。')).toBeVisible();
  expect(screen.getByRole('button', { name: '重新检查账户' })).toBeVisible();
  expect(screen.queryByRole('button', { name: '开始转账' })).not.toBeInTheDocument();
  expect(screen.queryByText('当前版本尚不能为这个钱包完成首次 7702 授权。你的原地址保持不变。')).not.toBeInTheDocument();
});

test('shows account checking in progress without repeating the refresh or treating an unknown account as ready', async () => {
  let requested = false;
  render(<WalletGuide {...defaults} checking wallet={{ address: '0x1111111111111111111111111111111111111111', balance: '0.02', delegation: 'unknown' }} onRefresh={() => { requested = true; }} />);
  const progress = screen.getByRole('button', { name: '正在检查账户…' });
  expect(progress).toBeDisabled();
  expect(screen.getByRole('status')).toHaveTextContent('正在从测试网读取账户状态，请稍候。');
  expect(screen.getByRole('heading', { name: '先核对账户状态' })).toBeVisible();
  expect(screen.queryByRole('button', { name: '开始转账' })).not.toBeInTheDocument();
  await userEvent.click(progress);
  expect(requested).toBe(false);
});
