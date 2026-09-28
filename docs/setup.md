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

E*TRADE can also register a callback URL, but this implementation uses its documented out-of-band verifier flow, so no E*TRADE callback registration is needed. Repeat these steps after the token expires at midnight US Eastern time. The Worker attempts E*TRADE token renewal after an authorization failure during the current day. If renewal fails, MCP tools return `authorization_required` and a reconnect URL. The URL requires the admin header to start a fresh flow.

## Connect ChatGPT

In ChatGPT's MCP connector setup, add the Worker URL ending in `/mcp`. The Worker advertises OAuth authorization and protected-resource metadata. ChatGPT registers a client, redirects you to the Worker's `/authorize` page, and uses PKCE to obtain short-lived bearer and refresh tokens. Enter `MCP_ADMIN_PASSWORD` on that page to approve read-only portfolio access. Do not paste E*TRADE credentials or tokens into ChatGPT. Test `get_connection_status` first and then `get_accounts`.

ChatGPT's connector UI and availability can vary by account. The Worker implements dynamic client registration and OAuth metadata expected by standard remote MCP clients. Restrict access to the Worker URL and rotate the admin password if it is exposed.

## Troubleshooting

- **401 from `/mcp`:** The MCP OAuth bearer token is absent or expired. Reconnect the client; check the Worker's OAuth metadata and `/authorize` password.
- **`authorization_required` from a tool:** E*TRADE token has expired or renewal failed. Run the first authorization flow again.
- **Invalid verifier/state:** Start authorization again; the state is one-time and lasts five minutes.
- **E*TRADE `upstream` error:** Confirm a production API key and account permissions. Upstream response bodies are deliberately not returned or logged.
- **Empty accounts or positions:** Verify the E*TRADE user and account type; some accounts may not support the brokerage balance or portfolio endpoints.
- **Deploy failure:** Confirm all GitHub variables and secrets are set, the KV namespace ID belongs to the Cloudflare account, and the API token can deploy Workers and set encrypted secrets.
