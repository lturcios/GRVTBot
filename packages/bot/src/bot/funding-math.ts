/**
 * Funding sign conventions — the single place they are defined.
 *
 * STORAGE (`funding_history.payment_usdt`) is SIGNED, in the same polarity
 * GRVT uses for `cumulative_realized_funding_payment`:
 *   negative → the account PAID funding (a cost)
 *   positive → the account RECEIVED funding (income)
 *
 * Two API surfaces expose totals derived from those rows, in OPPOSITE
 * polarities, and both are intentional:
 *   - `/api/v2/bots/:id/funding` → `totalPaymentUsdt` = raw SUM, i.e. P&L
 *     polarity (positive is good). This is what the FundingTable renders.
 *   - `/api/bots`, `/api/bots/:id` → `fundingPaid` = COST polarity
 *     (positive is a cost), because callers subtract it from trend PnL.
 *
 * Use the helpers below rather than open-coding a reduce, and never use
 * Math.abs() on these values: it reports credits as costs and makes a real
 * cost indistinguishable from income.
 */

export interface FundingRowLike {
  payment_usdt: number;
}

/** Raw signed total — P&L polarity: positive is income, negative is cost. */
export function fundingNetUsdt(rows: readonly FundingRowLike[]): number {
  return rows.reduce((sum, row) => sum + row.payment_usdt, 0);
}

/**
 * Cost polarity: positive means this much funding was PAID. This is the
 * value that gets subtracted from gross trend PnL.
 */
export function fundingPaidUsdt(rows: readonly FundingRowLike[]): number {
  return -fundingNetUsdt(rows);
}
