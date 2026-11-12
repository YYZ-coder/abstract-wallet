import { expect, test } from 'vitest';
import { keccak256, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createBrowserServices, type RuntimeNetwork } from '../src/browser-services';

const authority=privateKeyToAccount(`0x${'1'.padStart(64,'0')}`);
const delegate='0x00000000000000000000000000000000000000d1';
const zero='0x0000000000000000000000000000000000000000';
const receiptHash=`0x${'11'.repeat(32)}`;
const latestHash=`0x${'22'.repeat(32)}`;
const safeHash=`0x${'33'.repeat(32)}`;
const finalizedHash=`0x${'44'.repeat(32)}`;

function nativeHarness(overrides:Partial<RuntimeNetwork>={}){
 const network:RuntimeNetwork={mode:'arbitrum-sepolia',chainId:421614,rpcUrl:'https://rpc.example',bundlerUrl:'https://bundler.example',backendBaseUrl:'https://api.example',entryPoint:null,delegate,entryPointCodeHash:null,delegateCodeHash:null,paymaster:null,paymasterCodeHash:null,sponsorSigner:null,manifestVersion:'native-finality-fixture',finalityPolicy:'arbitrum-sepolia-finalized-v1',...overrides};
 const state={accountCode:`0xef0100${delegate.slice(2)}`,nonce:'0x0',receipt:null as any,finalized:{number:'0x5',hash:finalizedHash}};
 const broadcasts:Hex[]=[];
 const fetcher:typeof fetch=async(_url,init)=>{
  const q=JSON.parse(String(init?.body));let result:unknown;
  switch(q.method){
   case 'eth_chainId':result='0x66eee';break;
   case 'eth_getBalance':result='0x470de4df820000';break;
   case 'eth_getCode':result=q.params[0].toLowerCase()===zero?'0x':state.accountCode;break;
   case 'eth_getTransactionCount':result=state.nonce;break;
   case 'eth_gasPrice':result='0x3b9aca00';break;
   case 'eth_estimateGas':result='0xb3b0';break;
   case 'eth_sendRawTransaction':{
    const raw=q.params[0] as Hex;broadcasts.push(raw);result=keccak256(raw);
    state.accountCode='0x';state.nonce='0x2';
    state.receipt={transactionHash:result,status:'0x1',blockNumber:'0xa',blockHash:receiptHash};
    break;
   }
   case 'eth_getTransactionReceipt':result=state.receipt;break;
   case 'eth_getBlockByNumber':{
    const tag=q.params[0];
    if(tag==='latest')result={number:'0x64',hash:latestHash};
    else if(tag==='safe'||tag==='0x14')result={number:'0x14',hash:safeHash};
    else if(tag==='finalized')result=state.finalized;
    else if(tag==='0xa')result={number:'0xa',hash:receiptHash};
    else if(tag===state.finalized.number)result=state.finalized;
    else throw new Error(`Unconfigured block fixture: ${tag}`);
    break;
   }
   default:throw new Error(`Unexpected RPC fixture method: ${q.method}`);
  }
  return new Response(JSON.stringify({jsonrpc:'2.0',id:q.id,result}));
 };
 return{state,broadcasts,service:createBrowserServices(network,{fetch:fetcher,accountFactory:()=>authority})};
}

test('native revocation moves from pending to finalized using the same signed transaction under the public policy',async()=>{
 const {service,state,broadcasts}=nativeHarness();await service.createAccount();
 const pending=await service.revoke();
 expect(pending.confirmed).toBe(false);
 state.finalized={number:'0x14',hash:safeHash};
 const finalized=await service.revoke();
 expect(finalized).toEqual({transactionHash:pending.transactionHash,confirmed:true});
 expect(new Set(broadcasts).size).toBe(1);
 expect(finalized.transactionHash).toBe(keccak256(broadcasts[0]));
});

test.each([
 {name:'public L2 depth alone',options:{confirmationsRequired:1},confirmed:false},
 {name:'explicit local inclusion policy',options:{mode:'local' as const,confirmationsRequired:1},confirmed:true},
 {name:'local depth below its configured floor',options:{mode:'local' as const,confirmationsRequired:100},confirmed:false},
])('native revocation respects $name without borrowing another policy',async({options,confirmed})=>{
 const {service}=nativeHarness(options);await service.createAccount();
 await expect(service.revoke()).resolves.toMatchObject({confirmed});
});
