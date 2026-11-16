# sitestatus

Is it down for just you, or for everyone? sitestatus is a local forwarding client for the hosted downforjustmeoreveryone MCP service: it answers `tools/list` locally from the captured tool definitions and forwards every check to the service, returning the answers exactly as the service sends them back.

The surface covers a live up/down check of any public website from an independent server (Singapore, with Boston as the second view for sites that geo-block Singapore), the monitored sites confirmed down right now, uptime history for monitored sites, TLS certificate expiry reads, and the catalogue of the 634 monitored sites across 17 categories. Nothing is cached beyond the service's own 30-second per-domain cache, stored or computed locally — the package is a pipe, not a monitor.

## The tools

- **`check_site`** — Live up/down check of any public website, returning a one-sentence verdict plus status code, latency, resolved IP, redirect target, the view from the other region when available, and how many users reported problems in the last hour. `domain` is required; scheme, path, port and query are ignored and the host is checked as given.
- **`list_outages`** — The monitored sites confirmed down right now: two consecutive failed checks from their home region and no other region seeing them up in the last 15 minutes. An optional `category` filter is available; no field is required.
- **`site_history`** — Uptime percentage over 24 hours and over the requested window (up to 7 days), the outages in that window, when the site was last seen down, the current state and user-report counts. `domain` is required and must be a monitored site; `days` is an optional integer from 1 to 7.
- **`check_certificate`** — Reads the HTTPS certificate of a public domain and reports days until expiry, the expiry date and the issuer. `domain` is required.
- **`list_monitored_sites`** — The 634 sites checked every 5 minutes, grouped in 17 categories. Without arguments it returns the category list with counts; filter by `category` or a text `query` to get domains (at most 200 per call). No field is required.

## Install and run

As an MCP server via npm:

```bash
npx -y @reneturcios/sitestatus mcp
```

MCP client configuration:

```json
{
  "mcpServers": {
    "sitestatus": {
      "command": "npx",
      "args": ["-y", "@reneturcios/sitestatus", "mcp"]
    }
  }
}
```

As a container:

```bash
docker run -i ghcr.io/cloudcorprecords/sitestatus
docker run --rm ghcr.io/cloudcorprecords/sitestatus check_site '{"domain":"github.com"}'
```

## CLI

One binary serves both the command line and the MCP server. Each tool is a subcommand taking a single JSON string with that tool's arguments:

```bash
sitestatus check_site '{"domain":"github.com"}'
sitestatus list_outages '{"category":"ai"}'
sitestatus site_history '{"domain":"github.com","days":3}'
sitestatus check_certificate '{"domain":"example.com"}'
sitestatus list_monitored_sites '{"query":"bank"}'
sitestatus --version
```

Exit codes: `0` when the forwarded call succeeds, `1` when the upstream result is an error, and `2` for usage problems such as an unknown subcommand or a malformed JSON argument.

## Configuration

- `ISITDOWN_MCP_URL` — Overrides the upstream endpoint. The default is the pinned hosted endpoint, `https://downforjustmeoreveryone.com/mcp`. (The override variable is a reconstruction added by this rebuild.)

The upstream registry record declares no headers, so no authentication header is ever sent; the tool surface was captured keyless.

Upstream failures — a JSON-RPC error from the service, a non-2xx response, an unreadable body, or a request that fails outright — are reported to the caller as an error result whose text starts with `sitestatus error:`.

## How forwarding works

The first forwarded call opens a session: an `initialize` request (protocol version `2025-03-26`), followed by a `notifications/initialized` notification, then the `tools/call` itself. If the service answers the initialize request with an `Mcp-Session-Id` header, that value is carried on every later request, and the open session is reused for the rest of the process. Replies are accepted either as plain JSON or as server-sent events. Successful results pass through verbatim, including any `isError` flag and any extra fields the service includes.

## Development

```bash
npm install
npm run build   # tsc -> dist/ (dist/cli.js is the bin)
npm test        # tsx --test test/*.test.ts — stubbed upstream, no network
npm run dev     # run the CLI from source
```

The test suite checks the served tool list against the captured surface, exercises the session handshake and its reuse, verifies that no `Authorization` header is ever sent, and verifies that arguments go upstream untouched and results come back untouched.

## License

MIT — see `LICENSE`. Copyright (c) 2026 Rene Turcios.
