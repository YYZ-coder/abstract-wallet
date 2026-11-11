import { useEffect, useId, useRef, useState } from 'react';
import { isAddress, zeroAddress } from 'viem';
import { parseAmount } from '@abstract-wallet/sdk';
import type { WalletServices, WalletSnapshot, WalletChoice, Preview, OperationStatus } from './services';
import { WalletGuide } from './WalletGuide';
import { TestEthFunding } from './TestEthFunding';
import { OperationRecovery } from './OperationRecovery';

export function App({ services }: { services: WalletServices }) {
  const [wallet, setWallet] = useState<WalletSnapshot>();
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [sponsored, setSponsored] = useState(false);
  const [preview, setPreview] = useState<Preview>();
  const [operation, setOperation] = useState<OperationStatus>();
  const [error, setError] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [cancelApproval, setCancelApproval] = useState(false);
  const [cancellation, setCancellation] = useState<OperationStatus>();
  const [revokeApproval, setRevokeApproval] = useState(false);
  const [revocation, setRevocation] = useState<{ transactionHash: string; confirmed: boolean }>();
  const [walletChoices, setWalletChoices] = useState<WalletChoice[]>();
  const [connectingWallet, setConnectingWallet] = useState<string>();
  const [connectionNotice, setConnectionNotice] = useState('');
  const [copyNotice,setCopyNotice]=useState('');
  const [busy,setBusy]=useState<Record<string,boolean>>({});
  const activeActions=useRef(new Set<string>());
  const [fieldsChecked,setFieldsChecked]=useState(false);
  const fieldId=useId();
  const epoch = useRef(0);
  const previewRevision = useRef(0);
  const recipientInput=useRef<HTMLInputElement>(null);
  const amountInput=useRef<HTMLInputElement>(null);
  const balanceRequest=useRef<{context:number;promise:Promise<WalletSnapshot>}>(undefined);

  function invalidate(message = '', keepPicker = false) {
    epoch.current++;
    setWallet(undefined); setPreview(undefined); setOperation(undefined); setCancellation(undefined);
    setCancelApproval(false); setRevokeApproval(false); setRevocation(undefined);
    if (!keepPicker) { setWalletChoices(undefined); setConnectingWallet(undefined); }
    setPrivateKey(''); setRecipient(''); setAmount(''); setSponsored(false);
    setConnectionNotice(''); setError(message);
    activeActions.current.clear();setBusy({});
    setFieldsChecked(false);
  }

  useEffect(() => {
    const unsubscribe = services.onWalletChange?.(() => invalidate('钱包账户或网络已变化，请重新连接'));
    return () => { epoch.current++; unsubscribe?.(); };
  }, [services]);

  async function perform<T>(work: () => Promise<T>, apply: (value: T) => void, fallback: string, valid = () => true, activity?:string) {
    const context = epoch.current;
    if(activity&&activeActions.current.has(activity))return;
    if(activity){activeActions.current.add(activity);setBusy(value=>({...value,[activity]:true}));}
    setError('');
    try {
      const value = await work();
      if (context === epoch.current && valid()) apply(value);
    } catch (e) {
      if (context === epoch.current && valid()) setError(e instanceof Error ? e.message : fallback);
    } finally {
      if(activity&&context===epoch.current){activeActions.current.delete(activity);setBusy(value=>({...value,[activity]:false}));}
    }
  }

  const openWalletPicker=()=>{setCopyNotice('');void perform(()=>services.listWallets!(),setWalletChoices,'查找钱包失败');};
  async function copyPageAddress(){
    try{await navigator.clipboard.writeText(window.location.href);}
    catch{throw new Error('复制失败，请手动复制浏览器地址栏中的地址');}
  }
  function readWalletBalance():Promise<WalletSnapshot>{
    const context=epoch.current;
    const request={context,promise:undefined as unknown as Promise<WalletSnapshot>};
    let timeout:ReturnType<typeof setTimeout>;
    activeActions.current.add('refresh');setBusy(value=>({...value,refresh:true}));
    const deadline=new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(new Error('读取余额超时，请重试刷新余额')),15000);});
    request.promise=Promise.race([services.refresh(),deadline]).then(next=>{
      if(context!==epoch.current)throw new Error('钱包已变化，请重新检查当前账户余额');
      const latest=balanceRequest.current;
      return latest!==request&&latest?.context===context?latest.promise:next;
    },error=>{
      const latest=balanceRequest.current;
      if(context===epoch.current&&latest!==request&&latest?.context===context)return latest.promise;
      throw error;
    }).finally(()=>{
      clearTimeout(timeout);
      if(context===epoch.current&&balanceRequest.current===request){activeActions.current.delete('refresh');setBusy(value=>({...value,refresh:false}));}
    });
    balanceRequest.current=request;
    return request.promise;
  }
  async function refreshFundedWallet(expectedAddress:string){
    const context=epoch.current;
    const next=await readWalletBalance();
    if(context!==epoch.current||next.address.toLowerCase()!==expectedAddress.toLowerCase())throw new Error('钱包已变化，请重新检查当前账户余额');
    setWallet(next);
  }
  const recipientIssue=isAddress(recipient.trim())&&recipient.trim().toLowerCase()!==zeroAddress?'':'请输入有效的收款地址。';
  let amountIssue='';try{if(parseAmount(amount.trim(),18)<=0n)throw new Error();}catch{amountIssue='请输入大于 0 的金额，最多支持 18 位小数。';}
  return <main className="wallet-app">
    <header className="app-heading"><div><p className="eyebrow">你的原地址 · 智能转账</p><h1>Abstract Wallet</h1><p className="heading-copy">连接钱包后，我们会带你完成检查和转账。</p></div><p className="testnet-badge">Arbitrum Sepolia</p></header>
    <div className="workspace-grid"><div className="workspace-main">
    {services.listWallets && services.connectWallet && <WalletGuide wallet={wallet} checking={busy.refresh} connecting={connectingWallet!==undefined} connectingWalletName={connectingWallet} onConnect={openWalletPicker} onRefresh={()=>{void perform(readWalletBalance,setWallet,'检查失败',()=>true,'refresh');}} onSwitch={openWalletPicker} onStartTransfer={()=>{recipientInput.current?.scrollIntoView?.({behavior:'smooth',block:'center'});recipientInput.current?.focus();}}/>}
    {walletChoices && <section className="wallet-picker" role="dialog" aria-label="选择钱包">
      <h2>选择钱包</h2>
      {walletChoices.length === 0 && <div className="empty-wallet"><p>未发现可连接钱包，请在已安装钱包的浏览器中打开此页面。</p><p>先复制当前地址，在你平时使用钱包的浏览器中打开，再回来连接。</p><button className="button-primary" onClick={()=>perform(copyPageAddress,()=>setCopyNotice('地址已复制。在安装钱包扩展的浏览器中粘贴打开，再点击连接钱包。'),'复制失败，请手动复制浏览器地址栏中的地址')}>复制页面地址</button>{copyNotice&&<p role="status">{copyNotice}</p>}</div>}
      {connectingWallet && <p className="connection-progress">请打开 {connectingWallet}，确认账户连接请求。</p>}
      {walletChoices.map(choice => <button className="wallet-choice" key={choice.id} disabled={connectingWallet !== undefined} onClick={async () => {
        invalidate('', true);
        const context = epoch.current;
        setConnectingWallet(choice.name);
        await perform(() => services.connectWallet!(choice.id), value => { setWallet(value); setWalletChoices(undefined); }, '连接失败');
        if (context === epoch.current) setConnectingWallet(undefined);
      }}>{choice.name}</button>)}
      <button disabled={connectingWallet !== undefined} onClick={() => perform(() => services.listWallets!(), setWalletChoices, '查找钱包失败')}>重新检测钱包</button>
      <button disabled={connectingWallet !== undefined} onClick={() => setWalletChoices(undefined)}>关闭选择</button>
    </section>}
    {connectionNotice && <p role="status">{connectionNotice}</p>}
    <details className="developer-tools" open={!services.connectWallet}>
    <summary>开发测试工具</summary>
    <button onClick={() => { invalidate(); void perform(() => services.createAccount(), setWallet, '创建失败'); }}>创建测试钱包</button>
    {services.importAccount && <form className="import-form" onSubmit={e => {
      e.preventDefault(); const key = privateKey; invalidate();
      void perform(() => services.importAccount!(key), setWallet, '导入失败');
    }}>
      <label>测试账户私钥<input type="password" autoComplete="off" spellCheck={false} aria-label="测试账户私钥" value={privateKey} onChange={e => setPrivateKey(e.target.value)} /></label>
      <button type="submit">导入测试账户</button><small>仅存于本页内存，刷新后需重新导入。请使用测试账户。</small>
    </form>}
    </details>
    {services.inspectOperation && <OperationRecovery inspectOperation={services.inspectOperation} recentOperation={services.recentOperation} />}
    {wallet && <section className="wallet-card">
      {wallet.connection&&services.connectWallet&&<button className="button-quiet" disabled={connectingWallet!==undefined} onClick={openWalletPicker}>切换钱包</button>}
      {wallet.connection && <p>已连接 {wallet.connection.walletName}</p>}
      {wallet.connection && services.disconnectWallet && <button onClick={() => { invalidate(); void perform(() => services.disconnectWallet!(), () => setConnectionNotice('已断开连接；链上委托不会自动撤销'), '断开连接失败'); }}>断开连接</button>}
      {wallet.availability?.reason && wallet.availability.canSubmit && <p className="capability-note" role="status">{wallet.availability.reason}</p>}
      <p className="address">{wallet.address}</p><div className="balance-row"><p className="balance">{wallet.balance} ETH</p>
      <TestEthFunding key={wallet.address.toLowerCase()} address={wallet.address} refreshing={busy.refresh} onRequest={services.requestTestFunds?()=>services.requestTestFunds!():undefined} onStatus={services.testFundsStatus?claimId=>services.testFundsStatus!(claimId):undefined} onRefresh={services.requestTestFunds?()=>refreshFundedWallet(wallet.address):()=>{void perform(readWalletBalance,setWallet,'刷新失败',()=>true,'refresh');}}/></div>
      {services.requestTestFunds&&<p className="field-hint funding-note">每个地址每 24 小时可领取 0.001 测试 ETH，到账后余额会自动刷新。</p>}
      {/^0(?:\.0+)?$/.test(wallet.balance)&&<p className="field-hint funding-note">{services.requestTestFunds?'余额为 0。点击“领取测试币”，等待系统领取并刷新余额后，再开始转账。':'余额为 0。点击“领取测试币”，到账后刷新余额，再开始转账。'}</p>}
      <p className="delegation">{wallet.delegation === 'enabled' ? '智能账户已启用' : wallet.delegation === 'undelegated' ? '未启用智能账户' : '委托状态待核实'}</p>
      <button disabled={busy.refresh} onClick={() => perform(readWalletBalance, setWallet, '刷新失败',()=>true,'refresh')}>{busy.refresh?'正在刷新余额…':'刷新余额'}</button>
      <button onClick={() => setRevokeApproval(true)} disabled={wallet.delegation !== 'enabled' || wallet.availability?.canRevoke === false}>撤销智能账户</button>
      {wallet.delegation!=='unknown'&&wallet.availability?.canSubmit!==false&&<form className="transfer-form" onChange={() => { previewRevision.current++; setPreview(undefined);setError(''); }} onSubmit={e => {
        e.preventDefault(); setPreview(undefined); const revision = ++previewRevision.current;setFieldsChecked(true);
        if(recipientIssue||amountIssue){setError('');(recipientIssue?recipientInput:amountInput).current?.focus();return;}
        void perform(() => services.preview({ recipient:recipient.trim(), amount:amount.trim(), sponsored }), setPreview, '准备失败', () => revision === previewRevision.current,'preview');
      }}>
        <h2>填写转账信息</h2>
        <label>收款地址<input ref={recipientInput} disabled={busy.submit} aria-invalid={fieldsChecked&&!!recipientIssue} aria-describedby={`${fieldId}-recipient`} placeholder="0x 开头的钱包地址" aria-label="收款地址" value={recipient} onChange={e => setRecipient(e.target.value)} /><span id={`${fieldId}-recipient`} className={fieldsChecked&&recipientIssue?'field-error':'field-hint'}>{fieldsChecked&&recipientIssue?recipientIssue:'请输入 Arbitrum Sepolia 上的收款地址。'}</span></label>
        <label>金额（ETH）<input ref={amountInput} disabled={busy.submit} aria-invalid={fieldsChecked&&!!amountIssue} aria-describedby={`${fieldId}-amount`} placeholder="例如 0.001" inputMode="decimal" aria-label="金额（ETH）" value={amount} onChange={e => setAmount(e.target.value)} /><span id={`${fieldId}-amount`} className={fieldsChecked&&amountIssue?'field-error':'field-hint'}>{fieldsChecked&&amountIssue?amountIssue:'仅发送测试 ETH。手续费会在预览中列出。'}</span></label>
        <label className="payment-choice"><input type="checkbox" disabled={busy.submit} aria-label="申请 Gas 赞助" checked={sponsored} onChange={e => setSponsored(e.target.checked)} />申请 Gas 赞助<span className="field-hint">由应用支付手续费；额度不足时可明确改为自付。</span></label>
        <button className="button-primary" type="submit" disabled={busy.preview||busy.submit}>{busy.preview?'正在准备预览…':'预览交易'}</button>
        {busy.preview&&<p className="preparation-progress" role="status">正在检查交易和费用，请稍候…</p>}
      </form>}
    </section>}
    {preview && <section className="transaction-review" role="dialog" aria-label="确认交易">
      <h2>确认交易</h2><p>{preview.recipient}</p><p>{preview.amount} ETH</p><p>最高费用 {preview.maxCost} ETH</p><p>{preview.payment === 'sponsored' ? '应用赞助 Gas' : '账户使用 ETH 自付'}</p>
      <p className="field-hint">核对收款地址、金额和费用。返回修改后需要重新预览。</p>
      <button className="button-primary" disabled={busy.submit||wallet?.availability?.canSubmit === false} onClick={() => perform(() => services.submit(preview), value => { setOperation(value); setPreview(undefined); }, '签名失败',()=>true,'submit')}>{busy.submit?'正在签名和提交…':'确认并签名'}</button>
      <button className="button-secondary" disabled={busy.submit} onClick={()=>{previewRevision.current++;setPreview(undefined);recipientInput.current?.focus();}}>返回修改</button>
      {busy.submit&&<p role="status">{wallet?.connection?'请在钱包中确认签名，完成后会自动提交。':'正在签名并提交交易，请稍候…'}</p>}
    </section>}
    {error && <p role="alert">{error}</p>}
    {operation && <section className="operation-card">
      <h2 className="operation-heading">交易进度</h2><p>{operation.confirmation === 'reorged' ? '链发生重组，待重新核实' : operation.execution === 'reverted' ? '执行失败' : operation.execution === 'succeeded' ? operation.confirmation === 'confirmed' ? '交易已确认' : '执行成功，等待确认' : operation.submission === 'unknown' ? '提交结果待核实' : operation.submission === 'rejected' ? '提交被拒绝' : '已受理，等待执行'}</p>
      <p className="operation-message">{operation.confirmation==='reorged'?'链发生重组，原执行结果需要重新核实。请刷新交易状态后再决定下一步。':operation.execution==='succeeded'?operation.confirmation==='confirmed'?'本次转账已确认，可以继续填写下一笔转账。':'转账已执行，正在等待链上确认。你可以刷新查看进度。':operation.submission==='unknown'?'提交结果尚未核实，请先刷新状态再决定下一步。':operation.execution==='reverted'?'这笔转账执行失败。请检查原因并刷新余额，确认后再重新准备。':operation.submission==='rejected'?'这次提交未被受理。请查看错误信息，重新预览后再确认。':'交易已提交。点击“刷新交易状态”查看执行结果。'}</p>
      <p className="field-hint">操作编号</p><p className="operation-hash">{operation.hash}</p>
      <button className="button-primary" disabled={busy.status} onClick={() => perform(() => services.status(operation.hash), setOperation, '状态查询失败',()=>true,'status')}>{busy.status?'正在查询链上状态…':'刷新交易状态'}</button>
      {operation.execution === 'unknown' && <button disabled={wallet?.availability?.canSubmit === false} onClick={() => setCancelApproval(true)}>取消待处理交易</button>}
    </section>}
    {cancelApproval && operation && <section role="dialog" aria-label="确认取消交易">
      <h2>确认取消交易</h2><p>签署一笔同 nonce 的新操作，使用 ETH 自付。确认前原操作仍可能执行。</p>
      <button disabled={wallet?.availability?.canSubmit === false} onClick={() => perform(() => services.cancel(operation.hash), value => { setCancellation(value); setCancelApproval(false); }, '取消失败')}>签名取消操作</button>
      <button onClick={() => setCancelApproval(false)}>暂不取消</button>
    </section>}
    {cancellation && <section>
      <p>{cancellation.hash}</p><p>{cancellation.execution === 'succeeded' && cancellation.confirmation === 'confirmed' ? '取消已确认' : cancellation.execution === 'reverted' ? '取消执行失败，原交易仍需核实' : '取消处理中'}</p>
      <button onClick={() => perform(() => services.status(cancellation.hash), setCancellation, '状态查询失败')}>刷新取消状态</button>
    </section>}
    {revokeApproval && <section role="dialog" aria-label="确认撤销委托">
      <h2>确认撤销委托</h2><p>只影响当前测试链；已有 Token 授权不会清除。本次由测试账户支付原生交易费用。</p>
      <button disabled={wallet?.availability?.canRevoke === false} onClick={() => perform(() => services.revoke(), value => { setRevocation(value); setRevokeApproval(false); if (value.confirmed && wallet) setWallet({ ...wallet, delegation: 'undelegated' }); }, '撤销失败')}>确认撤销</button>
      <button onClick={() => setRevokeApproval(false)}>保留委托</button>
    </section>}
    {revocation && <section><p>{revocation.transactionHash}</p><p>{revocation.confirmed ? '撤销已确认' : '撤销待确认'}</p></section>}
    </div><aside className="help-sidebar"><p className="eyebrow">操作小贴士</p><h2>第一次使用？</h2><ol><li><strong>用你的原钱包连接</strong><p>在装有钱包扩展的浏览器中打开此页。</p></li><li><strong>看清账户检查结果</strong><p>能否继续会直接显示在左侧。原地址保持不变。</p></li><li><strong>先使用少量测试币</strong><p>这里使用 Arbitrum Sepolia 测试 ETH。</p></li></ol><p>签名请求会出现在你的钱包中，请核对后确认。</p></aside></div>
  </main>;
}
