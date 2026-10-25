import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ApiError, BASE } from '../client/src/api';
import { isNotFound, reasoning } from '../client/src/reasoning/api';
import { AttemptNotFound, DomainNotFound } from '../client/src/reasoning/pages';

/**
 * Final review UI-5 / LEFT-1: an unknown or foreign attempt id, or a mistyped domain, is a not-found
 * page (a heading and the ways back), not a bare "Assessment attempt not found" with a Retry button
 * and placeholder breadcrumbs.
 */

const go = () => {};
const linksOf = (html: string) => [...html.matchAll(/<a [^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/g)].map((m) => [m[1], m[2]]);

describe('not-found states (final review UI-5)', () => {
  it('reads the engine\'s 404 and a malformed-id 422 as not found, and nothing else', async () => {
    const realFetch = globalThis.fetch;
    const answer = (status: number, body: unknown) => { globalThis.fetch = (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as typeof fetch; };
    const errorOf = async () => { try { await reasoning.get('00000000-0000-4000-8000-000000000000'); return null; } catch (e) { return e; } };
    try {
      // What the engine answers for an id that is not this learner's (loadOwnedAttempt: a miss is 404, never 403).
      answer(404, { error: { code: 'REASONING_ATTEMPT_NOT_FOUND', message: 'Assessment attempt not found', retryable: false, request_id: 'r1' } });
      expect(isNotFound(await errorOf())).toBe(true);
      // The route guard's answer for an id that matches the client route but is not a UUID.
      answer(422, { error: { code: 'VALIDATION_FAILED', message: 'The request is not valid', retryable: false, request_id: 'r2', details: [{ path: 'id', message: 'must be a UUID' }] } });
      expect(isNotFound(await errorOf())).toBe(true);
      // Transient failures keep the error with its Retry.
      answer(503, { error: 'ThreatReady is starting up.', code: 'STARTING' });
      expect(isNotFound(await errorOf())).toBe(false);
      answer(500, { error: { code: 'INTERNAL_ERROR', message: 'Internal error', retryable: true, request_id: 'r3' } });
      expect(isNotFound(await errorOf())).toBe(false);
      answer(429, { error: 'Too many requests.', code: 'RATE_LIMITED' });
      expect(isNotFound(await errorOf())).toBe(false);
      globalThis.fetch = (async () => { throw new TypeError('network down'); }) as typeof fetch;
      expect(isNotFound(await errorOf())).toBe(false);
    } finally { globalThis.fetch = realFetch; }
    expect(isNotFound(new Error('boom'))).toBe(false);
    expect(isNotFound(null)).toBe(false);
    expect(isNotFound(new ApiError(401, 'Signing you in…', 'AUTH_REQUIRED'))).toBe(false);
  });

  it('an unknown attempt has a heading, real breadcrumbs and links to history and the domains, with no Retry', () => {
    const html = renderToStaticMarkup(createElement(AttemptNotFound, { go }));
    expect(html).toMatch(/<h1 class="tr-h1">This assessment doesn’t exist or isn’t yours<\/h1>/);
    expect(html).toContain('The link may be mistyped or out of date.');
    expect(linksOf(html)).toEqual([[BASE, 'All domains'], [`${BASE}history`, 'Your assessments'], [BASE, 'All domains']]);
    expect(html).toMatch(/aria-label="Breadcrumb".*<span>Not found<\/span><\/span><\/nav>/);
    expect(html).not.toContain('Retry');
    expect(html).not.toContain('role="alert"');
    // The placeholder crumbs of a loading attempt are gone.
    expect(html).not.toMatch(/<span>(Domain|Assessment)<\/span>/);
  });

  it('an unknown domain has a heading and the ways back, not the URL slug as a crumb', () => {
    const html = renderToStaticMarkup(createElement(DomainNotFound, { go }));
    expect(html).toMatch(/<h1 class="tr-h1">That domain does not exist<\/h1>/);
    expect(linksOf(html)).toEqual([[BASE, 'All domains'], [BASE, 'All domains'], [`${BASE}history`, 'Your assessments']]);
    expect(html).toMatch(/aria-label="Breadcrumb".*<span>Not found<\/span><\/span><\/nav>/);
    expect(html).not.toContain('Retry');
  });
});
