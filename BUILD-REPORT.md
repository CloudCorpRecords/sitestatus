# BUILD REPORT — sitestatus

Clean-room rebuild of `com.downforjustmeoreveryone/is-it-down` v1.0.0
(remote-only MCP server at `https://downforjustmeoreveryone.com/mcp`), built
2026-10-28 as a forwarding client. Package: `@reneturcios/sitestatus`
0.1.0, registry name `io.github.CloudCorpRecords/sitestatus`.

## Surface built

Full surface: **all 5 captured tools built**, no omissions.

| Tool | Required fields as served |
|------|---------------------------|
| `check_site` | `domain` |
| `list_outages` | NO `required` key in the capture — served verbatim, none invented |
| `site_history` | `domain` |
| `check_certificate` | `domain` |
| `list_monitored_sites` | NO `required` key in the capture — served verbatim, none invented |

Each served tool carries exactly the keys `name`, `title`,
`description`, `inputSchema`, exactly as captured. The capture's
`annotations` and `outputSchema` keys were dropped at fixture
slimming and are NOT part of the served literals, per the spec.
Every inputSchema carries `additionalProperties: false`, matching
the fixture. The tool literals were generated programmatically from
`harness/fixtures/isitdown-tools-original.json` by the script at
`/tmp/b44-sitestatus-scratch/gen.py` (parse + re-serialise,
placeholder substitution into `src/forward.ts`) — never retyped —
and a post-generation check (the registration-integrity test suite,
plus the parity harness) confirmed the served literals deep-equal
the fixture's 5 tool objects, in order. Tools are registered via
the MCP SDK low-level Server API (`ListToolsRequestSchema` /
`CallToolRequestSchema` handlers), not McpServer+zod.

## Fixture conflicts

**None.** The spec and the fixture agree on the tools' names,
titles, descriptions, required fields (`domain` for check_site,
site_history and check_certificate; no `required` key for
list_outages and list_monitored_sites) and property shapes.

## Labelled reconstructions (from the spec's Wire section)

- Upstream endpoint pinned: `https://downforjustmeoreveryone.com/mcp`.
- Env override `ISITDOWN_MCP_URL` — labelled reconstruction.
- The registry record declares NO headers on the remote: no auth
  header is ever sent. Tests assert that no `Authorization` header
  is sent under any environment — including with key-like env vars
  (`ISITDOWN_API_KEY`, `API_KEY`, `AUTHORIZATION`) set — and that no
  `X-API-Key` header is ever sent; upstream requests carry only
  `Content-Type`, `Accept` and, when issued, `Mcp-Session-Id`.
- Error rendering `sitestatus error:` text for upstream failures —
  labelled reconstruction.
- Upstream results pass through verbatim, including `isError` and
  extra fields. tools/call is forwarded as streamable-HTTP JSON-RPC:
  initialize (protocolVersion `2025-03-26`) →
  notifications/initialized → tools/call, honouring `Mcp-Session-Id`
  when issued; plain-JSON and SSE replies are both parsed. The
  forwarding core takes an injectable fetch; tests stub the
  upstream — no live network calls in tests.

## Deviations

None.

## Lockfile

- Route: generated clean from birth in the build dir with no
  `node_modules` and no pre-existing lockfile:
  `npm install --package-lock-only --ignore-scripts --offline` (Route 3).
- Parses as JSON; `name` == `@reneturcios/sitestatus`.
- Package entries: **128**.
- sha256: `03bd3422734d9f999f1a419272d4d1932d0c27d765a4080dfdd7e647ada8cec1`
  (re-verified unchanged after the subsequent offline `npm install`).

## server.json

- Description exactly: "Website up/down checks from two continents,
  outage lists, uptime history and TLS expiry." — **88 characters**.
- npm package entry carries `"version": "0.1.0"`; the OCI entry
  (`ghcr.io/cloudcorprecords/sitestatus:0.1.0`) carries **no**
  `version` field. Both entries carry packageArguments
  `[{type: positional, value: mcp}]` and transport stdio. Dockerfile
  (node:20-alpine, both stages) carries the label
  `io.modelcontextprotocol.server.name="io.github.CloudCorpRecords/sitestatus"`.
  Container workflow `IMAGE` is `ghcr.io/cloudcorprecords/sitestatus`
  and its smoke test asserts the server name `sitestatus`.

## Verification (all run 2026-10-28)

1. `npx tsc --noEmit` → exit 0.
2. `npm run build` → exit 0; real `dist/` produced (cli, forward,
   index, mcp, types — .js, .d.ts, .js.map each).
3. `node dist/cli.js --version` → `0.1.0`.
4. `npm test` → **55 tests, 55 pass, 0 fail** (registration-integrity
   suite deep-equals the served tools/list against the fixture's 5
   tools in order, plus the no-`required`-key assertions for
   list_outages and list_monitored_sites, session handling/reuse,
   env override, the no-Authorization-header assertions under any
   environment, verbatim argument forwarding for all 5 tools and
   result pass-through including upstream isError, SSE parsing,
   error rendering, MCP-layer validation, and CLI behaviour).
5. Parity: `python3 /home/hatch/workspace/mcp-rebuild-100/harness/parity.py --original /home/hatch/workspace/mcp-rebuild-100/harness/fixtures/isitdown-tools-original.json --rebuild "stdio:node /home/hatch/workspace/mcp-rebuild-100/builds/sitestatus/dist/cli.js mcp" --out /home/hatch/workspace/mcp-rebuild-100/builds/sitestatus/parity-out` → **verdict PASS, parity 100.0**
   (5/5 identical, 0 missing, 0 extra, no schema diffs). Output in
   `parity-out/`.
