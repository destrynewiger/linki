# Linki MCP on Apple Container

This fork exposes a bearer-authenticated Streamable HTTP MCP endpoint at
`/api/mcp`. It has two tools:

- `get_outreach_status` reads the approved account, paused run, list, and
  remaining daily capacity.
- `stage_prospects` adds reviewed prospects to that paused run. It requires a
  blank LinkedIn connection step, caps each batch at 25, deduplicates Sumble
  signals, and never starts outreach.

## Clone and create the environment

```bash
git clone https://github.com/destrynewiger/linki.git
cd linki
git switch codex/linki-mcp-apple-container

AUTH_PASSWORD="$(openssl rand -base64 18)"
NEXTAUTH_SECRET="$(openssl rand -base64 32)"
MCP_API_TOKEN="$(openssl rand -hex 32)"

cat > .env.local <<EOF
NEXTAUTH_URL=http://localhost:3456
NEXTAUTH_SECRET=${NEXTAUTH_SECRET}
AUTH_PASSWORD=${AUTH_PASSWORD}
HEADLESS=true
MCP_API_TOKEN=${MCP_API_TOKEN}
MCP_ACCOUNT_ID=
MCP_WORKFLOW_ID=
MCP_LIST_ID=
MCP_WRITES_ENABLED=false
EOF

printf 'Linki password: %s\nMCP bearer token: %s\n' "$AUTH_PASSWORD" "$MCP_API_TOKEN"
```

Store the printed values in a password manager. Do not commit `.env.local`.

## Build and run with Apple Container

Apple Container requires Apple silicon and macOS 26 or later.

```bash
container system start
container system status
container build --arch arm64 --memory 4G --cpus 4 --tag linki:local .
mkdir -p data
container run --detach \
  --name linki \
  --env-file .env.local \
  --env NODE_ENV=production \
  --env LINKI_DB_PATH=/data/linki.db \
  --publish 127.0.0.1:3456:3000 \
  --volume "$(pwd)/data:/data" \
  --memory 4G \
  --cpus 4 \
  linki:local
```

Check the UI and the protected MCP route:

```bash
curl --fail --head http://127.0.0.1:3456/login
curl --include --request POST http://127.0.0.1:3456/api/mcp \
  --header 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl-check","version":"1.0.0"}}}'
```

The second command must return `401 Unauthorized` without a bearer token.

## Authenticate LinkedIn and configure the review queue

Open `http://localhost:3456` and sign in with `AUTH_PASSWORD`. If
`data/linki.db` already contains John's authenticated Linki account, keep that
volume and first check whether the UI still reports it as authenticated.

Otherwise, **Settings → LinkedIn → Authenticate** offers two local-only paths:

- **Paste cookies** can reuse John's current browser session by following the UI
  instructions for `li_at` and `document.cookie`. Never put those values in an
  environment file, prompt, tunnel URL, or shared file.
- **Server login** creates a session under Linki's pinned browser fingerprint
  and captures httpOnly cookies that browser paste cannot read. Use it if the
  imported session fails or Sales Navigator access is required.

Create or select:

1. John's LinkedIn account with connection and message limits no higher than 25.
2. A workflow whose initial connection request has an empty note.
3. A list and a run that remains paused for review.

Copy those three IDs into `MCP_ACCOUNT_ID`, `MCP_WORKFLOW_ID`, and `MCP_LIST_ID`,
restart the container, verify `get_outreach_status`, and only then set
`MCP_WRITES_ENABLED=true`. Staging still leaves the run paused; launching it is a
separate UI approval.

## Sumble and Apollo handoff

Run one upstream Sumble MCP or scraper collection each day. Use the normalized,
lowercase company domain as `account_key`, and use Sumble's immutable signal ID
as `signal_key` (or a stable hash of the canonical signal URL when no ID exists).
Only pass new accounts or new signals into enrichment.

Apollo enrichment stays on its REST API. After Apollo returns an approved
contact with a LinkedIn URL, call `stage_prospects` with the original Sumble
keys. Linki stores the signal key under a unique constraint, so retries are safe:
duplicate signals are no-ops, while a new signal for an existing account is
recorded without creating a duplicate workflow enrollment.

## Expose the MCP endpoint

With ngrok:

```bash
ngrok config add-authtoken "$NGROK_AUTHTOKEN"
ngrok http http://127.0.0.1:3456
```

Or with Cloudflare Tunnel:

```bash
cloudflared tunnel --url http://127.0.0.1:3456
```

If the tunnel prints `https://example.ngrok-free.app`, configure the cloud agent
with:

```text
URL: https://example.ngrok-free.app/api/mcp
Authorization: Bearer <MCP_API_TOKEN>
```

Update `NEXTAUTH_URL` to the public HTTPS origin and restart Linki before using
the UI through that hostname. Protect the tunnel itself with an allowlist or
access policy in addition to Linki's bearer token.
