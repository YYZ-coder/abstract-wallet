import { expect, it } from 'vitest';
import { createBundlerHttpServer } from '../src/http.js';
it('exposes bounded loopback JSON RPC only to allowed browser origins', async () => {
  const server = createBundlerHttpServer(async request => ({ jsonrpc: '2.0', id: (request as any).id, result: ['0x3333333333333333333333333333333333333333'] }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as any).port;
    const response = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST', headers: { 'content-type':'application/json', origin:'http://127.0.0.1:5173' }, body: JSON.stringify({ jsonrpc:'2.0',id:1,method:'eth_supportedEntryPoints',params:[] }) });
    expect(await response.json()).toEqual({ jsonrpc:'2.0',id:1,result:['0x3333333333333333333333333333333333333333'] });
    expect(response.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:5173');
    expect((await fetch(`http://127.0.0.1:${port}/`, { method:'POST',headers:{origin:'https://untrusted.invalid'},body:'{}' })).status).toBe(403);
  } finally { await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())); }
});
