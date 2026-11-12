import { expect, test, vi } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, parseAbi, parseAbiParameters } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createBrowserServices, type RuntimeNetwork } from '../src/browser-services';
import fixture from './fixtures/selfpay-reference.json';
const account=privateKeyToAccount(`0x${'1'.padStart(64,'0')}`);
const reference={chainId:'421614' as const,address:account.address,hash:fixture.expectedUserOpHash};
const tx=`0x${'12'.repeat(32)}`,receiptHash=`0x${'aa'.repeat(32)}`;
const safeHash=`0x${'cc'.repeat(32)}`,finalHash=`0x${'dd'.repeat(32)}`,latestHash=`0x${'bb'.repeat(32)}`;
const code='0x6001600055',codeHash='0x7efcce47028dabcb0d42f3a7eda8820bf6f7f4e618398c2547d52f703cafb073';
const network:RuntimeNetwork={mode:'arbitrum-sepolia',chainId:421614,rpcUrl:'https://rpc.example',bundlerUrl:'https://bundler.example',backendBaseUrl:'https://api.example',entryPoint:fixture.input.entryPoint as `0x${string}`,delegate:fixture.input.delegate as `0x${string}`,paymaster:null,entryPointCodeHash:codeHash,delegateCodeHash:codeHash,paymasterCodeHash:null,sponsorSigner:null,manifestVersion:'test-v1',finalityPolicy:'arbitrum-sepolia-finalized-v1'};
const eventAbi=parseAbi(['event UserOperationEvent(bytes32 indexed userOpHash,address indexed sender,address indexed paymaster,uint256 nonce,bool success,uint256 actualGasCost,uint256 actualGasUsed)']);
function harness(overrides:Partial<RuntimeNetwork>={}){
 const state={reorgAfterCanonical:false,hangReceipt:false,accountCode:'0x',latest:{number:'0x64',hash:latestHash,timestamp:'0x3e8'},safe:{number:'0x50',hash:safeHash},finalized:{number:'0x14',hash:finalHash},canonicalReceiptHash:receiptHash,canonicalFinalHash:finalHash,canonicalSafeHash:safeHash,receiptPresent:true,logs:true,success:true,finalityError:false};
 const calls:any[]=[];let receiptBlockReads=0;
 const fetcher:typeof fetch=async(url,init)=>{
  const q=JSON.parse(String(init?.body));calls.push({...q,url:String(url)});
  let result:any;
  if(state.hangReceipt&&q.method==='eth_getUserOperationReceipt')return new Promise<Response>(()=>{});
  if(q.method==='eth_chainId')result='0x66eee';
  else if(q.method==='eth_getCode')result=q.params[0].toLowerCase()===account.address.toLowerCase()?state.accountCode:code;
  else if(q.method==='eth_getBalance')result='0x470de4df820000';
  else if(q.method==='eth_getTransactionCount')result='0x0';
  else if(q.method==='eth_call')result=`0x${'00'.repeat(32)}`;
  else if(q.method==='eth_gasPrice')result='0x3b9aca00';
  else if(q.method==='eth_supportedEntryPoints')result=[network.entryPoint];
  else if(q.method==='eth_estimateUserOperationGas')result={verificationGasLimit:'0x927c0',callGasLimit:'0x493e0',preVerificationGas:'0x186a0'};
  else if(q.method==='eth_sendUserOperation')result=fixture.expectedUserOpHash;
  else if(q.method==='eth_getUserOperationReceipt')result={receipt:{transactionHash:tx},success:true,finalized:true};
  else if(q.method==='eth_getTransactionReceipt')result=state.receiptPresent?{transactionHash:tx,to:network.entryPoint,status:'0x1',blockHash:receiptHash,blockNumber:'0xa',logs:state.logs?[{address:network.entryPoint,topics:encodeEventTopics({abi:eventAbi,eventName:'UserOperationEvent',args:{userOpHash:reference.hash as `0x${string}`,sender:account.address,paymaster:'0x0000000000000000000000000000000000000000'}}),data:encodeAbiParameters(parseAbiParameters('uint256,bool,uint256,uint256'),[0n,state.success,25n,250000n])}]:[]}:null;
  else if(q.method==='eth_getBlockByNumber'){
   if(state.finalityError&&['safe','finalized'].includes(q.params[0]))return new Response(JSON.stringify({jsonrpc:'2.0',id:q.id,error:{code:-32602,message:'unsupported tag'}}));
   if(q.params[0]==='latest')result=state.latest;
   else if(q.params[0]==='safe')result=state.safe;
   else if(q.params[0]==='finalized')result=state.finalized;
   else if(BigInt(q.params[0])===10n)result={number:'0xa',hash:state.reorgAfterCanonical&&++receiptBlockReads>1?latestHash:state.canonicalReceiptHash};
   else if(BigInt(q.params[0])===BigInt(state.finalized.number))result={...state.finalized,hash:state.canonicalFinalHash};
   else if(BigInt(q.params[0])===BigInt(state.safe.number))result={...state.safe,hash:state.canonicalSafeHash};
   else result=null;
  }else throw new Error('Unexpected boundary RPC '+q.method);
  return new Response(JSON.stringify({jsonrpc:'2.0',id:q.id,result}));
 };
 return{state,calls,service:createBrowserServices({...network,...overrides},{fetch:fetcher,accountFactory:()=>account,storage:{getItem:()=>null,setItem:()=>{}}})};
}
test('confirms a recovered operation only from canonical finalized evidence covering its receipt',async()=>{
 const {service,calls}=harness();const observed=await service.inspectOperation!(reference);
 expect(observed.operation.confirmation).toBe('confirmed');
 expect(observed.operation.finality).toEqual({policyId:'arbitrum-sepolia-finalized-v1',stage:'finalized',transactionHash:tx,blockNumber:'10',blockHash:receiptHash,safeBlockNumber:'80',finalizedBlockNumber:'20'});
 expect(calls.some(q=>q.method.startsWith('eth_send')||q.method.includes('sign'))).toBe(false);
});

test('preserves verified L2 execution when the finality RPC is unavailable',async()=>{
 const {service,state}=harness({confirmationsRequired:1});state.finalityError=true;
 await expect(service.inspectOperation!(reference)).resolves.toMatchObject({operation:{execution:'succeeded',confirmation:'pending',finality:{stage:'unavailable',blockNumber:'10'}}});
});

test('reports safe coverage separately while finalized head is still behind the receipt',async()=>{
 const {service,state}=harness({confirmationsRequired:1});state.finalized.number='0x5';
 const observed=await service.inspectOperation!(reference);
 expect(observed.operation).toMatchObject({execution:'succeeded',confirmation:'pending',finality:{stage:'safe',safeBlockNumber:'80',finalizedBlockNumber:'5'}});
});

test('does not report safe coverage from a noncanonical safe checkpoint',async()=>{
 const {service,state}=harness();state.finalized.number='0x5';state.canonicalSafeHash=receiptHash;
 const observed=await service.inspectOperation!(reference);
 expect(observed.operation).toMatchObject({execution:'succeeded',confirmation:'pending',finality:{stage:'unavailable'}});
});

test('applies the finalized policy to the active transfer status instead of leaving it pending',async()=>{
 const {service}=harness();await service.createAccount();
 const preview=await service.preview({recipient:fixture.input.recipient,amount:'0.001',sponsored:false});
 const sent=await service.submit(preview);
 expect(sent.hash).toBe(reference.hash);
 await expect(service.status(sent.hash)).resolves.toMatchObject({execution:'succeeded',confirmation:'confirmed',finality:{stage:'finalized',blockNumber:'10'}});
});

test('removes old finality evidence when an active receipt can no longer be verified',async()=>{
 const {service,state}=harness();await service.createAccount();
 const preview=await service.preview({recipient:fixture.input.recipient,amount:'0.001',sponsored:false});
 const sent=await service.submit(preview);
 expect((await service.status(sent.hash)).confirmation).toBe('confirmed');
 state.receiptPresent=false;
 const missing=await service.status(sent.hash);
 expect(missing).toMatchObject({execution:'unknown',confirmation:'pending'});
 expect(missing.finality).toBeUndefined();
});

test.each([['0x10','0x14'],['0x65','0x5']])('fails closed when safe %s is inconsistent with finalized %s and latest 100',async(safe,finalized)=>{
 const {service,state}=harness();state.safe.number=safe;state.finalized.number=finalized;
 await expect(service.inspectOperation!(reference)).resolves.toMatchObject({operation:{execution:'succeeded',confirmation:'pending',finality:{stage:'unavailable'}}});
});

test('times out an active observation so an unresponsive Bundler cannot stall polling forever',async()=>{
 const {service,state}=harness();await service.createAccount();
 const preview=await service.preview({recipient:fixture.input.recipient,amount:'0.001',sponsored:false});
 const sent=await service.submit(preview);state.hangReceipt=true;
 vi.useFakeTimers();
 try{
  let outcome='still waiting';
  void service.status(sent.hash).then(()=>{outcome='unexpected result';},error=>{outcome=error.message;});
  await vi.advanceTimersByTimeAsync(15000);
  expect(outcome).toBe('查询链上状态超时，请重试');
 }finally{vi.useRealTimers();}
});

test('revokes execution evidence if the receipt block changes while finality heads are being read',async()=>{
 const {service,state}=harness();state.reorgAfterCanonical=true;
 await expect(service.inspectOperation!(reference)).resolves.toMatchObject({operation:{execution:'unknown',confirmation:'reorged'}});
});

// Regression supplements: independent bad checkpoints must never promote execution.
test.each(['lagging','future','noncanonical','malformed','no receipt','no event','reverted event'])(
 'does not confuse %s evidence with a finalized successful operation',async scenario=>{
  const {service,state}=harness();
  if(scenario==='lagging'){state.safe.number='0x8';state.finalized.number='0x5';}
  if(scenario==='future')state.finalized.number='0x65';
  if(scenario==='noncanonical')state.canonicalFinalHash=receiptHash;
  if(scenario==='malformed')state.finalized.hash='0x12';
  if(scenario==='no receipt')state.receiptPresent=false;
  if(scenario==='no event')state.logs=false;
  if(scenario==='reverted event')state.success=false;
  const result=await service.inspectOperation!(reference);
  if(scenario==='reverted event')expect(result.operation).toMatchObject({execution:'reverted',confirmation:'confirmed',finality:{stage:'finalized'}});
  else expect(result.operation.confirmation).toBe('pending');
  if(scenario==='lagging')expect(result.operation.finality?.stage).toBe('l2');
 });
test('cannot substitute a depth count for a missing public finality policy',async()=>{
 const {service}=harness({finalityPolicy:undefined,confirmationsRequired:1});
 await expect(service.inspectOperation!(reference)).resolves.toMatchObject({operation:{execution:'succeeded',confirmation:'pending'}});
});
