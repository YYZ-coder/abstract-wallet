import { expect, test, vi } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, parseAbi, parseAbiParameters } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createBrowserServices, type RuntimeNetwork } from '../src/browser-services';
import type { OperationReference } from '../src/services';
import fixture from './fixtures/selfpay-reference.json';

const account=privateKeyToAccount(`0x${'1'.padStart(64,'0')}`);
const reference:OperationReference={chainId:'421614',address:account.address,hash:fixture.expectedUserOpHash};
const txHash=`0x${'ab'.repeat(32)}`,blockHash=`0x${'cd'.repeat(32)}`;
// Fixed bytecode hash: viem 2.57.17 reference, computed separately before this test.
const code='0x6001600055',codeHash='0x7efcce47028dabcb0d42f3a7eda8820bf6f7f4e618398c2547d52f703cafb073';
const network:RuntimeNetwork={mode:'arbitrum-sepolia',chainId:421614,rpcUrl:'https://rpc.example',bundlerUrl:'https://bundler.example',backendBaseUrl:'https://api.example',entryPoint:fixture.input.entryPoint as `0x${string}`,delegate:fixture.input.delegate as `0x${string}`,paymaster:null,entryPointCodeHash:codeHash,delegateCodeHash:codeHash,paymasterCodeHash:null,sponsorSigner:null,manifestVersion:'test-v1'};
const eventAbi=parseAbi(['event UserOperationEvent(bytes32 indexed userOpHash,address indexed sender,address indexed paymaster,uint256 nonce,bool success,uint256 actualGasCost,uint256 actualGasUsed)']);
function harness(storage?:Pick<Storage,'getItem'|'setItem'>){
  const requests:any[]=[];
  let savedAtBroadcast:unknown;
  const state={chain:'0x66eee',hint:{receipt:{transactionHash:txHash}} as any,canonical:blockHash,head:'0xa',code:`0xef0100${network.delegate!.slice(2)}`,balance:'0x470de4df820000',receipt:{transactionHash:txHash,to:network.entryPoint,status:'0x1',blockHash,blockNumber:'0xa',logs:[{address:network.entryPoint,topics:encodeEventTopics({abi:eventAbi,eventName:'UserOperationEvent',args:{userOpHash:reference.hash as `0x${string}`,sender:account.address,paymaster:'0x0000000000000000000000000000000000000000'}}),data:encodeAbiParameters(parseAbiParameters('uint256,bool,uint256,uint256'),[0n,true,25n,250000n])}]} as any};
  const fetcher:typeof fetch=async(url,init)=>{
    const q=JSON.parse(String(init?.body));requests.push({...q,url:String(url)});
    if(q.method==='eth_sendUserOperation')savedAtBroadcast=JSON.parse(storage?.getItem('abstract-wallet:recent-operation:v1:421614')??'null');
    const results:Record<string,unknown>={eth_chainId:state.chain,eth_getBalance:state.balance,eth_getTransactionCount:'0x0',eth_gasPrice:'0x3b9aca00',eth_call:`0x${'00'.repeat(32)}`,eth_getBlockByNumber:{timestamp:'0x3e8',number:state.head,hash:state.canonical},eth_estimateUserOperationGas:{verificationGasLimit:'0x927c0',callGasLimit:'0x493e0',preVerificationGas:'0x186a0'},eth_supportedEntryPoints:[network.entryPoint],eth_sendUserOperation:fixture.expectedUserOpHash,eth_getUserOperationReceipt:state.hint,eth_getTransactionReceipt:state.receipt};
    const value=q.method==='eth_getCode'?(q.params[0].toLowerCase()===account.address.toLowerCase()?state.code:code):results[q.method];
    if(value===undefined)throw new Error('Unexpected RPC '+q.method);
    return new Response(JSON.stringify({jsonrpc:'2.0',id:q.id,result:value}));
  };
  return {state,requests,fetcher,savedAtBroadcast:()=>savedAtBroadcast,service:createBrowserServices(network,{fetch:fetcher,accountFactory:()=>account,storage})};
}

test('inspects the original operation without a signing session using independently verified chain events',async()=>{
  const {service,requests}=harness();
  await expect(service.inspectOperation!(reference)).resolves.toEqual({reference:{...reference,address:account.address.toLowerCase()},wallet:{address:account.address.toLowerCase(),balance:'0.02',delegation:'enabled'},operation:{hash:reference.hash,submission:'accepted',execution:'succeeded',confirmation:'pending'},transactionHash:txHash});
  expect(requests.every(q=>!q.method.startsWith('eth_send')&&!q.method.includes('sign'))).toBe(true);
  await expect(service.preview({recipient:fixture.input.recipient,amount:'0.001',sponsored:false})).rejects.toThrow('请先创建测试钱包');
});

test('saves only the public operation reference before broadcast and restores it after the signing session ends',async()=>{
  const rows=new Map<string,string>();
  const storage={getItem:(key:string)=>rows.get(key)??null,setItem:(key:string,value:string)=>{rows.set(key,value);}};
  const {service,state,fetcher,savedAtBroadcast}=harness(storage);state.code='0x';
  await service.createAccount();
  const preview=await service.preview({recipient:fixture.input.recipient,amount:'0.001',sponsored:false});
  await service.submit(preview);
  expect(savedAtBroadcast()).toEqual({schemaVersion:'1',chainId:'421614',address:account.address.toLowerCase(),hash:fixture.expectedUserOpHash});
  const resumed=createBrowserServices(network,{fetch:fetcher,storage});
  expect(resumed.recentOperation!()).toEqual({chainId:'421614',address:account.address.toLowerCase(),hash:fixture.expectedUserOpHash});
  await expect(resumed.preview({recipient:fixture.input.recipient,amount:'0.001',sponsored:false})).rejects.toThrow('请先创建测试钱包');
  expect(JSON.stringify([...rows.values()])).not.toContain('signature');
  expect(JSON.stringify([...rows.values()])).not.toContain('privateKey');
});

test('bounds a stalled read-only recovery at fifteen seconds and cancels outstanding network reads',async()=>{
  vi.useFakeTimers();
  try{
    let aborted=false,settled=false;
    let failure:unknown;
    const service=createBrowserServices(network,{fetch:async(_url,init)=>new Promise((_resolve,reject)=>{init?.signal?.addEventListener('abort',()=>{aborted=true;reject(new DOMException('Aborted','AbortError'));},{once:true});})});
    const pending=service.inspectOperation!(reference).catch(error=>{settled=true;failure=error;});
    await vi.advanceTimersByTimeAsync(15000);
    expect(settled).toBe(true);
    expect(failure).toMatchObject({message:'查询链上状态超时，请重试'});
    expect(aborted).toBe(true);
    await pending;
  }finally{vi.useRealTimers();}
});

test('remembers a manually verified public reference for the next read-only page session',async()=>{
  const rows=new Map<string,string>();const storage={getItem:(key:string)=>rows.get(key)??null,setItem:(key:string,value:string)=>{rows.set(key,value);}};
  const {service,fetcher}=harness(storage);
  await service.inspectOperation!(reference);
  expect(JSON.parse(rows.get('abstract-wallet:recent-operation:v1:421614')??'null')).toEqual({schemaVersion:'1',chainId:'421614',address:account.address.toLowerCase(),hash:reference.hash});
  const resumed=createBrowserServices(network,{fetch:fetcher,storage});
  expect(resumed.recentOperation!()).toEqual({...reference,address:account.address.toLowerCase()});
  await expect(resumed.preview({recipient:fixture.input.recipient,amount:'0.001',sponsored:false})).rejects.toThrow('请先创建测试钱包');
});

test.each(['new query','new broadcast'])('does not let an older lookup overwrite the public reference from a %s',async mode=>{
  const rows=new Map<string,string>();const storage={getItem:(key:string)=>rows.get(key)??null,setItem:(key:string,value:string)=>{rows.set(key,value);}};
  const base=harness(storage);base.state.hint=null;base.state.code='0x';
  const oldReference={...reference,hash:`0x${'bb'.repeat(32)}`};
  let release!:()=>void,started!:()=>void;
  const gate=new Promise<void>(done=>{release=done;}),reachedHint=new Promise<void>(done=>{started=done;});
  const fetcher:typeof fetch=async(url,init)=>{const q=JSON.parse(String(init?.body));if(q.method==='eth_getUserOperationReceipt'&&q.params[0]===oldReference.hash){started();await gate;}return base.fetcher(url,init);};
  const service=createBrowserServices(network,{fetch:fetcher,accountFactory:()=>account,storage});
  const old=service.inspectOperation!(oldReference);await reachedHint;
  if(mode==='new query')await service.inspectOperation!(reference);
  else{await service.createAccount();const preview=await service.preview({recipient:fixture.input.recipient,amount:'0.001',sponsored:false});await service.submit(preview);}
  expect(service.recentOperation!()?.hash).toBe(reference.hash);
  release();await old;
  expect(service.recentOperation!()?.hash).toBe(reference.hash);
});

test.each([
  {chainId:'1'}, {address:'invalid'}, {address:'0x0000000000000000000000000000000000000000'}, {hash:'0x1234'},
])('rejects an invalid public reference before contacting any service: %j',async change=>{
  const {service,requests}=harness();
  await expect(service.inspectOperation!({...reference,...change} as OperationReference)).rejects.toThrow('请输入有效');
  expect(requests).toEqual([]);
});

test.each(['wrong sender','wrong hash','wrong EntryPoint','outer failure','missing event'])('does not trust a receipt hint or %s as operation execution',async scenario=>{
  const {service,state}=harness();state.hint.success=true;
  if(scenario==='wrong sender')state.receipt.logs[0].topics[2]=`0x${'22'.repeat(32)}`;
  if(scenario==='wrong hash')state.receipt.logs[0].topics[1]=`0x${'33'.repeat(32)}`;
  if(scenario==='wrong EntryPoint')state.receipt.logs[0].address='0x2222222222222222222222222222222222222222';
  if(scenario==='outer failure')state.receipt.status='0x0';
  if(scenario==='missing event')state.receipt.logs=[];
  const observed=await service.inspectOperation!(reference);
  expect(observed.operation.execution).toBe('unknown');expect(observed.transactionHash).toBeUndefined();
});

test('shows a real failed operation and a reorg separately while keeping delegation independent',async()=>{
  const {service,state}=harness();state.hint.success=true;
  state.receipt.logs[0].data=encodeAbiParameters(parseAbiParameters('uint256,bool,uint256,uint256'),[0n,false,25n,250000n]);
  await expect(service.inspectOperation!(reference)).resolves.toMatchObject({wallet:{delegation:'enabled'},operation:{execution:'reverted',confirmation:'pending'}});
  state.canonical=`0x${'ee'.repeat(32)}`;
  await expect(service.inspectOperation!(reference)).resolves.toMatchObject({operation:{execution:'unknown',confirmation:'reorged'}});
});

test.each(['{','null',JSON.stringify({...reference,schemaVersion:'1',chainId:'1'}),JSON.stringify({...reference,schemaVersion:'1',signature:'untrusted extra'})])('ignores malformed or foreign persisted metadata: %s',row=>{
  const {service}=harness({getItem:()=>row,setItem:()=>{}});
  expect(service.recentOperation!()).toBeUndefined();
});

test('does not broadcast when the public recovery journal cannot be stored',async()=>{
  const {service,state,requests}=harness({getItem:()=>null,setItem:()=>{throw new DOMException('Storage quota exceeded','QuotaExceededError');}});state.code='0x';
  await service.createAccount();const preview=await service.preview({recipient:fixture.input.recipient,amount:'0.001',sponsored:false});
  await expect(service.submit(preview)).rejects.toThrow('无法保存公开交易记录，未发送交易');
  expect(requests.some(q=>q.method.startsWith('eth_send'))).toBe(false);
});
