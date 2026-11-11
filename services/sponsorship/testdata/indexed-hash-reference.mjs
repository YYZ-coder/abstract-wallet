// Test-only independent reference: viem 2.57.17, never imports the production SDK or Go indexer.
import { hashTypedData, concat, toHex } from 'viem';
let input='';for await(const chunk of process.stdin)input+=chunk;
const v=JSON.parse(input);
const hash=hashTypedData({domain:{name:'ERC4337',version:'1',chainId:421614,verifyingContract:v.entryPoint},primaryType:'PackedUserOperation',types:{PackedUserOperation:[
 {name:'sender',type:'address'},{name:'nonce',type:'uint256'},{name:'initCode',type:'bytes'},{name:'callData',type:'bytes'},
 {name:'accountGasLimits',type:'bytes32'},{name:'preVerificationGas',type:'uint256'},{name:'gasFees',type:'bytes32'},{name:'paymasterAndData',type:'bytes'}]},
 message:{sender:v.sender,nonce:0n,initCode:v.delegate,callData:v.callData,
 accountGasLimits:concat([toHex(10n,{size:16}),toHex(10n,{size:16})]),preVerificationGas:10n,
 gasFees:concat([toHex(1n,{size:16}),toHex(1n,{size:16})]),
 paymasterAndData:concat([v.paymaster,toHex(10n,{size:16}),toHex(0n,{size:16}),v.paymasterData])}});
console.log(hash);
