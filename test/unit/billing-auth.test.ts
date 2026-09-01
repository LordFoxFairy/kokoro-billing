import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createBillingAuth } from '../../src/infrastructure/auth/billing-auth.js';

const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe('billing production authentication adapter', () => {
  it('verifies RS256 IAM sessions from the IAM JWKS and binds the tenant header to the token', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const jwk = await exportJWK(publicKey);
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ keys: [{ ...jwk, kid: 'billing-test-key', alg: 'RS256', use: 'sig' }] }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('test server did not bind');
    const token = await new SignJWT({ tenant_id: 'site-1' })
      .setProtectedHeader({ alg: 'RS256', kid: 'billing-test-key', typ: 'JWT' })
      .setSubject('team-1')
      .setIssuer('kokoro-iam')
      .setIssuedAt()
      .setExpirationTime('5 minutes')
      .sign(privateKey);
    const auth = createBillingAuth({
      mode: 'jwks',
      internalServiceSecret: 'service-secret',
      operatorProxySecret: 'operator-secret',
      jwksUrl: `http://127.0.0.1:${address.port}/.well-known/jwks.json`,
      issuer: 'kokoro-iam',
    });

    const valid = await auth.user({ headers: { authorization: `Bearer ${token}`, 'x-kokoro-tenant-id': 'site-1' } } as never);
    expect(valid).toEqual({ tenantId: 'site-1', subjectId: 'team-1' });
    const crossSite = await auth.user({ headers: { authorization: `Bearer ${token}`, 'x-kokoro-tenant-id': 'site-2' } } as never);
    expect(crossSite).toBeNull();
  });

  it('keeps local fixture auth separate from production JWT auth', async () => {
    const auth = createBillingAuth({ mode: 'header-fixture', internalServiceSecret: 'service-secret', operatorProxySecret: 'service-secret', issuer: 'kokoro-iam' });
    expect(await auth.user({ headers: { 'x-kokoro-tenant-id': 'site-1', 'x-kokoro-subject': 'team-1' } } as never)).toEqual({ tenantId: 'site-1', subjectId: 'team-1' });
    expect(await auth.user({ headers: { authorization: 'Bearer fixture-token', 'x-kokoro-tenant-id': 'site-1' } } as never)).toBeNull();
  });

  it('requires the trusted BFF proxy marker for operator calls', async () => {
    const auth = createBillingAuth({ mode: 'header-fixture', internalServiceSecret: 'service-secret', operatorProxySecret: 'operator-secret', issuer: 'kokoro-iam' });
    const headers = { 'x-kokoro-tenant-id': 'site-1', 'x-kokoro-operator': 'op-1', 'x-kokoro-role': 'finance', 'x-kokoro-proxy-secret': 'operator-secret' };
    expect(await auth.admin({ headers } as never)).toBeNull();
    expect(await auth.admin({ headers: { ...headers, 'x-kokoro-service': 'admin' } } as never)).toBeNull();
    expect(await auth.admin({ headers: { ...headers, 'x-kokoro-service': 'admin', 'x-kokoro-role': 'billing.admin' } } as never)).toMatchObject({ tenantId: 'site-1', operatorId: 'op-1', role: 'billing.admin' });
  });

  it('accepts only registered internal service identities', async () => {
    const auth = createBillingAuth({ mode: 'header-fixture', internalServiceSecret: 'service-secret', operatorProxySecret: 'service-secret', issuer: 'kokoro-iam' });
    const headers = { 'x-kokoro-tenant-id': 'site-1', 'x-kokoro-internal-secret': 'service-secret' };
    expect(await auth.internal({ headers: { ...headers, 'x-kokoro-service': 'agent' } } as never)).toEqual({ tenantId: 'site-1', serviceId: 'agent' });
    expect(await auth.internal({ headers: { ...headers, 'x-kokoro-service': 'unregistered-service' } } as never)).toBeNull();
  });

  it('keeps the HTTP tenant boundary aligned with the VARCHAR(191) storage contract', async () => {
    const auth = createBillingAuth({ mode: 'header-fixture', internalServiceSecret: 'service-secret', operatorProxySecret: 'service-secret', issuer: 'kokoro-iam' });
    const accepted = `tenant-${'x'.repeat(184)}`;
    expect(accepted.length).toBe(191);
    expect(await auth.user({ headers: { 'x-kokoro-tenant-id': accepted, 'x-kokoro-subject': 'team-1' } } as never)).toMatchObject({ tenantId: accepted });
    expect(await auth.user({ headers: { 'x-kokoro-tenant-id': `${accepted}x`, 'x-kokoro-subject': 'team-1' } } as never)).toBeNull();
    expect(await auth.user({ headers: { 'x-kokoro-tenant-id': '', 'x-kokoro-subject': 'team-1' } } as never)).toBeNull();
  });
});
