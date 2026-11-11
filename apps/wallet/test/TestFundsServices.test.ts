import { expect, test, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { createBrowserServices, type RuntimeNetwork } from '../src/browser-services';
import type { WalletHost, WalletProvider } from '../src/external-wallet';

const root=privateKeyToAccount(`0x${'1'.padStart(64,'0')}`);
const network:RuntimeNetwork={mode:'local',chainId:421614,rpcUrl:'https://rpc.example',bundlerUrl:'https://bundler.example',backendBaseUrl:'https://api.example',entryPoint:null,delegate:null,paymaster:null,entryPointCodeHash:null,delegateCodeHash:null,paymasterCodeHash:null,sponsorSigner:null,manifestVersion:'test-v1'};
const claimId='1'.repeat(32),txHash=`0x${'ab'.repeat(32)}`;
const responseClaim=(overrides:Record<string,unknown>={})=>({schemaVersion:'1',requestId:'request-1',claimId,chainId:'421614',address:root.address.toLowerCase(),amountWei:'1000000000000000',status:'submitted',transactionHash:txHash,...overrides});
function harness(walletHost?:WalletHost){
  const http:{url:string;method:string;body:any}[]=[];const state:{chain:string;reply:unknown;rawReply?:string;responseStatus:number;networkFailure:boolean;rpcFailure?:boolean;beforeReply?:()=>Promise<void>;hang?:'fetch'|'body';onHang?:()=>void;aborted?:boolean}={chain:'0x66eee',reply:responseClaim(),responseStatus:202,networkFailure:false};
  const fetcher:typeof fetch=async(url,init)=>{
    if(String(url).startsWith(network.backendBaseUrl)){
      http.push({url:String(url),method:init?.method??'GET',body:init?.body?JSON.parse(String(init.body)):undefined});
      if(state.networkFailure)throw new Error('connection lost after request');
      if(state.hang==='fetch')return new Promise<Response>((_resolve,reject)=>{init?.signal?.addEventListener('abort',()=>{state.aborted=true;reject(new DOMException('Aborted','AbortError'));},{once:true});state.onHang?.();});
      if(state.hang==='body')return new Response(new ReadableStream({start(controller){init?.signal?.addEventListener('abort',()=>{state.aborted=true;controller.error(new DOMException('Aborted','AbortError'));},{once:true});state.onHang?.();}}),{status:200});
      const body=state.rawReply??JSON.stringify(state.reply);await state.beforeReply?.();return new Response(body,{status:state.responseStatus});
    }
    if(state.rpcFailure)throw new Error('private RPC outage');
    const q=JSON.parse(String(init?.body));const results:Record<string,unknown>={eth_chainId:state.chain,eth_getBalance:'0x0',eth_getCode:'0x'};
    if(!(q.method in results))throw new Error('Unexpected read-only RPC '+q.method);
    return new Response(JSON.stringify({jsonrpc:'2.0',id:q.id,result:results[q.method]}));
  };
  return{service:createBrowserServices(network,{fetch:fetcher,accountFactory:()=>root,walletHost}),http,state};
}

test('requests fixed test funds for the current original address without asking for a wallet signature',async()=>{
  const{service,http}=harness();await service.createAccount();
  await expect(service.requestTestFunds!()).resolves.toEqual({claimId,chainId:'421614',address:root.address.toLowerCase(),amountWei:'1000000000000000',status:'submitted',transactionHash:txHash});
  expect(http[0].url).toBe('https://api.example/v1/test-funds/claims');expect(http[0].method).toBe('POST');
  expect(http[0].body).toMatchObject({schemaVersion:'1',chainId:'421614',address:root.address.toLowerCase(),idempotencyKey:expect.stringMatching(/^[A-Za-z0-9_-]{16,128}$/)});
  expect(Object.keys(http[0].body).sort()).toEqual(['address','chainId','idempotencyKey','schemaVersion']);
});
test('retries an ambiguous request with exactly the same idempotency key',async()=>{
  const{service,http,state}=harness();await service.createAccount();state.networkFailure=true;
  await expect(service.requestTestFunds!()).rejects.toThrow();state.networkFailure=false;
  await expect(service.requestTestFunds!()).resolves.toMatchObject({claimId});
  expect(http).toHaveLength(2);expect(http[1].body.idempotencyKey).toBe(http[0].body.idempotencyKey);
});

test('checks the existing claim instead of requesting a second transfer',async()=>{
  const{service,http,state}=harness();await service.createAccount();
  await service.requestTestFunds!();state.reply=responseClaim({status:'confirmed'});state.responseStatus=200;
  await expect(service.requestTestFunds!()).resolves.toMatchObject({claimId,status:'confirmed'});
  expect(http.map(({method,url})=>({method,url}))).toEqual([
    {method:'POST',url:'https://api.example/v1/test-funds/claims'},
    {method:'GET',url:`https://api.example/v1/test-funds/claims/${claimId}`}
  ]);
  state.reply=responseClaim({status:'unknown',transactionHash:undefined});
  await expect(service.testFundsStatus!(claimId)).resolves.toMatchObject({claimId,status:'unknown'});
});

test('allows a fresh daily claim only after a full 24 hours from the observed confirmed claim',async()=>{
  vi.useFakeTimers();
  try{
    const start=Date.parse('2026-11-11T00:00:00Z');vi.setSystemTime(start);
    const{service,http,state}=harness();await service.createAccount();state.reply=responseClaim({status:'confirmed'});
    await service.requestTestFunds!();const firstKey=http[0].body.idempotencyKey;
    vi.setSystemTime(start+86_399_999);await service.requestTestFunds!();
    expect(http.at(-1)?.method).toBe('GET');
    vi.setSystemTime(start+86_400_000);state.reply=responseClaim({status:'confirmed',claimId:'2'.repeat(32)});
    await expect(service.requestTestFunds!()).resolves.toMatchObject({claimId:'2'.repeat(32)});
    expect(http.at(-1)?.method).toBe('POST');
    expect(http.at(-1)?.body.idempotencyKey).not.toBe(firstKey);
  }finally{vi.useRealTimers();}
});
test.each(['pending','submitted','unknown'])('keeps a %s claim identity after two days instead of starting another transfer',async status=>{
  vi.useFakeTimers();
  try{
    const start=Date.parse('2026-11-11T00:00:00Z');vi.setSystemTime(start);
    const{service,http,state}=harness();await service.createAccount();state.reply=responseClaim({status});
    await service.requestTestFunds!();vi.setSystemTime(start+172_800_000);
    await expect(service.requestTestFunds!()).resolves.toMatchObject({claimId,status});
    expect(http.at(-1)?.method).toBe('GET');
  }finally{vi.useRealTimers();}
});
test('keeps querying the original claim after a previously confirmed transfer becomes uncertain',async()=>{
  vi.useFakeTimers();
  try{
    const start=Date.parse('2026-11-11T00:00:00Z');vi.setSystemTime(start);
    const{service,http,state}=harness();await service.createAccount();state.reply=responseClaim({status:'confirmed'});
    await service.requestTestFunds!();state.reply=responseClaim({status:'unknown'});await service.testFundsStatus!(claimId);
    vi.setSystemTime(start+172_800_000);await expect(service.requestTestFunds!()).resolves.toMatchObject({claimId,status:'unknown'});
    expect(http.at(-1)?.method).toBe('GET');
  }finally{vi.useRealTimers();}
});

test.each([
  ['wrong schema',{schemaVersion:'2'}],['missing request identifier',{requestId:undefined}],
  ['wrong chain',{chainId:'1'}],['numeric chain',{chainId:421614}],
  ['another recipient',{address:`0x${'22'.repeat(20)}`}],['invalid address',{address:'wallet'}],
  ['wrong amount',{amountWei:'1000000000000001'}],['numeric amount',{amountWei:1000000000000000}],
  ['invalid claim identifier',{claimId:'../claims'}],['unknown status',{status:'complete'}],
  ['submitted without transaction',{transactionHash:undefined}],['confirmed without transaction',{status:'confirmed',transactionHash:undefined}],
  ['invalid transaction hash',{transactionHash:'0x1234'}],['failed without a reason',{status:'failed',failureCode:undefined}],
  ['success carrying a failure',{status:'confirmed',failureCode:'FAUCET_TRANSFER_FAILED'}]
])('rejects a successful HTTP response with %s',async(_label,overrides)=>{
  const{service,state}=harness();await service.createAccount();state.reply=responseClaim(overrides);
  await expect(service.requestTestFunds!()).rejects.toMatchObject({code:'INVALID_FAUCET_RESPONSE'});
});

test('queries only the current address claim and rejects replacement claim responses',async()=>{
  const{service,http,state}=harness();await service.createAccount();
  await expect(service.testFundsStatus!('../other')).rejects.toMatchObject({code:'INVALID_FAUCET_CLAIM'});
  await expect(service.testFundsStatus!('2'.repeat(32))).rejects.toMatchObject({code:'INVALID_FAUCET_CLAIM'});
  expect(http).toHaveLength(0);
  await service.requestTestFunds!();state.reply=responseClaim({claimId:'2'.repeat(32)});
  await expect(service.testFundsStatus!(claimId)).rejects.toMatchObject({code:'INVALID_FAUCET_RESPONSE'});
  state.reply=responseClaim({address:`0x${'22'.repeat(20)}`});
  await expect(service.testFundsStatus!(claimId)).rejects.toMatchObject({code:'INVALID_FAUCET_RESPONSE'});
});

test.each([
  ['FAUCET_UNAVAILABLE','领取服务暂未开启，请稍后重试'],
  ['FAUCET_EMPTY','测试币池余额不足，请稍后重试'],
  ['FAUCET_COOLDOWN','此地址 24 小时内已领取，请稍后再试'],
  ['FAUCET_BUDGET_EXCEEDED','今日测试币额度已用完，请明天再试'],
  ['UPSTREAM_UNAVAILABLE','网络暂时不可用，请重试同一领取申请'],
  ['RESOURCE_NOT_FOUND','未找到此领取申请，请重新检查当前账户'],
])('preserves %s with an actionable message on both claim and status requests',async(code,message)=>{
  const{service,state}=harness();await service.createAccount();state.responseStatus=503;state.reply={error:{code,message:'private upstream details'}};
  await expect(service.requestTestFunds!()).rejects.toMatchObject({code,message});
  state.responseStatus=202;state.reply=responseClaim();await service.requestTestFunds!();
  state.responseStatus=503;state.reply={error:{code,message:'private upstream details'}};
  await expect(service.testFundsStatus!(claimId)).rejects.toMatchObject({code,message});
});
test('reports an ambiguous network failure without losing its retry identity',async()=>{
  const{service,state}=harness();await service.createAccount();state.networkFailure=true;
  await expect(service.requestTestFunds!()).rejects.toMatchObject({code:'UPSTREAM_UNAVAILABLE',message:'网络暂时不可用，请重试同一领取申请'});
});

test('requires a current account and the live Arbitrum Sepolia chain before contacting the faucet',async()=>{
  const{service,state,http}=harness();
  await expect(service.requestTestFunds!()).rejects.toMatchObject({code:'WALLET_NOT_CONNECTED'});
  await expect(service.testFundsStatus!(claimId)).rejects.toMatchObject({code:'WALLET_NOT_CONNECTED'});
  expect(http).toHaveLength(0);await service.createAccount();state.chain='0x1';
  await expect(service.requestTestFunds!()).rejects.toMatchObject({code:'UNSUPPORTED_CHAIN'});
  expect(http).toHaveLength(0);state.chain='0x66eee';await service.requestTestFunds!();state.chain='0x1';
  await expect(service.testFundsStatus!(claimId)).rejects.toMatchObject({code:'UNSUPPORTED_CHAIN'});
  expect(http).toHaveLength(1);
});

test.each(['request','status'] as const)('rejects a delayed %s result after switching to another account',async(method)=>{
  const{service,state}=harness();await service.createAccount();if(method==='status')await service.requestTestFunds!();
  let release!:()=>void,start!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{start=resolve;});
  state.beforeReply=async()=>{start();await gate;};
  const pending=method==='request'?service.requestTestFunds!():service.testFundsStatus!(claimId);await started;
  await service.importAccount!(`0x${'2'.padStart(64,'0')}`);release();
  await expect(pending).rejects.toMatchObject({code:'WALLET_CONTEXT_CHANGED'});
});
test.each(['request','status'] as const)('rejects a delayed %s result after the RPC chain changes',async(method)=>{
  const{service,state}=harness();await service.createAccount();if(method==='status')await service.requestTestFunds!();
  let release!:()=>void,start!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{start=resolve;});
  state.beforeReply=async()=>{start();await gate;};
  const pending=method==='request'?service.requestTestFunds!():service.testFundsStatus!(claimId);await started;
  state.chain='0x1';release();await expect(pending).rejects.toMatchObject({code:'UNSUPPORTED_CHAIN'});
});

test.each([[200,'INVALID_FAUCET_RESPONSE'],[502,'FAUCET_UNAVAILABLE']] as const)('handles a non-JSON HTTP %s response without exposing upstream text',async(status,code)=>{
  const{service,state}=harness();await service.createAccount();state.responseStatus=status;state.rawReply='<html>private upstream details</html>';
  const error=await service.requestTestFunds!().catch(error=>error);
  expect(error).toMatchObject({code});expect(error.message).not.toContain('private upstream');
});

test.each(['pending','unknown','failed'] as const)('keeps the backend %s state without inventing a confirmed transfer',async(status)=>{
  const{service,state}=harness();await service.createAccount();state.reply=responseClaim({address:root.address,status,transactionHash:undefined,...(status==='failed'?{failureCode:'FAUCET_TRANSFER_FAILED'}:{})});
  await expect(service.requestTestFunds!()).resolves.toEqual({claimId,chainId:'421614',address:root.address.toLowerCase(),amountWei:'1000000000000000',status,...(status==='failed'?{failureCode:'FAUCET_TRANSFER_FAILED'}:{})});
});
test('isolates ambiguous retry keys by address and retains the original key after reconnecting',async()=>{
  const{service,state,http}=harness();await service.createAccount();state.networkFailure=true;await expect(service.requestTestFunds!()).rejects.toThrow();
  const firstKey=http[0].body.idempotencyKey;
  const second=await service.importAccount!(`0x${'2'.padStart(64,'0')}`);state.networkFailure=false;state.reply=responseClaim({address:second.address});
  await expect(service.requestTestFunds!()).resolves.toMatchObject({address:second.address.toLowerCase()});expect(http[1].body.idempotencyKey).not.toBe(firstKey);
  await expect(service.testFundsStatus!('2'.repeat(32))).rejects.toMatchObject({code:'INVALID_FAUCET_CLAIM'});
  await service.importAccount!(`0x${'1'.padStart(64,'0')}`);state.reply=responseClaim();await service.requestTestFunds!();
  expect(http[2].body).toMatchObject({address:root.address.toLowerCase(),idempotencyKey:firstKey});
});
test('funds an existing wallet without signing and invalidates a delayed response on wallet events',async()=>{
  const methods:string[]=[],events=new Map<string,Set<(...args:any[])=>void>>();
  const provider:WalletProvider={request:async({method})=>{methods.push(method);if(method==='eth_chainId')return'0x66eee';if(['eth_requestAccounts','eth_accounts'].includes(method))return[root.address];throw new Error('Unexpected wallet signature or broadcast request');},on(event,listener){const handlers=events.get(event)??new Set();handlers.add(listener);events.set(event,handlers);},removeListener(event,listener){events.get(event)?.delete(listener);}};
  const host=Object.assign(new EventTarget(),{ethereum:provider}) as WalletHost;
  const{service,state}=harness(host);const choices=await service.listWallets!();await service.connectWallet!(choices[0].id);
  await expect(service.requestTestFunds!()).resolves.toMatchObject({address:root.address.toLowerCase(),status:'submitted'});
  expect(methods.some(method=>method.includes('sign')||method.includes('send'))).toBe(false);
  let release!:()=>void,start!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{start=resolve;});
  state.beforeReply=async()=>{start();await gate;};const pending=service.testFundsStatus!(claimId);await started;
  for(const listener of events.get('chainChanged')??[])listener('0x1');release();
  await expect(pending).rejects.toMatchObject({code:'WALLET_CONTEXT_CHANGED'});
});

test.each(['before','after'] as const)('fails closed when the live chain cannot be verified %s the funding request',async(phase)=>{
  const{service,state,http}=harness();await service.createAccount();
  if(phase==='before')state.rpcFailure=true;else state.beforeReply=async()=>{state.rpcFailure=true;};
  await expect(service.requestTestFunds!()).rejects.toMatchObject({code:'UPSTREAM_UNAVAILABLE',message:'网络暂时不可用，请重试同一领取申请'});
  expect(http).toHaveLength(phase==='before'?0:1);
});

test.each(['fetch','body'] as const)('cancels a stalled %s at fifteen seconds and retries the same funding identity',async(phase)=>{
  vi.useFakeTimers();
  try{
    const{service,state,http}=harness();await service.createAccount();state.hang=phase;
    let start!:()=>void;const started=new Promise<void>(resolve=>{start=resolve;});state.onHang=start;
    let outcome:unknown,settled=false;
    const pending=service.requestTestFunds!().then(value=>{outcome=value;settled=true;},error=>{outcome=error;settled=true;});
    await started;await vi.advanceTimersByTimeAsync(14_999);expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);expect(settled).toBe(true);await pending;
    expect(outcome).toMatchObject({code:'UPSTREAM_UNAVAILABLE',message:'网络暂时不可用，请重试同一领取申请'});expect(state.aborted).toBe(true);
    state.hang=undefined;await expect(service.requestTestFunds!()).resolves.toMatchObject({claimId});
    expect(http[1].body.idempotencyKey).toBe(http[0].body.idempotencyKey);
  }finally{vi.useRealTimers();}
});
