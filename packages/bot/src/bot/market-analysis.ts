// Market analysis utilities: ATR, regime detection, grid spacing suggestions.
// All functions are pure (no side effects, no I/O) — pass candles in, get numbers out.

export type MarketRegime = 'ranging' | 'trending_up' | 'trending_down';

export interface OhlcvCandle {
  time: number; // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
}

// ATR(period) using Wilder's smoothing method.
// Requires at least period+1 candles. Returns 0 when insufficient data.
export function calculateATR(candles: OhlcvCandle[], period = 14): number {
  if (candles.length < period + 1) return 0;

  // Seed: simple average of first `period` true ranges
  let atr = 0;
  for (let i = 1; i <= period; i++) {
    const c = candles[i]!;
    const prev = candles[i - 1]!;
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - prev.close),
      Math.abs(c.low - prev.close)
    );
    atr += tr;
  }
  atr /= period;

  // Wilder's smoothing for the rest
  for (let i = period + 1; i < candles.length; i++) {
    const c = candles[i]!;
    const prev = candles[i - 1]!;
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - prev.close),
      Math.abs(c.low - prev.close)
    );
    atr = (atr * (period - 1) + tr) / period;
  }

  return atr;
}

// Regime detection.
// Strategy:
//  1. Split candles into two equal halves.
//  2. Compare median close of first half vs second half to detect direction.
//  3. Measure net move vs ATR * sqrt(n): if net > threshold → trending, else ranging.
export function detectMarketRegime(candles: OhlcvCandle[]): MarketRegime {
  if (candles.length < 20) return 'ranging';

  const atr = calculateATR(candles);
  if (atr === 0) return 'ranging';

  const closes = candles.map((c) => c.close);
  const half = Math.floor(closes.length / 2);
  const firstHalfMedian = median(closes.slice(0, half));
  const secondHalfMedian = median(closes.slice(half));

  const netMove = Math.abs(secondHalfMedian - firstHalfMedian);
  // Threshold: 1.5× ATR is considered a meaningful directional move
  const threshold = atr * 1.5;

  if (netMove < threshold) return 'ranging';
  return secondHalfMedian > firstHalfMedian ? 'trending_up' : 'trending_down';
}

// Suggest a grid range centered on currentPrice with spacing = 1.5× ATR.
// The returned range spans numGrids × suggested spacing symmetric around price.
export function suggestGridSpacing(
  atr: number,
  numGrids: number,
  currentPrice: number
): { lowerPrice: number; upperPrice: number } {
  if (atr <= 0 || numGrids <= 0 || currentPrice <= 0) {
    return { lowerPrice: currentPrice * 0.95, upperPrice: currentPrice * 1.05 };
  }
  const halfRange = (atr * 1.5 * numGrids) / 2;
  const lowerPrice = Math.max(currentPrice - halfRange, currentPrice * 0.01);
  const upperPrice = currentPrice + halfRange;
  return { lowerPrice, upperPrice };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}
