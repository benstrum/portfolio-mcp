# Setup and first authorization

## Prerequisites

Obtain an active E*TRADE **production** consumer key and secret, a Cloudflare account and Workers KV namespace, and a long random admin password. E*TRADE individual keys only work with their original user. Ensure the Worker is available over HTTPS. The admin password is also the approval credential for connecting a ChatGPT MCP client.

Configure repository GitHub **Secrets**: `ETRADE_CONSUMER_KEY`, `ETRADE_CONSUMER_SECRET`, `MCP_ADMIN_PASSWORD`, `CLOUDFLARE_API_TOKEN`. Configure GitHub **Variables**: `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_KV_NAMESPACE_ID`, `CLOUDFLARE_WORKER_NAME`, `ETRADE_ENV=production`, `MCP_ACCESS_TOKEN_TTL_SECONDS=3600`, and `MCP_REFRESH_TOKEN_TTL_SECONDS=2592000`. The Cloudflare token needs Worker deployment, KV binding and Worker secret permissions. The workflow injects the Worker name and KV ID at deploy time, then writes the three application credentials with `wrangler secret bulk`; they are never plaintext Worker vars. Deployment runs on `main` or manual dispatch; PRs only run CI.

## Authorize E*TRADE for the first time

1. Deploy the Worker from `main` and note its HTTPS URL, for example `https://your-worker.workers.dev`.
2. From a trusted terminal, request `GET https://your-worker.workers.dev/etrade/auth/start` with header `x-admin-password: YOUR_ADMIN_PASSWORD`. Avoid shell history for the password; use a private environment variable or a secret manager. The response has `authorizeUrl` and `verifierUrl`.
3. Open `authorizeUrl` in your browser, sign in at E*TRADE, approve access, and copy the verifier code. The Worker never sees your E*TRADE username or password.
4. Open `verifierUrl` in your browser, paste the code and submit. Its random one-time state expires after five minutes. The Worker exchanges the code and stores the access token and secret in KV.
5. Check `/etrade/status` with the admin header. It should report `connected: true`. Connect ChatGPT using the steps below.

## Browser-based reconnect (recommended)

After deployment, open **https://portfolio-mcp.ben-strum.workers.dev/etrade/connect** in a browser. The Worker shows a secure form for your Portfolio MCP admin password (not your E*TRADE password), then requests a short-lived E*TRADE request token.

- If E*TRADE confirms a registered callback, the Worker redirects you to E*TRADE to log in/approve. E*TRADE then redirects back with the verifier, and the Worker exchanges it automatically. This removes PowerShell and verifier copy/paste. The callback is bound to an HTTP-only, Secure, SameSite=Lax, five-minute browser session cookie; it does not require putting secrets or persistent brokerage credentials in the browser.
- If no callback is registered, the Worker shows an E*TRADE authorization link and a same-page verification form. This still avoids PowerShell but requires pasting the code.

**One-time external setup required:** Ask E*TRADE customer service to register the exact callback URL `https://portfolio-mcp.ben-strum.workers.dev/etrade/callback` for your **production consumer key**. Per E*TRADE's [developer guide](https://developer.etrade.com/getting-started/developer-guides), sign in to E*TRADE, send a secure message with subject "Technical Issues", topic "E*TRADE API", and provide the callback URL and the consumer key. Do not include the consumer secret. The callback code is present but cannot be tested end to end until E*TRADE confirms registration.

The older `/etrade/auth/start` admin-header endpoint and `/etrade/complete?state=...` verifier endpoint remain functional for compatibility, but the browser reconnect page is the preferred entry point. The MCP `get_connection_status` tool now returns a clickable `reconnectUrl` for the browser page.

**Important limitation:** E*TRADE production access tokens expire at midnight Eastern. The renewal endpoint only restores tokens that became inactive during the SAME Eastern calendar day; cron or keepalive requests cannot avoid the daily authorization requirement. The browser-based approval still requires E*TRADE login and any MFA challenges. No brokerage password or session-cookie scraping is implemented.

## Pre-review monitoring and alerts

The Worker runs scheduled checks at 13:30 and 14:30 UTC and executes a probe **only when the local time in America/New_York is 09:30** (covers daylight saving time). It probes the account-list API, renews an inactive same-day token if necessary, and stores the result in KV as `etrade:lastHealth`. `get_connection_status` includes this historical preflight status, which should not be confused with a fresh, live quote.

An optional alert can be sent to a user-owned HTTPS webhook when the preflight finds expired authorization or service unavailability. To configure it, set Worker secret `ETRADE_ALERT_WEBHOOK_URL` to a trusted endpoint capable of POST JSON payloads. Its payload contains only the status, timestamp and browser reconnection URL; it never includes brokerage credentials, holdings or account identifiers. Failures are rate-limited to one alert per Eastern day when the webhook accepts the notification. Without the secret, health is recorded, but no external notification is sent. The existing ChatGPT daily portfolio review may still report missing authorization separately.

The configured `ETRADE_PUBLIC_BASE_URL` Worker variable is the public base URL used in alerts. If your Worker host changes, update this variable and ask E*TRADE to change the registered callback URL.

**Production rollout:** Do not merge/deploy until the branch tests pass and the user approves the public-browser authorization flow. If desired, protect `/etrade/connect` with Cloudflare Access or a WAF rule in addition to its required admin password. Do not deploy a staged Worker with real E*TRADE production credentials and the same shared KV token namespace as the production Worker. Use isolated test credentials and storage.

### Token life cycle

Repeat the browser authorization when E*TRADE expires the token at midnight Eastern. The Worker automatically attempts intraday renewal when authorization fails, then retries account listing. If renewal fails because the token is genuinely unauthorized, the Worker removes the invalid access token. A transient network outage does **not** delete a token that may still be valid.

## Connect ChatGPT

In ChatGPT's MCP connector setup, add the Worker URL ending in `/mcp`. The Worker advertises OAuth authorization and protected-resource metadata. ChatGPT registers a client, redirects you to the Worker's `/authorize` page, and uses PKCE to obtain short-lived bearer and refresh tokens. Enter `MCP_ADMIN_PASSWORD` on that page to approve read-only portfolio access. Do not paste E*TRADE credentials or tokens into ChatGPT. Test `get_connection_status` first and then `get_accounts`.

ChatGPT's connector UI and availability can vary by account. The Worker implements dynamic client registration and OAuth metadata expected by standard remote MCP clients. Restrict access to the Worker URL and rotate the admin password if it is exposed.

## Troubleshooting

- **401 from `/mcp`:** The MCP OAuth bearer token is absent or expired. Reconnect the client; check the Worker's OAuth metadata and `/authorize` password.
- **`authorization_required` from a tool:** E*TRADE token has expired or renewal failed. Open `/etrade/connect` in your browser. E*TRADE may still require login/MFA.
- **Invalid verifier/state:** Start authorization again; each browser session uses a five-minute, single-use authorization state. For registered callbacks, use the same browser through authorization and return.
- **E*TRADE `upstream` error:** Confirm a production API key and account permissions. Upstream response bodies are deliberately not returned or logged.
- **Empty accounts or positions:** Verify the E*TRADE user and account type; some accounts may not support the brokerage balance or portfolio endpoints.
- **Deploy failure:** Confirm all GitHub variables and secrets are set, the KV namespace ID belongs to the Cloudflare account, and the API token can deploy Workers and set encrypted secrets.
