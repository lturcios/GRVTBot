// Funding ingest + sign conventions.
//
// GRVT's funding_payment_history returns one row per 8-hour settlement, each
// with a `tx_id` and a SIGNED `amount` that counts the PAYMENT MADE: positive
// when the account pays, negative when it receives. Verified in production on
// 2026-09-22 against tx 192056279 (-0.015221), which GRVT's UI renders as
// +0.015221 green. We store P&L polarity — negative is a cost — so the client
// negates at the boundary.
//
// This replaced a model that differenced `cumulative_realized_funding_payment`
// against the sum of stored rows. That meter is PER POSITION and restarts when
// a position closes, so every flip wrote a large positive row that erased the
// closed position's real cost.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    getBotsByStatus: vi.fn(),
    getAllBots: vi.fn().mockResolvedValue([]),
    getFundingHistoryByBot: vi.fn().mockResolvedValue([]),
    insertFundingPayment: vi.fn().mockResolvedValue(true),
    deleteLegacyFundingForBot: vi.fn().mockResolvedValue(0),
    countFillsForBot: vi.fn().mockResolvedValue(317),
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
  last_funding_alert_at: null as number | null,
};

/** A payment as getFundingPayments() returns it (already P&L polarity). */
function payment(amountUsdt: number, txId: string, iso = '2026-09-22T00:00:00Z') {
  return {
    tx_id: txId,
    instrument: 'XRP_USDT_Perp',
    currency: 'USDT',
    event_time_ms: Date.parse(iso),
    amount_usdt: amountUsdt,
  };
}

function engineWith(payments: ReturnType<typeof payment>[], ticker: any = null) {
  const engine = new GridEngine();
  const client = {
    getFundingPayments: vi.fn().mockResolvedValue(payments),
    getTicker: ticker
      ? vi.fn().mockResolvedValue(ticker)
      : vi.fn().mockRejectedValue(new Error('no ticker stub')),
  };
  (engine as any).getClientForBot = vi.fn().mockResolvedValue(client);
  return { engine, client };
}

describe('pollFundingHistory — settled payment ingest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.countFillsForBot.mockResolvedValue(317);
    mockDb.getBotsByStatus.mockResolvedValue([{ ...BOT }]);
    mockDb.insertFundingPayment.mockResolvedValue(true);
  });

  it('stores each settlement with its tx_id and real settlement time', async () => {
    const { engine } = engineWith([
      payment(-0.028144, '195951743', '2026-09-22T00:00:00Z'),
      payment(-0.028686, '195797980', '2026-09-21T16:00:00Z'),
    ]);

    await (engine as any).pollFundingHistory();

    expect(mockDb.insertFundingPayment).toHaveBeenCalledTimes(2);
    const first = mockDb.insertFundingPayment.mock.calls[0]![0];
    expect(first.tx_id).toBe('195951743');
    expect(first.payment_usdt).toBeCloseTo(-0.028144, 8);
    // Real settlement time, not the poll time — the old model stamped
    // Date.now() and drifted the whole series by hours.
    expect(first.funding_time).toBe('2026-09-22T00:00:00.000Z');
  });

  it('keeps a credit positive instead of dropping it', async () => {
    // The old `delta < 1e-8` filter discarded credits outright: tx 192056279
    // (+0.015221 to the account) never reached the table.
    const { engine } = engineWith([
      payment(0.015221, '192056279', '2026-09-13T16:00:00Z'),
    ]);

    await (engine as any).pollFundingHistory();

    const row = mockDb.insertFundingPayment.mock.calls[0]![0];
    expect(row.payment_usdt).toBeCloseTo(0.015221, 8);
  });

  it('re-reads an overlapping window without writing duplicates', async () => {
    // The unique tx_id index reports "no row written" for known settlements.
    mockDb.insertFundingPayment.mockResolvedValueOnce(false);
    mockDb.insertFundingPayment.mockResolvedValueOnce(true);
    const { engine } = engineWith([
      payment(-0.028144, '195951743'),
      payment(-0.028686, '195797980'),
    ]);

    await (engine as any).pollFundingHistory();

    expect(mockDb.insertFundingPayment).toHaveBeenCalledTimes(2);
  });

  it('never writes a watermark — there is no meter to track any more', async () => {
    const { engine } = engineWith([payment(-0.028144, '195951743')]);

    await (engine as any).pollFundingHistory();

    const watermarkWrites = mockDb.updateBot.mock.calls.filter(
      ([, patch]: any[]) => patch && 'last_funding_cumulative' in patch
    );
    expect(watermarkWrites).toHaveLength(0);
  });

  it('tolerates an empty payment list', async () => {
    const { engine } = engineWith([]);

    await (engine as any).pollFundingHistory();

    expect(mockDb.insertFundingPayment).not.toHaveBeenCalled();
  });
});

describe('backfillFundingHistory — one-time rebuild', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.countFillsForBot.mockResolvedValue(317);
    mockDb.getAllBots.mockResolvedValue([{ ...BOT }]);
    mockDb.insertFundingPayment.mockResolvedValue(true);
    mockDb.deleteLegacyFundingForBot.mockResolvedValue(125);
  });

  const legacyRow = { id: 1, bot_id: 5, payment_usdt: 0.03, tx_id: null };
  const realRow = { id: 2, bot_id: 5, payment_usdt: -0.03, tx_id: '195951743' };

  it('restores the real settlements BEFORE purging the synthetic rows', async () => {
    // Ordering is the whole safety argument: an interrupted rebuild must
    // leave the legacy rows in place so the next startup can retry. Deleting
    // first would erase the very marker (NULL tx_id) that triggers the retry.
    mockDb.getFundingHistoryByBot.mockResolvedValue([legacyRow]);
    const order: string[] = [];
    mockDb.insertFundingPayment.mockImplementation(async () => {
      order.push('insert');
      return true;
    });
    mockDb.deleteLegacyFundingForBot.mockImplementation(async () => {
      order.push('delete');
      return 125;
    });
    const { engine } = engineWith([
      payment(-0.028144, '195951743'),
      payment(0.015221, '192056279'),
    ]);

    await (engine as any).backfillFundingHistory();

    expect(order).toEqual(['insert', 'insert', 'delete']);
    expect(mockDb.deleteLegacyFundingForBot).toHaveBeenCalledWith(5);
  });

  it('leaves the synthetic rows intact when an insert throws mid-rebuild', async () => {
    mockDb.getFundingHistoryByBot.mockResolvedValue([legacyRow]);
    mockDb.insertFundingPayment.mockResolvedValueOnce(true);
    mockDb.insertFundingPayment.mockRejectedValueOnce(new Error('SQLITE_BUSY'));
    const { engine } = engineWith([
      payment(-0.028144, '195951743'),
      payment(0.015221, '192056279'),
    ]);

    await (engine as any).backfillFundingHistory();

    expect(mockDb.deleteLegacyFundingForBot).not.toHaveBeenCalled();
  });

  it('does NOT purge when GRVT hit its page cap — history may be incomplete', async () => {
    mockDb.getFundingHistoryByBot.mockResolvedValue([legacyRow]);
    const full = Array.from({ length: 500 }, (_, i) =>
      payment(-0.03, `tx-${i}`, '2026-09-22T00:00:00Z'));
    const { engine } = engineWith(full);

    await (engine as any).backfillFundingHistory();

    expect(mockDb.insertFundingPayment).toHaveBeenCalledTimes(500);
    expect(mockDb.deleteLegacyFundingForBot).not.toHaveBeenCalled();
  });

  it('skips a bot that never traded — funding belongs to the bot that held the position', async () => {
    // Bots 3, 4 and 5 are all XRP_USDT_Perp on one sub-account, so GRVT
    // returns the same settlements for each. Only the one that actually
    // traded accrued them.
    mockDb.countFillsForBot.mockResolvedValue(0);
    mockDb.getFundingHistoryByBot.mockResolvedValue([legacyRow]);
    const { engine, client } = engineWith([payment(-0.028144, '195951743')]);

    await (engine as any).backfillFundingHistory();

    expect(client.getFundingPayments).not.toHaveBeenCalled();
    expect(mockDb.insertFundingPayment).not.toHaveBeenCalled();
  });

  it('cleans up funding misattributed to a bot that never traded', async () => {
    // Observed in production: the old model copied the sub-account cumulative
    // onto bots 3 and 4, which never placed an order, leaving -2.369793 on
    // each. Skipping them must not mean leaving that behind.
    mockDb.countFillsForBot.mockResolvedValue(0);
    mockDb.deleteLegacyFundingForBot.mockResolvedValue(4);
    const { engine } = engineWith([payment(-0.028144, '195951743')]);

    await (engine as any).backfillFundingHistory();

    expect(mockDb.deleteLegacyFundingForBot).toHaveBeenCalledWith(5);
    expect(mockDb.insertFundingPayment).not.toHaveBeenCalled();
  });

  it('does NOT purge when GRVT returns nothing — a failed fetch must not empty the table', async () => {
    mockDb.getFundingHistoryByBot.mockResolvedValue([legacyRow]);
    const { engine } = engineWith([]);

    await (engine as any).backfillFundingHistory();

    expect(mockDb.deleteLegacyFundingForBot).not.toHaveBeenCalled();
    expect(mockDb.insertFundingPayment).not.toHaveBeenCalled();
  });

  it('does NOT purge when the GRVT call throws', async () => {
    mockDb.getFundingHistoryByBot.mockResolvedValue([legacyRow]);
    const engine = new GridEngine();
    (engine as any).getClientForBot = vi.fn().mockResolvedValue({
      getFundingPayments: vi.fn().mockRejectedValue(new Error('timeout')),
    });

    await (engine as any).backfillFundingHistory();

    expect(mockDb.deleteLegacyFundingForBot).not.toHaveBeenCalled();
  });
});

describe('GRVTClient.getFundingPayments — polarity and parsing', () => {
  async function clientWith(rows: any[]) {
    const { GRVTClient } = await vi.importActual<
      typeof import('../src/api/client.js')
    >('../src/api/client.js');
    const client: any = new GRVTClient({
      subAccountId: 'mock-sub',
      apiKey: 'k',
      privateKey: '0x00',
    } as any);
    client.authedRequest = vi.fn().mockResolvedValue(rows);
    return client;
  }

  const grvtRow = (amount: string, txId: string, nanos: string) => ({
    event_time: nanos,
    sub_account_id: '2643476037689792',
    instrument: 'XRP_USDT_Perp',
    currency: 'USDT',
    amount,
    tx_id: txId,
  });

  it('flips GRVT\'s payment counter into P&L polarity', async () => {
    const client = await clientWith([
      grvtRow('0.028144', '195951743', '1790035200014284269'),
    ]);

    const out = await client.getFundingPayments('XRP_USDT_Perp', 5);

    expect(out).toHaveLength(1);
    expect(out[0].amount_usdt).toBeCloseTo(-0.028144, 8);
    expect(out[0].tx_id).toBe('195951743');
  });

  it('flips a credit the same way', async () => {
    const client = await clientWith([
      grvtRow('-0.015221', '192056279', '1789646400011000000'),
    ]);

    const out = await client.getFundingPayments('XRP_USDT_Perp', 5);
    expect(out[0].amount_usdt).toBeCloseTo(0.015221, 8);
  });

  it('converts the nanosecond event_time to epoch ms', async () => {
    const client = await clientWith([
      grvtRow('0.028144', '195951743', '1790035200014284269'),
    ]);

    const out = await client.getFundingPayments('XRP_USDT_Perp', 5);
    expect(out[0].event_time_ms).toBe(1790035200014);
    expect(new Date(out[0].event_time_ms).toISOString()).toBe('2026-09-22T00:00:00.014Z');
  });

  it('re-filters by instrument so ETH funding cannot land on an XRP bot', async () => {
    const client = await clientWith([
      { ...grvtRow('0.9', '111', '1790035200000000000'), instrument: 'ETH_USDT_Perp' },
      grvtRow('0.028144', '195951743', '1790035200014284269'),
    ]);

    const out = await client.getFundingPayments('XRP_USDT_Perp', 5);

    expect(out).toHaveLength(1);
    expect(out[0].instrument).toBe('XRP_USDT_Perp');
  });

  it('skips rows without a tx_id — they cannot be deduplicated', async () => {
    const client = await clientWith([
      { ...grvtRow('0.028144', '', '1790035200014284269') },
    ]);

    const out = await client.getFundingPayments('XRP_USDT_Perp', 5);
    expect(out).toHaveLength(0);
  });

  it('skips a malformed event_time instead of storing it at epoch 0', async () => {
    // Coercing to 0 would file the settlement under 1970-01-01 and corrupt
    // every ORDER BY funding_time.
    for (const bad of ['', 'not-a-number', '-1', '1.5e9']) {
      const client = await clientWith([grvtRow('0.028144', '195951743', bad)]);
      const out = await client.getFundingPayments('XRP_USDT_Perp', 5);
      expect(out, `event_time ${JSON.stringify(bad)} debio descartarse`).toHaveLength(0);
    }
  });

  it('skips a row whose event_time is missing entirely', async () => {
    const row: any = grvtRow('0.028144', '195951743', '0');
    delete row.event_time;
    const client = await clientWith([row]);

    const out = await client.getFundingPayments('XRP_USDT_Perp', 5);
    expect(out).toHaveLength(0);
  });
});

describe('funding alert cooldown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.countFillsForBot.mockResolvedValue(317);
    mockDb.insertFundingPayment.mockResolvedValue(true);
  });

  const ticker = { funding_rate_8h_curr: '0.01' }; // 0.01% per 8h

  it('normalises the percent rate before comparing to the threshold', async () => {
    mockDb.getBotsByStatus.mockResolvedValue([
      { ...BOT, alert_funding_rate_pct: 0.005 },
    ]);
    const { engine } = engineWith([payment(-0.028144, '1')], ticker);
    const alerts: any[] = [];
    engine.on('fundingRateAlert', (a) => alerts.push(a));

    await (engine as any).pollFundingHistory();

    expect(alerts).toHaveLength(1);
    // 0.01% — NOT 1%, which is what treating the quote as a fraction gives.
    expect(alerts[0].fundingRatePct).toBeCloseTo(0.01, 6);
  });

  it('stays silent below the threshold', async () => {
    mockDb.getBotsByStatus.mockResolvedValue([
      { ...BOT, alert_funding_rate_pct: 5 },
    ]);
    const { engine } = engineWith([payment(-0.028144, '1')], ticker);
    const alerts: any[] = [];
    engine.on('fundingRateAlert', (a) => alerts.push(a));

    await (engine as any).pollFundingHistory();
    expect(alerts).toHaveLength(0);
  });

  it('suppresses a repeat inside the cooldown window', async () => {
    mockDb.getBotsByStatus.mockResolvedValue([
      { ...BOT, alert_funding_rate_pct: 0.005, last_funding_alert_at: Date.now() - 60_000 },
    ]);
    const { engine } = engineWith([payment(-0.028144, '1')], ticker);
    const alerts: any[] = [];
    engine.on('fundingRateAlert', (a) => alerts.push(a));

    await (engine as any).pollFundingHistory();
    expect(alerts).toHaveLength(0);
  });

  it('alerts again once the cooldown elapsed', async () => {
    mockDb.getBotsByStatus.mockResolvedValue([
      { ...BOT, alert_funding_rate_pct: 0.005, last_funding_alert_at: Date.now() - 7 * 3600_000 },
    ]);
    const { engine } = engineWith([payment(-0.028144, '1')], ticker);
    const alerts: any[] = [];
    engine.on('fundingRateAlert', (a) => alerts.push(a));

    await (engine as any).pollFundingHistory();
    expect(alerts).toHaveLength(1);
  });

  it('skips the check when the ticker lookup fails, without losing the ingest', async () => {
    mockDb.getBotsByStatus.mockResolvedValue([
      { ...BOT, alert_funding_rate_pct: 0.005 },
    ]);
    const { engine } = engineWith([payment(-0.028144, '1')]); // ticker rejects
    const alerts: any[] = [];
    engine.on('fundingRateAlert', (a) => alerts.push(a));

    await (engine as any).pollFundingHistory();

    expect(alerts).toHaveLength(0);
    expect(mockDb.insertFundingPayment).toHaveBeenCalledTimes(1);
  });
});

describe('funding-math — the canonical sign conventions', () => {
  const rows = (...p: number[]) => p.map(payment_usdt => ({ payment_usdt }));

  it('reports a cost as positive "funding paid"', () => {
    expect(fundingPaidUsdt(rows(-2.369793))).toBeCloseTo(2.369793, 8);
  });

  it('reports a credit as negative "funding paid"', () => {
    expect(fundingPaidUsdt(rows(1.2))).toBeCloseTo(-1.2, 8);
  });

  it('keeps P&L polarity in the net total', () => {
    expect(fundingNetUsdt(rows(-2.369793))).toBeCloseTo(-2.369793, 8);
  });

  it('nets mixed rows instead of inflating them (the Math.abs bug)', () => {
    const r = rows(-3.0, 1.0);
    expect(fundingPaidUsdt(r)).toBeCloseTo(2.0, 8);
    const legacy = r.reduce((s, x) => s + Math.abs(x.payment_usdt), 0);
    expect(legacy).toBeCloseTo(4.0, 8);
    expect(legacy).not.toBeCloseTo(fundingPaidUsdt(r), 8);
  });

  it('the two helpers are exact inverses', () => {
    const r = rows(-3.0, 1.0, -0.25);
    expect(fundingPaidUsdt(r)).toBeCloseTo(-fundingNetUsdt(r), 8);
  });

  it('returns 0 for an empty history', () => {
    expect(fundingNetUsdt([])).toBe(0);
  });
});
