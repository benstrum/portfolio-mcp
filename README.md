# E*TRADE read-only portfolio MCP

A TypeScript Cloudflare Worker that serves an authenticated Streamable HTTP MCP endpoint at `/mcp`. Its six tools only read E*TRADE production accounts, balances, positions and transactions. The Worker contains no order, trade, transfer or account modification calls.

## Routes

| Route | Access | Purpose |
| --- | --- | --- |
| `GET /health` | Public | Worker liveness only |
| `GET /etrade/status` | `x-admin-password` | E*TRADE connection status |
| `GET /etrade/auth/start` | `x-admin-password` | Request E*TRADE token and return authorization and verifier URLs |
| `GET/POST /etrade/complete?state=...` | One-time state | Browser verifier form and token exchange |
| `GET/POST /mcp` | OAuth 2 bearer token | Streamable HTTP MCP |
| `/.well-known/oauth-*`, `/register`, `/authorize`, `/token` | OAuth flow | ChatGPT client authorization with PKCE |

MCP tools: `get_connection_status`, `get_accounts`, `get_account_balances`, `get_positions`, `get_transactions`, `get_portfolio_snapshot`. Account-specific tools require an `accountIdKey` from `get_accounts`. The snapshot combines all accounts and retains symbol, quantity, price, market value, cost basis and unrealized gain/loss when E*TRADE supplies them. Account numbers are masked in returned data. Account ID keys remain available because they are needed for account-specific reads.

## Setup

See [docs/setup.md](docs/setup.md) for GitHub configuration, first authorization, ChatGPT connection and troubleshooting.

## Development

Node 22 or newer. Run `npm ci`, `npm run typecheck`, `npm test`, and `npm run build`. The build uses a Wrangler dry run. Put local credentials in `.dev.vars` and a local KV namespace in Wrangler configuration for local development; never commit either. `.env.example` contains placeholders only.

## E*TRADE API references

Paths and response fields were checked against E*TRADE's published [account list](https://apisb.etrade.com/docs/api/account/api-account-v1.html), [balance](https://apisb.etrade.com/docs/api/account/api-balance-v1.html), [portfolio](https://apisb.etrade.com/docs/api/account/api-portfolio-v1.html), [transaction](https://apisb.etrade.com/docs/api/account/api-transaction-v1.html), and [OAuth guide](https://developer.etrade.com/getting-started/developer-guides). E*TRADE's default production token expires at midnight US Eastern time; an inactive token can be renewed during that day.

## Limits

The service holds one E*TRADE user's token in KV, while that user may own multiple E*TRADE accounts. KV's eventual consistency can briefly affect one-time OAuth state and token rotation across distant edge locations. The snapshot paginates positions up to 5,000 per account; transactions return one page and expose the next marker. Cash and portfolio totals use E*TRADE balance fields, with a documented fallback when they are absent.
