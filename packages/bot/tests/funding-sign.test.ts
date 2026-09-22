// Funding sign + delta regression tests.
//
// GRVT's account_summary exposes only `cumulative_realized_funding_payment`
// per position — a SIGNED running total, negative when the account PAYS
// funding. Three defects used to conspire to hide that:
//   1. client.getFundingHistory() applied Math.abs() to the cumulative.
//   2. pollFundingHistory()/backfillFundingHistory() skipped on
//      `delta < 1e-8`, which discards every payment once the sign is kept.
//   3. The dashboard summed with Math.abs(), reporting costs as income.
//
// These tests pin the delta arithmetic so a negative cumulative is recorded
// and SUM(payment_usdt) always converges on the true cumulative.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    getBotsByStatus: vi.fn(),
    getAllBots: vi.fn().mockResolvedValue([]),
    getFundingHistoryByBot: vi.fn(),
    createFundingRecord: vi.fn().mockResolvedValue(1),
    getBot: vi.fn(),
    updateBot: vi.fn(),
    close: vi.fn(),
  },
}));

vi.mock('../src/database/db.js', () => ({ db: mockDb }));
vi.mock('../src/api/client.js', () => ({
  grvtClient: {},
  GRVTClient: vi.fn(),
}));

import { GridEngine } from '../src/bot/grid-engine.js';
import { fundingNetUsdt, fundingPaidUsdt } from '../src/bot/funding-math.js';

const BOT = {
  id: 5,
  user_id: 1,
  pair: 'XRP_USDT_Perp',
  status: 'running',
  grvt_sub_account_id: null,
  alert_funding_rate_pct: null as number | null,
  last_funding_cumulative: null as number | null,
  last_funding_alert_at: null as number | null,
};

/** Build an engine whose per-bot client returns one funding snapshot. */
function engineWith(snapshot: Record<string, string> | null) {
  const engine = new GridEngine();
  const client = {
    getFundingHistory: vi.fn().mockResolvedValue(snapshot ? [snapshot] : []),
  };
  (engine as any).getClientForBot = vi.fn().mockResolvedValue(client);
  return { engine, client };
}

function snapshot(cumulative: string, rate = '0.0001') {
  return {
    sub_account_id: 'mock-sub',
    instrument: 'XRP_USDT_Perp',
    funding_rate: rate,
    payment: cumulative,
    position_size: '183.2',
    funding_time: Math.floor(Date.now() / 1000),
  };
}

/** Rows as getFundingHistoryByBot() returns them. */
function storedRows(...payments: number[]) {
  return payments.map((p, i) => ({
    id: i + 1,
    bot_id: 5,
    instrument: 'XRP_USDT_Perp',
    funding_rate: 0,
    payment_usdt: p,
    position_size: 183.2,
    funding_time: new Date().toISOString(),
    created_at: new Date().toISOString(),
  }));
}

describe('pollFundingHistory — signed cumulative', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.getBotsByStatus.mockResolvedValue([{ ...BOT }]);
    mockDb.createFundingRecord.mockResolvedValue(1);
  });

  it('records a NEGATIVE delta when the account pays funding', async () => {
    mockDb.getFundingHistoryByBot.mockResolvedValue([]);
    const { engine } = engineWith(snapshot('-2.34'));

    await (engine as any).pollFundingHistory();

    expect(mockDb.createFundingRecord).toHaveBeenCalledTimes(1);
    const row = mockDb.createFundingRecord.mock.calls[0]![0];
    expect(row.payment_usdt).toBeCloseTo(-2.34, 8);
    expect(row.bot_id).toBe(5);
  });

  it('still records funding RECEIVED (positive cumulative)', async () => {
    mockDb.getFundingHistoryByBot.mockResolvedValue([]);
    const { engine } = engineWith(snapshot('1.5'));

    await (engine as any).pollFundingHistory();

    const row = mockDb.createFundingRecord.mock.calls[0]![0];
    expect(row.payment_usdt).toBeCloseTo(1.5, 8);
  });

  it('self-heals corrupt positive history: stored SUM converges on the true cumulative', async () => {
    // Production state: 124 rows written under Math.abs(), summing to +0.0353,
    // while GRVT's real cumulative is -2.34.
    mockDb.getFundingHistoryByBot.mockResolvedValue(storedRows(0.02, 0.0153));
    const { engine } = engineWith(snapshot('-2.34'));

    await (engine as any).pollFundingHistory();

    const row = mockDb.createFundingRecord.mock.calls[0]![0];
    const storedTotal = 0.02 + 0.0153;
    expect(row.payment_usdt).toBeCloseTo(-2.34 - storedTotal, 8);
    // The whole point: after this correcting row, SUM == the true cumulative.
    expect(storedTotal + row.payment_usdt).toBeCloseTo(-2.34, 8);
  });

  it('writes nothing when the cumulative has not moved', async () => {
    mockDb.getFundingHistoryByBot.mockResolvedValue(storedRows(-2.34));
    const { engine } = engineWith(snapshot('-2.34'));

    await (engine as any).pollFundingHistory();

    expect(mockDb.createFundingRecord).not.toHaveBeenCalled();
  });

  it('records each subsequent payment as an incremental delta', async () => {
    mockDb.getFundingHistoryByBot.mockResolvedValue(storedRows(-2.34));
    const { engine } = engineWith(snapshot('-2.61'));

    await (engine as any).pollFundingHistory();

    const row = mockDb.createFundingRecord.mock.calls[0]![0];
    expect(row.payment_usdt).toBeCloseTo(-0.27, 8);
  });

  it('skips the bot when the snapshot is empty', async () => {
    mockDb.getFundingHistoryByBot.mockResolvedValue([]);
    const { engine } = engineWith(null);

    await (engine as any).pollFundingHistory();

    expect(mockDb.createFundingRecord).not.toHaveBeenCalled();
  });
});

describe('funding rate alert', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.getFundingHistoryByBot.mockResolvedValue([]);
    mockDb.createFundingRecord.mockResolvedValue(1);
  });

  it('fires once the real rate exceeds the per-bot threshold', async () => {
    mockDb.getBotsByStatus.mockResolvedValue([
      { ...BOT, alert_funding_rate_pct: 0.005 },
    ]);
    const { engine } = engineWith(snapshot('-2.34', '0.0001')); // 0.01%
    const alerts: any[] = [];
    engine.on('fundingRateAlert', (a) => alerts.push(a));

    await (engine as any).pollFundingHistory();

    expect(alerts).toHaveLength(1);
    expect(alerts[0].botId).toBe(5);
    expect(alerts[0].fundingRatePct).toBeCloseTo(0.01, 6);
  });

  it('stays silent below the threshold', async () => {
    mockDb.getBotsByStatus.mockResolvedValue([
      { ...BOT, alert_funding_rate_pct: 5 },
    ]);
    const { engine } = engineWith(snapshot('-2.34', '0.0001'));
    const alerts: any[] = [];
    engine.on('fundingRateAlert', (a) => alerts.push(a));

    await (engine as any).pollFundingHistory();

    expect(alerts).toHaveLength(0);
  });

  it('stays silent when no threshold is configured', async () => {
    mockDb.getBotsByStatus.mockResolvedValue([{ ...BOT }]);
    const { engine } = engineWith(snapshot('-2.34', '0.9'));
    const alerts: any[] = [];
    engine.on('fundingRateAlert', (a) => alerts.push(a));

    await (engine as any).pollFundingHistory();

    expect(alerts).toHaveLength(0);
  });
});

describe('GRVTClient.getFundingHistory — sign preservation', () => {
  /**
   * Build a client whose network calls are stubbed: account_summary returns
   * the positions payload, getTicker returns the live rate.
   */
  async function clientWith(
    positions: any[],
    ticker: any = { funding_rate_8h_curr: '0.00012' }
  ) {
    // The module is vi.mock()'d above for the engine tests — reach past the
    // mock for the real implementation.
    const { GRVTClient } = await vi.importActual<
      typeof import('../src/api/client.js')
    >('../src/api/client.js');
    const client: any = new GRVTClient({
      subAccountId: 'mock-sub',
      apiKey: 'k',
      privateKey: '0x00',
    } as any);
    client.authedRequest = vi.fn().mockResolvedValue({ positions });
    client.getTicker = vi.fn().mockResolvedValue(ticker);
    return client;
  }

  it('keeps the NEGATIVE cumulative intact (Math.abs regression)', async () => {
    const client = await clientWith([
      {
        instrument: 'XRP_USDT_Perp',
        cumulative_realized_funding_payment: '-2.34',
        size: '183.2',
      },
    ]);

    const out = await client.getFundingHistory(50, 'XRP_USDT_Perp');

    expect(out).toHaveLength(1);
    expect(parseFloat(out[0].payment)).toBeCloseTo(-2.34, 8);
  });

  it('keeps a positive cumulative positive', async () => {
    const client = await clientWith([
      {
        instrument: 'XRP_USDT_Perp',
        cumulative_realized_funding_payment: '0.91',
        size: '183.2',
      },
    ]);

    const out = await client.getFundingHistory(50, 'XRP_USDT_Perp');
    expect(parseFloat(out[0].payment)).toBeCloseTo(0.91, 8);
  });

  it('carries the live funding rate instead of a hardcoded zero', async () => {
    const client = await clientWith([
      {
        instrument: 'XRP_USDT_Perp',
        cumulative_realized_funding_payment: '-2.34',
        size: '183.2',
      },
    ]);

    const out = await client.getFundingHistory(50, 'XRP_USDT_Perp');
    expect(parseFloat(out[0].funding_rate)).toBeCloseTo(0.00012, 8);
  });

  it('still returns funding when the ticker lookup fails', async () => {
    const client = await clientWith([
      {
        instrument: 'XRP_USDT_Perp',
        cumulative_realized_funding_payment: '-2.34',
        size: '183.2',
      },
    ]);
    client.getTicker = vi.fn().mockRejectedValue(new Error('ticker timeout'));

    const out = await client.getFundingHistory(50, 'XRP_USDT_Perp');

    expect(out).toHaveLength(1);
    expect(parseFloat(out[0].payment)).toBeCloseTo(-2.34, 8);
    expect(out[0].funding_rate).toBe('0');
  });

  it('filters to the requested instrument', async () => {
    const client = await clientWith([
      {
        instrument: 'ETH_USDT_Perp',
        cumulative_realized_funding_payment: '-9.99',
        size: '0.2',
      },
      {
        instrument: 'XRP_USDT_Perp',
        cumulative_realized_funding_payment: '-2.34',
        size: '183.2',
      },
    ]);

    const out = await client.getFundingHistory(50, 'XRP_USDT_Perp');

    expect(out).toHaveLength(1);
    expect(out[0].instrument).toBe('XRP_USDT_Perp');
  });
});

describe('position flips — GRVT resets its per-position funding meter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.createFundingRecord.mockResolvedValue(1);
  });

  it('parks the watermark at 0 when the position is gone', async () => {
    mockDb.getBotsByStatus.mockResolvedValue([
      { ...BOT, last_funding_cumulative: -5 },
    ]);
    const { engine } = engineWith(null);

    await (engine as any).pollFundingHistory();

    expect(mockDb.updateBot).toHaveBeenCalledWith(5, { last_funding_cumulative: 0 });
    expect(mockDb.createFundingRecord).not.toHaveBeenCalled();
  });

  it('does NOT erase the closed position\'s cost when a new position opens', async () => {
    // Position A accrued -5.00 and closed, so the watermark was parked at 0.
    // GRVT now reports the NEW position's meter at -0.30.
    mockDb.getBotsByStatus.mockResolvedValue([
      { ...BOT, last_funding_cumulative: 0 },
    ]);
    mockDb.getFundingHistoryByBot.mockResolvedValue(storedRows(-5.0));
    const { engine } = engineWith(snapshot('-0.30'));

    await (engine as any).pollFundingHistory();

    const row = mockDb.createFundingRecord.mock.calls[0]![0];
    // The whole fresh meter is new cost — NOT `-0.30 - (-5.00) = +4.70`,
    // which is what the old sum-based delta wrote and which wiped position
    // A's real -5.00 out of the running total.
    expect(row.payment_usdt).toBeCloseTo(-0.3, 8);
    expect(-5.0 + row.payment_usdt).toBeCloseTo(-5.3, 8);
  });

  it('measures against the watermark, not the stored sum, while a position lives', async () => {
    mockDb.getBotsByStatus.mockResolvedValue([
      { ...BOT, last_funding_cumulative: -2.34 },
    ]);
    // A stored sum that disagrees with the watermark must be ignored.
    mockDb.getFundingHistoryByBot.mockResolvedValue(storedRows(-99));
    const { engine } = engineWith(snapshot('-2.61'));

    await (engine as any).pollFundingHistory();

    const row = mockDb.createFundingRecord.mock.calls[0]![0];
    expect(row.payment_usdt).toBeCloseTo(-0.27, 8);
    expect(mockDb.getFundingHistoryByBot).not.toHaveBeenCalled();
  });

  it('seeds the watermark from stored rows on the first ever observation', async () => {
    mockDb.getBotsByStatus.mockResolvedValue([
      { ...BOT, last_funding_cumulative: null },
    ]);
    mockDb.getFundingHistoryByBot.mockResolvedValue(storedRows(0.02, 0.0153));
    const { engine } = engineWith(snapshot('-2.34'));

    await (engine as any).pollFundingHistory();

    const row = mockDb.createFundingRecord.mock.calls[0]![0];
    expect(row.payment_usdt).toBeCloseTo(-2.34 - 0.0353, 8);
    expect(mockDb.updateBot).toHaveBeenCalledWith(5, { last_funding_cumulative: -2.34 });
  });

  it('persists the watermark even when nothing changed', async () => {
    mockDb.getBotsByStatus.mockResolvedValue([
      { ...BOT, last_funding_cumulative: null },
    ]);
    mockDb.getFundingHistoryByBot.mockResolvedValue(storedRows(-2.34));
    const { engine } = engineWith(snapshot('-2.34'));

    await (engine as any).pollFundingHistory();

    expect(mockDb.createFundingRecord).not.toHaveBeenCalled();
    expect(mockDb.updateBot).toHaveBeenCalledWith(5, { last_funding_cumulative: -2.34 });
  });
});

describe('funding alert cooldown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.getFundingHistoryByBot.mockResolvedValue([]);
    mockDb.createFundingRecord.mockResolvedValue(1);
  });

  it('suppresses a repeat alert inside the cooldown window', async () => {
    mockDb.getBotsByStatus.mockResolvedValue([
      {
        ...BOT,
        alert_funding_rate_pct: 0.005,
        last_funding_alert_at: Date.now() - 60_000, // 1 minute ago
      },
    ]);
    const { engine } = engineWith(snapshot('-2.34', '0.0001'));
    const alerts: any[] = [];
    engine.on('fundingRateAlert', (a) => alerts.push(a));

    await (engine as any).pollFundingHistory();

    expect(alerts).toHaveLength(0);
  });

  it('alerts again once the cooldown has elapsed', async () => {
    mockDb.getBotsByStatus.mockResolvedValue([
      {
        ...BOT,
        alert_funding_rate_pct: 0.005,
        last_funding_alert_at: Date.now() - 7 * 60 * 60 * 1000, // 7h ago
      },
    ]);
    const { engine } = engineWith(snapshot('-2.34', '0.0001'));
    const alerts: any[] = [];
    engine.on('fundingRateAlert', (a) => alerts.push(a));

    await (engine as any).pollFundingHistory();

    expect(alerts).toHaveLength(1);
  });
});

describe('funding-math — the canonical sign conventions', () => {
  it('reports a cost as positive "funding paid"', () => {
    expect(fundingPaidUsdt(storedRows(-2.34))).toBeCloseTo(2.34, 8);
  });

  it('reports a credit as negative "funding paid"', () => {
    expect(fundingPaidUsdt(storedRows(1.2))).toBeCloseTo(-1.2, 8);
  });

  it('keeps P&L polarity in the net total', () => {
    expect(fundingNetUsdt(storedRows(-2.34))).toBeCloseTo(-2.34, 8);
  });

  it('the two helpers are exact inverses', () => {
    const rows = storedRows(-3.0, 1.0, -0.25);
    expect(fundingPaidUsdt(rows)).toBeCloseTo(-fundingNetUsdt(rows), 8);
  });

  it('nets mixed rows instead of inflating them (the Math.abs bug)', () => {
    const rows = storedRows(-3.0, 1.0);
    expect(fundingPaidUsdt(rows)).toBeCloseTo(2.0, 8);
    // What the old Math.abs() reduce would have produced:
    const legacy = rows.reduce((s, r) => s + Math.abs(r.payment_usdt), 0);
    expect(legacy).toBeCloseTo(4.0, 8);
    expect(legacy).not.toBeCloseTo(fundingPaidUsdt(rows), 8);
  });

  it('returns 0 for an empty history', () => {
    expect(fundingPaidUsdt([])).toBe(-0);
    expect(fundingNetUsdt([])).toBe(0);
  });
});
