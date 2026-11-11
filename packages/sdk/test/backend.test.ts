import { expect, it } from 'vitest';
import { createBackendClient } from '../src/index.js';
import type { FetchLike } from '../src/types.js';

it('posts exact sponsorship DTOs with scoped auth and refuses root secrets', async () => {
  const seen: any[] = [];
  const fetchImpl: FetchLike = async (url, options) => { seen.push({ url, ...options }); return new Response(JSON.stringify({ state: 'issued', sponsorshipId: 'sponsor-1' }), { status: 201 }); };
  const client = createBackendClient('https://backend.invalid', fetchImpl);
  const request = { schemaVersion: '1', chainId: '421614', idempotencyKey: 'same-request-12345678', accountWindow: { validAfter: '1000', validUntil: '1100' }, nonce: '9007199254740995' };
  expect(await client.createSponsorship(request, 'test-session-token')).toEqual({ state: 'issued', sponsorshipId: 'sponsor-1' });
  expect(seen[0].url).toBe('https://backend.invalid/v1/sponsorships');
  expect(seen[0].headers.authorization).toBe('Bearer test-session-token');
  expect(JSON.parse(seen[0].body)).toEqual(request);
  await expect(client.createSponsorship({ ...request, privateKey: 'must-never-leave-client' }, 'test')).rejects.toThrow('FORBIDDEN_SECRET');
  expect(seen.length).toBe(1);
});
