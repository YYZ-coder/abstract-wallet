import { createServer } from 'node:http';
export function createBundlerHttpServer(handle: (request: unknown) => Promise<unknown>, allowedOrigins = ['http://127.0.0.1:5173','http://localhost:5173']) {
  return createServer(async (request, response) => {
    const origin = request.headers.origin;
    const host = request.headers.host?.split(':')[0];
    response.setHeader('content-type','application/json'); response.setHeader('cache-control','no-store');
    if (!['127.0.0.1','localhost'].includes(host ?? '') || (origin && !allowedOrigins.includes(origin))) { response.writeHead(403); response.end('{"error":"LOCAL_ORIGIN_REQUIRED"}'); return; }
    if (origin) { response.setHeader('access-control-allow-origin',origin); response.setHeader('vary','Origin'); }
    response.setHeader('access-control-allow-methods','POST, OPTIONS'); response.setHeader('access-control-allow-headers','content-type');
    if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
    if (request.method !== 'POST' || !['/','/rpc'].includes(request.url ?? '')) { response.writeHead(405); response.end('{"error":"POST_JSON_RPC_REQUIRED"}'); return; }
    try {
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 131072) { response.writeHead(413); response.end('{"error":"REQUEST_TOO_LARGE"}'); return; }
        chunks.push(Buffer.from(chunk));
      }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const result = await handle(input);
      response.end(JSON.stringify(result, (_key,value)=>typeof value==='bigint'?`0x${value.toString(16)}`:value));
    } catch { response.end('{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"INVALID_JSON_OR_REQUEST"}}'); }
  });
}
