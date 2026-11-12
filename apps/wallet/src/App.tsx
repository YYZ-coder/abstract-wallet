import { Layers3, ReceiptText, Settings2, ArrowLeft, ArrowRight, Hourglass, Check } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { formatUnits, isAddress, zeroAddress } from 'viem';
import { parseAmount } from '@abstract-wallet/sdk';
import type { WalletServices, WalletSnapshot, WalletChoice, Preview, OperationStatus } from './services';
import { WalletGuide } from './WalletGuide';
import { TestEthFunding } from './TestEthFunding';
import { OperationRecovery } from './OperationRecovery';
import { presentOperation } from './operation-presentation';
import { useReadonlyPolling } from './use-readonly-polling';

function ethAmount(value:bigint){
  const [whole,fraction='']=formatUnits(value,18).split('.');
  return `${whole}.${fraction.padEnd(6,'0')}`;
}

export function App({ services }: { services: WalletServices }) {
  const [wallet, setWallet] = useState<WalletSnapshot>();
  const [page,setPage]=useState<'home'|'transfer'|'activity'|'settings'|'result'>('home');
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [sponsored, setSponsored] = useState(false);
  const [preview, setPreview] = useState<Preview>();
  const [operation, setOperation] = useState<OperationStatus>();
  const [operationPreview,setOperationPreview]=useState<Preview>();
  const [receiveOpen,setReceiveOpen]=useState(false);
  const [receiveNotice,setReceiveNotice]=useState('');
  const [receiveError,setReceiveError]=useState(false);
  const [balanceNotice,setBalanceNotice]=useState('');
  const [error, setError] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [cancelApproval, setCancelApproval] = useState(false);
  const [cancellation, setCancellation] = useState<OperationStatus & {targetHash:string}>();
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
    setPage('home');setOperationPreview(undefined);
    setReceiveOpen(false);setReceiveNotice('');
    setBalanceNotice('');
  }

  useEffect(() => {
    const unsubscribe = services.onWalletChange?.(() => invalidate('钱包账户或网络已变化，请重新连接'));
    return () => { epoch.current++; unsubscribe?.(); };
  }, [services]);

  useEffect(()=>{
    if(page==='transfer'&&!preview)recipientInput.current?.focus();
  },[page,preview]);

  useEffect(()=>{
    if(!wallet||operation?.execution!=='succeeded'||operation.confirmation==='reorged')return;
    const context=epoch.current;
    setBalanceNotice('');
    void refreshFundedWallet(wallet.address).catch(()=>{
      if(context===epoch.current)setBalanceNotice('交易执行结果已核实，账户余额尚未刷新。请返回钱包点击刷新余额。');
    });
  },[operation?.hash,operation?.execution,operation?.confirmation]);

  const tracking=useReadonlyPolling({
    key:operation?`${epoch.current}:${operation.hash}`:undefined,
    terminal:operation?.confirmation==='confirmed'||operation?.submission==='rejected',
    scope:services,
    read:()=>services.status(operation!.hash),
    apply:value=>setOperation(current=>current?.hash===operation?.hash?value:current),
  });
  const cancellationTracking=useReadonlyPolling({
    key:cancellation&&cancellation.targetHash===operation?.hash?`${epoch.current}:${cancellation.targetHash}:${cancellation.hash}`:undefined,
    terminal:cancellation?.confirmation==='confirmed'||cancellation?.submission==='rejected',
    scope:services,
    read:()=>services.status(cancellation!.hash),
    apply:value=>setCancellation(current=>current?.hash===cancellation?.hash&&current?.targetHash===cancellation?.targetHash?{...value,targetHash:current!.targetHash}:current),
  });

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
  function navigate(next:typeof page){
    if(activeActions.current.has('submit'))return;
    previewRevision.current++;setPreview(undefined);setError('');setPage(next);
    setCancelApproval(false);setRevokeApproval(false);setReceiveOpen(false);
  }
  let amountIssue='';try{if(parseAmount(amount.trim(),18)<=0n)throw new Error();}catch{amountIssue='请输入大于 0 的金额，最多支持 18 位小数。';}
  const step=page==='result'?3:busy.submit?2:preview?1:0;
  const shortBalance=wallet?.balance?.slice(0,wallet.balance.indexOf('.')+7);
  const balanceSummary=wallet?.balance&&/^\d+\.\d{7,}$/.test(wallet.balance)?(/^0\.0{6}$/.test(shortBalance!)&&parseAmount(wallet.balance,18)>0n?'< 0.000001':`约 ${shortBalance}`):wallet?.balance;
  const delegationLabel=wallet?.delegation==='enabled'?'智能账户已启用':wallet?.delegation==='undelegated'?'未启用智能账户':'委托状态待核实';
  const guide=services.listWallets&&services.connectWallet?<WalletGuide wallet={wallet} checking={busy.refresh} connecting={connectingWallet!==undefined} connectingWalletName={connectingWallet} onConnect={openWalletPicker} onRefresh={()=>{void perform(readWalletBalance,setWallet,'检查失败',()=>true,'refresh');}} onSwitch={openWalletPicker} onStartTransfer={()=>navigate('transfer')}/>:null;
  const accountIdentity=wallet&&<div className="account-identity"><span className="field-hint">原地址</span><p className="address">{wallet.address}</p><span className={`delegation ${wallet.delegation==='enabled'?'success':'unknown'}`}>{wallet.delegation==='enabled'&&<Check size={16}/>} {delegationLabel}</span>{wallet.connection&&<small>已连接 {wallet.connection.walletName}</small>}</div>;
  const operationView=operation&&presentOperation(operation);
  const recentActivity=<section className="empty-activity"><h2>最近转账</h2>{operation?<div className="activity-row"><ReceiptText size={22}/><div><strong>{operationPreview?.amount} ETH</strong><p className="address">{operationPreview?.recipient}</p></div><button onClick={()=>setPage('result')}>查看交易详情</button></div>:<p><ReceiptText size={22}/>还没有转账记录</p>}</section>;
  return <div className="pixel-shell"><aside className="app-rail"><a className="pixel-brand" href="#" onClick={e=>{e.preventDefault();navigate('home');}}>ABSTRACT<br/>WALLET<span>YOUR ADDRESS. UPGRADED.</span></a><nav className="rail-nav" aria-label="主导航">{([['home','资产'],['activity','活动'],['settings','设置']] as const).map(([target,label])=><button key={target} disabled={busy.submit} aria-current={(page===target||(target==='home'&&(page==='transfer'||page==='result')))?'page':undefined} onClick={()=>navigate(target)}>{target==='home'?<Layers3 size={22}/>:target==='activity'?<ReceiptText size={22}/>:<Settings2 size={22}/>} {label}</button>)}</nav><div className="rail-footer">原地址，由你掌控<br/><small>Arbitrum Sepolia · 测试网</small></div></aside><main className="wallet-app">
    <div className="page-topline">{(page==='transfer'||page==='result')?<button className="return-link" disabled={busy.submit} onClick={()=>navigate('home')}><ArrowLeft size={18}/>返回钱包</button>:<span/>}<p className="testnet-badge">Arbitrum Sepolia <span>· 测试网</span></p></div>
    <header className="page-heading"><h1>{page==='home'?'你的钱包':page==='activity'?'交易活动':page==='settings'?'钱包设置':page==='result'?'交易进度':preview?'核对这笔转账':'发送测试 ETH'}</h1></header>
    {(page==='transfer'||page==='result')&&<nav className="transfer-steps" aria-label="转账步骤">{['填写信息','核对交易','钱包确认','交易结果'].map((label,index)=><span className={`flow-step ${index===step?'is-current':index<step?'is-complete':''}`} key={label} aria-current={index===step?'step':undefined}><b>{String(index+1).padStart(2,'0')}</b>{label}</span>)}</nav>}
    <div className="workspace-grid"><div className="workspace-main">
    {!wallet&&guide}
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
    {wallet && <section className="wallet-card">
      {page==='settings'&&<div className="account-settings"><h2>账户设置</h2>{accountIdentity}<p>保留原地址；账户能力按当前测试链单独检查。</p>
      {wallet.connection&&services.connectWallet&&<button className="button-quiet" disabled={connectingWallet!==undefined} onClick={openWalletPicker}>切换钱包</button>}
      {wallet.connection && services.disconnectWallet && <button onClick={() => { invalidate(); void perform(() => services.disconnectWallet!(), () => setConnectionNotice('已断开连接；链上委托不会自动撤销'), '断开连接失败'); }}>断开连接</button>}
      <button onClick={() => setRevokeApproval(true)} disabled={wallet.delegation !== 'enabled' || wallet.availability?.canRevoke === false}>撤销智能账户</button></div>}
      {wallet.availability?.reason && wallet.availability.canSubmit && <p className="capability-note" role="status">{wallet.availability.reason}</p>}
      {page==='home'&&accountIdentity}
      <div className="wallet-summary" hidden={page!=='home'}>
        {page==='home'&&<div className="balance-panel"><p className="balance-caption">可用测试余额</p><p className={`balance ${balanceSummary!==wallet.balance?'is-approx':''}`} aria-label="当前账户余额" title={`完整余额：${wallet.balance} ETH`}>{balanceSummary} <span className="amount-unit">ETH</span></p><div className="home-actions"><button className="button-primary" disabled={wallet.delegation==='unknown'||wallet.availability?.canSubmit===false} onClick={()=>navigate('transfer')}>转账<ArrowRight size={20}/></button><button className="button-secondary" onClick={()=>{setReceiveOpen(true);setReceiveNotice('');}}>收款</button></div><button className="button-quiet" disabled={busy.refresh} onClick={()=>perform(readWalletBalance,setWallet,'刷新失败',()=>true,'refresh')}>{busy.refresh?'正在刷新余额…':'刷新余额'}</button></div>}
        <div className="funding-slot"><h3>领取测试币</h3><TestEthFunding key={wallet.address.toLowerCase()} address={wallet.address} refreshing={busy.refresh} onRequest={services.requestTestFunds?()=>services.requestTestFunds!():undefined} onStatus={services.testFundsStatus?claimId=>services.testFundsStatus!(claimId):undefined} onRefresh={services.requestTestFunds?()=>refreshFundedWallet(wallet.address):()=>{void perform(readWalletBalance,setWallet,'刷新失败',()=>true,'refresh');}}/>
        {services.requestTestFunds&&<p className="field-hint funding-note">每个地址每 24 小时可领取 0.001 测试 ETH，到账后余额会自动刷新。</p>}
        {/^0(?:\.0+)?$/.test(wallet.balance)&&<p className="field-hint funding-note">{services.requestTestFunds?'余额为 0。点击“领取测试币”，等待系统领取并刷新余额后，再开始转账。':'余额为 0。点击“领取测试币”，到账后刷新余额，再开始转账。'}</p>}</div>
        {page==='home'&&<figure className="wallet-art"><img src="/pixel-wallet.png" alt="" width="172" height="172"/><figcaption>地址不变，由你掌控</figcaption></figure>}
      </div>
      {page==='home'&&<><section className="wallet-asset-list"><h2>资产</h2><div className="asset-table-heading"><span>资产</span><span>余额</span></div><div className="asset-row"><div><strong>ETH</strong><small>Arbitrum Sepolia · 测试资产</small></div><span>{wallet.balance}<small> 测试 ETH</small></span></div></section>{recentActivity}</>}
      {receiveOpen&&<section role="dialog" aria-label="接收测试 ETH" className="receive-dialog"><h2>接收测试 ETH</h2><p>仅接收 Arbitrum Sepolia 测试 ETH</p><p className="address">{wallet.address}</p><button onClick={()=>{const context=epoch.current;void (async()=>{try{await navigator.clipboard.writeText(wallet.address);if(context===epoch.current){setReceiveError(false);setReceiveNotice('收款地址已复制');}}catch{if(context===epoch.current){setReceiveError(true);setReceiveNotice('复制失败，请手动复制上方地址');}}})();}}>复制收款地址</button><button onClick={()=>setReceiveOpen(false)}>关闭收款</button>{receiveNotice&&<p role={receiveError?'alert':'status'}>{receiveNotice}</p>}</section>}
      {page==='transfer'&&!preview&&<div className="transfer-layout"><div className="transfer-main">
      {page==='transfer'&&!preview&&wallet.delegation!=='unknown'&&wallet.availability?.canSubmit!==false&&<form className="transfer-form" onChange={() => { previewRevision.current++; setPreview(undefined);setError(''); }} onSubmit={e => {
        e.preventDefault(); setPreview(undefined); const revision = ++previewRevision.current;setFieldsChecked(true);
        if(recipientIssue||amountIssue){setError('');(recipientIssue?recipientInput:amountInput).current?.focus();return;}
        void perform(() => services.preview({ recipient:recipient.trim(), amount:amount.trim(), sponsored }), setPreview, '准备失败', () => revision === previewRevision.current,'preview');
      }}>
        
        <label>收款地址<input ref={recipientInput} disabled={busy.submit} aria-invalid={fieldsChecked&&!!recipientIssue} aria-describedby={`${fieldId}-recipient`} placeholder="0x 开头的钱包地址" aria-label="收款地址" value={recipient} onChange={e => setRecipient(e.target.value)} /><span id={`${fieldId}-recipient`} className={fieldsChecked&&recipientIssue?'field-error':'field-hint'}>{fieldsChecked&&recipientIssue?recipientIssue:'请输入 Arbitrum Sepolia 上的收款地址。'}</span></label>
        <label>金额（ETH）<input ref={amountInput} disabled={busy.submit} aria-invalid={fieldsChecked&&!!amountIssue} aria-describedby={`${fieldId}-amount`} placeholder="例如 0.001" inputMode="decimal" aria-label="金额（ETH）" value={amount} onChange={e => setAmount(e.target.value)} /><span id={`${fieldId}-amount`} className={fieldsChecked&&amountIssue?'field-error':'field-hint'}>{fieldsChecked&&amountIssue?amountIssue:'仅发送测试 ETH。手续费会在预览中列出。'}</span></label>
        <fieldset className="payment-options"><legend>手续费支付方式</legend>
        <label className="payment-choice"><input type="radio" name={`${fieldId}-payment`} aria-label="使用 ETH 自付" checked={!sponsored} onChange={()=>setSponsored(false)}/>使用 ETH 自付<span className="field-hint">从当前账户支付网络费用。</span></label>
        <label className="payment-choice"><input type="radio" name={`${fieldId}-payment`} aria-label="申请 Gas 赞助" checked={sponsored} onChange={()=>setSponsored(true)}/>申请应用赞助<span className="field-hint">由应用支付手续费；额度不足时可明确改为自付。</span></label>
        {sponsored&&<p className="field-hint">预览时可能需要签署赞助验证，提交时还需确认交易签名。</p>}
        </fieldset>
        <button className="button-primary" type="submit" disabled={busy.preview||busy.submit}>{busy.preview?'正在准备预览…':'预览交易'}</button>
        {busy.preview&&<p className="preparation-progress" role="status">正在检查交易和费用，请稍候…</p>}
      </form>}
      </div><aside className="account-context"><h2>当前账户</h2><img src="/pixel-wallet.png" alt="" width="88" height="88"/>{accountIdentity}<p className="balance-caption">可用余额</p><p className="context-balance" aria-label="转账可用余额" title={`完整余额：${wallet.balance} ETH`}>{balanceSummary} <span className="amount-unit">ETH</span></p>{wallet.delegation==='undelegated'&&<p className="field-hint">首笔转账包含 7702 智能功能授权，原地址保持不变。</p>}</aside></div>}

    </section>}
    {preview && <div className="transfer-layout"><section className="transaction-review" role="dialog" aria-label="确认交易">
      <p className="balance-caption">你将转出</p><p className="review-amount">{preview.amount} <span className="amount-unit">ETH</span></p><p>发送至</p><p className="review-address">{preview.recipient}</p>
      <dl className="summary-list"><div><dt>发送账户</dt><dd>{wallet?.address}</dd></div><div><dt>网络</dt><dd>Arbitrum Sepolia</dd></div><div><dt>手续费支付</dt><dd>{preview.payment === 'sponsored' ? '应用赞助 Gas' : '账户使用 ETH 自付'}</dd></div><div><dt>最高费用</dt><dd aria-label="手续费上限">{preview.maxCost} ETH</dd></div><div className="summary-total"><dt>最大支出</dt><dd aria-label="最大支出">{ethAmount(parseAmount(preview.amount,18)+(preview.payment==='self'?parseAmount(preview.maxCost,18):0n))} ETH</dd></div></dl>
      <p className="field-hint">核对收款地址、金额和费用。返回修改后需要重新预览。</p>
      <div className="review-actions"><button className="button-primary" disabled={busy.submit||wallet?.availability?.canSubmit === false} onClick={() => perform(() => services.submit(preview), value => { setOperation(value);setOperationPreview(preview);setPage('result');setPreview(undefined);setCancelApproval(false);setCancellation(undefined); }, '签名失败',()=>true,'submit')}>{busy.submit?'正在签名和提交…':'确认并签名'}</button>
      <button className="button-secondary" disabled={busy.submit} onClick={()=>{previewRevision.current++;setPreview(undefined);recipientInput.current?.focus();}}>返回修改</button>
      </div><p className="field-hint">确认后请在钱包中核对签名请求。原地址保持不变。</p>
      {busy.submit&&<p role="status">{wallet?.connection?'请在钱包中确认签名，完成后会自动提交。':'正在签名并提交交易，请稍候…'}</p>}
    </section><aside className="account-context"><h2>下一步</h2><img src="/pixel-wallet.png" alt="" width="112" height="112"/><p>{wallet?.connection?'打开原钱包，核对并确认。':'本页测试签名器将签署已核对的交易。'}</p><p>完成后自动显示交易进度。</p><p className="delegation">{delegationLabel}</p>{wallet?.delegation==='undelegated'&&<p className="field-hint">首笔交易包含智能功能授权。原地址保持不变。</p>}</aside></div>}
    {error && <p role="alert">{error}</p>}
    {balanceNotice&&<p role="status">{balanceNotice}</p>}
    {page==='activity'&&recentActivity}
    {operation && page==='result' && <div className="transfer-layout"><section className="operation-card">
      <p className={`operation-status ${operation.confirmation==='reorged'||operation.execution==='reverted'?'failed':operation.confirmation==='confirmed'?'success':'pending'}`}>{operation.confirmation==='confirmed'?<Check size={22}/>:<Hourglass size={22}/>}<span aria-live="polite">{operationView!.title}</span></p>
      <p className="operation-message">{operationView!.message}</p>
      {operation.confirmation!=='confirmed'&&operation.submission!=='rejected'&&<p className="field-hint">系统会自动查询交易进度，无需再次签名。</p>}
      {operationPreview&&<><p className="review-amount">{operationPreview.amount} <span className="amount-unit">ETH</span></p><p aria-label="转账收款人" className="review-address">{operationPreview.recipient}</p></>}
      <dl className="operation-state"><div><dt>业务执行</dt><dd aria-label="业务执行">{operationView!.execution}</dd></div><div><dt>链上确认</dt><dd aria-label="链上确认">{operationView!.confirmation}</dd></div></dl>
      <p className="field-hint">操作编号</p><p className="operation-hash">{operation.hash}</p>
      <button className="button-primary" disabled={tracking.busy} onClick={()=>{void tracking.refresh();}}>{tracking.busy?'正在查询链上状态…':'刷新交易状态'}</button>
      {tracking.error&&<p role="alert">状态更新暂不可用：{tracking.error}。保留上次已核实结果，系统将自动重试。</p>}
      {operation.execution === 'unknown' && <button disabled={wallet?.availability?.canSubmit === false} onClick={() => setCancelApproval(true)}>取消待处理交易</button>}
    </section><aside className="account-context"><h2>当前账户</h2><img src="/pixel-wallet.png" alt="" width="112" height="112"/><p className="delegation">{delegationLabel}</p><p>账户状态与本笔交易结果分别展示。</p><p className="address">{wallet?.address}</p></aside></div>}
    {cancelApproval && operation && <section role="dialog" aria-label="确认取消交易">
      <h2>确认取消交易</h2><p>签署一笔同 nonce 的新操作，使用 ETH 自付。确认前原操作仍可能执行。</p>
      <button disabled={wallet?.availability?.canSubmit === false} onClick={() => perform(() => services.cancel(operation.hash), value => { setCancellation({...value,targetHash:operation.hash}); setCancelApproval(false); }, '取消失败')}>签名取消操作</button>
      <button onClick={() => setCancelApproval(false)}>暂不取消</button>
    </section>}
    {cancellation && cancellation.targetHash===operation?.hash && page==='result' && <section>
      <p>{cancellation.hash}</p><p aria-live="polite">{cancellation.execution === 'succeeded' && cancellation.confirmation === 'confirmed' ? cancellation.finality?.stage==='finalized'?'取消已最终确认':'取消已确认' : cancellation.confirmation==='reorged'?'取消链重组，待核实':cancellation.execution === 'reverted' ? '取消执行失败，原交易仍需核实' : cancellation.submission==='rejected'?'取消提交被拒绝':'取消处理中'}</p>
      <button disabled={cancellationTracking.busy} onClick={()=>{void cancellationTracking.refresh();}}>{cancellationTracking.busy?'正在查询取消状态…':'刷新取消状态'}</button>
      {cancellationTracking.error&&<p role="alert">取消状态更新暂不可用：{cancellationTracking.error}。系统将自动重试。</p>}
    </section>}
    {revokeApproval && <section role="dialog" aria-label="确认撤销委托">
      <h2>确认撤销委托</h2><p>只影响当前测试链；已有 Token 授权不会清除。本次由测试账户支付原生交易费用。</p>
      <button disabled={wallet?.availability?.canRevoke === false} onClick={() => perform(() => services.revoke(), value => { setRevocation(value); setRevokeApproval(false); if (value.confirmed && wallet) setWallet({ ...wallet, delegation: 'undelegated' }); }, '撤销失败')}>确认撤销</button>
      <button onClick={() => setRevokeApproval(false)}>保留委托</button>
    </section>}
    {revocation && <section><p>{revocation.transactionHash}</p><p>{revocation.confirmed ? '撤销已确认' : '撤销待确认'}</p></section>}
    {page==='home'&&wallet&&(wallet.delegation!=='unknown'&&wallet.availability?.canSubmit!==false?<details className="account-guide-disclosure"><summary>账户使用引导</summary>{guide}</details>:guide)}
    <div className="support-tools">    <details className="developer-tools" open={!services.connectWallet}>
    <summary>开发测试工具</summary>
    <button disabled={busy.submit} onClick={() => { invalidate(); void perform(() => services.createAccount(), setWallet, '创建失败'); }}>创建测试钱包</button>
    {services.importAccount && <form className="import-form" onSubmit={e => {
      e.preventDefault(); const key = privateKey; invalidate();
      void perform(() => services.importAccount!(key), setWallet, '导入失败');
    }}>
      <label>测试账户私钥<input type="password" disabled={busy.submit} autoComplete="off" spellCheck={false} aria-label="测试账户私钥" value={privateKey} onChange={e => setPrivateKey(e.target.value)} /></label>
      <button type="submit" disabled={busy.submit}>导入测试账户</button><small>仅存于本页内存，刷新后需重新导入。请使用测试账户。</small>
    </form>}
    </details>
    </div>
    {services.inspectOperation&&<div hidden={Boolean(wallet)&&page!=='activity'}><OperationRecovery inspectOperation={services.inspectOperation} recentOperation={services.recentOperation}/></div>}
    </div></div>
  </main></div>;
}
