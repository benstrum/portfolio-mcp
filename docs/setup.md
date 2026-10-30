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

## Passwordless reconnect through ChatGPT (recommended)

Once the Worker is deployed, you do **not** need to enter `MCP_ADMIN_PASSWORD` each time you reauthorize E*TRADE:

1. Ask ChatGPT to check your Ben Portfolio connection. The existing authenticated `get_connection_status` MCP tool generates a unique **five-minute** `reconnectUrl` when E*TRADE authorization has expired. A tool returning `authorization_required` can generate the same URL.
2. Open that link. The Worker verifies its capability, sets a short-lived Secure, HttpOnly, SameSite=Strict browser cookie, and redirects to a clean `/etrade/connect` URL, removing the ticket from the address bar.
3. Click **Continue to E*TRADE**. You will not be asked for the Portfolio MCP admin password. The Worker consumes the short-lived ticket before starting E*TRADE OAuth.
4. Complete E*TRADE login, consent and any MFA challenge. If E*TRADE has registered the callback, the verifier is exchanged automatically. Otherwise, paste the E*TRADE verifier into the browser form.

The fallback `https://portfolio-mcp.ben-strum.workers.dev/etrade/connect` without a valid ChatGPT-issued link **still requires your admin password**. This is intentional: an unauthenticated visitor must not be able to replace the single brokerage token used by your portfolio tools. You can also use the old admin-header flow for emergency recovery. Reconnect URLs are bearer capabilities: do not paste them into public messages or logs; they expire after five minutes and the Worker deletes them after use.

Your ChatGPT Portfolio MCP integration remains authenticated using its existing OAuth bearer token. The separate `/authorize` flow may still require the admin password if you reinstall or reauthorize the **ChatGPT connector itself**, but not for normal daily E*TRADE reconnection.

- If E*TRADE confirms a registered callback, the Worker redirects you to E*TRADE and handles the browser return to `/etrade/callback`. The callback is bound to a separate five-minute, Secure, HttpOnly, SameSite=Lax session cookie.
- If no callback is registered, the Worker shows an E*TRADE authorization link and same-page verifier form. This avoids PowerShell even when automatic verifier delivery is not possible.

**One-time external setup required:** Ask E*TRADE customer service to register the exact callback URL `https://portfolio-mcp.ben-strum.workers.dev/etrade/callback` for your **production consumer key**. Per E*TRADE's [developer guide](https://developer.etrade.com/getting-started/developer-guides), sign in to E*TRADE, send a secure message with subject "Technical Issues", topic "E*TRADE API", and provide the callback URL and the consumer key. Do not include the consumer secret. The callback code is present but cannot be tested end to end until E*TRADE confirms registration.

The older `/etrade/auth/start` admin-header endpoint and `/etrade/complete?state=...` verifier endpoint remain functional for compatibility. The MCP `get_connection_status` tool now supplies a fresh five-minute authorization link, which is preferred over opening the bare browser page.

**Important limitation:** E*TRADE production access tokens expire at midnight Eastern. The renewal endpoint only restores tokens that became inactive during the SAME Eastern calendar day; cron or keepalive requests cannot avoid the daily authorization requirement. The browser-based approval still requires E*TRADE login and any MFA challenges. No brokerage password or session-cookie scraping is implemented.

## Pre-review monitoring and alerts

The Worker runs scheduled checks at 13:30 and 14:30 UTC and executes a probe **only when the local time in America/New_York is 09:30** (covers daylight saving time). It probes the account-list API, renews an inactive same-day token if necessary, and stores the result in KV as `etrade:lastHealth`. `get_connection_status` includes this historical preflight status, which should not be confused with a fresh, live quote.

An optional alert can be sent to a user-owned HTTPS webhook when the preflight finds expired authorization or service unavailability. To configure it, set Worker secret `ETRADE_ALERT_WEBHOOK_URL` to a trusted endpoint capable of POST JSON payloads. Its payload contains only the status, timestamp and browser reconnection URL; it never includes brokerage credentials, holdings or account identifiers. Failures are rate-limited to one alert per Eastern day when the webhook accepts the notification. Without the secret, health is recorded, but no external notification is sent. The existing ChatGPT daily portfolio review may still report missing authorization separately.

The configured `ETRADE_PUBLIC_BASE_URL` Worker variable is the public base URL used in alerts. If your Worker host changes, update this variable and ask E*TRADE to change the registered callback URL.

**Production rollout:** Do not merge/deploy until the branch tests pass and the user approves the public-browser authorization flow. Consider Cloudflare Access or rate limiting as additional defense-in-depth. Never remove the password fallback protection or expose an unauthenticated token-creation path. Do not deploy a staged Worker with real E*TRADE production credentials and the same shared KV token namespace as the production Worker. Use isolated test credentials and storage.

### Token life cycle

Repeat the browser authorization when E*TRADE expires the token at midnight Eastern. The Worker automatically attempts intraday renewal when authorization fails, then retries account listing. If renewal fails because the token is genuinely unauthorized, the Worker removes the invalid access token. A transient network outage does **not** delete a token that may still be valid.

## Connect ChatGPT

In ChatGPT's MCP connector setup, add the Worker URL ending in `/mcp`. The Worker advertises OAuth authorization and protected-resource metadata. ChatGPT registers a client, redirects you to the Worker's `/authorize` page, and uses PKCE to obtain short-lived bearer and refresh tokens. Enter `MCP_ADMIN_PASSWORD` on that page to approve read-only portfolio access. Do not paste E*TRADE credentials or tokens into ChatGPT. Test `get_connection_status` first and then `get_accounts`.

ChatGPT's connector UI and availability can vary by account. The Worker implements dynamic client registration and OAuth metadata expected by standard remote MCP clients. Restrict access to the Worker URL and rotate the admin password if it is exposed.

## Troubleshooting

- **401 from `/mcp`:** The MCP OAuth bearer token is absent or expired. Reconnect the client; check the Worker's OAuth metadata and `/authorize` password.
- **`authorization_required` from a tool:** E*TRADE token has expired or renewal failed. Open the **fresh link generated by the authenticated MCP tool** instead of the bare `/etrade/connect` page; E*TRADE may still require login/MFA. If the link expires, ask ChatGPT for a new one.
- **Invalid verifier/state:** Start authorization again; each browser session uses a five-minute, single-use authorization state. For registered callbacks, use the same browser through authorization and return.
- **E*TRADE `upstream` error:** Confirm a production API key and account permissions. Upstream response bodies are deliberately not returned or logged.
- **Empty accounts or positions:** Verify the E*TRADE user and account type; some accounts may not support the brokerage balance or portfolio endpoints.
- **Deploy failure:** Confirm all GitHub variables and secrets are set, the KV namespace ID belongs to the Cloudflare account, and the API token can deploy Workers and set encrypted secrets.
