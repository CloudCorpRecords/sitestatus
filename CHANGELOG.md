# Changelog

## 0.1.0 (2026-10-28)

- First release: a forwarding client for the hosted downforjustmeoreveryone MCP server. All five captured tools are answered locally for tools/list, and every tools/call is forwarded upstream over a streamable-HTTP JSON-RPC session (initialize, notifications/initialized, tools/call, honouring the Mcp-Session-Id header when the upstream issues one).
- Tools: `check_site`, `list_outages`, `site_history`, `check_certificate`, `list_monitored_sites`. This is the full captured surface; `list_outages` and `list_monitored_sites` carry no `required` key in the capture and are served verbatim with none invented.
- Upstream results pass through verbatim, including the isError flag; upstream failures surface as `sitestatus error:` text results.
- One bin serves the CLI (one subcommand per tool, plus `--version`) and the stdio MCP server (`mcp` subcommand). The upstream endpoint can be overridden via `ISITDOWN_MCP_URL`. The upstream record declares no headers, so no auth header is ever sent.
