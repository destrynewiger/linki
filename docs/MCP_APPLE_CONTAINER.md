# Review-only MCP and local container operation

`/api/mcp` exposes `get_outreach_status` and `stage_prospects` over stateless
Streamable HTTP. A dedicated `MCP_API_TOKEN` is required on every request.
A browser Origin, when present, must exactly match the origin in `NEXTAUTH_URL`.
A missing token returns 503, an invalid token 401, and an invalid Origin 403.
Native clients may omit Origin. POST requests return JSON; GET and DELETE return
405 because this endpoint offers no server-initiated events or persistent sessions.
Next's parsed body goes directly to the SDK web transport, avoiding the Node
adapter's late request-drain callback and preserving HTTP keep-alive sockets.
This endpoint uses a configured bearer secret;
it does not implement OAuth discovery or delegate the UI login session.

The MCP [transport specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
requires Origin validation. Keep the published port on loopback. A remote proxy
must provide TLS and its own access policy; configure `NEXTAUTH_URL` to its exact
HTTPS origin before allowing browser clients. Do not use a public quick tunnel
as the production access boundary.

## Queue contract

Staging requires all of the following, rechecked inside one SQLite immediate
transaction before any write:

- `MCP_WRITES_ENABLED=true` and all three configured IDs exist.
- The account has a stored authenticated flag and an actual connection limit
  between 1 and 25. Status reports the configured limit, rather than showing a
  lower number while the runner retains a higher limit.
- Exactly one paused or running run matches the configured workflow, account,
  and list, and that run is paused. Multiple eligible runs are an error.
- The list has purpose `linkedin`. The workflow has exactly one enabled step,
  on the LinkedIn track, of type `connect`, with a blank note.
- Every profile is an HTTPS `linkedin.com/in/<slug>` or
  `www.linkedin.com/in/<slug>` URL without credentials or a nondefault port.
  Profile slugs use ASCII letters, digits, dots, underscores or hyphens.
  The stored canonical address uses `www`, without a trailing slash, query or
  fragment. Unsupported profile forms require reconciliation before staging.

The stored authenticated flag is **not a fresh identity/session check**. Confirm
the intended operator, browser lane, company scope and current session through
the existing approved account process before enabling writes. This feature does
not import cookies, log in, change accounts, or authorize sending.

Up to 25 prospects may arrive in one call. New enrollment consumes an unreserved
slot: configured connection limit minus connection-send logs today minus existing
unsent, unfinished LinkedIn profiles in pending, paused or running runs for this
account. This intentionally conservative reservation prevents repeated calls from
building an unlimited queue. It may reserve other workflows' unfinished profiles.
Daily accounting follows the existing runner's UTC date, not the displayed account
timezone. Status distinguishes daily remaining capacity and staging slots.

Signal identity is `(lowercase source, lowercase account_key, trimmed signal_key)`.
Whitespace-only required fields and non-HTTP(S) evidence URLs fail validation.
A replay for the same canonical profile is a no-op even at zero capacity. Reusing
that key for another or deleted profile fails the entire batch. A new signal for
an existing workflow enrollment records evidence without enrolling again. Existing
profile URL variants are reused; ambiguous duplicate targets must be reconciled.
An active enrollment elsewhere is recorded as skipped. A mid-batch failure rolls
back targets, evidence, list entries and enrollment together.

The operation creates only a pending LinkedIn track with no email account. It
never launches a run, changes its status, sends a message, or visits LinkedIn.
A later UI launch and any workflow/account changes remain separate operator
operations. The 25/day guarantee depends on keeping the account limit at or below
25 and retaining the existing runner's controls; MCP is not a tamper-resistant
restriction on administrators or direct database edits.

## Environment and rollout

Use the repository's lockfile with Node 22 and `npm ci`. Review `.env.example` and
create a private `.env.local` at mode 0600. Generate `NEXTAUTH_SECRET`,
`AUTH_PASSWORD` and `MCP_API_TOKEN` into a password manager or protected secret
file. Do not print their values or put them in shell history, prompts or logs.
Set `MCP_WRITES_ENABLED=false` initially. Use a dedicated empty data directory;
never attach an existing operator's data volume to a smoke-test container.

Before touching existing data, take a SQLite backup through its native backup
API, including integrity verification, and preserve the current image digest and
configuration in private recovery storage. Startup adds `mcp_signal_events` with
a unique signal identity constraint. It does not rewrite existing targets or
start a paused run. Existing application migrations still run at startup, so test
against a private backup before a production upgrade.

1. Build and smoke-test the application using synthetic data and no account
   credentials. Run `npm run lint`, `npx tsc --noEmit`, `npm run build`, and
   `npm run test:integration`. After the build, rerun the same suite against
   production with `LINKI_TEST_RUNTIME=production npm run test:integration`.
2. Choose the verified company/operator account, dedicated blank-connect workflow,
   LinkedIn list and one paused run. Set the three MCP IDs; keep writes disabled.
3. Read `get_outreach_status`, verify configuration, account identity and actual
   limits. Enable writes only for the reviewed staging integration.
4. Stage one reviewed record and read its signal, list membership and pending
   track back. Confirm run remains paused. Repeat the request and confirm zero
   new enrollment. Queue acceptance is not a sent or delivered connection.
5. Leave all outbound execution subject to the account's existing approval policy.

Rollback first sets `MCP_WRITES_ENABLED=false` and restarts the service. Preserve
the staged records and return to the prior image/configuration. Do not drop the
signal ledger or delete staged records to hide a failed rollout. Restore a backup
only through an explicit data-recovery decision because newer writes could be lost.

## Apple Container

Apple's [official project requirements](https://github.com/apple/container#requirements)
currently require Apple silicon and macOS 26. The current review host has macOS
15.5 and no `container` executable, so native Apple engine execution is unverified.
The Dockerfile produces an OCI Linux image. Linux tests do not prove the Apple
engine, host filesystem permissions, browser login, or a live account session.

On a supported host with the signed Apple Container installation already present:

```bash
container system status
container build --arch arm64 --memory 4G --cpus 4 --tag linki:review .
mkdir -m 700 data-review
container run --detach --name linki-review \
  --env-file .env.local --env NODE_ENV=production \
  --env LINKI_DB_PATH=/data/linki.db \
  --publish 127.0.0.1:3456:3000 \
  --volume "$PWD/data-review:/data" --memory 4G --cpus 4 linki:review
```

The image runs as the unprivileged `node` user. The dedicated bind directory must
be writable by that container UID. Inspect and set ownership for this directory
only; do not use world-writable permissions or recursively change an existing
operator's files. If binding is unavailable, use a dedicated managed volume whose
ownership is initialized for that UID.

Check `/login` returns 200 and unauthenticated `/api/mcp` returns 401. Initialize a
native MCP client using the secret manager's bearer injection, list exactly the two
tools, and run the synthetic paused-staging checks above. Inspect the image's ARM64
architecture and Chromium version. Record the actual image digest, engine version,
HTTP results and database readback; do not reuse an older build's receipt.

Stop and remove only the `linki-review` test container after verification. Preserve
the production volume, account sessions and other containers.

## Upstream handoff

Sumble supplies a stable signal ID (or a reproducible canonical-URL hash) and the
normalized company domain. Apollo enrichment uses its own approved identity/API.
Only pass reviewed contacts with the original signal keys into Linki. Collection,
enrichment, staging, operator launch and native send receipts remain separate
states. The MCP tools do not invoke Sumble, Apollo or LinkedIn themselves.
