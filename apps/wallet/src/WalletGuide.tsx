import type { WalletSnapshot } from './services';

export type WalletGuideProps = {
  wallet?: WalletSnapshot;
  connecting?: boolean;
  connectingWalletName?: string;
  checking?: boolean;
  onConnect: () => void;
  onRefresh: () => void;
  onSwitch: () => void;
  onStartTransfer: () => void;
};

type GuideState = 'connect' | 'waiting' | 'blocked' | 'unknown' | 'ready' | 'test-ready';
const steps = ['连接钱包', '检查账户', '开始转账'];

export function WalletGuide({ wallet, connecting = false, connectingWalletName, checking = false, onConnect, onRefresh, onSwitch, onStartTransfer }: WalletGuideProps) {
  const firstAuthorizationUnavailable = Boolean(!connecting && wallet?.connection && wallet.delegation === 'undelegated' && wallet.availability?.canSubmit === false);
  const ready = !connecting && wallet?.delegation === 'enabled' && wallet.availability?.canSubmit !== false;
  const testReady = !connecting && wallet?.delegation === 'undelegated' && !wallet.connection && !wallet.availability;
  const unknown = !connecting && wallet?.delegation === 'unknown';
  const signingUnavailable = !connecting && !firstAuthorizationUnavailable && !unknown && wallet?.availability?.canSubmit === false;
  const canTransfer = ready || testReady;
  const needsCheck = firstAuthorizationUnavailable || unknown || signingUnavailable;
  const checkingAccount = checking && needsCheck;
  const currentStep = canTransfer ? 2 : needsCheck ? 1 : 0;
  const state: GuideState = connecting ? 'waiting' : testReady ? 'test-ready' : ready ? 'ready' : unknown ? 'unknown' : needsCheck ? 'blocked' : 'connect';

  const title = {
    connect: '先连接你的钱包',
    waiting: '正在等待你的钱包',
    blocked: '钱包已连接，还不能开始转账',
    unknown: '先核对账户状态',
    ready: '账户已就绪',
    'test-ready': '测试账户已准备好',
  }[state];
  let description: string;
  if (connecting) {
    description = `${connectingWalletName ? `正在连接 ${connectingWalletName}。` : ''}请在钱包中确认连接。若未出现弹窗，请打开浏览器的钱包扩展。`;
  } else if (checkingAccount) {
    description = '正在从测试网读取账户状态，请稍候。';
  } else if (testReady) {
    description = '首笔转账会包含智能功能授权。填写地址和金额后，先查看交易预览。';
  } else if (ready) {
    description = '接下来填写收款地址和金额，再预览并确认。';
  } else if (unknown) {
    description = '还不能确认这个地址的智能功能状态。请重新检查后再操作。';
  } else if (firstAuthorizationUnavailable) {
    description = '当前版本尚不能为这个钱包完成首次 7702 授权。你的原地址保持不变。';
  } else if (signingUnavailable) {
    description = wallet?.availability?.reason || '当前钱包还不能签署本项目的操作。请检查钱包能力或选择其他钱包。';
  } else {
    description = '连接后会自动检查原地址能否使用。签名请求将在你的钱包中确认。';
  }

  return <section aria-label="操作引导" className="wallet-guide" data-guide-state={state}>
    <nav aria-label="使用步骤">
      <ol className="guide-steps">
        {steps.map((label, index) => <li key={label} className={`guide-step${index === currentStep ? ' is-current' : index < currentStep ? ' is-complete' : ''}`} aria-current={index === currentStep ? 'step' : undefined}>
          <span className="guide-step-number" aria-hidden="true">{index + 1}</span><span>{label}</span>
        </li>)}
      </ol>
    </nav>
    <div className="guide-content">
      <p className="guide-eyebrow">第 {currentStep + 1} 步 · {steps[currentStep]}</p>
      <h2 className="guide-title">{title}</h2>
      <p className="guide-description" role={connecting || checkingAccount ? 'status' : undefined}>{description}</p>
      <div className="guide-actions">
        {canTransfer ? <button type="button" className="guide-primary" onClick={onStartTransfer}>开始转账</button> : needsCheck ? <>
          <button type="button" className="guide-primary" onClick={onRefresh} disabled={checkingAccount}>{checkingAccount ? '正在检查账户…' : '重新检查账户'}</button>
          <button type="button" className="guide-secondary" onClick={onSwitch}>选择其他钱包</button>
        </> : <button type="button" className="guide-primary" onClick={onConnect} disabled={connecting}>{connecting ? '等待钱包确认' : '连接钱包'}</button>}
      </div>
      <p className="guide-note">仅使用 Arbitrum Sepolia 测试网，保留你的原地址。</p>
    </div>
  </section>;
}
