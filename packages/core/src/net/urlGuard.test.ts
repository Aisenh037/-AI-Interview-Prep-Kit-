import { describe, expect, it, vi } from 'vitest';
import { createNetworkPolicy } from './networkPolicy.js';
import { checkUrlShape, normaliseUrl, validateUrl } from './urlGuard.js';

const strict = createNetworkPolicy({
  nodeEnv: 'production',
  allowPrivateEnv: undefined,
  defaultAllowPrivate: false,
});

const permissive = createNetworkPolicy({
  nodeEnv: 'development',
  allowPrivateEnv: 'true',
  defaultAllowPrivate: true,
  extraPorts: [8099, 3000, 8080],
});

describe('the production gate cannot be opened by configuration', () => {
  it('ignores ALLOW_PRIVATE_NETWORK=true when NODE_ENV=production, and says so', () => {
    const onWarn = vi.fn();
    const policy = createNetworkPolicy({
      nodeEnv: 'production',
      allowPrivateEnv: 'true',
      defaultAllowPrivate: true,
      onWarn,
    });
    expect(policy.allowPrivate).toBe(false);
    expect(policy.isAllowedAddress('127.0.0.1')).toBe(false);
    expect(onWarn).toHaveBeenCalledOnce();
    expect(onWarn.mock.calls[0]![0]).toContain('ignored');
  });

  it('permits loopback for the batch harness when the variable is unset', () => {
    // This is what makes `npm run evaluate` work against http://localhost:8099/
    // with no setup, which the brief requires.
    const policy = createNetworkPolicy({
      nodeEnv: undefined,
      allowPrivateEnv: undefined,
      defaultAllowPrivate: true,
    });
    expect(policy.allowPrivate).toBe(true);
    expect(policy.isAllowedAddress('127.0.0.1')).toBe(true);
  });

  it('defaults the API server to blocking private addresses', () => {
    const policy = createNetworkPolicy({
      nodeEnv: 'development',
      allowPrivateEnv: undefined,
      defaultAllowPrivate: false,
    });
    expect(policy.isAllowedAddress('10.0.0.5')).toBe(false);
  });
});

describe('blocked addresses', () => {
  const blocked = [
    ['loopback v4', 'http://127.0.0.1/'],
    ['loopback v4, other octet', 'http://127.3.2.1/'],
    ['private 10/8', 'http://10.0.0.5/'],
    ['private 172.16/12', 'http://172.20.1.1/'],
    ['private 192.168/16', 'http://192.168.1.1/'],
    ['carrier-grade NAT', 'http://100.64.0.1/'],
    ['link-local', 'http://169.254.1.1/'],
    ['cloud metadata', 'http://169.254.169.254/latest/meta-data/'],
    ['unspecified', 'http://0.0.0.0/'],
    ['multicast', 'http://224.0.0.1/'],
    ['loopback v6', 'http://[::1]/'],
    ['IPv4-mapped IPv6 loopback', 'http://[::ffff:127.0.0.1]/'],
    ['unique local v6', 'http://[fd00::1]/'],
    ['link-local v6', 'http://[fe80::1]/'],
    ['decimal-encoded loopback', 'http://2130706433/'],
    ['octal-encoded loopback', 'http://0177.0.0.1/'],
    ['hex-encoded loopback', 'http://0x7f000001/'],
  ] as const;

  it.each(blocked)('rejects %s', (_label, url) => {
    const result = checkUrlShape(url, strict);
    expect(result.ok, `${url} should have been rejected`).toBe(false);
  });

  it('blocks the cloud metadata address even when private addresses are permitted', () => {
    // The one exception to the permissive policy. A crawler that will fetch
    // 169.254.169.254 on request is a credential leak, in any environment.
    expect(permissive.isAllowedAddress('169.254.169.254')).toBe(false);
    expect(checkUrlShape('http://169.254.169.254/latest/meta-data/', permissive).ok).toBe(false);
  });

  it.each([
    ['file', 'file:///etc/passwd'],
    ['gopher', 'gopher://example.com/'],
    ['javascript', 'javascript:alert(1)'],
    ['data', 'data:text/html,hello'],
    ['ftp', 'ftp://example.com/'],
  ])('rejects the %s scheme', (_label, url) => {
    const result = checkUrlShape(url, permissive);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('URL_SCHEME_UNSUPPORTED');
  });

  it('rejects embedded credentials', () => {
    const result = checkUrlShape('http://user:pass@example.com/', strict);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('URL_CREDENTIALS_FORBIDDEN');
  });

  it('rejects a non-web port in production', () => {
    const result = checkUrlShape('http://example.com:22/', strict);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('URL_BLOCKED_PORT');
  });
});

describe('allowed addresses', () => {
  it.each([
    'https://example.com/',
    'http://example.com:80/',
    'https://careers.acme.co.uk/interview-process',
    'https://handbook.gitlab.com/handbook/hiring/',
  ])('accepts %s', (url) => {
    expect(checkUrlShape(url, strict).ok).toBe(true);
  });

  it('accepts the fixture server port when private access is permitted', () => {
    expect(checkUrlShape('http://localhost:8099/acme/', permissive).ok).toBe(true);
    expect(checkUrlShape('http://127.0.0.1:8099/acme/', permissive).ok).toBe(true);
  });

  it('rejects that same fixture URL in production', () => {
    expect(checkUrlShape('http://127.0.0.1:8099/acme/', strict).ok).toBe(false);
  });
});

describe('DNS resolution is checked, not just the literal host', () => {
  const resolvesTo = (...addresses: string[]) => async () =>
    addresses.map((address) => ({ address }));

  it('rejects a public hostname that resolves into private space', async () => {
    // The rebinding case: the name looks public, the address is not.
    const result = await validateUrl('https://rebind.example/', strict, resolvesTo('10.1.2.3'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('URL_BLOCKED_PRIVATE');
  });

  it('rejects when only one of several records is private', async () => {
    // One public A record is not a licence to connect: the resolver may hand us
    // the private one on the connection that matters.
    const result = await validateUrl(
      'https://mixed.example/',
      strict,
      resolvesTo('93.184.216.34', '192.168.0.9'),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('URL_BLOCKED_PRIVATE');
  });

  it('accepts a hostname whose records are all public', async () => {
    const result = await validateUrl(
      'https://example.com/',
      strict,
      resolvesTo('93.184.216.34', '93.184.216.35'),
    );
    expect(result.ok).toBe(true);
  });

  it('reports a resolution failure as its own outcome, not as a crash', async () => {
    const result = await validateUrl('https://does-not-exist.invalid/', strict, async () => {
      throw new Error('ENOTFOUND');
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('FETCH_DNS_FAILURE');
  });

  it('reports an empty resolution as a failure rather than accepting it', async () => {
    const result = await validateUrl('https://empty.example/', strict, resolvesTo());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('FETCH_DNS_FAILURE');
  });
});

describe('normalisation', () => {
  it('strips fragments, tracking parameters and a trailing slash', () => {
    const url = normaliseUrl('https://Example.com/careers/?utm_source=x&role=be#top');
    expect(url?.toString()).toBe('https://example.com/careers?role=be');
  });

  it('resolves relative links against a base, including localhost fixtures', () => {
    expect(normaliseUrl('../interview', 'http://localhost:8099/acme/careers/')?.toString()).toBe(
      'http://localhost:8099/acme/interview',
    );
    expect(normaliseUrl('/about', 'http://localhost:8099/acme/careers')?.toString()).toBe(
      'http://localhost:8099/about',
    );
  });

  it('returns null rather than throwing on rubbish', () => {
    expect(normaliseUrl('not a url')).toBeNull();
    expect(normaliseUrl('')).toBeNull();
  });
});

describe('dual-stack hosts', () => {
  // Regression guard. `localhost` resolves to ::1 before 127.0.0.1 on Windows.
  // Pinning a connection to only the first validated address made every fetch
  // against an IPv4-only server fail, and every kit was silently built from the
  // job description alone — a broken pipeline that still reported success.
  it('validates and returns every address for a dual-stack host', async () => {
    const result = await validateUrl('http://localhost:8099/acme/', permissive, async () => [
      { address: '::1' },
      { address: '127.0.0.1' },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.addresses).toEqual(['::1', '127.0.0.1']);
  });

  it('still rejects the host if either address is disallowed under a strict policy', async () => {
    const result = await validateUrl('http://dual.example/', strict, async () => [
      { address: '93.184.216.34' },
      { address: '::1' },
    ]);
    expect(result.ok).toBe(false);
  });
});
