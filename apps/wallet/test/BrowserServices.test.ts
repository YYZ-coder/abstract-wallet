import { test, expect } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { keccak256 } from 'viem';
import { createBrowserServices, type RuntimeNetwork } from '../src/browser-services';
import reference from './fixtures/selfpay-reference.json';
import { decodeAbiParameters, parseAbiParameters, recoverTypedDataAddress, parseTransaction, encodeAbiParameters,encodeEventTopics,parseAbi } from 'viem';
import { getUserOperationHash } from 'viem/account-abstraction';
import { createSiweMessage } from 'viem/siwe';
import { hashTypedData,toHex } from 'viem';

const account = privateKeyToAccount(`0x${'1'.padStart(64, '0')}`);
const network: RuntimeNetwork = { mode: 'local', chainId: 421614, rpcUrl: 'https://rpc.example', bundlerUrl: 'https://bundler.example', backendBaseUrl: 'https://api.example', entryPoint: null, delegate: null, paymaster: null, entryPointCodeHash: null, delegateCodeHash: null, paymasterCodeHash: null, sponsorSigner: null, manifestVersion: 'test-v1' };
test('creates a browser-held account and reads its actual chain balance without sending a private key', async () => {
  const outgoing: unknown[] = [];
  const rpc: typeof fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body)); outgoing.push(request);
    const results: Record<string, unknown> = { eth_chainId: '0x66eee', eth_getBalance: '0x470de4df820000', eth_getCode: '0x' };
    if (!(request.method in results)) throw new Error('Unexpected external RPC: '+request.method);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: results[request.method] }), { status: 200 });
  };
  const service = createBrowserServices(network, { fetch: rpc, accountFactory: () => account });
  expect(await service.createAccount()).toEqual({ address: '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf', balance: '0.02', delegation: 'undelegated' });
  expect(JSON.stringify(outgoing)).not.toContain('privateKey');
  expect(outgoing.length).toBeGreaterThan(0);
});

test('prepares a self pay transfer from verified deployment and quoted gas without broadcasting', async () => {
  const bytecode = '0x6001600055';
  const configured: RuntimeNetwork = { ...network, entryPoint: '0x00000000000000000000000000000000000000e1', delegate: '0x00000000000000000000000000000000000000d1', entryPointCodeHash: keccak256(bytecode), delegateCodeHash: keccak256(bytecode) };
  const requests: { method: string; params: any[] }[] = [];
  const rpc: typeof fetch = async (_url, init) => {
    const q = JSON.parse(String(init?.body)); requests.push(q);
    const results: Record<string, unknown> = { eth_chainId: '0x66eee', eth_getBalance: '0x470de4df820000', eth_getTransactionCount: '0x0', eth_gasPrice: '0x3b9aca00', eth_call: `0x${'00'.repeat(32)}`, eth_getBlockByNumber: { timestamp: '0x3e8', number: '0xa', hash: `0x${'ab'.repeat(32)}` }, eth_estimateUserOperationGas: { verificationGasLimit: '0x927c0', callGasLimit: '0x493e0', preVerificationGas: '0x186a0' } };
    const result = q.method === 'eth_getCode' ? q.params[0].toLowerCase() === account.address.toLowerCase() ? '0x' : bytecode : results[q.method];
    if (result === undefined) throw new Error('Unexpected external RPC '+q.method);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: q.id, result }), { status: 200 });
  };
  const service = createBrowserServices(configured, { fetch: rpc, accountFactory: () => account });
  await service.createAccount();
  await expect(service.preview({ recipient: '0x2222222222222222222222222222222222222222', amount: '0.001', sponsored: false })).resolves.toMatchObject({ recipient: '0x2222222222222222222222222222222222222222', amount: '0.001', maxCost: '0.002', payment: 'self' });
  expect(requests.some(q => ['eth_sendUserOperation', 'eth_sendRawTransaction'].includes(q.method))).toBe(false);
});

function selfPayHarness(overrides:Partial<RuntimeNetwork>={}) {
  const bytecode = '0x6001600055';
  const configured: RuntimeNetwork = { ...network, entryPoint: reference.input.entryPoint as `0x${string}`, delegate: reference.input.delegate as `0x${string}`, entryPointCodeHash: keccak256(bytecode), delegateCodeHash: keccak256(bytecode),...overrides };
  const requests: any[] = [];
  const state = { eoaNonce: '0x0', epNonce: `0x${'00'.repeat(32)}`, accountCode: '0x', now: '0x3e8', receipt: null as any,chainReceipt:null as any,nativeReceipt:null as any, canonicalHash: `0x${'ab'.repeat(32)}`, chain: '0x66eee' };
  const rpc: typeof fetch = async (url, init) => {
    const q = JSON.parse(String(init?.body)); requests.push({ ...q, url:String(url) });
    const results: Record<string, unknown> = { eth_chainId: state.chain, eth_getBalance:'0x470de4df820000',eth_getTransactionCount:state.eoaNonce,eth_gasPrice:'0x3b9aca00',eth_call:state.epNonce,eth_getBlockByNumber:{timestamp:state.now,number:'0xa',hash:state.canonicalHash},eth_estimateUserOperationGas:{verificationGasLimit:'0x927c0',callGasLimit:'0x493e0',preVerificationGas:'0x186a0'},eth_supportedEntryPoints:[configured.entryPoint],eth_sendUserOperation:reference.expectedUserOpHash,eth_getUserOperationReceipt:state.receipt };
    let result = q.method === 'eth_getCode' ? q.params[0]==='0x0000000000000000000000000000000000000000'?'0x':q.params[0].toLowerCase() === account.address.toLowerCase() ? state.accountCode : bytecode : results[q.method];
    if(q.method==='eth_estimateGas')result='0xb3b0';
    if(q.method==='eth_sendRawTransaction'){result=keccak256(q.params[0]);state.accountCode='0x';state.eoaNonce='0x2';state.nativeReceipt={transactionHash:result,status:'0x1',blockNumber:'0xa',blockHash:state.canonicalHash};}
    if(q.method==='eth_getTransactionReceipt')result=state.nativeReceipt?.transactionHash===q.params[0]?state.nativeReceipt:state.chainReceipt;
    if(q.method==='eth_sendUserOperation' && (q.params[0].callData!==reference.callData||q.params[0].paymaster)){ const op=q.params[0]; result=getUserOperationHash({chainId:421614,entryPointAddress:configured.entryPoint!,entryPointVersion:'0.9',userOperation:{sender:op.sender,nonce:BigInt(op.nonce),factory:'0x7702',factoryData:'0x',authorization:{address:configured.delegate!,chainId:421614,nonce:0,r:`0x${'00'.repeat(32)}`,s:`0x${'00'.repeat(32)}`,yParity:0},callData:op.callData,verificationGasLimit:BigInt(op.verificationGasLimit),callGasLimit:BigInt(op.callGasLimit),preVerificationGas:BigInt(op.preVerificationGas),maxPriorityFeePerGas:BigInt(op.maxPriorityFeePerGas),maxFeePerGas:BigInt(op.maxFeePerGas),...(op.paymaster?{paymaster:op.paymaster,paymasterData:op.paymasterData,paymasterVerificationGasLimit:BigInt(op.paymasterVerificationGasLimit),paymasterPostOpGasLimit:BigInt(op.paymasterPostOpGasLimit)}:{}),signature:'0x'}}); }
    if (result === undefined) throw new Error('Unexpected external RPC '+q.method);
    return new Response(JSON.stringify({ jsonrpc:'2.0',id:q.id,result }),{status:200});
  };
  return { configured, requests, state, rpc, service:createBrowserServices(configured,{fetch:rpc,accountFactory:()=>account}) };
}
function actualOperationReceipt(entryPoint:string,blockHash:string,success:boolean,hash=reference.expectedUserOpHash){
  const abi=parseAbi(['event UserOperationEvent(bytes32 indexed userOpHash,address indexed sender,address indexed paymaster,uint256 nonce,bool success,uint256 actualGasCost,uint256 actualGasUsed)']);
  return{transactionHash:`0x${'cd'.repeat(32)}`,to:entryPoint,status:'0x1',blockNumber:'0xa',blockHash,logs:[{address:entryPoint,topics:encodeEventTopics({abi,eventName:'UserOperationEvent',args:{userOpHash:hash as `0x${string}`,sender:account.address,paymaster:'0x0000000000000000000000000000000000000000'}}),data:encodeAbiParameters(parseAbiParameters('uint256,bool,uint256,uint256'),[0n,success,25n,250000n])}]};
}

test('signs and submits the frozen self pay preview with its independently known operation hash', async () => {
  const { service,requests } = selfPayHarness(); await service.createAccount();
  const preview = await service.preview({recipient:reference.input.recipient,amount:'0.001',sponsored:false});
  await expect(service.submit({...preview,amount:'0.002'})).rejects.toThrow('预览已失效');
  await expect(service.submit(preview)).resolves.toEqual({hash:reference.expectedUserOpHash,submission:'accepted',execution:'unknown',confirmation:'pending'});
  const sent = requests.find(q=>q.method==='eth_sendUserOperation');
  expect(sent.params[0].callData).toBe(reference.callData); expect(sent.params[0].nonce).toBe('0x0');
  expect(sent.params[0].eip7702Auth.address.toLowerCase()).toBe(reference.input.delegate);
  const [, ,after,until,signature] = decodeAbiParameters(parseAbiParameters('uint8,uint8,uint48,uint48,bytes'),sent.params[0].signature);
  expect([after,until]).toEqual([999,1600]);
  expect(await recoverTypedDataAddress({domain:{name:'AbstractWallet',version:'1',chainId:421614,verifyingContract:account.address},primaryType:'WalletOperation',types:{WalletOperation:[{name:'userOpHash',type:'bytes32'},{name:'validAfter',type:'uint48'},{name:'validUntil',type:'uint48'}]},message:{userOpHash:reference.expectedUserOpHash as `0x${string}`,validAfter:999,validUntil:1600},signature})).toBe(account.address);
  expect(JSON.stringify(requests)).not.toContain('privateKey');
});

test('shows canonical UserOperation failure separately from outer success and revokes confirmation on reorg', async () => {
  const {service,state,configured}=selfPayHarness(); await service.createAccount();
  const preview=await service.preview({recipient:reference.input.recipient,amount:'0.001',sponsored:false});
  const sent=await service.submit(preview);
  state.receipt={userOpHash:reference.expectedUserOpHash,entryPoint:configured.entryPoint,sender:account.address,nonce:'0x0',success:false,receipt:{transactionHash:`0x${'cd'.repeat(32)}`,status:'0x1',blockNumber:'0xa',blockHash:state.canonicalHash}};
  state.chainReceipt=actualOperationReceipt(configured.entryPoint!,state.canonicalHash,false);
  await expect(service.status(sent.hash)).resolves.toMatchObject({hash:sent.hash,submission:'accepted',execution:'reverted',confirmation:'confirmed'});
  state.canonicalHash=`0x${'ef'.repeat(32)}`;
  await expect(service.status(sent.hash)).resolves.toMatchObject({execution:'unknown',confirmation:'reorged'});
  state.receipt=null;
  await expect(service.status(sent.hash)).resolves.toMatchObject({execution:'unknown',confirmation:'pending'});
});

test('signs a fresh same nonce cancellation and refuses it once the nonce is consumed',async()=>{
  const {service,state,requests}=selfPayHarness(); await service.createAccount();
  const preview=await service.preview({recipient:reference.input.recipient,amount:'0.001',sponsored:false}); const original=await service.submit(preview);
  const pending=service.cancel(original.hash);
  await expect(pending).resolves.toMatchObject({submission:'accepted',execution:'unknown',confirmation:'pending'});
  const cancelled=await pending;
  expect(cancelled).toMatchObject({submission:'accepted',execution:'unknown',confirmation:'pending'});
  expect(cancelled.hash).not.toBe(original.hash);
  const sent=requests.filter(q=>q.method==='eth_sendUserOperation');
  const calls=decodeAbiParameters(parseAbiParameters('(address target,uint256 value,bytes data)[]'),`0x${sent[1].params[0].callData.slice(10)}`)[0];
  expect(calls).toEqual([{target:account.address,value:0n,data:'0x'}]);
  expect(sent[1].params[0].nonce).toBe('0x0'); expect(BigInt(sent[1].params[0].maxFeePerGas)).toBeGreaterThan(2000000000n);
  state.epNonce=`0x${'0'.repeat(63)}1`;
  await expect(service.cancel(original.hash)).rejects.toThrow('nonce');
});
test('imports an existing root only in browser memory and invalidates the previous account preview',async()=>{
  const {service,requests}=selfPayHarness(); await service.createAccount();
  const preview=await service.preview({recipient:reference.input.recipient,amount:'0.001',sponsored:false});
  expect(typeof service.importAccount).toBe('function');
  const key=`0x${'6'.padStart(64,'0')}`;
  const imported=await service.importAccount!(key);
  expect(imported.address).toBe(privateKeyToAccount(key as `0x${string}`).address);
  await expect(service.submit(preview)).rejects.toThrow('预览已失效');
  expect(JSON.stringify(requests)).not.toContain(key);
  expect(requests.some(q=>q.method==='eth_sendUserOperation')).toBe(false);
});

test('revokes through a root signed native type4 transaction with N plus one authorization and verified code readback',async()=>{
  const {service,state,requests,configured}=selfPayHarness({entryPoint:null,entryPointCodeHash:null}); await service.createAccount();
  state.accountCode=`0xef0100${configured.delegate!.slice(2)}`;
  const pending=service.revoke(); await expect(pending).resolves.toMatchObject({confirmed:true}); const result=await pending;
  const raw=requests.find(q=>q.method==='eth_sendRawTransaction').params[0]; const tx=parseTransaction(raw);
  if(tx.type!=='eip7702')throw new Error('Expected a real type4 transaction');
  expect(raw.startsWith('0x04')).toBe(true);expect(tx.nonce).toBe(0);expect(tx.authorizationList?.[0].nonce).toBe(1);
  expect(tx.to).toBe('0x0000000000000000000000000000000000000000');expect(tx.authorizationList?.[0].address).toBe(tx.to);
  expect(result.transactionHash).toBe(keccak256(raw));expect(requests.some(q=>q.method==='eth_sendUserOperation')).toBe(false);
});
test('refuses a caller mutation of the actual returned preview object',async()=>{
  const {service,requests}=selfPayHarness();await service.createAccount();
  const preview=await service.preview({recipient:reference.input.recipient,amount:'0.001',sponsored:false});
  preview.amount='0.002';
  await expect(service.submit(preview)).rejects.toThrow('预览已失效');
  expect(requests.some(q=>q.method==='eth_sendUserOperation')).toBe(false);
});
test('does not accept a bundler fabricated result without the exact RPC EntryPoint event',async()=>{
  const {service,state,configured}=selfPayHarness();await service.createAccount();const preview=await service.preview({recipient:reference.input.recipient,amount:'0.001',sponsored:false});const sent=await service.submit(preview);
  state.receipt={userOpHash:sent.hash,entryPoint:configured.entryPoint,sender:account.address,nonce:'0x0',success:true,receipt:{transactionHash:`0x${'cd'.repeat(32)}`,status:'0x1',blockNumber:'0xa',blockHash:state.canonicalHash}};
  state.chainReceipt={...actualOperationReceipt(configured.entryPoint!,state.canonicalHash,true),logs:[]};
  await expect(service.status(sent.hash)).resolves.toMatchObject({execution:'unknown',confirmation:'pending'});
  state.chainReceipt=actualOperationReceipt(configured.entryPoint!,state.canonicalHash,true,`0x${'ff'.repeat(32)}`);
  await expect(service.status(sent.hash)).resolves.toMatchObject({execution:'unknown',confirmation:'pending'});
  state.chainReceipt=actualOperationReceipt(configured.entryPoint!,state.canonicalHash,false);
  await expect(service.status(sent.hash)).resolves.toMatchObject({execution:'reverted',confirmation:'confirmed'});
});

async function sponsoredHarness(options:{holdQuote?:Promise<void>;onQuote?:()=>void;holdGas?:Promise<void>;onGas?:()=>void}={}){
  const base=selfPayHarness();const sponsor=privateKeyToAccount(`0x${'2'.padStart(64,'0')}`);const pm='0x00000000000000000000000000000000000000a1';
  const configured:RuntimeNetwork={...base.configured,paymaster:pm,paymasterCodeHash:keccak256('0x6001600055'),sponsorSigner:sponsor.address};
  const http:any[]=[];let deny=false;let frozen:any;let registrationFails=false;
  const now=BigInt(Math.floor(Date.now()/1000));const nonce='FixedChallengeNonce123456';
  const message=createSiweMessage({domain:'wallet.local',address:account.address,uri:'https://wallet.local',version:'1',chainId:421614,nonce,issuedAt:new Date(Number(now)*1000),expirationTime:new Date(Number(now+300n)*1000)});
  const types={Permit:([['version','uint8'],['expectedDelegate','address'],['sender','address'],['entryPoint','address'],['nonce','uint256'],['initCodeHash','bytes32'],['callDataHash','bytes32'],['accountGasLimits','bytes32'],['preVerificationGas','uint256'],['gasFees','bytes32'],['paymasterVerificationGasLimit','uint128'],['paymasterPostOpGasLimit','uint128'],['validAfter','uint48'],['validUntil','uint48'],['maxCost','uint256'],['reservationId','bytes32']] as const).map(([name,type])=>({name,type}))};
  const fetcher:typeof fetch=async(url,init)=>{
    const body=JSON.parse(String(init?.body));
    if(String(url).startsWith(network.backendBaseUrl)){
      const path=String(url).slice(network.backendBaseUrl.length);http.push({path,body,headers:init?.headers});
      if(deny)return new Response(JSON.stringify({error:{code:'SPONSORSHIP_DENIED',message:'not eligible'}}),{status:403});
      if(path==='/v1/auth/challenges')return new Response(JSON.stringify({schemaVersion:'1',challengeId:'challenge-1',projectId:'project-1',chainId:'421614',account:account.address.toLowerCase(),signatureScheme:'root-eip191-65',domain:'wallet.local',uri:'https://wallet.local',nonce,issuedAt:String(now),expiresAt:String(now+300n),message}));
      if(path==='/v1/auth/sessions')return new Response(JSON.stringify({schemaVersion:'1',chainId:'421614',account:account.address.toLowerCase(),projectId:'project-1',tokenType:'Bearer',accessToken:'s'.repeat(64),issuedAt:String(now),expiresAt:String(now+300n),scopes:['sponsorship']}));
      if(path==='/v1/sponsorships/prepare'){
        frozen=body;const data=encodeAbiParameters(parseAbiParameters('uint8,address,uint48,uint48,uint256,bytes32,bytes'),[1,configured.delegate!,Number(body.accountWindow.validAfter),Number(body.accountWindow.validUntil),BigInt(body.maxCost),`0x${'ab'.repeat(32)}`,`0x${'00'.repeat(65)}`]);
        options.onQuote?.();await options.holdQuote;
        return new Response(JSON.stringify({schemaVersion:'1',quoteId:'quote-1',chainId:'421614',account:account.address.toLowerCase(),manifestVersion:configured.manifestVersion,serverTime:String(now),quoteExpiresAt:String(now+60n),maxCost:body.maxCost,paymaster:pm,paymasterVerificationGasLimit:'200000',paymasterPostOpGasLimit:'0',stubPaymasterData:data,stubIsExecutable:false}));
      }
      if(path==='/v1/sponsorships'){
        const op=body.unsignedUserOperation;const m={version:1,expectedDelegate:configured.delegate!,sender:account.address,entryPoint:configured.entryPoint!,nonce:BigInt(op.nonce),initCodeHash:keccak256('0x7702000000000000000000000000000000000000'),callDataHash:keccak256(op.callData),accountGasLimits:toHex((BigInt(op.verificationGasLimit)<<128n)|BigInt(op.callGasLimit),{size:32}),preVerificationGas:BigInt(op.preVerificationGas),gasFees:toHex((BigInt(op.maxPriorityFeePerGas)<<128n)|BigInt(op.maxFeePerGas),{size:32}),paymasterVerificationGasLimit:BigInt(op.paymasterVerificationGasLimit),paymasterPostOpGasLimit:BigInt(op.paymasterPostOpGasLimit),validAfter:Number(body.accountWindow.validAfter),validUntil:Number(body.accountWindow.validUntil),maxCost:BigInt(body.maxCost),reservationId:`0x${'ab'.repeat(32)}` as `0x${string}`};
        const typed={domain:{name:'AbstractWalletPaymaster',version:'1',chainId:421614,verifyingContract:pm as `0x${string}`},primaryType:'Permit' as const,types,message:m};const sig=await sponsor.signTypedData(typed);
        const data=encodeAbiParameters(parseAbiParameters('uint8,address,uint48,uint48,uint256,bytes32,bytes'),[1,configured.delegate!,m.validAfter,m.validUntil,m.maxCost,m.reservationId,sig]);
        return new Response(JSON.stringify({state:'issued',permit:{permitVersion:'1',chainId:'421614',entryPoint:configured.entryPoint,sender:account.address.toLowerCase(),expectedDelegate:configured.delegate,nonce:op.nonce,accountWindow:body.accountWindow,maxCost:body.maxCost,chainReservationId:m.reservationId,paymaster:pm,paymasterVerificationGasLimit:op.paymasterVerificationGasLimit,paymasterPostOpGasLimit:op.paymasterPostOpGasLimit,paymasterData:data,permitDigest:hashTypedData(typed),sponsorSignature:sig}}));
      }
      if(path==='/v1/operations')return new Response(JSON.stringify(registrationFails?{error:{code:'SERVICE_UNAVAILABLE',message:'registration unavailable'}}:{submissionState:'unknown'}),{status:registrationFails?503:201});
      throw new Error('Unexpected backend route '+path);
    }
    if(body.method==='eth_call'&&body.params[0].to.toLowerCase()===pm)return new Response(JSON.stringify({jsonrpc:'2.0',id:body.id,result:encodeAbiParameters(parseAbiParameters('address'),[sponsor.address])}));
    if(body.method==='eth_gasPrice'){options.onGas?.();await options.holdGas;}
    return base.rpc(url,init);
  };
  const service=createBrowserServices(configured,{fetch:fetcher,accountFactory:()=>account});await service.createAccount();
  return{service,base,http,getFrozen:()=>frozen,deny:()=>{deny=true;},failRegistration:()=>{registrationFails=true;}};
}
test('previews sponsorship through a scoped root session gas quote and independently signed exact permit without self pay fallback',async()=>{
  const{service,base,http,getFrozen,deny}=await sponsoredHarness();
  await expect(service.preview({recipient:reference.input.recipient,amount:'0.001',sponsored:true})).resolves.toMatchObject({payment:'sponsored',maxCost:'0.0024'});
  expect(http.map(q=>q.path)).toEqual(['/v1/auth/challenges','/v1/auth/sessions','/v1/sponsorships/prepare','/v1/sponsorships']);
  expect(getFrozen().unsignedUserOperation.nonce).toBe('0');expect(getFrozen().unsignedUserOperation.maxFeePerGas).toBe('2000000000');expect(getFrozen().authorizationContext.eip7702Auth).toBeNull();
  expect(base.requests.some(q=>q.method==='eth_sendUserOperation')).toBe(false);
  deny();
  await expect(service.preview({recipient:reference.input.recipient,amount:'0.001',sponsored:true})).rejects.toThrow();
  expect(base.requests.some(q=>q.method==='eth_sendUserOperation')).toBe(false);
});
test('does not attribute another native transaction receipt to the signed revocation',async()=>{
  const base=selfPayHarness();
  const fetcher:typeof fetch=async(url,init)=>{const result=await base.rpc(url,init);const q=JSON.parse(String(init?.body));if(q.method!=='eth_getTransactionReceipt')return result;const body=await result.json();if(body.result)body.result.transactionHash=`0x${'ff'.repeat(32)}`;return new Response(JSON.stringify(body));};
  const service=createBrowserServices(base.configured,{fetch:fetcher,accountFactory:()=>account});await service.createAccount();base.state.accountCode=`0xef0100${base.configured.delegate!.slice(2)}`;
  await expect(service.revoke()).resolves.toMatchObject({confirmed:false});
});

test('registers a sponsored submission best effort without overriding acceptance or rebroadcasting on HTTP failure',async()=>{
  const{service,base,http,failRegistration}=await sponsoredHarness();failRegistration();
  const preview=await service.preview({recipient:reference.input.recipient,amount:'0.001',sponsored:true});
  const result=await service.submit(preview);
  expect(result.submission).toBe('accepted');
  const registered=http.find(q=>q.path==='/v1/operations');expect(registered).toBeDefined();
  expect(registered.body).toMatchObject({schemaVersion:'1',manifestVersion:'test-v1',chainId:'421614',entryPoint:reference.input.entryPoint,account:account.address.toLowerCase(),userOpHash:result.hash,nonce:'0',expectedDelegate:reference.input.delegate,reportedTransactionHash:null});
  expect(registered.body.attempts[0]).toMatchObject({reportedResult:'accepted',reportedTransactionHash:null});
  expect(base.requests.filter(q=>q.method==='eth_sendUserOperation').length).toBe(1);
});
test('does not reserve a sponsorship after disconnect while a quote is pending',async()=>{
  let release!:()=>void,quoted!:()=>void;const holdQuote=new Promise<void>(r=>release=r),quoteReady=new Promise<void>(r=>quoted=r);
  const{service,http}=await sponsoredHarness({holdQuote,onQuote:quoted});const pending=service.preview({recipient:reference.input.recipient,amount:'0.001',sponsored:true});pending.catch(()=>{});await quoteReady;await service.disconnectWallet!();release();
  const error=await pending.then(()=>undefined,error=>error);expect(http.some(q=>q.path==='/v1/sponsorships')).toBe(false);expect(error).toBeInstanceOf(Error);
});
test('does not use a newly imported account for an old sponsorship preparation',async()=>{
  let release!:()=>void,priced!:()=>void;const holdGas=new Promise<void>(r=>release=r),gasReady=new Promise<void>(r=>priced=r);
  const{service,http}=await sponsoredHarness({holdGas,onGas:priced});const pending=service.preview({recipient:reference.input.recipient,amount:'0.001',sponsored:true});pending.catch(()=>{});await gasReady;await service.importAccount!(`0x${'6'.padStart(64,'0')}`);release();
  const error=await pending.then(()=>undefined,error=>error);expect(http).toEqual([]);expect(error).toBeInstanceOf(Error);
});
