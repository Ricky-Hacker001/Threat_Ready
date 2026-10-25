import { describe, it, expect, vi, afterEach } from 'vitest';
import { onboardIdentity, plausibleSessionCookie, sessionTokenOf } from '../server/identity';

// A well-formed Better Auth session cookie value: <token>.<44-char base64 signature ending "=">.
const sig = 'A'.repeat(43) + '=';
const token = (t: string) => `${t}.${sig}`;
const cookie = (t: string, extra = '') => `tr.session_token=${token(t)}${extra ? '; ' + extra : ''}`;

function stubOnboard(user: any = { id: 'u1', name: 'Asha', isTrial: false, isAdmin: false }) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ user }), { status: 200, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
afterEach(() => vi.unstubAllGlobals());

describe('onboardIdentity — IP-REG1 / junk-cookie and cache keying', () => {
  it('a cookie without a well-formed tr.session_token never reaches onboard', async () => {
    const fetchMock = stubOnboard();
    const id = onboardIdentity({ identityUrl: 'http://onboard', internalToken: 't' });
    for (const c of [undefined, 'other=1', 'tr.session_token=nope', `tr.session_token=x.${'A'.repeat(10)}`]) {
      const r = await id({ cookie: c } as any, 'ip1');
      expect(r.ok).toBe(false);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('caches on the session token, so a rotating non-session cookie does not bust the cache', async () => {
    const fetchMock = stubOnboard();
    const id = onboardIdentity({ identityUrl: 'http://onboard', internalToken: 't', cacheSeconds: 30 });
    const a = await id({ cookie: cookie('sess', 'ga=111') } as any, 'ip1');
    const b = await id({ cookie: cookie('sess', 'ga=222') } as any, 'ip1'); // same session, different analytics cookie
    expect(a.ok && b.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1); // second request is a cache hit, no new lookup
    // A different session token is a distinct key → a second lookup.
    await id({ cookie: cookie('other') } as any, 'ip1');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('peek answers from cache only (a known session), null otherwise', async () => {
    stubOnboard();
    const id = onboardIdentity({ identityUrl: 'http://onboard', internalToken: 't', cacheSeconds: 30 });
    expect(id.peek?.({ cookie: cookie('sess') } as any)).toBeNull(); // not looked up yet
    await id({ cookie: cookie('sess', 'ga=1') } as any, 'ip1');
    expect(id.peek?.({ cookie: cookie('sess', 'ga=2') } as any)?.id).toBe('u1'); // cached, any extra cookie
    expect(id.peek?.({ cookie: 'junk=1' } as any)).toBeNull();
  });

  it('a classroom behind one NAT address opening the lab together (cold cache) is served, not refused', async () => {
    // Onboard answers in 100 ms; 40 learners each make 3 calls at once from the same client address.
    let active = 0, peak = 0;
    const fetchMock = vi.fn(async (_url: any, init: any) => {
      active++; peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 100));
      active--;
      const name = /tr\.session_token=([^.;]+)/.exec(String(init?.headers?.cookie))![1];
      return new Response(JSON.stringify({ user: { id: `u_${name}`, name, isTrial: false, isAdmin: false } }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const id = onboardIdentity({ identityUrl: 'http://onboard', internalToken: 't' });
    const calls = Array.from({ length: 40 }, (_, i) => [0, 1, 2].map(() => id({ cookie: cookie(`learner${i}`) } as any, 'nat'))).flat();
    const results = await Promise.all(calls);
    expect(results.filter((r) => !r.ok)).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(40); // same-session calls share one lookup, even while it waits for a slot
    expect(peak).toBeLessThanOrEqual(16);
  }, 15_000);

  it('a learner onboard confirmed recently is never shed behind a flood from the same address', async () => {
    const pending: (() => void)[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: any, init: any) => {
      const name = /tr\.session_token=([^.;]+)/.exec(String(init?.headers?.cookie))![1];
      if (name.startsWith('slow')) { await new Promise<void>((r) => pending.push(r)); return new Response('{}', { status: 401 }); }
      return new Response(JSON.stringify({ user: { id: `u_${name}`, name, isTrial: false, isAdmin: false } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const id = onboardIdentity({ identityUrl: 'http://onboard', internalToken: 't', cacheSeconds: 0.05, maxInFlight: 10, maxPerClient: 2 });
    expect(await id({ cookie: cookie('good') } as any, 'flooder')).toMatchObject({ ok: true });
    const flood = Array.from({ length: 20 }, (_, i) => id({ cookie: cookie(`slow${i}`) } as any, 'flooder'));
    await new Promise((r) => setTimeout(r, 80)); // the cached answer for 'good' has expired meanwhile
    expect(pending.length).toBe(2);
    expect(await id({ cookie: cookie('good') } as any, 'flooder')).toMatchObject({ ok: true, user: { id: 'u_good' } });
    // Onboard answers: the queued lookups then run, two at a time; nothing is left hanging.
    while (pending.length) { pending.shift()!(); await new Promise((r) => setTimeout(r, 5)); }
    const r = await Promise.all(flood);
    expect(r.every((x) => x.ok === false)).toBe(true);
  }, 15_000);

  it('exports agree on what a plausible session cookie is (LABHUB handoff)', () => {
    expect(plausibleSessionCookie(cookie('sess'))).toBe(true);
    expect(plausibleSessionCookie('__Secure-tr.session_token=' + token('s'))).toBe(true);
    expect(plausibleSessionCookie('tr.session_token=bad')).toBe(false);
    expect(sessionTokenOf(cookie('sess'))).toBe(token('sess'));
  });
});
