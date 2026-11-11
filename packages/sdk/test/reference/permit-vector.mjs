// Independent reference: viem 2.57.17, no imports from the SDK under test.
// Private key 1 is a public test fixture and must never hold real funds.
import { encodeAbiParameters, hashTypedData, keccak256, parseAbiParameters, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { writeFileSync, mkdirSync } from 'node:fs';
const addr = digit => `0x${digit.repeat(40)}`;
const names = [['version','uint8'],['expectedDelegate','address'],['sender','address'],['entryPoint','address'],['nonce','uint256'],['initCodeHash','bytes32'],['callDataHash','bytes32'],['accountGasLimits','bytes32'],['preVerificationGas','uint256'],['gasFees','bytes32'],['paymasterVerificationGasLimit','uint128'],['paymasterPostOpGasLimit','uint128'],['validAfter','uint48'],['validUntil','uint48'],['maxCost','uint256'],['reservationId','bytes32']];
const domain = { name: 'AbstractWalletPaymaster', version: '1', chainId: 421614, verifyingContract: addr('4') };
const message = { version:1, expectedDelegate:addr('2'), sender:addr('1'), entryPoint:addr('3'), nonce:7n, initCodeHash:keccak256('0x7702000000000000000000000000000000000000'), callDataHash:keccak256('0x1234'), accountGasLimits:toHex((100000n<<128n)|80000n,{size:32}), preVerificationGas:50000n, gasFees:toHex((1n<<128n)|100n,{size:32}), paymasterVerificationGasLimit:60000n, paymasterPostOpGasLimit:0n, validAfter:1000, validUntil:1100, maxCost:29000000n, reservationId:`0x${'ab'.repeat(32)}` };
const typedData = { domain, types:{Permit:names.map(([name,type])=>({name,type}))}, primaryType:'Permit', message };
const account = privateKeyToAccount(`0x${'00'.repeat(31)}01`);
const signature = await account.signTypedData(typedData);
const paymasterData = encodeAbiParameters(parseAbiParameters('uint8,address,uint48,uint48,uint256,bytes32,bytes'), [1,message.expectedDelegate,1000,1100,29000000n,message.reservationId,signature]);
const vector = { source:'Independent viem 2.57.17 reference; candidate SIGNATURE_FORMATS v1', domain, fields:message, digest:hashTypedData(typedData), sponsorSigner:account.address, signature, paymasterData };
mkdirSync(new URL('../fixtures/', import.meta.url),{recursive:true});
writeFileSync(new URL('../fixtures/permit-v1.json',import.meta.url),JSON.stringify(vector,(_key,value)=>typeof value==='bigint'?value.toString():value,2)+'\n');
