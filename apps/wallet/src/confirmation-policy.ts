import type { RuntimeNetwork } from './browser-services';
import type { FinalityEvidence, OperationStatus } from './services';

type Rpc=(method:string,params?:unknown[])=>Promise<any>;
type Receipt={transactionHash:string;blockNumber:string;blockHash:string};
type Confirmation=Pick<OperationStatus,'confirmation'|'finality'>;
const block=(value:any):value is {number:string;hash:string}=>Boolean(value&&/^0x[0-9a-f]+$/i.test(value.number)&&/^0x[0-9a-f]{64}$/i.test(value.hash));

// The public policy follows Nitro's parent-batch finalized tag, never L2 depth.
export async function readConfirmation(network:RuntimeNetwork,receipt:Receipt,rpc:Rpc):Promise<Confirmation>{
 const [canonical,latest]=await Promise.all([rpc('eth_getBlockByNumber',[receipt.blockNumber,false]),rpc('eth_getBlockByNumber',['latest',false])]);
 if(!canonical||canonical.hash?.toLowerCase()!==receipt.blockHash.toLowerCase())return{confirmation:'reorged'};
 if(network.mode==='local'){
  const required=network.confirmationsRequired??1;
  return{confirmation:Number.isSafeInteger(required)&&required>0&&BigInt(latest.number)-BigInt(receipt.blockNumber)+1n>=BigInt(required)?'confirmed':'pending'};
 }
 if(network.chainId!==421614||network.finalityPolicy!=='arbitrum-sepolia-finalized-v1')return{confirmation:'pending'};
 const evidence:FinalityEvidence={policyId:'arbitrum-sepolia-finalized-v1',stage:'l2',transactionHash:receipt.transactionHash,blockNumber:BigInt(receipt.blockNumber).toString(),blockHash:receipt.blockHash};
 try {
 const [safe,finalized]=await Promise.all([rpc('eth_getBlockByNumber',['safe',false]),rpc('eth_getBlockByNumber',['finalized',false])]);
 if(!block(canonical)||BigInt(canonical.number)!==BigInt(receipt.blockNumber)||!block(latest)||!block(finalized)||!block(safe)||BigInt(finalized.number)>BigInt(safe.number)||BigInt(safe.number)>BigInt(latest.number))return{confirmation:'pending',finality:{...evidence,stage:'unavailable'}};
 const pinned=await rpc('eth_getBlockByNumber',[finalized.number,false]);
 if(!block(pinned)||BigInt(pinned.number)!==BigInt(finalized.number)||pinned.hash.toLowerCase()!==finalized.hash.toLowerCase())return{confirmation:'pending',finality:{...evidence,stage:'unavailable'}};
 if(block(safe)){
  const pinnedSafe=await rpc('eth_getBlockByNumber',[safe.number,false]);
  if(!block(pinnedSafe)||BigInt(pinnedSafe.number)!==BigInt(safe.number)||pinnedSafe.hash.toLowerCase()!==safe.hash.toLowerCase())return{confirmation:'pending',finality:{...evidence,stage:'unavailable'}};
  evidence.safeBlockNumber=BigInt(safe.number).toString();
 }
 const current=await rpc('eth_getBlockByNumber',[receipt.blockNumber,false]);
 if(!block(current)||BigInt(current.number)!==BigInt(receipt.blockNumber)||current.hash.toLowerCase()!==receipt.blockHash.toLowerCase())return{confirmation:'reorged'};
 evidence.finalizedBlockNumber=BigInt(finalized.number).toString();
 if(BigInt(finalized.number)>=BigInt(receipt.blockNumber))return{confirmation:'confirmed',finality:{...evidence,stage:'finalized'}};
 return{confirmation:'pending',finality:{...evidence,stage:block(safe)&&BigInt(safe.number)>=BigInt(receipt.blockNumber)?'safe':'l2'}};
 }catch{return{confirmation:'pending',finality:{...evidence,stage:'unavailable'}};}
}
