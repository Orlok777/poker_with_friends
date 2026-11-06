import { afterEach, describe, expect, it } from 'vitest';
import { createHarness } from './helpers.js';

const h = createHarness();

afterEach(() => h.cleanup());

const get = (port: number) => fetch(`http://127.0.0.1:${port}/api/public-ip`);

describe('GET /api/public-ip', () => {
  it('returns the looked-up address with the port the server listens on', async () => {
    const { srv } = await h.boot({ publicIpLookup: async () => '203.0.113.7' });
    const res = await get(srv.port);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ip: '203.0.113.7', port: srv.port });
  });

  it('asks the outside service once for repeated clicks', async () => {
    let calls = 0;
    const { srv } = await h.boot({ publicIpLookup: async () => (++calls, '203.0.113.7') });
    await get(srv.port);
    await get(srv.port);
    expect(calls).toBe(1);
  });

  it('answers 502 with a message when the lookup fails, and tries again next time', async () => {
    let fail = true;
    const { srv } = await h.boot({
      publicIpLookup: async () => {
        if (fail) throw new Error('offline');
        return '203.0.113.7';
      },
    });
    const bad = await get(srv.port);
    expect(bad.status).toBe(502);
    expect(((await bad.json()) as { error: string }).error).toMatch(/public IP/);
    expect(h.logs.some((m) => m.includes('offline'))).toBe(true);

    fail = false;
    expect((await get(srv.port)).status).toBe(200);
  });
});
