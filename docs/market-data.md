# Read-only market, options, orders, tax lots, and portfolio data

All tools are available through the existing authenticated `/mcp` connector. No extra OAuth scope or write privileges are needed. The service uses **GET** only; it does not expose E*TRADE place/preview/modify/cancel order APIs.

## Trading quote examples

### AVGO Nov 20, 2026 $360/$390 call debit spread

```json
{"tool":"get_vertical_spread_quote","arguments":{"underlying":"AVGO","expiration":"2026-11-20","optionType":"CALL","longStrike":360,"shortStrike":390}}
```

Returned long and short legs each have bid, ask, bid size, ask size, `quoteStatus` and `quoteTimeUTC` from E*TRADE. The calculated:
- `openingDebitAsk = long ask - short bid`
- `closingCreditBid = long bid - short ask`
- `indicativeMid = (openingDebitAsk + closingCreditBid) / 2`

These are arithmetic combinations of independently quoted legs, NOT an executable spread-market bid/ask. `executableComboQuote` is always `false`. Check the exact combo quote and available sizes in E*TRADE before placing a limit order. For a credit spread, signed amounts can be negative; do not relabel without accounting for the trade direction.

### VRT Jan 15, 2027 $230 call

```json
{"tool":"get_option_quote","arguments":{"underlying":"VRT","expiration":"2027-01-15","optionType":"CALL","strikePrice":230}}
```

Quote fields include the best available bid/ask, last, size, open interest, multiplier and Greeks where E*TRADE returns them. `get_quotes` supports up to 25 equity symbols and `get_option_chain` supports strike filtering on a known expiration. `get_option_expirations` lists available dates.

E*TRADE option quote IDs follow the documented six-field format with strike values formatted to six decimal places. Stock quotes include a separate `extendedHours` object when E*TRADE returns pre-market or after-hours bid, ask and last; these are not silently substituted for regular-session prices.

Market data is real-time only if E*TRADE returns a corresponding real-time status and the user has the required market-data agreement. Otherwise treat data as delayed or closing. Quotes can also be stale outside normal options hours. Do not claim orders will execute at calculated spreads.

## Open orders

```json
{"tool":"get_orders","arguments":{"accountIdKey":"<accountIdKey from get_accounts>","status":"OPEN","count":50}}
```

Use `status` OPEN, EXECUTED, CANCELLED, CANCEL_REQUESTED, EXPIRED, REJECTED or INDIVIDUAL_FILLS. The response includes `orders[].orderId`, high-level status, order terms/prices and legs with actions, strikes and quantities when supplied. Pagination returns `nextMarker`. For historical orders, specify both `fromDate` and `toDate` in MMDDYYYY format; E*TRADE documents up to two years of history. Order IDs and multi-leg details are read-only; this tool will not change an order.

## Tax lots and margin

```json
{"tool":"get_position_lots","arguments":{"accountIdKey":"<accountIdKey>"}}
```

The tool calls E*TRADE Portfolio with `lotsRequired=true&view=COMPLETE`, and exposes acquired dates, remaining shares, adjusted cost, total cost and gains where available. Missing or zero-position lots must be reconciled; they do not mean zero basis. For account cash, `get_account_balances` now includes:
- Broker-reported total account value (if provided)
- `settledCashForInvestment`, `unSettledCashForInvestment` and buying power
- `marginBalance` and account mode (if provided)
- `optionLevel` approval, quote mode and as-of timestamp

A money-market fund such as VMFXX or VMSXX is a **position**. Avoid treating it as both cash and an investment position. Its sale/redemption and buying power must be evaluated separately.

## Consolidated snapshot and limitations

`get_portfolio_snapshot` excludes CLOSED accounts, proceeds when one ACTIVE account fails, and returns `partial` and `unavailableAccounts`. Account totals are labelled `BROKER_REPORTED` when E*TRADE provides `totalAccountValue`; otherwise `ESTIMATED_MARKET_PLUS_CASH`. The estimated total may not equal net liquidation value in margin accounts.

The tool does **not** compute monthly/annual performance from current cost-basis unrealized gain/loss. Accurate period returns need historical account equity and adjustments for transfers, dividends, contributions and Roth conversions. These are separate future requirements.

## Security and tests

- The connection is still OAuth-protected; no public quote endpoint is added.
- Account methods require an E*TRADE `accountIdKey` currently accessible by the authorized user.
- Inputs bound symbols, expiration, strike prices, page counts and date filters.
- Test suite mocks API responses for quote status, options mapping, spread arithmetic, order details, tax lots and cash/margin fields; never sends orders.
- Deploy using the existing GitHub CI, on a separate branch and reviewable PR. Do not merge until CI and live acceptance review succeed.

Official docs: [Market quotes](https://apisb.etrade.com/docs/api/market/api-quote-v1.html), [Option chains](https://apisb.etrade.com/docs/api/market/api-market-v1.html), [Orders](https://apisb.etrade.com/docs/api/order/api-order-v1.html), [Portfolio lots](https://apisb.etrade.com/docs/api/account/api-portfolio-v1.html), [Balances](https://apisb.etrade.com/docs/api/account/api-balance-v1.html).
