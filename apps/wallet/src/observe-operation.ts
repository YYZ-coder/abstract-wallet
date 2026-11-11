import { decodeEventLog, formatEther, isAddress, keccak256, zeroAddress } from 'viem';
import { entryPoint09Abi } from 'viem/account-abstraction';
import type { RuntimeNetwork } from './browser-services';
import type { ObservedOperation, OperationReference, OperationStatus } from './services';

export function validOperationReference(value: unknown): value is OperationReference {
  const record=value as OperationReference|undefined;
  return !!record&&record.chainId==='421614'&&typeof record.address==='string'&&isAddress(record.address)&&record.address.toLowerCase()!==zeroAddress&&typeof record.hash==='string'&&/^0x[0-9a-fA-F]{64}$/.test(record.hash);
}

export async function inspectRecordedOperation(network:RuntimeNetwork, input:OperationReference, fetchImpl:typeof fetch):Promise<ObservedOperation>{
  const controller=new AbortController();
  let timeout:ReturnType<typeof setTimeout>;
  const deadline=new Promise<never>((_,reject)=>{timeout=setTimeout(()=>{reject(new Error('查询链上状态超时，请重试'));controller.abort();},15000);});
  const boundedFetch:typeof fetch=(url,init)=>fetchImpl(url,{...init,signal:controller.signal});
  try{return await Promise.race([readRecordedOperation(network,input,boundedFetch),deadline]);}
  finally{clearTimeout(timeout!);controller.abort();}
}

async function readRecordedOperation(network:RuntimeNetwork, input:OperationReference, fetchImpl:typeof fetch):Promise<ObservedOperation>{
  if(!validOperationReference(input))throw new Error('请输入有效的 Arbitrum Sepolia 地址和 UserOperation 编号');
  if(network.chainId!==421614||!network.entryPoint||!network.delegate||!network.entryPointCodeHash||!network.delegateCodeHash)throw new Error('当前测试网部署配置不可用');
  const reference:OperationReference={chainId:'421614',address:input.address.toLowerCase(),hash:input.hash.toLowerCase()};
  let sequence=0;
  async function rpc(method:string,params:unknown[]=[],url=network.rpcUrl):Promise<any>{
    const id=++sequence;
    const response=await fetchImpl(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id,method,params})});
    if(!response.ok)throw new Error('链上查询暂不可用，请重试');
    const data=await response.json();
    if(data.jsonrpc!=='2.0'||data.id!==id||data.error||!Object.hasOwn(data,'result'))throw new Error('链上结果暂时无法核实');
    return data.result;
  }
  const [chain,epCode,delegateCode]=await Promise.all([rpc('eth_chainId'),rpc('eth_getCode',[network.entryPoint,'latest']),rpc('eth_getCode',[network.delegate,'latest'])]);
  if(BigInt(chain)!==421614n)throw new Error('只支持查询 Arbitrum Sepolia');
  if(epCode==='0x'||delegateCode==='0x'||keccak256(epCode)!==network.entryPointCodeHash||keccak256(delegateCode)!==network.delegateCodeHash)throw new Error('DEPLOYMENT_MISMATCH：合约代码与部署清单不一致');
  let operation:OperationStatus={hash:reference.hash,submission:'unknown',execution:'unknown',confirmation:'pending'};
  let transactionHash:string|undefined;
  const hint=await rpc('eth_getUserOperationReceipt',[reference.hash],network.bundlerUrl);
  const candidate=hint?.receipt?.transactionHash??hint?.transactionHash;
  if(typeof candidate==='string'&&/^0x[0-9a-fA-F]{64}$/.test(candidate)){
    const receipt=await rpc('eth_getTransactionReceipt',[candidate]);
    let event:{success:boolean}|undefined;
    if(receipt?.transactionHash?.toLowerCase()===candidate.toLowerCase()&&receipt.to?.toLowerCase()===network.entryPoint.toLowerCase()&&receipt.status==='0x1'&&/^0x[0-9a-fA-F]{64}$/.test(receipt.blockHash)&&/^0x[0-9a-fA-F]+$/.test(receipt.blockNumber)){
      for(const log of receipt.logs??[]){
        if(log.address?.toLowerCase()!==network.entryPoint.toLowerCase())continue;
        try{
          const decoded=decodeEventLog({abi:entryPoint09Abi,data:log.data,topics:log.topics});
          if(decoded.eventName==='UserOperationEvent'&&decoded.args.userOpHash.toLowerCase()===reference.hash&&decoded.args.sender.toLowerCase()===reference.address)event={success:decoded.args.success};
        }catch{/* Only the configured EntryPoint's matching operation event is execution evidence. */}
      }
      if(event){
        const [canonical,head]=await Promise.all([rpc('eth_getBlockByNumber',[receipt.blockNumber,false]),rpc('eth_getBlockByNumber',['latest',false])]);
        transactionHash=candidate;
        if(canonical?.hash?.toLowerCase()!==receipt.blockHash.toLowerCase())operation={...operation,confirmation:'reorged'};
        else{
          const required=network.confirmationsRequired??(network.mode==='local'?1:undefined);
          const depth=BigInt(head.number)-BigInt(receipt.blockNumber)+1n;
          const confirmed=required!==undefined&&Number.isSafeInteger(required)&&required>0&&depth>=BigInt(required);
          operation={...operation,submission:'accepted',execution:event.success?'succeeded':'reverted',confirmation:confirmed?'confirmed':'pending'};
        }
      }
    }
  }
  const [balance,code,finalChain]=await Promise.all([rpc('eth_getBalance',[reference.address,'latest']),rpc('eth_getCode',[reference.address,'latest']),rpc('eth_chainId')]);
  if(BigInt(finalChain)!==421614n||typeof balance!=='string'||!/^0x[0-9a-fA-F]+$/.test(balance)||typeof code!=='string')throw new Error('当前链上状态无法核实，请重新查询');
  const expected=`0xef0100${network.delegate.slice(2).toLowerCase()}`;
  return{reference,wallet:{address:reference.address,balance:formatEther(BigInt(balance)),delegation:code==='0x'?'undelegated':code.toLowerCase()===expected?'enabled':'unknown'},operation,...(transactionHash?{transactionHash}:{} )};
}
