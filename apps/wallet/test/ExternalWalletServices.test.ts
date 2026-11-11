import { expect, test } from 'vitest';
import { createBrowserServices, type RuntimeNetwork } from '../src/browser-services';
import type { WalletHost, WalletProvider } from '../src/external-wallet';
import { keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import reference from './fixtures/selfpay-reference.json';
const network:RuntimeNetwork={mode:'local',chainId:421614,rpcUrl:'https://rpc.example',bundlerUrl:'https://bundler.example',backendBaseUrl:'https://api.example',entryPoint:null,delegate:null,paymaster:null,entryPointCodeHash:null,delegateCodeHash:null,paymasterCodeHash:null,sponsorSigner:null,manifestVersion:'test-v1'};
const address='0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf';
function host(provider:WalletProvider){
  const target=new EventTarget() as WalletHost;
  target.addEventListener('eip6963:requestProvider',()=>target.dispatchEvent(new CustomEvent('eip6963:announceProvider',{detail:{info:{uuid:'11111111-1111-4111-8111-111111111111',name:'Existing Wallet',rdns:'org.example.wallet',icon:'data:image/svg+xml,unsafe'},provider}})));
  return target;
}
test('lists announced existing wallets as choices without account access or private keys',async()=>{
  const provider:WalletProvider={request:async()=>{throw new Error('Discovery must not request private account access');}};
  const service=createBrowserServices(network,{walletHost:host(provider)});
  expect(await service.listWallets!()).toEqual([{id:'11111111-1111-4111-8111-111111111111',name:'Existing Wallet'}]);
});
test('connects the existing address without a key import and explains missing 7702 authorization',async()=>{
  const methods:string[]=[];
  const provider:WalletProvider={request:async({method})=>{methods.push(method);if(method==='eth_chainId')return'0x66eee';if(['eth_requestAccounts','eth_accounts'].includes(method))return[address];throw new Error('Unexpected wallet action '+method);}};
  const rpc:typeof fetch=async(_url,init)=>{const q=JSON.parse(String(init?.body));const result={eth_chainId:'0x66eee',eth_getBalance:'0x470de4df820000',eth_getCode:'0x'}[q.method as string];return new Response(JSON.stringify({jsonrpc:'2.0',id:q.id,result}));};
  const service=createBrowserServices(network,{walletHost:host(provider),fetch:rpc});
  await expect(service.connectWallet!('11111111-1111-4111-8111-111111111111')).resolves.toMatchObject({address,balance:'0.02',delegation:'undelegated',connection:{walletName:'Existing Wallet'},availability:{canSubmit:false,canRevoke:false,reason:expect.stringContaining('7702')}});
  expect(methods.some(m=>m.includes('sign')||m.includes('send'))).toBe(false);
});
test('refuses an undelegated external wallet before preparing fees or reserving sponsorship',async()=>{
  const provider:WalletProvider={request:async({method})=>method==='eth_chainId'?'0x66eee':[address]};
  const methods:string[]=[];
  const configured={...network,entryPoint:'0x00000000000000000000000000000000000000e1' as const,delegate:'0x00000000000000000000000000000000000000d1' as const,entryPointCodeHash:keccak256('0x6001'),delegateCodeHash:keccak256('0x6001')};
  const rpc:typeof fetch=async(url,init)=>{const q=JSON.parse(String(init?.body));methods.push(q.method??String(url));const results:Record<string,unknown>={eth_chainId:'0x66eee',eth_getBalance:'0x470de4df820000',eth_getTransactionCount:'0x0',eth_call:`0x${'00'.repeat(32)}`,eth_gasPrice:'0x3b9aca00',eth_getBlockByNumber:{timestamp:'0x3e8'},eth_estimateUserOperationGas:{verificationGasLimit:'0x927c0',callGasLimit:'0x493e0',preVerificationGas:'0x186a0'}};const result=q.method==='eth_getCode'?q.params[0].toLowerCase()===address.toLowerCase()?'0x':'0x6001':results[q.method];return new Response(JSON.stringify({jsonrpc:'2.0',id:q.id,result}));};
  const service=createBrowserServices(configured,{walletHost:host(provider),fetch:rpc});await service.connectWallet!('11111111-1111-4111-8111-111111111111');
  await expect(service.preview({recipient:'0x2222222222222222222222222222222222222222',amount:'0.001',sponsored:false})).rejects.toThrow('7702');
  expect(methods).not.toContain('eth_estimateUserOperationGas');
});
test('invalidates the connected account and its preview immediately on a wallet account event',async()=>{
  const events=new Map<string,Set<(...args:any[])=>void>>();
  const provider:WalletProvider={request:async({method})=>method==='eth_chainId'?'0x66eee':[address],on(event,listener){const set=events.get(event)??new Set();set.add(listener);events.set(event,set);},removeListener(event,listener){events.get(event)?.delete(listener);}};
  const delegate='0x00000000000000000000000000000000000000d1' as const;
  const configured={...network,entryPoint:'0x00000000000000000000000000000000000000e1' as const,delegate,entryPointCodeHash:keccak256('0x6001'),delegateCodeHash:keccak256('0x6001')};
  const rpc:typeof fetch=async(_url,init)=>{const q=JSON.parse(String(init?.body));const results:Record<string,unknown>={eth_chainId:'0x66eee',eth_getBalance:'0x470de4df820000',eth_getTransactionCount:'0x1',eth_call:`0x${'00'.repeat(32)}`,eth_gasPrice:'0x3b9aca00',eth_getBlockByNumber:{timestamp:'0x3e8'},eth_estimateUserOperationGas:{verificationGasLimit:'0x927c0',callGasLimit:'0x493e0',preVerificationGas:'0x186a0'}};const result=q.method==='eth_getCode'?q.params[0].toLowerCase()===address.toLowerCase()?`0xef0100${delegate.slice(2)}`:'0x6001':results[q.method];return new Response(JSON.stringify({jsonrpc:'2.0',id:q.id,result}));};
  const service=createBrowserServices(configured,{walletHost:host(provider),fetch:rpc});await service.connectWallet!('11111111-1111-4111-8111-111111111111');
  const preview=await service.preview({recipient:'0x2222222222222222222222222222222222222222',amount:'0.001',sponsored:false});
  let changes=0;service.onWalletChange!(()=>changes++);
  for(const listener of events.get('accountsChanged')??[])listener([]);
  expect(changes).toBe(1);
  await expect(service.refresh()).rejects.toThrow();
  await expect(service.submit(preview)).rejects.toThrow('失效');
});
test('disconnects only the app session and leaves the original chain delegation untouched',async()=>{
  const provider:WalletProvider={request:async({method})=>method==='eth_chainId'?'0x66eee':[address]};
  const methods:string[]=[];const rpc:typeof fetch=async(_url,init)=>{const q=JSON.parse(String(init?.body));methods.push(q.method);const result=({eth_chainId:'0x66eee',eth_getBalance:'0x470de4df820000',eth_getCode:'0x'} as Record<string,unknown>)[q.method];return new Response(JSON.stringify({jsonrpc:'2.0',id:q.id,result}));};
  const service=createBrowserServices(network,{walletHost:host(provider),fetch:rpc});await service.connectWallet!('11111111-1111-4111-8111-111111111111');
  await service.disconnectWallet!();await expect(service.refresh()).rejects.toThrow();
  expect(methods.some(m=>m.includes('send'))).toBe(false);
});
test('uses an already delegated original address for externally signed 4337 execution',async()=>{
  const root=privateKeyToAccount(`0x${'1'.padStart(64,'0')}`);const walletMethods:string[]=[];
  const provider:WalletProvider={request:async({method,params})=>{walletMethods.push(method);if(method==='eth_chainId')return'0x66eee';if(method==='eth_signTypedData_v4'){const data=JSON.parse((params as any[])[1]);return root.signTypedData(data);}return[address];}};
  const delegate=reference.input.delegate as `0x${string}`;const configured={...network,entryPoint:reference.input.entryPoint as `0x${string}`,delegate,entryPointCodeHash:keccak256('0x6001'),delegateCodeHash:keccak256('0x6001')};const sent:any[]=[];
  const rpc:typeof fetch=async(_url,init)=>{const q=JSON.parse(String(init?.body));const results:Record<string,unknown>={eth_chainId:'0x66eee',eth_getBalance:'0x470de4df820000',eth_getTransactionCount:'0x1',eth_call:`0x${'00'.repeat(32)}`,eth_gasPrice:'0x3b9aca00',eth_getBlockByNumber:{timestamp:'0x3e8'},eth_estimateUserOperationGas:{verificationGasLimit:'0x927c0',callGasLimit:'0x493e0',preVerificationGas:'0x186a0'},eth_supportedEntryPoints:[configured.entryPoint],eth_sendUserOperation:reference.expectedUserOpHash};if(q.method==='eth_sendUserOperation')sent.push(q.params[0]);const result=q.method==='eth_getCode'?q.params[0].toLowerCase()===address.toLowerCase()?`0xef0100${delegate.slice(2)}`:'0x6001':results[q.method];return new Response(JSON.stringify({jsonrpc:'2.0',id:q.id,result}));};
  const service=createBrowserServices(configured,{walletHost:host(provider),fetch:rpc});
  await expect(service.connectWallet!('11111111-1111-4111-8111-111111111111')).resolves.toMatchObject({address,delegation:'enabled',availability:{canSubmit:true,canRevoke:false}});
  const preview=await service.preview({recipient:reference.input.recipient,amount:'0.001',sponsored:false});
  await expect(service.submit(preview)).resolves.toMatchObject({hash:reference.expectedUserOpHash,submission:'accepted'});
  expect(sent[0].sender.toLowerCase()).toBe(address.toLowerCase());expect(sent[0].eip7702Auth).toBeUndefined();
  expect(walletMethods).toContain('eth_signTypedData_v4');expect(walletMethods).not.toContain('eth_signAuthorization');
});
test('detects silent provider account changes before returning an old account snapshot',async()=>{
  let accounts=[address];const provider:WalletProvider={request:async({method})=>method==='eth_chainId'?'0x66eee':accounts};
  const rpc:typeof fetch=async(_url,init)=>{const q=JSON.parse(String(init?.body));return new Response(JSON.stringify({jsonrpc:'2.0',id:q.id,result:({eth_chainId:'0x66eee',eth_getBalance:'0x470de4df820000',eth_getCode:'0x'} as Record<string,unknown>)[q.method]}));};
  const service=createBrowserServices(network,{walletHost:host(provider),fetch:rpc});await service.connectWallet!('11111111-1111-4111-8111-111111111111');
  accounts=['0x2222222222222222222222222222222222222222'];
  await expect(service.refresh()).rejects.toThrow();
});
test('does not restore a preview when the user disconnects during fee preparation',async()=>{
  const provider:WalletProvider={request:async({method})=>method==='eth_chainId'?'0x66eee':[address]};
  const delegate=reference.input.delegate as `0x${string}`;const configured={...network,entryPoint:reference.input.entryPoint as `0x${string}`,delegate,entryPointCodeHash:keccak256('0x6001'),delegateCodeHash:keccak256('0x6001')};
  let release!:()=>void,started!:()=>void;const feeGate=new Promise<void>(r=>release=r),feeStarted=new Promise<void>(r=>started=r);
  const rpc:typeof fetch=async(_url,init)=>{const q=JSON.parse(String(init?.body));if(q.method==='eth_estimateUserOperationGas'){started();await feeGate;}const results:Record<string,unknown>={eth_chainId:'0x66eee',eth_getBalance:'0x470de4df820000',eth_getTransactionCount:'0x1',eth_call:`0x${'00'.repeat(32)}`,eth_gasPrice:'0x3b9aca00',eth_getBlockByNumber:{timestamp:'0x3e8'},eth_estimateUserOperationGas:{verificationGasLimit:'0x927c0',callGasLimit:'0x493e0',preVerificationGas:'0x186a0'}};return new Response(JSON.stringify({jsonrpc:'2.0',id:q.id,result:q.method==='eth_getCode'?q.params[0].toLowerCase()===address.toLowerCase()?`0xef0100${delegate.slice(2)}`:'0x6001':results[q.method]}));};
  const service=createBrowserServices(configured,{walletHost:host(provider),fetch:rpc});await service.connectWallet!('11111111-1111-4111-8111-111111111111');
  const preview=service.preview({recipient:reference.input.recipient,amount:'0.001',sponsored:false});await feeStarted;await service.disconnectWallet!();release();
  await expect(preview).rejects.toThrow('连接已失效');
});
test('does not reconnect an old wallet after the user disconnects while approval is pending',async()=>{
  let approve!:(value:unknown)=>void,requested!:()=>void;const requestStarted=new Promise<void>(r=>requested=r);const approval=new Promise(r=>approve=r);
  const provider:WalletProvider={request:async({method})=>{if(method==='eth_requestAccounts'){requested();return approval;}return method==='eth_chainId'?'0x66eee':[address];}};
  const rpc:typeof fetch=async(_url,init)=>{const q=JSON.parse(String(init?.body));return new Response(JSON.stringify({jsonrpc:'2.0',id:q.id,result:({eth_chainId:'0x66eee',eth_getBalance:'0x470de4df820000',eth_getCode:'0x'} as Record<string,unknown>)[q.method]}));};
  const service=createBrowserServices(network,{walletHost:host(provider),fetch:rpc});const connecting=service.connectWallet!('11111111-1111-4111-8111-111111111111');await requestStarted;await service.disconnectWallet!();approve([address]);
  await expect(connecting).rejects.toThrow('连接已失效');await expect(service.refresh()).rejects.toThrow();
});
test('does not broadcast a signed operation after disconnect during the final RPC checks',async()=>{
  const root=privateKeyToAccount(`0x${'1'.padStart(64,'0')}`);let signed=false,paused=false,sends=0;
  let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>release=r),startedPromise=new Promise<void>(r=>started=r);
  const provider:WalletProvider={request:async({method,params})=>{if(method==='eth_signTypedData_v4'){signed=true;return root.signTypedData(JSON.parse((params as any[])[1]));}return method==='eth_chainId'?'0x66eee':[address];}};
  const delegate=reference.input.delegate as `0x${string}`;const configured={...network,entryPoint:reference.input.entryPoint as `0x${string}`,delegate,entryPointCodeHash:keccak256('0x6001'),delegateCodeHash:keccak256('0x6001')};
  const rpc:typeof fetch=async(_url,init)=>{const q=JSON.parse(String(init?.body));if(q.method==='eth_chainId'&&signed&&!paused){paused=true;started();await gate;}if(q.method==='eth_sendUserOperation')sends++;const results:Record<string,unknown>={eth_chainId:'0x66eee',eth_getBalance:'0x470de4df820000',eth_getTransactionCount:'0x1',eth_call:`0x${'00'.repeat(32)}`,eth_gasPrice:'0x3b9aca00',eth_getBlockByNumber:{timestamp:'0x3e8'},eth_estimateUserOperationGas:{verificationGasLimit:'0x927c0',callGasLimit:'0x493e0',preVerificationGas:'0x186a0'},eth_supportedEntryPoints:[configured.entryPoint],eth_sendUserOperation:reference.expectedUserOpHash};return new Response(JSON.stringify({jsonrpc:'2.0',id:q.id,result:q.method==='eth_getCode'?q.params[0].toLowerCase()===address.toLowerCase()?`0xef0100${delegate.slice(2)}`:'0x6001':results[q.method]}));};
  const service=createBrowserServices(configured,{walletHost:host(provider),fetch:rpc});await service.connectWallet!('11111111-1111-4111-8111-111111111111');const preview=await service.preview({recipient:reference.input.recipient,amount:'0.001',sponsored:false});const submitting=service.submit(preview);submitting.catch(()=>{});await startedPromise;await service.disconnectWallet!();release();
  const error=await submitting.then(()=>undefined,error=>error);expect(sends).toBe(0);expect(error).toBeInstanceOf(Error);
});
test('preserves the real broadcast result if disconnect occurs after transmission has started',async()=>{
  const root=privateKeyToAccount(`0x${'1'.padStart(64,'0')}`);let sends=0;let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>release=r),startedPromise=new Promise<void>(r=>started=r);
  const provider:WalletProvider={request:async({method,params})=>method==='eth_signTypedData_v4'?root.signTypedData(JSON.parse((params as any[])[1])):method==='eth_chainId'?'0x66eee':[address]};const delegate=reference.input.delegate as `0x${string}`;const configured={...network,entryPoint:reference.input.entryPoint as `0x${string}`,delegate,entryPointCodeHash:keccak256('0x6001'),delegateCodeHash:keccak256('0x6001')};
  const rpc:typeof fetch=async(_url,init)=>{const q=JSON.parse(String(init?.body));if(q.method==='eth_sendUserOperation'){sends++;started();await gate;}const results:Record<string,unknown>={eth_chainId:'0x66eee',eth_getBalance:'0x470de4df820000',eth_getTransactionCount:'0x1',eth_call:`0x${'00'.repeat(32)}`,eth_gasPrice:'0x3b9aca00',eth_getBlockByNumber:{timestamp:'0x3e8'},eth_estimateUserOperationGas:{verificationGasLimit:'0x927c0',callGasLimit:'0x493e0',preVerificationGas:'0x186a0'},eth_supportedEntryPoints:[configured.entryPoint],eth_sendUserOperation:reference.expectedUserOpHash};return new Response(JSON.stringify({jsonrpc:'2.0',id:q.id,result:q.method==='eth_getCode'?q.params[0].toLowerCase()===address.toLowerCase()?`0xef0100${delegate.slice(2)}`:'0x6001':results[q.method]}));};
  const service=createBrowserServices(configured,{walletHost:host(provider),fetch:rpc});await service.connectWallet!('11111111-1111-4111-8111-111111111111');const preview=await service.preview({recipient:reference.input.recipient,amount:'0.001',sponsored:false});const submitting=service.submit(preview);submitting.catch(()=>{});await startedPromise;await service.disconnectWallet!();release();
  await expect(submitting).resolves.toMatchObject({hash:reference.expectedUserOpHash,submission:'accepted'});expect(sends).toBe(1);await expect(service.refresh()).rejects.toThrow();
});
test('does not sign a different preview created while approval context is being checked',async()=>{
  const root=privateKeyToAccount(`0x${'1'.padStart(64,'0')}`);let arm=false,paused=false,sends=0;
  let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>release=r),startedPromise=new Promise<void>(r=>started=r);
  const provider:WalletProvider={request:async({method,params})=>{if(method==='eth_accounts'&&arm&&!paused){paused=true;started();await gate;}return method==='eth_signTypedData_v4'?root.signTypedData(JSON.parse((params as any[])[1])):method==='eth_chainId'?'0x66eee':[address];}};const delegate=reference.input.delegate as `0x${string}`;const configured={...network,entryPoint:reference.input.entryPoint as `0x${string}`,delegate,entryPointCodeHash:keccak256('0x6001'),delegateCodeHash:keccak256('0x6001')};
  const rpc:typeof fetch=async(_url,init)=>{const q=JSON.parse(String(init?.body));if(q.method==='eth_sendUserOperation')sends++;const results:Record<string,unknown>={eth_chainId:'0x66eee',eth_getBalance:'0x470de4df820000',eth_getTransactionCount:'0x1',eth_call:`0x${'00'.repeat(32)}`,eth_gasPrice:'0x3b9aca00',eth_getBlockByNumber:{timestamp:'0x3e8'},eth_estimateUserOperationGas:{verificationGasLimit:'0x927c0',callGasLimit:'0x493e0',preVerificationGas:'0x186a0'},eth_supportedEntryPoints:[configured.entryPoint],eth_sendUserOperation:reference.expectedUserOpHash};return new Response(JSON.stringify({jsonrpc:'2.0',id:q.id,result:q.method==='eth_getCode'?q.params[0].toLowerCase()===address.toLowerCase()?`0xef0100${delegate.slice(2)}`:'0x6001':results[q.method]}));};
  const service=createBrowserServices(configured,{walletHost:host(provider),fetch:rpc});await service.connectWallet!('11111111-1111-4111-8111-111111111111');const preview=await service.preview({recipient:reference.input.recipient,amount:'0.001',sponsored:false});arm=true;const submitting=service.submit(preview);submitting.catch(()=>{});await startedPromise;await service.preview({recipient:reference.input.recipient,amount:'0.002',sponsored:false});release();
  const error=await submitting.then(()=>undefined,error=>error);expect(sends).toBe(0);expect(error).toBeInstanceOf(Error);
});
test('switches the selected wallet session without reporting the intentional replacement as an external invalidation',async()=>{
  let selected=address;const next='0x2222222222222222222222222222222222222222';
  const provider:WalletProvider={request:async({method})=>method==='eth_chainId'?'0x66eee':[selected]};const rpc:typeof fetch=async(_url,init)=>{const q=JSON.parse(String(init?.body));return new Response(JSON.stringify({jsonrpc:'2.0',id:q.id,result:({eth_chainId:'0x66eee',eth_getBalance:'0x470de4df820000',eth_getCode:'0x'} as Record<string,unknown>)[q.method]}));};
  const service=createBrowserServices(network,{walletHost:host(provider),fetch:rpc});await service.connectWallet!('11111111-1111-4111-8111-111111111111');let changes=0;service.onWalletChange!(()=>changes++);selected=next;
  await expect(service.connectWallet!('11111111-1111-4111-8111-111111111111')).resolves.toMatchObject({address:next});expect(changes).toBe(0);await expect(service.refresh()).resolves.toMatchObject({address:next});
});
