// D.3 — Grid calculation tests
// Pure math tests for computeLiqPriceLocal + grid level generation +
// safeguard distance formula. No real GRVT calls — ticker is mocked.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── computeLiqPriceLocal (C.4 pure function) ─────────────────────────
// Imported directly — it's a pure function with no side effects.
// We hoist mocks so the module can load without hitting real DB/API.

const { mockGrvtClient, mockDb } = vi.hoisted(() => ({
  mockGrvtClient: {
    getTicker: vi.fn(),
    calculateLiquidationPrice: vi.fn(),
    getOpenOrders: vi.fn(),
    getPosition: vi.fn(),
    getPositions: vi.fn(),
    getBalance: vi.fn(),
    getFillHistory: vi.fn(),
    getFundingHistory: vi.fn(),
    createOrder: vi.fn(),
    cancelOrder: vi.fn(),
    cancelAllOrders: vi.fn(),
    setLeverage: vi.fn(),
    getInstruments: vi.fn(),
    login: vi.fn(),
    subAccountId: 'mock-sub',
  },
  mockDb: {
    getBot: vi.fn(),
    createBot: vi.fn(),
    updateBot: vi.fn(),
    getBotsByStatus: vi.fn().mockResolvedValue([]),
    getAllBots: vi.fn().mockResolvedValue([]),
    getGridLevels: vi.fn().mockResolvedValue([]),
    createGridLevel: vi.fn(),
    updateGridLevel: vi.fn(),
    fillGridLevel: vi.fn(),
    createOrder: vi.fn(),
    updateOrderStatus: vi.fn(),
    createTrade: vi.fn(),
    getOrders: vi.fn(),
    close: vi.fn(),
    getLastFillArchiveTimestamp: vi.fn(),
    insertFillArchive: vi.fn(),
    insertPairedRoundtrip: vi.fn(),
    getFillsArchive: vi.fn(),
    getPairedRoundtrips: vi.fn(),
    getFundingHistoryByBot: vi.fn().mockResolvedValue([]),
    createFundingRecord: vi.fn(),
  },
}));

vi.mock('../src/api/client.js', () => ({
  grvtClient: mockGrvtClient,
  GRVTClient: vi.fn(),
  getInstrumentSpec: (pair: string) => {
    if (pair === 'BTC_USDT_Perp') return { min_size: 0.001, min_notional: 100, tick_size: 0.1 };
    return { min_size: 0.01, min_notional: 20, tick_size: 0.01 };
  },
  InstrumentSpec: {},
}));

vi.mock('../src/api/grvt-client-factory.js', () => ({
  getGrvtClientForUser: vi.fn().mockResolvedValue(mockGrvtClient),
  invalidateGrvtClient: vi.fn(),
}));

vi.mock('../src/database/db.js', () => ({
  db: mockDb,
}));

vi.mock('../src/server/logger.js', () => ({
  childLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
  }),
}));

import { computeLiqPriceCross, computeLiqPriceLocal, GridEngine } from '../src/bot/grid-engine.js';

// ── 1b. computeLiqPriceCross ─────────────────────────────────────────
// Cross-margin liquidation from real account state. The case that
// motivated it: bot 5 (XRP long) had grown to 244.1 units on ~106 USDT
// of equity — ~2.9x effective against a declared 2x — so the local
// estimate put liquidation 20 points of price further away than it was.

describe('computeLiqPriceCross', () => {
  it('LONG: solves equity(P) = maintenance(P)', () => {
    // 244.1 @ mark 1.40 = 341.74 notional, equity 106.52, flat 0.5% mm
    // → (341.74 - 106.52) / (244.1 * 0.995) = 0.9685
    const liq = computeLiqPriceCross(244.1, 1.4, 106.52, 'long');
    expect(liq).toBeCloseTo(0.9685, 3);
  });

  it('LONG: a position that outgrew its budget liquidates NEARER the mark than the local estimate claims', () => {
    const bot = { avg_entry_price: 1.3679, leverage: 2, direction: 'long' } as any;
    const local = computeLiqPriceLocal(bot)!;
    const cross = computeLiqPriceCross(244.1, 1.4, 106.52, 'long')!;
    // This is the whole point of the function: the safeguard must see
    // the higher (closer) number for a long, not the comfortable one.
    expect(cross).toBeGreaterThan(local);
    expect(Math.max(local, cross)).toBe(cross);
  });

  it("prefers GRVT's reported maintenance margin over the flat constant", () => {
    const flat = computeLiqPriceCross(244.1, 1.4, 106.52, 'long')!;
    // 2% of notional instead of 0.5% → liquidation moves closer to mark
    const tiered = computeLiqPriceCross(244.1, 1.4, 106.52, 'long', 341.74 * 0.02)!;
    expect(tiered).toBeGreaterThan(flat);
  });

  it('ignores a maintenance margin that is absurd (>= notional) and uses the constant', () => {
    const flat = computeLiqPriceCross(244.1, 1.4, 106.52, 'long');
    expect(computeLiqPriceCross(244.1, 1.4, 106.52, 'long', 99_999)).toBeCloseTo(flat!, 8);
    expect(computeLiqPriceCross(244.1, 1.4, 106.52, 'long', 0)).toBeCloseTo(flat!, 8);
  });

  it('SHORT: liquidates above the mark', () => {
    const liq = computeLiqPriceCross(244.1, 1.4, 106.52, 'short')!;
    expect(liq).toBeGreaterThan(1.4);
    // (341.74 + 106.52) / (244.1 * 1.005) = 1.8269
    expect(liq).toBeCloseTo(1.8269, 3);
  });

  it('LONG: equity above notional is unreachable by price → null, never "safe"', () => {
    expect(computeLiqPriceCross(10, 1.4, 500, 'long')).toBeNull();
  });

  it('returns null for missing position, mark or equity', () => {
    expect(computeLiqPriceCross(0, 1.4, 106.52, 'long')).toBeNull();
    expect(computeLiqPriceCross(244.1, 0, 106.52, 'long')).toBeNull();
    expect(computeLiqPriceCross(244.1, 1.4, 0, 'long')).toBeNull();
    expect(computeLiqPriceCross(NaN, 1.4, 106.52, 'long')).toBeNull();
  });

  it('treats an unsigned short size the same as a signed one', () => {
    expect(computeLiqPriceCross(-244.1, 1.4, 106.52, 'short')).toBeCloseTo(
      computeLiqPriceCross(244.1, 1.4, 106.52, 'short')!,
      8
    );
  });
});

// ── 1. computeLiqPriceLocal ──────────────────────────────────────────

describe('computeLiqPriceLocal', () => {
  it('LONG 2x entry 60000 → liq ≈ 30300', () => {
    const liq = computeLiqPriceLocal({
      avg_entry_price: 60000,
      leverage: 2,
      direction: 'long',
    } as any);
    expect(liq).toBeCloseTo(30300, 0);
  });

  it('SHORT 5x entry 60000 → liq ≈ 71700', () => {
    const liq = computeLiqPriceLocal({
      avg_entry_price: 60000,
      leverage: 5,
      direction: 'short',
    } as any);
    expect(liq).toBeCloseTo(71700, 0);
  });

  it('entry = 0 → null (no position)', () => {
    expect(
      computeLiqPriceLocal({ avg_entry_price: 0, leverage: 2, direction: 'long' } as any)
    ).toBeNull();
  });

  it('undefined entry → null', () => {
    expect(
      computeLiqPriceLocal({ avg_entry_price: undefined, leverage: 2, direction: 'long' } as any)
    ).toBeNull();
  });

  it('leverage = 1 → near zero for LONG (degenerate but valid)', () => {
    const liq = computeLiqPriceLocal({
      avg_entry_price: 60000,
      leverage: 1,
      direction: 'long',
    } as any);
    // factor = 1/1 - 0.005 = 0.995 → liq = 60000 * 0.005 = 300
    expect(liq).toBeCloseTo(300, 0);
    expect(liq).toBeGreaterThan(0);
  });

  it('LONG 10x → reasonable liq price', () => {
    const liq = computeLiqPriceLocal({
      avg_entry_price: 2000,
      leverage: 10,
      direction: 'long',
    } as any);
    // factor = 0.1 - 0.005 = 0.095 → liq = 2000 * (1 - 0.095) = 2000 * 0.905 = 1810
    expect(liq).toBeCloseTo(1810, 0);
  });

  it('SHORT 3x → liq above entry', () => {
    const liq = computeLiqPriceLocal({
      avg_entry_price: 2000,
      leverage: 3,
      direction: 'short',
    } as any);
    // factor = 1/3 - 0.005 ≈ 0.3283 → liq = 2000 * 1.3283 ≈ 2656.7
    expect(liq!).toBeGreaterThan(2000);
  });
});

// ── 2. Safeguard distance math ───────────────────────────────────────

describe('safeguard distance formula', () => {
  function distancePct(
    direction: 'long' | 'short',
    currentPrice: number,
    liqPrice: number
  ): number {
    if (direction === 'long') {
      return ((currentPrice - liqPrice) / currentPrice) * 100;
    } else {
      return ((liqPrice - currentPrice) / currentPrice) * 100;
    }
  }

  it('LONG: mark far above liq → large distance (safe)', () => {
    expect(distancePct('long', 63000, 30300)).toBeCloseTo(51.9, 0);
  });

  it('LONG: mark approaching liq → small distance (danger)', () => {
    expect(distancePct('long', 31500, 30300)).toBeCloseTo(3.8, 0);
  });

  it('LONG: trigger at threshold=5%, distance=3.8% → should trigger', () => {
    const dist = distancePct('long', 31500, 30300);
    expect(dist).toBeLessThanOrEqual(5);
  });

  it('LONG: trigger at threshold=5%, distance=14.3% → should NOT trigger', () => {
    const dist = distancePct('long', 35000, 30300);
    expect(dist).toBeGreaterThan(5);
  });

  it('SHORT: liq above current → correct distance', () => {
    const dist = distancePct('short', 60000, 71700);
    // (71700 - 60000) / 60000 * 100 = 19.5%
    expect(dist).toBeCloseTo(19.5, 0);
  });
});

// ── 3. GridEngine.calculateGridLevels ────────────────────────────────

describe('GridEngine.calculateGridLevels', () => {
  let engine: GridEngine;

  beforeEach(() => {
    vi.clearAllMocks();
    engine = new GridEngine();
    mockGrvtClient.getTicker.mockResolvedValue({ last_price: '2100' });
    mockGrvtClient.calculateLiquidationPrice.mockResolvedValue('1200.00');
  });

  it('generates numGrids+1 levels with correct spacing', async () => {
    const result = await engine.calculateGridLevels({
      pair: 'ETH_USDT_Perp',
      direction: 'long',
      leverage: 2,
      lowerPrice: 1800,
      upperPrice: 2400,
      numGrids: 10,
      investmentUSDT: 500,
    });

    expect(result.gridLevels).toHaveLength(11); // 10 grids = 11 levels
    expect(result.spacing).toBeCloseTo(60, 1); // (2400-1800)/10
  });

  it('levels below current price are buy, above are sell (LONG)', async () => {
    const result = await engine.calculateGridLevels({
      pair: 'ETH_USDT_Perp',
      direction: 'long',
      leverage: 2,
      lowerPrice: 1800,
      upperPrice: 2400,
      numGrids: 10,
      investmentUSDT: 500,
    });

    for (const level of result.gridLevels) {
      if (level.price < 2100) {
        expect(level.side).toBe('buy');
      } else {
        expect(level.side).toBe('sell');
      }
    }
  });

  it('SHORT direction flips buy/sell assignment', async () => {
    const result = await engine.calculateGridLevels({
      pair: 'ETH_USDT_Perp',
      direction: 'short',
      leverage: 2,
      lowerPrice: 1800,
      upperPrice: 2400,
      numGrids: 10,
      investmentUSDT: 500,
    });

    for (const level of result.gridLevels) {
      if (level.price > 2100) {
        expect(level.side).toBe('sell');
      } else {
        expect(level.side).toBe('buy');
      }
    }
  });

  it('canonical qty formula matches expected value', async () => {
    // inv=500, lev=2, ORDER_ALLOC=0.75
    // effCap = 500*2*0.75 = 750
    // midPrice = (1800+2400)/2 = 2100
    // qty = ceil((750/10/2100)*100)/100 = ceil(0.03571*100)/100 = ceil(3.571)/100 = 4/100 = 0.04
    const result = await engine.calculateGridLevels({
      pair: 'ETH_USDT_Perp',
      direction: 'long',
      leverage: 2,
      lowerPrice: 1800,
      upperPrice: 2400,
      numGrids: 10,
      investmentUSDT: 500,
    });

    expect(result.quantityPerGrid).toBe(0.04);
    // All levels should have the same qty
    for (const level of result.gridLevels) {
      expect(level.quantity).toBe(result.quantityPerGrid);
    }
  });

  it('all levels have uniform quantity (no drift)', async () => {
    const result = await engine.calculateGridLevels({
      pair: 'ETH_USDT_Perp',
      direction: 'long',
      leverage: 5,
      lowerPrice: 1800,
      upperPrice: 2400,
      numGrids: 50,
      investmentUSDT: 1000,
    });

    const quantities = new Set(result.gridLevels.map(l => l.quantity));
    expect(quantities.size).toBe(1); // all identical
  });

  it('throws when current price is outside range', async () => {
    mockGrvtClient.getTicker.mockResolvedValue({ last_price: '1500' }); // below range

    await expect(
      engine.calculateGridLevels({
        pair: 'ETH_USDT_Perp',
        direction: 'long',
        leverage: 2,
        lowerPrice: 1800,
        upperPrice: 2400,
        numGrids: 10,
        investmentUSDT: 500,
      })
    ).rejects.toThrow(/fuera del rango/);
  });

  it('qty floors at 0.03 for tiny investments', async () => {
    const result = await engine.calculateGridLevels({
      pair: 'ETH_USDT_Perp',
      direction: 'long',
      leverage: 1,
      lowerPrice: 1800,
      upperPrice: 2400,
      numGrids: 50,
      investmentUSDT: 100, // very small
    });

    expect(result.quantityPerGrid).toBeGreaterThanOrEqual(0.03);
  });

  it('liquidation price is included in result', async () => {
    const result = await engine.calculateGridLevels({
      pair: 'ETH_USDT_Perp',
      direction: 'long',
      leverage: 2,
      lowerPrice: 1800,
      upperPrice: 2400,
      numGrids: 10,
      investmentUSDT: 500,
    });

    expect(result.liquidationPrice).toBe(1200);
  });

  it('estimated profit per grid = spacing * qty', async () => {
    const result = await engine.calculateGridLevels({
      pair: 'ETH_USDT_Perp',
      direction: 'long',
      leverage: 2,
      lowerPrice: 1800,
      upperPrice: 2400,
      numGrids: 10,
      investmentUSDT: 500,
    });

    expect(result.estimatedProfitPerGrid).toBeCloseTo(
      result.spacing * result.quantityPerGrid,
      2
    );
  });
});
