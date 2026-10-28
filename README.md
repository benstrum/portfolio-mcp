# E*TRADE read-only portfolio MCP

A TypeScript Cloudflare Worker that serves an authenticated Streamable HTTP MCP endpoint at `/mcp`. Its tools only read E*TRADE production accounts, balances, positions, tax lots, open orders, quote data, and option chains. The Worker contains no order placement, cancellation, trade execution, transfer, or account modification calls.

## Routes

| Route | Access | Purpose |
| --- | --- | --- |
| `GET /health` | Public | Worker liveness only |
| `GET /etrade/status` | `x-admin-password` | E*TRADE connection status |
| `GET /etrade/auth/start` | `x-admin-password` | Request E*TRADE token and return authorization and verifier URLs |
| `GET/POST /etrade/complete?state=...` | One-time state | Browser verifier form and token exchange |
| `GET/POST /mcp` | OAuth 2 bearer token | Streamable HTTP MCP |
| `/.well-known/oauth-*`, `/register`, `/authorize`, `/token` | OAuth flow | ChatGPT client authorization with PKCE |

### MCP tools (all read-only)

- Accounts: `get_connection_status`, `get_accounts`, `get_account_balances`, `get_positions`, `get_transactions`, `get_portfolio_snapshot`, `get_position_lots`, `get_orders`.
- Market data: `get_quotes`, `get_option_quote`, `get_option_chain`, `get_option_expirations`, `get_vertical_spread_quote`.

Account-specific tools require `accountIdKey` from `get_accounts`. `get_orders` defaults to OPEN and can list other order states. `get_position_lots` requests acquisition-level lots when E*TRADE supplies them.

`get_vertical_spread_quote` derives buy and sell prices from separate option legs; this is **not** an executable broker combination quote. Broker quotes can be **DELAYED**, including if the market-data agreement is missing. All quotes retain the provider status and timestamp; do not describe any result as real-time without verification.

`get_portfolio_snapshot` excludes CLOSED accounts, continues if some active accounts fail, and reports unavailable accounts. Money-market funds such as VMFXX and VMSXX remain investment positions instead of being double-counted as cash. The snapshot distinguishes broker-reported account values from simple market-plus-cash estimates, which may not represent net liquidation value when margin liabilities are unknown. Missing historical market values and cash flows are not silently treated as portfolio return.

Account numbers are masked, and account ID keys remain available for account-specific reads. See [docs/market-data.md](docs/market-data.md) for examples, quote licensing, response semantics, and limitations.

## Setup

See [docs/setup.md](docs/setup.md) for GitHub configuration, first authorization, ChatGPT connection and troubleshooting.

## Development

Node 22 or newer. Run `npm ci`, `npm run typecheck`, `npm test`, and `npm run build`. The build uses a Wrangler dry run. Put local credentials in `.dev.vars` and a local KV namespace in Wrangler configuration for local development; never commit either. `.env.example` contains placeholders only.

## E*TRADE API references

Paths and response fields were checked against E*TRADE's published [account list](https://apisb.etrade.com/docs/api/account/api-account-v1.html), [balance](https://apisb.etrade.com/docs/api/account/api-balance-v1.html), [portfolio](https://apisb.etrade.com/docs/api/account/api-portfolio-v1.html), [transaction](https://apisb.etrade.com/docs/api/account/api-transaction-v1.html), [quote](https://apisb.etrade.com/docs/api/market/api-quote-v1.html), [option chain](https://apisb.etrade.com/docs/api/market/api-market-v1.html), [orders](https://apisb.etrade.com/docs/api/order/api-order-v1.html), and [OAuth guide](https://developer.etrade.com/getting-started/developer-guides). E*TRADE's default production token expires at midnight US Eastern time; an inactive token can be renewed during that day.

## Limits

The service holds one E*TRADE user's token in KV, while that user may own multiple E*TRADE accounts. KV's eventual consistency can briefly affect one-time OAuth state and token rotation across distant edge locations. The snapshot paginates positions up to 5,000 per account; transactions and orders return one page and expose the next marker. Cash is distinct from money-market funds and broker account totals are labeled when estimated. No historic net-return calculation is inferred without historical values and verified external cash flows.
