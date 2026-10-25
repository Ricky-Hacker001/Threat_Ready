// The catalog's track views, rendered to HTML from catalog data (no browser needed).
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TrackGrid, TrackLabs, type Entry } from '../client/src/catalog';
import { CATALOG } from '../server/catalog';

// What /api/labs answers when SOC (Blue Team, featured on the main page) and the hub's own lab are live.
const labs: Entry[] = CATALOG.map(c => ({ ...c, available: c.id === 'TR-SOC-001' || c.id === 'TR-CLOUD-001', progress: null, progressIn: 'account', onProfile: true }));
const card = (html: string, title: string) => html.split('<li class="tr-card lab-track">').find(x => x.includes(`>${title}</a>`)) ?? '';

describe('labs catalog tracks', () => {
  it('a featured lab counts in its track: Blue Team is live and lists SOC Simulation', () => {
    expect(labs.find(l => l.id === 'TR-SOC-001')).toMatchObject({ home: true, track: 'blue' });
    const html = renderToStaticMarkup(createElement(TrackGrid, { labs, go: () => {} }));
    const blue = card(html, 'Blue Team');
    expect(blue).toContain('1 live'); expect(blue).toContain('SOC Simulation'); expect(blue).toContain('1 available');
    expect(blue).not.toContain('Coming soon'); expect(blue).not.toContain('being prepared');
  });
  it('the Blue Team page lists SOC Simulation under "Available now"', () => {
    const html = renderToStaticMarkup(createElement(TrackLabs, { labs, track: 'blue', open: () => {} }));
    expect(html).toContain('Available now'); expect(html).toContain('SOC Simulation'); expect(html).toContain('href="/soc/"');
    expect(html).not.toContain('No labs in this track yet');
  });
  it('each card says where its progress is kept', () => {
    const html = renderToStaticMarkup(createElement(TrackLabs, { labs: [...labs.filter(l => l.track === 'cloud').map(l => (l.href ? { ...l, available: true, progressIn: 'browser' as const, onProfile: false } : l))], track: 'cloud', open: () => {} }));
    expect(html).toContain('Saved to your ThreatReady account'); expect(html).toContain('Progress is kept in this browser');
    // Kept by the server, but not (or no longer) across restarts: no promise about the account.
    const server = renderToStaticMarkup(createElement(TrackLabs, { labs: labs.filter(l => l.track === 'blue').map(l => ({ ...l, progressIn: 'server' as const })), track: 'blue', open: () => {} }));
    expect(server).toContain('Progress is kept on the ThreatReady lab server'); expect(server).not.toContain('Saved to your ThreatReady account');
  });
});
