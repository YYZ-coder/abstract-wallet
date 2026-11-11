import { decodeAbiParameters, decodeEventLog, encodeFunctionData, formatEther, keccak256, parseAbi, parseAbiParameters, toHex, type Address, type Hex, type LocalAccount } from 'viem';
import { entryPoint09Abi } from 'viem/account-abstraction';
import { parseSiweMessage } from 'viem/siwe';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { attachSponsorship, createBackendClient, createWalletClientTransport, createUnsignedAuthorization, createLocalSignerAdapter, signOperation, sendOperation, prepareOperation, prepareCancellation, prepareDelegationChange, signDelegationChange, parseAmount, parseInteger, type PreparedOperation, type SignedOperation, type ChainConfig, type SignerAdapter } from '@abstract-wallet/sdk';
import type { WalletServices, Preview, TransferDraft, OperationStatus, TestFundsClaim, OperationReference, ObservedOperation } from './services';
import { inspectRecordedOperation, validOperationReference } from './observe-operation';
import { discoverExternalWallets, connectExternalWallet, type ExternalWalletConnection, type WalletHost } from './external-wallet';

export type RuntimeNetwork = {
  mode: 'local' | 'arbitrum-sepolia'; chainId: 421614;
  rpcUrl: string; bundlerUrl: string; backendBaseUrl: string;
  entryPoint: Address | null; delegate: Address | null; paymaster: Address | null;
  entryPointCodeHash: Hex | null; delegateCodeHash: Hex | null; paymasterCodeHash: Hex | null;
  sponsorSigner: Address | null; manifestVersion: string;
  confirmationsRequired?: number;
  authDomain?:string;authUri?:string;
};
type ActiveAccount = { address:Address; signTypedData:LocalAccount['signTypedData']; signMessage:LocalAccount['signMessage']; signTransaction?:LocalAccount['signTransaction']; signer:SignerAdapter };
function localAccount(root:LocalAccount):ActiveAccount { return { address:root.address,signTypedData:root.signTypedData,signMessage:root.signMessage,signTransaction:root.signTransaction,signer:createLocalSignerAdapter(root) }; }
export function createBrowserServices(network: RuntimeNetwork, options: { fetch?: typeof fetch; accountFactory?: () => LocalAccount; walletHost?: WalletHost; storage?:Pick<Storage,'getItem'|'setItem'> } = {}): WalletServices {
  network = structuredClone(network);
  const fetchImpl = options.fetch ?? fetch;
  const walletHost = options.walletHost ?? (typeof window === 'undefined' ? undefined : window);
  const wallets = walletHost ? discoverExternalWallets(walletHost) : undefined;
  let account: ActiveAccount | undefined;
  let external:ExternalWalletConnection|undefined;
  let contextVersion=0;
  const walletChanges=new Set<()=>void>();
  let prepared: PreparedOperation | undefined;
  let currentPreview: Preview | undefined;
  let sequence = 0;
  let id = 0;
  const operations = new Map<string, { signed: SignedOperation; preview: Preview; status: OperationStatus }>();
  let pendingRevocation:{raw:Hex;hash:Hex;account:Address;minimumNonce:bigint}|undefined;
  let session:{token:string;expiresAt:bigint;account:Address}|undefined;
  let preparedQuoteExpiry:bigint|undefined;
  // An ambiguous response must retain its request identity across wallet session resets.
  const testFundsKeys=new Map<string,string>();
  const testFundsClaims=new Map<string,string>();
  const testFundsConfirmedAt=new Map<string,number>();
  const backend=createBackendClient(network.backendBaseUrl,fetchImpl);
  const nextKey=(prefix:string)=>`${prefix}_${Array.from(crypto.getRandomValues(new Uint8Array(16)),value=>value.toString(16).padStart(2,'0')).join('')}`;
  let journalVersion=0;
  const journalKey='abstract-wallet:recent-operation:v1:421614';
  const journalStorage=()=>options.storage??(typeof window==='undefined'?undefined:window.sessionStorage);
  function recentOperation():OperationReference|undefined{
    try{
      const value=JSON.parse(journalStorage()?.getItem(journalKey)??'null');
      if(!value||value.schemaVersion!=='1'||Object.keys(value).sort().join(',')!=='address,chainId,hash,schemaVersion'||!validOperationReference(value))return undefined;
      return{chainId:'421614',address:value.address.toLowerCase(),hash:value.hash.toLowerCase()};
    }catch{return undefined;}
  }
  function saveOperation(reference:OperationReference){
    journalVersion++;
    try{
      const storage=journalStorage();if(!storage||!validOperationReference(reference))throw new Error();
      storage.setItem(journalKey,JSON.stringify({schemaVersion:'1',chainId:'421614',address:reference.address.toLowerCase(),hash:reference.hash.toLowerCase()}));
    }catch{throw new Error('无法保存公开交易记录，未发送交易；请检查浏览器存储后重试');}
  }
  async function checkWalletContext(authority:ActiveAccount,connection:ExternalWalletConnection|undefined,version:number){
    await connection?.assertActive();
    if(account!==authority||external!==connection||contextVersion!==version)throw new Error('钱包连接已失效，请重新连接');
  }
  async function sendCurrent(signed:SignedOperation,authority:ActiveAccount,connection:ExternalWalletConnection|undefined,version:number,checkPreparation?:()=>void){
    let blocked:unknown;
    const guardedFetch:typeof fetch=async(url,init)=>{
      const method=typeof init?.body==='string'?JSON.parse(init.body).method:undefined;
      if(method==='eth_sendUserOperation'){
        try{await checkWalletContext(authority,connection,version);checkPreparation?.();saveOperation({chainId:'421614',address:authority.address,hash:signed.userOpHash});}catch(error){blocked=error;throw error;}
      }
      return fetchImpl(url,init);
    };
    const result=await sendOperation(createWalletClientTransport(signed.prepared.config,guardedFetch),signed);
    if(blocked)throw blocked;
    return result;
  }
  async function rpc(method: string, params: unknown[] = []): Promise<any> {
    const requestId = ++id;
    const response = await fetchImpl(network.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) });
    if (!response.ok) throw new Error('网络连接失败');
    const result = await response.json();
    if (result.jsonrpc !== '2.0' || result.id !== requestId || result.error || !Object.hasOwn(result, 'result')) throw new Error('链状态暂时不可用');
    return result.result;
  }
  async function snapshot() {
    if (!account) throw new Error('请先创建测试钱包');
    const authority=account,connection=external;
    await connection?.assertActive();
    if(account!==authority || external!==connection)throw new Error('钱包连接已失效，请重新连接');
    if (network.chainId !== 421614 || BigInt(await rpc('eth_chainId')) !== 421614n) throw new Error('当前连接不是 Arbitrum Sepolia');
    const [balance, code] = await Promise.all([rpc('eth_getBalance', [account.address, 'latest']), rpc('eth_getCode', [account.address, 'latest'])]);
    await connection?.assertActive();
    if(account!==authority || external!==connection)throw new Error('钱包连接已失效，请重新连接');
    const expected = network.delegate ? `0xef0100${network.delegate.slice(2).toLowerCase()}` : null;
    const delegation=(code === '0x' ? 'undelegated' : expected && code.toLowerCase() === expected ? 'enabled' : 'unknown') as 'undelegated'|'enabled'|'unknown';
    return { address: account.address, balance: formatEther(BigInt(balance)), delegation, ...(external?{connection:{walletId:external.walletId,walletName:external.walletName},availability:{canSubmit:delegation==='enabled',canRevoke:false,reason:delegation==='enabled'?'原地址已启用，可请求钱包签名；撤销请在原钱包中操作':delegation==='undelegated'?'当前钱包未提供本项目的7702授权接口，暂不能启用；原地址保持不变':'账户存在其他委托或代码状态未知，请先在原钱包中核实'}}:{}) };
  }
  async function ready(requirePaymaster=false) {
    if (!network.entryPoint || !network.delegate || !network.entryPointCodeHash || !network.delegateCodeHash) throw new Error('测试网部署尚未完成，请等待网络准备就绪');
    const [epCode, delegateCode] = await Promise.all([rpc('eth_getCode', [network.entryPoint, 'latest']), rpc('eth_getCode', [network.delegate, 'latest'])]);
    if (epCode === '0x' || delegateCode === '0x' || keccak256(epCode) !== network.entryPointCodeHash || keccak256(delegateCode) !== network.delegateCodeHash) throw new Error('DEPLOYMENT_MISMATCH：合约代码与网络清单不一致');
    if(requirePaymaster){
      if(!network.paymaster||!network.paymasterCodeHash||!network.sponsorSigner)throw new Error('赞助合约尚未配置');
      const code=await rpc('eth_getCode',[network.paymaster,'latest']);
      if(code==='0x'||keccak256(code)!==network.paymasterCodeHash)throw new Error('DEPLOYMENT_MISMATCH：赞助合约代码不一致');
      const signer=decodeAbiParameters(parseAbiParameters('address'),await rpc('eth_call',[{to:network.paymaster,data:encodeFunctionData({abi:parseAbi(['function sponsorSigner() view returns(address)']),functionName:'sponsorSigner'})},'latest']))[0];
      if(signer.toLowerCase()!==network.sponsorSigner.toLowerCase())throw new Error('赞助签名人与链上部署不一致');
    }
    const config: ChainConfig = { chainId: network.chainId, rpcUrl: network.rpcUrl, bundlerUrls: [network.bundlerUrl], entryPoint: network.entryPoint, delegate: network.delegate, ...(network.paymaster ? { paymaster: network.paymaster } : {}) };
    return { config, transport: createWalletClientTransport(config, fetchImpl) };
  }
  async function previewTransfer(draft: TransferDraft): Promise<Preview> {
    prepared=undefined;currentPreview=undefined;preparedQuoteExpiry=undefined;
    if (!account) throw new Error('请先创建测试钱包');
    const authority=account,connection=external,version=contextVersion;
    await connection?.assertActive();
    const checkContext=()=>checkWalletContext(authority,connection,version);
    await checkContext();
    const value = parseAmount(draft.amount, 18);
    if (value <= 0n) throw new Error('请输入大于 0 的转账金额');
    const { config, transport } = await ready(draft.sponsored);
    const state = await transport.readAccountState(authority.address);
    if (!['none', 'expected'].includes(state.delegation.status)) throw new Error('账户存在其他委托，请先显式撤销或迁移');
    if (state.delegation.status === 'none' && !authority.signer.capabilities.authorization) throw new Error('当前钱包不支持本项目所需的7702授权；请先在支持的钱包中为原地址启用');
    const gasPrice = await transport.gasPrice();
    const now = BigInt((await rpc('eth_getBlockByNumber', ['latest', false])).timestamp);
    const gas = { verificationGasLimit: 600_000n, callGasLimit: 300_000n, preVerificationGas: 100_000n, maxPriorityFeePerGas: gasPrice, maxFeePerGas: gasPrice * 2n };
    const input = { config, account: authority.address, calls: [{ target: draft.recipient as Address, value, data: '0x' as Hex }], nonce: state.entryPointNonce, gas, window: { validAfter: now > 0n ? now - 1n : 0n, validUntil: now + 600n }, ...(state.delegation.status === 'none' ? { authorizationNonce: state.eoaNonce } : {}) };
    if(draft.sponsored){
      await checkContext();
      const result=await prepareSponsored(input,transport,authority);
      await checkContext();
      if(state.balance<value)throw new Error('测试 ETH 余额不足以支付转账本金');
      prepared=result.prepared;preparedQuoteExpiry=result.quoteExpiry;
      currentPreview=Object.freeze({id:`preview-${++sequence}`,recipient:draft.recipient,amount:draft.amount,maxCost:formatEther(result.maxCost),payment:'sponsored'});
      return{...currentPreview};
    }
    const initial = prepareOperation(input);
    const auth = input.authorizationNonce === undefined ? undefined : createUnsignedAuthorization(config.chainId, config.delegate, input.authorizationNonce);
    const estimate = await transport.estimateGas(initial.rpcUserOperation, auth);
    await checkContext();
    prepared = prepareOperation({ ...input, gas: { ...gas, verificationGasLimit:estimate.verificationGasLimit,callGasLimit:estimate.callGasLimit,preVerificationGas:estimate.preVerificationGas } });
    const maximum = (prepared.gas.verificationGasLimit + prepared.gas.callGasLimit + prepared.gas.preVerificationGas) * prepared.gas.maxFeePerGas;
    if (maximum > 5_000_000_000_000_000n) { prepared = undefined; throw new Error('预计费用超过本次测试上限，请稍后重试'); }
    if (state.balance < value + maximum) { prepared = undefined; throw new Error('测试 ETH 余额不足，请先领取或转入测试币'); }
    currentPreview = Object.freeze({ id: `preview-${++sequence}`, recipient: draft.recipient, amount: draft.amount, maxCost: formatEther(maximum), payment: 'self' });
    return {...currentPreview};
  }
  async function authenticate(authority:ActiveAccount){
    const now=BigInt(Math.floor(Date.now()/1000));
    if(session && session.account.toLowerCase()===authority.address.toLowerCase() && session.expiresAt>now+10n)return session.token;
    const domain=network.authDomain ?? (network.mode==='local'?'wallet.local':undefined);
    const uri=network.authUri ?? (network.mode==='local'?'https://wallet.local':undefined);
    let safeUri=false;
    try{const parsed=new URL(uri??'');safeUri=parsed.protocol==='https:'||(parsed.protocol==='http:'&&['127.0.0.1','localhost'].includes(parsed.hostname));}catch{/* Reject malformed pinned service URI. */}
    if(!domain||!uri||!safeUri)throw new Error('赞助登录域尚未配置');
    const challenge=await backend.request('/v1/auth/challenges',{schemaVersion:'1',idempotencyKey:nextKey('challenge'),chainId:String(network.chainId),account:authority.address.toLowerCase()});
    const parsed=parseSiweMessage(challenge.message);
    if(challenge.schemaVersion!=='1'||challenge.signatureScheme!=='root-eip191-65'||challenge.chainId!==String(network.chainId)||challenge.account?.toLowerCase()!==authority.address.toLowerCase()||challenge.domain!==domain||challenge.uri!==uri||parsed.domain!==domain||parsed.uri!==uri||parsed.address?.toLowerCase()!==authority.address.toLowerCase()||parsed.chainId!==network.chainId||parsed.version!=='1'||parsed.nonce!==challenge.nonce||!parsed.issuedAt||!parsed.expirationTime||BigInt(Math.floor(parsed.issuedAt.getTime()/1000))!==parseInteger(challenge.issuedAt)||BigInt(Math.floor(parsed.expirationTime.getTime()/1000))!==parseInteger(challenge.expiresAt)||parseInteger(challenge.expiresAt)<=now||parseInteger(challenge.expiresAt)-parseInteger(challenge.issuedAt)>300n)throw new Error('赞助登录挑战与当前账户、链或服务域不符');
    const signature=await authority.signMessage({message:challenge.message});
    const response=await backend.request('/v1/auth/sessions',{schemaVersion:'1',idempotencyKey:nextKey('session'),challengeId:challenge.challengeId,signatureScheme:'root-eip191-65',signature});
    if(response.chainId!==String(network.chainId)||response.account?.toLowerCase()!==authority.address.toLowerCase()||response.projectId!==challenge.projectId||response.tokenType!=='Bearer'||!response.scopes?.includes('sponsorship')||!/^[A-Za-z0-9_-]{32,512}$/.test(response.accessToken??'')||parseInteger(response.expiresAt)<=now)throw new Error('赞助会话范围不符');
    if(account!==authority)throw new Error('账户已改变，请重新预览');
    session={token:response.accessToken,expiresAt:parseInteger(response.expiresAt),account:authority.address};return session.token;
  }
  async function prepareSponsored(input:Parameters<typeof prepareOperation>[0],transport:ReturnType<typeof createWalletClientTransport>,authority:ActiveAccount){
    const connection=external,version=contextVersion;
    const token=await authenticate(authority);let gas={...input.gas};let pmGas=200000n;let postGas=0n;
    const auth=input.authorizationNonce===undefined?undefined:createUnsignedAuthorization(network.chainId,network.delegate!,input.authorizationNonce);
    for(let attempt=0;attempt<4;attempt++){
      const initial=prepareOperation({...input,gas});
      const maximum=(gas.verificationGasLimit+gas.callGasLimit+gas.preVerificationGas+pmGas+postGas)*gas.maxFeePerGas;
      if(maximum>5_000_000_000_000_000n)throw new Error('赞助费用超过本次测试上限');
      const op=initial.rpcUserOperation;
      const body={schemaVersion:'1',idempotencyKey:nextKey('quote'),manifestVersion:network.manifestVersion,chainId:String(network.chainId),entryPoint:network.entryPoint!.toLowerCase(),account:authority.address.toLowerCase(),expectedDelegate:network.delegate!.toLowerCase(),unsignedUserOperation:{sender:authority.address.toLowerCase(),nonce:input.nonce.toString(),factory:'0x7702',factoryData:'0x',callData:op.callData,callGasLimit:gas.callGasLimit.toString(),verificationGasLimit:gas.verificationGasLimit.toString(),preVerificationGas:gas.preVerificationGas.toString(),maxFeePerGas:gas.maxFeePerGas.toString(),maxPriorityFeePerGas:gas.maxPriorityFeePerGas.toString(),paymaster:network.paymaster!.toLowerCase(),paymasterVerificationGasLimit:pmGas.toString(),paymasterPostOpGasLimit:postGas.toString()},authorizationContext:input.authorizationNonce===undefined?null:{chainId:String(network.chainId),address:network.delegate!.toLowerCase(),nonce:input.authorizationNonce.toString(),eip7702Auth:null},accountWindow:{validAfter:input.window.validAfter.toString(),validUntil:input.window.validUntil.toString()},maxCost:maximum.toString()};
      const quote=await backend.request('/v1/sponsorships/prepare',body,token);
      if(quote.chainId!==String(network.chainId)||quote.account?.toLowerCase()!==authority.address.toLowerCase()||quote.manifestVersion!==network.manifestVersion||quote.paymaster?.toLowerCase()!==network.paymaster!.toLowerCase()||quote.stubIsExecutable!==false||quote.maxCost!==body.maxCost||parseInteger(quote.quoteExpiresAt)<=parseInteger(quote.serverTime)||parseInteger(quote.quoteExpiresAt)<=BigInt(Math.floor(Date.now()/1000)))throw new Error('赞助报价已失效或与当前操作不符');
      const quotePmGas=parseInteger(quote.paymasterVerificationGasLimit),quotePostGas=parseInteger(quote.paymasterPostOpGasLimit);
      const candidate=prepareOperation({...input,gas,paymaster:{address:network.paymaster!,verificationGasLimit:quotePmGas,postOpGasLimit:quotePostGas,data:quote.stubPaymasterData}});
      const estimated=await transport.estimateGas(candidate.rpcUserOperation,auth);
      const nextGas={...gas,verificationGasLimit:estimated.verificationGasLimit,callGasLimit:estimated.callGasLimit,preVerificationGas:estimated.preVerificationGas};const nextPmGas=estimated.paymasterVerificationGasLimit??quotePmGas;
      if(nextGas.verificationGasLimit!==gas.verificationGasLimit||nextGas.callGasLimit!==gas.callGasLimit||nextGas.preVerificationGas!==gas.preVerificationGas||nextPmGas!==pmGas||quotePostGas!==postGas){gas=nextGas;pmGas=nextPmGas;postGas=quotePostGas;continue;}
      await checkWalletContext(authority,connection,version);
      const record=await backend.request('/v1/sponsorships',{...body,idempotencyKey:nextKey('permit'),quoteId:quote.quoteId},token);
      if(record.state!=='issued'||!record.permit)throw new Error('赞助许可签发结果待核实；请查询原记录，未自动转为自付');
      if(record.permit.maxCost!==body.maxCost)throw new Error('最终赞助费用上限发生变化，请重新预览');
      const final=await attachSponsorship(candidate,record,network.sponsorSigner!);
      const checked=await transport.estimateGas(final.rpcUserOperation,auth);
      if(checked.verificationGasLimit!==gas.verificationGasLimit||checked.callGasLimit!==gas.callGasLimit||checked.preVerificationGas!==gas.preVerificationGas||(checked.paymasterVerificationGasLimit??pmGas)!==pmGas)throw new Error('最终赞助估费发生变化，请重新预览；旧许可风险仍保留');
      if(account!==authority)throw new Error('账户已改变，请重新预览');
      return{prepared:final,maxCost:maximum,quoteExpiry:parseInteger(quote.quoteExpiresAt)};
    }
    throw new Error('赞助估费尚未稳定，请稍后重新预览');
  }
  async function submit(preview: Preview): Promise<OperationStatus> {
    if (!account || !prepared || !currentPreview || JSON.stringify(preview) !== JSON.stringify(currentPreview)) throw new Error('预览已失效，请重新预览并确认');
    const frozen=prepared,approvedPreview=currentPreview,quoteExpiry=preparedQuoteExpiry;
    const checkPreparation=()=>{if(prepared!==frozen||currentPreview!==approvedPreview)throw new Error('预览已失效，请重新预览并确认');};
    const authority=account,connection=external,version=contextVersion;
    await checkWalletContext(authority,connection,version);
    checkPreparation();
    const { transport } = await ready(Boolean(frozen.paymaster));
    const state = await transport.readAccountState(account.address);
    const now = BigInt((await rpc('eth_getBlockByNumber',['latest',false])).timestamp);
    if (state.entryPointNonce !== frozen.nonce || (frozen.authorizationNonce !== undefined && state.eoaNonce !== frozen.authorizationNonce) || !['none','expected'].includes(state.delegation.status) || (frozen.authorizationNonce === undefined && state.delegation.status !== 'expected') || now <= frozen.window.validAfter || now > frozen.window.validUntil || (quoteExpiry!==undefined&&BigInt(Math.floor(Date.now()/1000))>=quoteExpiry)) throw new Error('预览已失效：链上状态或有效期已改变，请重新确认');
    await checkWalletContext(authority,connection,version);
    checkPreparation();
    const signed = await signOperation(frozen,authority.signer);
    await checkWalletContext(authority,connection,version);
    checkPreparation();
    const initial: OperationStatus = { hash:signed.userOpHash,submission:'unknown',execution:'unknown',confirmation:'pending' };
    operations.set(signed.userOpHash,{signed,preview:{...approvedPreview},status:initial});
    const result = await sendCurrent(signed,authority,connection,version,checkPreparation);
    const status: OperationStatus = { ...initial,submission:result.admission };
    const stored=operations.get(signed.userOpHash);if(stored)stored.status=status;
    if(account===authority&&external===connection&&contextVersion===version&&prepared===frozen&&currentPreview===approvedPreview){prepared=undefined;currentPreview=undefined;}
    if(frozen.paymaster && session && session.account.toLowerCase()===frozen.account.toLowerCase() && session.expiresAt>BigInt(Math.floor(Date.now()/1000))){
      const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),2000);
      const reporting=createBackendClient(network.backendBaseUrl,(url,init)=>fetchImpl(url,{...init,signal:controller.signal}));
      try{
        await reporting.request('/v1/operations',{schemaVersion:'1',idempotencyKey:nextKey('register'),manifestVersion:network.manifestVersion,chainId:String(frozen.config.chainId),entryPoint:frozen.config.entryPoint.toLowerCase(),account:frozen.account.toLowerCase(),userOpHash:signed.userOpHash,nonce:frozen.nonce.toString(),expectedDelegate:frozen.config.delegate.toLowerCase(),reportedTransactionHash:null,attempts:[{attemptId:nextKey('attempt'),bundlerId:'configured_bundler_421614',attemptedAt:String(Math.floor(Date.now()/1000)),reportedResult:result.admission,reportedTransactionHash:null}]},session.token);
      }catch{/* Registration is an untrusted query hint; its failure never changes broadcast evidence or retries the transfer. */}
      finally{clearTimeout(timeout);}
    }
    return status;
  }
  async function status(hash: string): Promise<OperationStatus> {
    const record=operations.get(hash);
    if (!account || !record || record.signed.prepared.account.toLowerCase()!==account.address.toLowerCase()) throw new Error('找不到当前账户的操作记录');
    const {transport}=await ready(); const hint=await transport.getReceipt(hash as Hex);
    let next:OperationStatus={...record.status,execution:'unknown',confirmation:'pending'};
    const txHash=hint?.receipt?.transactionHash ?? hint?.transactionHash;
    if(typeof txHash==='string' && /^0x[0-9a-fA-F]{64}$/.test(txHash)){
      // Bundler metadata is only a locator. Execution is proven independently at the chain RPC.
      const receipt=await rpc('eth_getTransactionReceipt',[txHash]);
      let event:{success:boolean}|undefined;
      if(receipt?.transactionHash?.toLowerCase()===txHash.toLowerCase() && receipt.to?.toLowerCase()===network.entryPoint!.toLowerCase() && receipt.status==='0x1' && receipt.blockHash && receipt.blockNumber){
        const expectedPaymaster=record.signed.prepared.paymaster?.address ?? '0x0000000000000000000000000000000000000000';
        for(const log of receipt.logs ?? []){
          if(log.address?.toLowerCase()!==network.entryPoint!.toLowerCase())continue;
          try{const parsed=decodeEventLog({abi:entryPoint09Abi,data:log.data,topics:log.topics});
            if(parsed.eventName==='UserOperationEvent' && parsed.args.userOpHash.toLowerCase()===hash.toLowerCase() && parsed.args.sender.toLowerCase()===account.address.toLowerCase() && parsed.args.nonce===record.signed.prepared.nonce && parsed.args.paymaster.toLowerCase()===expectedPaymaster.toLowerCase())event={success:parsed.args.success};
          }catch{/* Unrelated or malformed logs do not prove this operation executed. */}
        }
      }
      if(event){
        const [canonical,head]=await Promise.all([rpc('eth_getBlockByNumber',[receipt.blockNumber,false]),rpc('eth_getBlockByNumber',['latest',false])]);
        if (!canonical || canonical.hash?.toLowerCase()!==receipt.blockHash.toLowerCase()) next={...next,confirmation:'reorged'};
        else {
        const depth=BigInt(head.number)-BigInt(receipt.blockNumber)+1n;
        const required=network.confirmationsRequired ?? (network.mode==='local'?1:undefined);
        const confirmed=required!==undefined && Number.isSafeInteger(required) && required>0 && depth>=BigInt(required);
        next={...next,submission:'accepted',execution:event.success?'succeeded':'reverted',confirmation:confirmed?'confirmed':'pending'};
        }
      }
    }
    record.status=next; return next;
  }
  async function cancel(hash:string):Promise<OperationStatus>{
    const original=operations.get(hash);
    if(!account || !original || original.signed.prepared.account.toLowerCase()!==account.address.toLowerCase()) throw new Error('找不到当前账户的操作记录');
    const authority=account,connection=external,version=contextVersion;
    await checkWalletContext(authority,connection,version);
    const observed=await status(hash);
    const {transport}=await ready(); const state=await transport.readAccountState(account.address);
    if(state.entryPointNonce!==original.signed.prepared.nonce || observed.execution!=='unknown') throw new Error('原操作 nonce 已被消费，请刷新原交易；取消未生效');
    if(!['none','expected'].includes(state.delegation.status)) throw new Error('当前委托状态不允许取消，请先核实');
    const price=await transport.gasPrice(); const old=original.signed.prepared.gas;
    const bump=(value:bigint)=>value*9n/8n+1n;
    const priority=price>bump(old.maxPriorityFeePerGas)?price:bump(old.maxPriorityFeePerGas);
    const max=price*2n>bump(old.maxFeePerGas)?price*2n:bump(old.maxFeePerGas);
    const now=BigInt((await rpc('eth_getBlockByNumber',['latest',false])).timestamp);
    const input={gas:{...old,maxPriorityFeePerGas:priority,maxFeePerGas:max},window:{validAfter:now>0n?now-1n:0n,validUntil:now+600n},...(state.delegation.status==='none'?{authorizationNonce:state.eoaNonce}:{})};
    const initial=prepareCancellation(original.signed.prepared,input);
    const auth=initial.authorizationNonce===undefined?undefined:createUnsignedAuthorization(network.chainId,network.delegate!,initial.authorizationNonce);
    const estimate=await transport.estimateGas(initial.rpcUserOperation,auth);
    const candidate=prepareCancellation(original.signed.prepared,{...input,gas:{...input.gas,verificationGasLimit:estimate.verificationGasLimit,callGasLimit:estimate.callGasLimit,preVerificationGas:estimate.preVerificationGas}});
    const maximum=(candidate.gas.verificationGasLimit+candidate.gas.callGasLimit+candidate.gas.preVerificationGas)*candidate.gas.maxFeePerGas;
    if(maximum>5_000_000_000_000_000n || state.balance<maximum) throw new Error('取消的测试 ETH 费用不足或超过上限');
    await checkWalletContext(authority,connection,version);
    const signed=await signOperation(candidate,authority.signer);
    await checkWalletContext(authority,connection,version);
    const preview:Preview={id:`cancel-${++sequence}`,recipient:account.address,amount:'0',maxCost:formatEther(maximum),payment:'self'};
    const initialStatus:OperationStatus={hash:signed.userOpHash,submission:'unknown',execution:'unknown',confirmation:'pending'};
    operations.set(signed.userOpHash,{signed,preview,status:initialStatus});
    const result=await sendCurrent(signed,authority,connection,version); const next={...initialStatus,submission:result.admission};
    const stored=operations.get(signed.userOpHash);if(stored)stored.status=next; return next;
  }
  async function revoke():Promise<{transactionHash:string;confirmed:boolean}>{
    if(!account)throw new Error('请先创建或导入测试账户');
    const authority=account;const zero='0x0000000000000000000000000000000000000000' as Address;
    if(network.chainId!==421614 || BigInt(await rpc('eth_chainId'))!==421614n)throw new Error('当前连接不是 Arbitrum Sepolia');
    if(!pendingRevocation){
      const [code,safeCode,nonceHex,priceHex,balanceHex]=await Promise.all([rpc('eth_getCode',[authority.address,'latest']),rpc('eth_getCode',[zero,'latest']),rpc('eth_getTransactionCount',[authority.address,'pending']),rpc('eth_gasPrice'),rpc('eth_getBalance',[authority.address,'latest'])]);
      if(code==='0x')throw new Error('当前账户没有需要撤销的委托');
      if(!/^0xef0100[0-9a-fA-F]{40}$/.test(code)||safeCode!=='0x')throw new Error('无法确认安全的原生撤销路径');
      const nonce=BigInt(nonceHex);if(nonce+1n>BigInt(Number.MAX_SAFE_INTEGER))throw new Error('授权 nonce 超出当前签名器支持范围');
      // Native authorization is independent of EntryPoint; this placeholder is never called.
      const config:ChainConfig={chainId:421614,rpcUrl:network.rpcUrl,bundlerUrls:[],entryPoint:zero,delegate:`0x${code.slice(8)}`};
      const change=prepareDelegationChange({config,account:authority.address,target:zero,eoaNonce:nonce,outerSender:authority.address});
      const auth=await signDelegationChange(change,authority.signer);
      const price=BigInt(priceHex);const fee=price*2n;
      const request={type:'0x4',from:authority.address,to:zero,value:'0x0',data:'0x',nonce:toHex(nonce),maxFeePerGas:toHex(fee),maxPriorityFeePerGas:toHex(price),authorizationList:[auth]};
      const estimated=BigInt(await rpc('eth_estimateGas',[request]));const gas=estimated+estimated/5n+10000n;
      if(gas*fee>5_000_000_000_000_000n || BigInt(balanceHex)<gas*fee)throw new Error('原生撤销费用不足或超过本次测试上限');
      if(!authority.signTransaction)throw new Error('当前钱包未提供原生7702撤销能力，请在原钱包中操作');
      const raw=await authority.signTransaction({type:'eip7702',chainId:421614,to:zero,value:0n,data:'0x',nonce:Number(nonce),gas,maxFeePerGas:fee,maxPriorityFeePerGas:price,authorizationList:[{chainId:421614,address:zero,nonce:Number(change.authorizationNonce),yParity:Number(BigInt(auth.yParity)),r:auth.r,s:auth.s}]} as any);
      if(account!==authority)throw new Error('账户已改变，请重新确认撤销');
      pendingRevocation={raw,hash:keccak256(raw),account:authority.address,minimumNonce:change.authorizationNonce+1n};
    }
    const pending=pendingRevocation;
    try{await rpc('eth_sendRawTransaction',[pending.raw]);}catch{/* Unknown broadcast is tracked by its already-computed hash; never create another nonce. */}
    for(let attempt=0;attempt<10;attempt++){
      const receipt=await rpc('eth_getTransactionReceipt',[pending.hash]);
      if(receipt?.blockHash && receipt?.blockNumber){
        const [canonical,head,code,nonce]=await Promise.all([rpc('eth_getBlockByNumber',[receipt.blockNumber,false]),rpc('eth_getBlockByNumber',['latest',false]),rpc('eth_getCode',[authority.address,'latest']),rpc('eth_getTransactionCount',[authority.address,'latest'])]);
        const required=network.confirmationsRequired ?? (network.mode==='local'?1:undefined);
        const confirmed=receipt.transactionHash?.toLowerCase()===pending.hash.toLowerCase() && required!==undefined && required>0 && Number.isSafeInteger(required) && canonical?.hash?.toLowerCase()===receipt.blockHash.toLowerCase() && BigInt(head.number)-BigInt(receipt.blockNumber)+1n>=BigInt(required) && code==='0x' && BigInt(nonce)>=pending.minimumNonce;
        if(confirmed){pendingRevocation=undefined;prepared=undefined;currentPreview=undefined;return{transactionHash:pending.hash,confirmed:true};}
        return{transactionHash:pending.hash,confirmed:false};
      }
      if(attempt<9)await new Promise(resolve=>setTimeout(resolve,500));
    }
    return{transactionHash:pending.hash,confirmed:false};
  }
  function reset(){contextVersion++;prepared=undefined;currentPreview=undefined;preparedQuoteExpiry=undefined;operations.clear();pendingRevocation=undefined;session=undefined;}
  async function importAccount(privateKey:string){
    let imported:LocalAccount;
    try{if(!/^0x[0-9a-fA-F]{64}$/.test(privateKey))throw new Error();imported=privateKeyToAccount(privateKey as Hex);}catch{throw new Error('测试私钥格式无效');}
    releaseExternal();account=localAccount(imported);reset();return snapshot();
  }
  function releaseExternal(){const previous=external;external=undefined;previous?.disconnect();}
  async function connectWallet(id:string){
    const choice=wallets?.list().find(item=>item.id===id);if(!choice)throw new Error('找不到所选钱包，请重新检测');
    releaseExternal();account=undefined;reset();
    const attempt=contextVersion;
    const connected=await connectExternalWallet(choice,{chainId:network.chainId});
    if(contextVersion!==attempt){connected.disconnect();throw new Error('钱包连接已失效，请重新连接');}
    external=connected;
    connected.subscribeInvalidation(()=>{
      if(external!==connected)return;
      external=undefined;account=undefined;reset();
      for(const listener of walletChanges)listener();
    });
    account={address:connected.address,signer:connected.signer,signTypedData:connected.signer.signTypedData,signMessage:async args=>{if(typeof args.message!=='string')throw new Error('不支持此消息格式');return connected.signMessage(args.message);}};
    return snapshot();
  }
  async function testFundsContext(){
    if(!account)throw fundsError('WALLET_NOT_CONNECTED','请先连接钱包或创建测试账户');
    const authority=account,connection=external,version=contextVersion;
    const walletCheck=async()=>{try{await checkWalletContext(authority,connection,version);}catch{throw fundsError('WALLET_CONTEXT_CHANGED','钱包或网络已切换，请在当前账户下重新检查');}};
    const check=async()=>{
      await walletCheck();let chain:unknown;
      try{chain=await rpc('eth_chainId');}catch{throw fundsError('UPSTREAM_UNAVAILABLE','网络暂时不可用，请重试同一领取申请');}
      await walletCheck();
      if(network.chainId!==421614||typeof chain!=='string'||!/^0x[0-9a-f]+$/i.test(chain)||BigInt(chain)!==421614n)throw fundsError('UNSUPPORTED_CHAIN','请切换到 Arbitrum Sepolia 后再领取');
    };
    await check();return{check,address:authority.address.toLowerCase()};
  }
  async function requestTestFunds():Promise<TestFundsClaim>{
    const {address,check}=await testFundsContext();
    const confirmedAt=testFundsConfirmedAt.get(address);
    if(confirmedAt!==undefined&&Date.now()-confirmedAt>=86_400_000){testFundsClaims.delete(address);testFundsKeys.delete(address);testFundsConfirmedAt.delete(address);}
    const existing=testFundsClaims.get(address);if(existing)return testFundsStatus(existing);
    let idempotencyKey=testFundsKeys.get(address);if(!idempotencyKey){idempotencyKey=nextKey('test_funds');testFundsKeys.set(address,idempotencyKey);}
    const data=await fetchTestFunds('/v1/test-funds/claims',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({schemaVersion:'1',chainId:'421614',address,idempotencyKey})});
    await check();
    const claim=testFundsClaim(data,address);rememberTestFundsClaim(address,claim);
    return claim;
  }
  function rememberTestFundsClaim(address:string,claim:TestFundsClaim){
    testFundsClaims.set(address,claim.claimId);
    if(claim.status==='confirmed'){if(!testFundsConfirmedAt.has(address))testFundsConfirmedAt.set(address,Date.now());}
    else testFundsConfirmedAt.delete(address);
  }
  function fundsError(code:string,message:string){return Object.assign(new Error(message),{code});}
  async function fetchTestFunds(path:string,init:RequestInit){
    const controller=new AbortController(),deadline=setTimeout(()=>controller.abort(),15_000);
    try{
      let response:Response;
      try{response=await fetchImpl(`${network.backendBaseUrl}${path}`,{...init,signal:controller.signal});}catch{throw fundsError('UPSTREAM_UNAVAILABLE','网络暂时不可用，请重试同一领取申请');}
      let data:any;
      try{data=await response.json();}catch{
        if(controller.signal.aborted)throw fundsError('UPSTREAM_UNAVAILABLE','网络暂时不可用，请重试同一领取申请');
        throw response.ok?fundsError('INVALID_FAUCET_RESPONSE','领取结果无法核实，请重新检查同一申请'):fundsError('FAUCET_UNAVAILABLE','领取服务暂未开启，请稍后重试');
      }
      if(!response.ok){
        const code=typeof data?.error?.code==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/.test(data.error.code)?data.error.code:'FAUCET_UNAVAILABLE';
        const messages:Record<string,string>={FAUCET_UNAVAILABLE:'领取服务暂未开启，请稍后重试',FAUCET_EMPTY:'测试币池余额不足，请稍后重试',FAUCET_COOLDOWN:'此地址 24 小时内已领取，请稍后再试',COOLDOWN:'此地址 24 小时内已领取，请稍后再试',FAUCET_BUDGET_EXCEEDED:'今日测试币额度已用完，请明天再试',BUDGET_EXCEEDED:'今日测试币额度已用完，请明天再试',UPSTREAM_UNAVAILABLE:'网络暂时不可用，请重试同一领取申请',RESOURCE_NOT_FOUND:'未找到此领取申请，请重新检查当前账户'};
        throw fundsError(code,messages[code]??'领取暂时不可用，请检查同一申请后重试');
      }
      return data;
    }finally{clearTimeout(deadline);}
  }
  function testFundsClaim(data:any,address:string):TestFundsClaim{
    const invalid=()=>fundsError('INVALID_FAUCET_RESPONSE','领取结果无法核实，请重新检查同一申请');
    if(!data||typeof data!=='object'||Array.isArray(data)||data.schemaVersion!=='1'||typeof data.requestId!=='string'||!data.requestId.trim()||data.requestId.length>128||
      typeof data.claimId!=='string'||!/^[0-9a-f]{32}$/.test(data.claimId)||data.chainId!=='421614'||typeof data.address!=='string'||!/^0x[0-9a-fA-F]{40}$/.test(data.address)||data.address.toLowerCase()!==address||
      data.amountWei!=='1000000000000000'||!['pending','submitted','confirmed','failed','unknown'].includes(data.status))throw invalid();
    if(data.transactionHash!==undefined&&(typeof data.transactionHash!=='string'||!/^0x[0-9a-fA-F]{64}$/.test(data.transactionHash)))throw invalid();
    if(['submitted','confirmed'].includes(data.status)&&data.transactionHash===undefined)throw invalid();
    if(data.status==='failed'?(typeof data.failureCode!=='string'||!/^[A-Z][A-Z0-9_]{0,63}$/.test(data.failureCode)):data.failureCode!==undefined)throw invalid();
    return{claimId:data.claimId,chainId:data.chainId,address:data.address.toLowerCase(),amountWei:data.amountWei,status:data.status,...(data.transactionHash?{transactionHash:data.transactionHash}:{}),...(data.failureCode?{failureCode:data.failureCode}:{})};
  }
  async function testFundsStatus(claimId:string):Promise<TestFundsClaim>{
    const {address,check}=await testFundsContext();
    if(!/^[0-9a-f]{32}$/.test(claimId)||testFundsClaims.get(address)!==claimId)throw fundsError('INVALID_FAUCET_CLAIM','请在当前账户下发起或检查自己的领取申请');
    const data=await fetchTestFunds(`/v1/test-funds/claims/${claimId}`,{method:'GET'});await check();
    const claim=testFundsClaim(data,address);
    if(claim.claimId!==claimId)throw fundsError('INVALID_FAUCET_RESPONSE','领取结果无法核实，请重新检查同一申请');
    rememberTestFundsClaim(address,claim);
    return claim;
  }
  async function inspectOperation(reference:OperationReference):Promise<ObservedOperation>{
    const queryVersion=++journalVersion;
    const observed=await inspectRecordedOperation(network,reference,fetchImpl);
    if(queryVersion===journalVersion){try{saveOperation(observed.reference);}catch{/* Read-only results remain usable when browser storage is unavailable. */}}
    return observed;
  }
  return {recentOperation,inspectOperation, requestTestFunds,testFundsStatus,listWallets: async () => wallets?.list().map(({id,name})=>({id,name})) ?? [], connectWallet, disconnectWallet: async () => { const previous=external;external=undefined;account=undefined;reset();previous?.disconnect(); }, onWalletChange: listener => {walletChanges.add(listener);return()=>{walletChanges.delete(listener);};}, createAccount: async () => { releaseExternal();account = localAccount(options.accountFactory?.() ?? privateKeyToAccount(generatePrivateKey())); reset(); return snapshot(); }, importAccount, refresh: snapshot, preview: previewTransfer, submit, status, cancel, revoke };
}
