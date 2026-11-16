import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  SitestatusClient,
  callTool,
  createClient,
  DEFAULT_ENDPOINT_URL,
  isKnownTool,
  parseRpcBody,
  PROTOCOL_VERSION,
  TOOL_DEFS,
  TOOL_NAMES,
  VERSION,
} from "../src/forward.js";
import { handleCallTool } from "../src/mcp.js";
import type {
  FetchFn,
  FetchResponseLike,
  ToolDef,
  ToolResult,
} from "../src/types.js";

/**
 * Every test runs against a stubbed JSON-RPC upstream that
 * implements the streamable-HTTP session flow
 * (initialize -> notifications/initialized -> tools/call):
 * no live network, and the real downforjustmeoreveryone
 * endpoint is never contacted.
 */

const FIXTURE_URL = new URL(
  "../../../harness/fixtures/isitdown-tools-original.json",
  import.meta.url,
);
const FIXTURE_AVAILABLE = existsSync(FIXTURE_URL);
const fixture = (
  FIXTURE_AVAILABLE
    ? JSON.parse(readFileSync(FIXTURE_URL, "utf-8"))
    : { tools: [] }
) as {
  tools: ToolDef[];
};
/**
 * Publish-survival guard (Wave 25 preflight, proven Wave 24 pattern):
 * the parity fixture lives in the build harness, outside the published
 * repo tree, so fixture-dependent tests skip cleanly when it is absent;
 * with the fixture present they run in full, with no skips.
 */
function skipWithoutFixture(t: {
  skip: (message: string) => void;
}): boolean {
  if (FIXTURE_AVAILABLE) return false;
  t.skip("parity fixture lives in the build harness, not the repo tree");
  return true;
}


const CHECK = "check_site";
const OUTAGES = "list_outages";
const HISTORY = "site_history";
const CERT = "check_certificate";
const MONITORED = "list_monitored_sites";
const ALL_TOOLS = [CHECK, OUTAGES, HISTORY, CERT, MONITORED];

const SAMPLE_RESULT = {
  content: [{ type: "text", text: "{\"status\":\"up\"}" }],
  structuredContent: { status: "up" },
};

const SAMPLE_ARGS = { domain: "github.com" };

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

interface FakeOptions {
  callResult?: Record<string, unknown>;
  callBodyText?: string;
  callError?: Record<string, unknown>;
  callStatus?: number;
  initError?: Record<string, unknown>;
  throwOn?: "initialize" | "tools/call";
  sessionId?: string | null;
  hangOnCall?: boolean;
  sse?: boolean;
}

function makeResponse(
  status: number,
  bodyText: string,
  headers: Record<string, string> = {},
): FetchResponseLike {
  const lowered = new Map(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => lowered.get(name.toLowerCase()) ?? null },
    text: async () => bodyText,
  };
}

function jsonResponse(
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
) {
  return makeResponse(status, JSON.stringify(payload), headers);
}

function makeUpstream(options: FakeOptions = {}): {
  fetchFn: FetchFn;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
    calls.push({ url, headers: init?.headers ?? {}, body });
    const method = body.method as string;
    if (options.throwOn === method) throw new Error("socket hang up");
    if (method === "initialize") {
      if (options.initError !== undefined) {
        return jsonResponse(200, {
          jsonrpc: "2.0",
          id: body.id,
          error: options.initError,
        });
      }
      const headers: Record<string, string> = {};
      const sessionId =
        options.sessionId === undefined ? "sess-abc" : options.sessionId;
      if (sessionId !== null) headers["mcp-session-id"] = sessionId;
      return jsonResponse(
        200,
        {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            serverInfo: { name: "is-it-down", version: "1.0.0" },
          },
        },
        headers,
      );
    }
    if (method === "notifications/initialized") {
      return makeResponse(202, "");
    }
    if (method === "tools/call") {
      if (options.hangOnCall) {
        return new Promise<FetchResponseLike>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal) {
            if (signal.aborted) {
              reject(new Error("aborted"));
              return;
            }
            signal.addEventListener("abort", () => reject(new Error("aborted")));
          }
        });
      }
      if (options.callBodyText !== undefined) {
        return makeResponse(options.callStatus ?? 200, options.callBodyText);
      }
      if (options.callError !== undefined) {
        return jsonResponse(200, {
          jsonrpc: "2.0",
          id: body.id,
          error: options.callError,
        });
      }
      const result = options.callResult ?? SAMPLE_RESULT;
      const payload = { jsonrpc: "2.0", id: body.id, result };
      if (options.sse) {
        return makeResponse(
          200,
          `event: message\ndata: ${JSON.stringify(payload)}\n\n`,
        );
      }
      return jsonResponse(options.callStatus ?? 200, payload);
    }
    return jsonResponse(200, {});
  };
  return { fetchFn, calls };
}

function stubClient(options: FakeOptions = {}, extra: Record<string, unknown> = {}) {
  const upstream = makeUpstream(options);
  const c = new SitestatusClient({
    fetchFn: upstream.fetchFn,
    env: {},
    ...extra,
  });
  return { client: c, calls: upstream.calls };
}

function textOf(result: ToolResult): string {
  const content = result.content as Array<{ type: string; text: string }>;
  return content[0].text;
}

function methods(calls: Captured[]): string[] {
  return calls.map((c) => c.body.method as string);
}

function schemaOf(tool: ToolDef): Record<string, any> {
  return tool.inputSchema as Record<string, any>;
}

function hasAuthHeader(call: Captured): boolean {
  return Object.keys(call.headers).some(
    (k) => k.toLowerCase() === "authorization",
  );
}

/* ------------------------------------------------------------------ */

describe("registration integrity (captured surface)", () => {
  it("serves exactly the fixture's 5 tools, deep-equal, in order", (t) => {
    if (skipWithoutFixture(t)) return;
    assert.equal(fixture.tools.length, 5);
    assert.deepEqual(TOOL_DEFS, fixture.tools);
  });

  it("serves the 5 tool names in fixture order", () => {
    assert.deepEqual(TOOL_NAMES, ALL_TOOLS);
  });

  it("carries exactly the fixture's keys on every tool", () => {
    for (const tool of TOOL_DEFS) {
      assert.deepEqual(Object.keys(tool).sort(), [
        "description",
        "inputSchema",
        "name",
        "title",
      ]);
    }
  });

  it("carries the fixture's titles verbatim", () => {
    assert.equal(TOOL_DEFS[0].title, "Check whether a website is down");
    assert.equal(TOOL_DEFS[1].title, "Which monitored sites are down right now");
    assert.equal(TOOL_DEFS[2].title, "Uptime and recent incidents of a monitored site");
    assert.equal(TOOL_DEFS[3].title, "TLS certificate expiry of a website");
    assert.equal(TOOL_DEFS[4].title, "Sites with stored history");
  });

  it("carries the fixture's descriptions verbatim", (t) => {
    if (skipWithoutFixture(t)) return;
    for (let i = 0; i < TOOL_DEFS.length; i++) {
      assert.equal(TOOL_DEFS[i].description, fixture.tools[i].description);
    }
    assert.ok(TOOL_DEFS[0].description.startsWith("Live up/down check of any public website"));
    assert.ok(TOOL_DEFS[1].description.startsWith("Lists the monitored sites (634 across 17 categories)"));
    assert.ok(TOOL_DEFS[3].description.startsWith("Reads the HTTPS certificate of a public domain"));
  });

  it("list_outages carries NO required key, exactly as captured", () => {
    assert.equal("required" in schemaOf(TOOL_DEFS[1]), false);
    assert.equal(schemaOf(TOOL_DEFS[1]).required, undefined);
  });

  it("list_monitored_sites carries NO required key, exactly as captured", () => {
    assert.equal("required" in schemaOf(TOOL_DEFS[4]), false);
    assert.equal(schemaOf(TOOL_DEFS[4]).required, undefined);
  });

  it("check_site, site_history and check_certificate each require exactly domain", () => {
    assert.deepEqual(schemaOf(TOOL_DEFS[0]).required, ["domain"]);
    assert.deepEqual(schemaOf(TOOL_DEFS[2]).required, ["domain"]);
    assert.deepEqual(schemaOf(TOOL_DEFS[3]).required, ["domain"]);
  });

  it("carries object type and additionalProperties false on every inputSchema, with no $schema marker", () => {
    for (const tool of TOOL_DEFS) {
      assert.equal(schemaOf(tool).type, "object");
      assert.equal(schemaOf(tool).additionalProperties, false);
      assert.equal("$schema" in schemaOf(tool), false);
    }
  });

  it("carries every fixture property, in order, for every tool", (t) => {
    if (skipWithoutFixture(t)) return;
    for (let i = 0; i < TOOL_DEFS.length; i++) {
      const served = Object.keys(schemaOf(TOOL_DEFS[i]).properties);
      const expected = Object.keys(schemaOf(fixture.tools[i]).properties);
      assert.deepEqual(served, expected);
    }
    assert.deepEqual(Object.keys(schemaOf(TOOL_DEFS[0]).properties), ["domain"]);
    assert.deepEqual(Object.keys(schemaOf(TOOL_DEFS[1]).properties), ["category"]);
    assert.deepEqual(Object.keys(schemaOf(TOOL_DEFS[2]).properties), ["domain", "days"]);
    assert.deepEqual(Object.keys(schemaOf(TOOL_DEFS[3]).properties), ["domain"]);
    assert.deepEqual(Object.keys(schemaOf(TOOL_DEFS[4]).properties), ["category", "query"]);
  });

  it("site_history days is an integer bounded 1 to 7", () => {
    const days = schemaOf(TOOL_DEFS[2]).properties.days;
    assert.equal(days.type, "integer");
    assert.equal(days.minimum, 1);
    assert.equal(days.maximum, 7);
  });

  it("isKnownTool recognises all 5 built tools and rejects others", () => {
    for (const name of ALL_TOOLS) assert.equal(isKnownTool(name), true);
    assert.equal(isKnownTool("check"), false);
    assert.equal(isKnownTool("register_monitor"), false);
    assert.equal(isKnownTool(""), false);
  });
});

/* ------------------------------------------------------------------ */

describe("session establishment and reuse", () => {
  it("runs initialize, notifications/initialized, then tools/call in order", async () => {
    const { client: c, calls } = stubClient();
    const out = await c.callTool(CHECK, SAMPLE_ARGS);
    assert.equal(out.isError, undefined);
    assert.deepEqual(methods(calls), [
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
    assert.ok(calls.every((call) => call.url === DEFAULT_ENDPOINT_URL));
    assert.equal(DEFAULT_ENDPOINT_URL, "https://downforjustmeoreveryone.com/mcp");
    for (const call of calls) {
      assert.equal(call.headers["Content-Type"], "application/json");
      assert.equal(call.headers["Accept"], "application/json, text/event-stream");
    }
    assert.equal(calls[0].headers["Mcp-Session-Id"], undefined);
    assert.equal(calls[1].headers["Mcp-Session-Id"], "sess-abc");
    assert.equal(calls[2].headers["Mcp-Session-Id"], "sess-abc");
  });

  it("sends clientInfo name sitestatus and the pinned protocol version on initialize", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(CHECK, SAMPLE_ARGS);
    const initParams = calls[0].body.params as Record<string, unknown>;
    assert.equal(initParams.protocolVersion, PROTOCOL_VERSION);
    assert.equal(PROTOCOL_VERSION, "2025-03-26");
    assert.deepEqual(initParams.capabilities, {});
    assert.deepEqual(initParams.clientInfo, { name: "sitestatus", version: VERSION });
  });

  it("establishes the session lazily once and reuses it on later calls", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(CHECK, SAMPLE_ARGS);
    await c.callTool(CERT, { domain: "example.com" });
    assert.deepEqual(methods(calls), [
      "initialize",
      "notifications/initialized",
      "tools/call",
      "tools/call",
    ]);
    assert.equal(calls[3].headers["Mcp-Session-Id"], "sess-abc");
    assert.notEqual(calls[2].body.id, calls[3].body.id);
  });

  it("sends no session header when the upstream issues none", async () => {
    const { client: c, calls } = stubClient({ sessionId: null });
    const out = await c.callTool(CHECK, SAMPLE_ARGS);
    assert.equal(out.isError, undefined);
    assert.ok(calls.every((call) => call.headers["Mcp-Session-Id"] === undefined));
  });

  it("honours the ISITDOWN_MCP_URL env override", async () => {
    const upstream = makeUpstream();
    const c = new SitestatusClient({
      fetchFn: upstream.fetchFn,
      env: { ISITDOWN_MCP_URL: "https://staging.example.com/mcp" },
    });
    await c.callTool(CHECK, SAMPLE_ARGS);
    assert.ok(
      upstream.calls.every((call) => call.url === "https://staging.example.com/mcp"),
    );
  });

  it("honours an explicit url override over the default endpoint", async () => {
    const upstream = makeUpstream();
    const c = createClient({
      fetchFn: upstream.fetchFn,
      env: {},
      url: "https://alt.example.com/mcp",
    });
    await c.callTool(CHECK, SAMPLE_ARGS);
    assert.ok(upstream.calls.every((call) => call.url === "https://alt.example.com/mcp"));
  });

  it("prefers an explicit url override over the env override", async () => {
    const upstream = makeUpstream();
    const c = createClient({
      fetchFn: upstream.fetchFn,
      env: { ISITDOWN_MCP_URL: "https://env.example.com/mcp" },
      url: "https://explicit.example.com/mcp",
    });
    await c.callTool(CHECK, SAMPLE_ARGS);
    assert.ok(
      upstream.calls.every((call) => call.url === "https://explicit.example.com/mcp"),
    );
  });

  it("falls back to the pinned endpoint when the env override is blank", async () => {
    const upstream = makeUpstream();
    const c = new SitestatusClient({
      fetchFn: upstream.fetchFn,
      env: { ISITDOWN_MCP_URL: "   " },
    });
    await c.callTool(CHECK, SAMPLE_ARGS);
    assert.ok(upstream.calls.every((call) => call.url === DEFAULT_ENDPOINT_URL));
  });
});

/* ------------------------------------------------------------------ */

describe("no Authorization header is ever sent (record declares no headers)", () => {
  it("sends no Authorization header with an empty environment", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(CHECK, SAMPLE_ARGS);
    assert.equal(calls.length, 3);
    assert.ok(calls.every((call) => !hasAuthHeader(call)));
    assert.ok(calls.every((call) => call.headers["Authorization"] === undefined));
  });

  it("sends no Authorization header even when key-like env vars are set", async () => {
    const upstream = makeUpstream();
    const c = new SitestatusClient({
      fetchFn: upstream.fetchFn,
      env: {
        ISITDOWN_API_KEY: "should-never-be-sent",
        API_KEY: "also-ignored",
        AUTHORIZATION: "Bearer planted",
      },
    });
    await c.callTool(CHECK, SAMPLE_ARGS);
    assert.equal(upstream.calls.length, 3);
    assert.ok(upstream.calls.every((call) => !hasAuthHeader(call)));
  });

  it("never sends an X-API-Key header either", async () => {
    const upstream = makeUpstream();
    const c = new SitestatusClient({
      fetchFn: upstream.fetchFn,
      env: { ISITDOWN_API_KEY: "should-never-be-sent" },
    });
    await c.callTool(CHECK, SAMPLE_ARGS);
    assert.ok(upstream.calls.every((call) => call.headers["X-API-Key"] === undefined));
    const { client: c2, calls } = stubClient();
    await c2.callTool(CHECK, SAMPLE_ARGS);
    assert.ok(calls.every((call) => call.headers["X-API-Key"] === undefined));
  });

  it("sends only Content-Type, Accept and (when issued) Mcp-Session-Id headers", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(CHECK, SAMPLE_ARGS);
    assert.deepEqual(Object.keys(calls[0].headers).sort(), ["Accept", "Content-Type"]);
    assert.deepEqual(Object.keys(calls[2].headers).sort(), [
      "Accept",
      "Content-Type",
      "Mcp-Session-Id",
    ]);
  });
});

/* ------------------------------------------------------------------ */

describe("tools/call forwarding", () => {
  it("forwards a check_site call verbatim", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(CHECK, SAMPLE_ARGS);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, CHECK);
    assert.deepEqual(params.arguments, SAMPLE_ARGS);
  });

  it("forwards list_outages, site_history, check_certificate and list_monitored_sites under their own names", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await c.callTool(OUTAGES, { category: "ai" });
    await c.callTool(HISTORY, { domain: "github.com", days: 3 });
    await c.callTool(CERT, { domain: "example.com" });
    await c.callTool(MONITORED, { query: "bank" });
    const callParams = upstream.calls
      .filter((call) => call.body.method === "tools/call")
      .map((call) => call.body.params as Record<string, unknown>);
    assert.deepEqual(
      callParams.map((p) => p.name),
      [OUTAGES, HISTORY, CERT, MONITORED],
    );
    assert.deepEqual(callParams[0].arguments, { category: "ai" });
    assert.deepEqual(callParams[1].arguments, { domain: "github.com", days: 3 });
    assert.deepEqual(callParams[2].arguments, { domain: "example.com" });
    assert.deepEqual(callParams[3].arguments, { query: "bank" });
  });

  it("forwards list_outages and list_monitored_sites with no arguments as an empty object", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await c.callTool(OUTAGES, {});
    await c.callTool(MONITORED, {});
    const callParams = upstream.calls
      .filter((call) => call.body.method === "tools/call")
      .map((call) => call.body.params as Record<string, unknown>);
    assert.deepEqual(callParams[0].arguments, {});
    assert.deepEqual(callParams[1].arguments, {});
  });

  it("passes the upstream result through verbatim, including extra fields", async () => {
    const { client: c } = stubClient();
    const out = await c.callTool(CHECK, SAMPLE_ARGS);
    assert.deepEqual(out, SAMPLE_RESULT);
  });

  it("passes an upstream isError result through untouched", async () => {
    const upstreamResult = {
      content: [{ type: "text", text: "domain could not be resolved" }],
      isError: true,
    };
    const { client: c } = stubClient({ callResult: upstreamResult });
    const out = await c.callTool(CHECK, SAMPLE_ARGS);
    assert.deepEqual(out, upstreamResult);
  });

  it("reads an SSE-framed tools/call response", async () => {
    const { client: c } = stubClient({ sse: true });
    const out = await c.callTool(CHECK, SAMPLE_ARGS);
    assert.equal(out.isError, undefined);
    assert.deepEqual(out, SAMPLE_RESULT);
  });

  it("the one-shot callTool helper forwards under the right tool name", async () => {
    const upstream = makeUpstream();
    const out = await callTool(
      CERT,
      { domain: "example.com" },
      { fetchFn: upstream.fetchFn, env: {} },
    );
    assert.equal(out.isError, undefined);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, CERT);
    assert.deepEqual(params.arguments, { domain: "example.com" });
  });
});

/* ------------------------------------------------------------------ */

describe("upstream failures surface as sitestatus error text", () => {
  it("maps a JSON-RPC error to `sitestatus error: <message>`", async () => {
    const { client: c } = stubClient({
      callError: { code: -32000, message: "check failed upstream" },
    });
    const out = await c.callTool(CHECK, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "sitestatus error: check failed upstream");
  });

  it("maps an initialize JSON-RPC error to sitestatus error text", async () => {
    const { client: c } = stubClient({
      initError: { code: -32600, message: "bad initialize" },
    });
    const out = await c.callTool(CHECK, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "sitestatus error: bad initialize");
  });

  it("maps an unparseable upstream response to a malformed-response error", async () => {
    const { client: c } = stubClient({ callBodyText: "<html>oops</html>" });
    const out = await c.callTool(CHECK, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "sitestatus error: malformed response");
  });

  it("maps a response with no result object to a malformed-response error", async () => {
    const { client: c } = stubClient({
      callBodyText: '{"jsonrpc":"2.0","id":3,"result":null}',
    });
    const out = await c.callTool(CHECK, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "sitestatus error: malformed response");
  });

  it("maps a non-2xx upstream status to sitestatus error text", async () => {
    const { client: c } = stubClient({ callBodyText: "internal error", callStatus: 500 });
    const out = await c.callTool(CHECK, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "sitestatus error: HTTP 500");
  });

  it("maps a throwing fetch to sitestatus error text", async () => {
    const { client: c } = stubClient({ throwOn: "tools/call" });
    const out = await c.callTool(CHECK, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.match(textOf(out), /^sitestatus error: /);
  });

  it("maps a throwing initialize fetch to sitestatus error text", async () => {
    const { client: c } = stubClient({ throwOn: "initialize" });
    const out = await c.callTool(CHECK, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "sitestatus error: socket hang up");
  });

  it("maps a timed-out call to sitestatus error text", async () => {
    const { client: c } = stubClient({ hangOnCall: true }, { timeoutMs: 20 });
    const out = await c.callTool(CHECK, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.match(textOf(out), /^sitestatus error: /);
  });
});

/* ------------------------------------------------------------------ */

describe("parseRpcBody", () => {
  it("parses plain JSON and picks the message with the matching id", () => {
    const body = '{"jsonrpc":"2.0","id":7,"result":{"ok":true}}';
    assert.deepEqual(parseRpcBody(body, 7), {
      jsonrpc: "2.0",
      id: 7,
      result: { ok: true },
    });
  });

  it("parses SSE data lines", () => {
    const body =
      'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"ok":true}}\n\n';
    assert.deepEqual(parseRpcBody(body, 2), {
      jsonrpc: "2.0",
      id: 2,
      result: { ok: true },
    });
  });

  it("picks the matching id among several SSE messages", () => {
    const body =
      'data: {"jsonrpc":"2.0","id":1,"result":{"n":1}}\n\n' +
      'data: {"jsonrpc":"2.0","id":2,"result":{"n":2}}\n\n';
    assert.deepEqual(parseRpcBody(body, 2), {
      jsonrpc: "2.0",
      id: 2,
      result: { n: 2 },
    });
  });

  it("ignores the SSE [DONE] sentinel", () => {
    const body =
      'data: {"jsonrpc":"2.0","id":4,"result":{"ok":true}}\ndata: [DONE]\n';
    assert.deepEqual(parseRpcBody(body, 4), {
      jsonrpc: "2.0",
      id: 4,
      result: { ok: true },
    });
  });

  it("returns null for empty and unparseable bodies", () => {
    assert.equal(parseRpcBody(""), null);
    assert.equal(parseRpcBody("not json at all"), null);
    assert.equal(parseRpcBody("[1,2,3]"), null);
  });
});

/* ------------------------------------------------------------------ */

describe("MCP layer validation", () => {
  it("rejects an unknown tool with MethodNotFound before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, "not_a_tool", {}),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.MethodNotFound,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("rejects array arguments with InvalidParams before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, CHECK, ["nope"]),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.InvalidParams,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("rejects string arguments with InvalidParams before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, CHECK, "domain=github.com"),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.InvalidParams,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("forwards a valid check_site call through the MCP layer unchanged", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    const out = await handleCallTool(c, CHECK, SAMPLE_ARGS);
    assert.deepEqual(out, SAMPLE_RESULT);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.deepEqual(params.arguments, SAMPLE_ARGS);
  });

  it("treats omitted arguments as an empty object", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    const out = await handleCallTool(c, OUTAGES, undefined);
    assert.deepEqual(out, SAMPLE_RESULT);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.deepEqual(params.arguments, {});
  });
});

/* ------------------------------------------------------------------ */

describe("CLI", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

  function runCli(args: string[]) {
    return spawnSync(process.execPath, ["--import", "tsx", cliPath, ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 30000,
    });
  }

  it("--version prints 0.1.0 and exits 0", () => {
    const res = runCli(["--version"]);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "0.1.0");
    assert.equal(res.stdout.trim(), VERSION);
  });

  it("-v prints 0.1.0 and exits 0", () => {
    const res = runCli(["-v"]);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "0.1.0");
  });

  it("an unknown command prints usage on stderr and exits 2", () => {
    const res = runCli(["not-a-tool"]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /Usage:/);
    assert.match(res.stderr, /check_site, list_outages, site_history, check_certificate, list_monitored_sites/);
  });

  it("a non-JSON argument exits 2", () => {
    const res = runCli([CHECK, "not json"]);
    assert.equal(res.status, 2);
  });

  it("a JSON array argument exits 2", () => {
    const res = runCli([CHECK, "[]"]);
    assert.equal(res.status, 2);
  });

  it("extra arguments after mcp exit 2", () => {
    const res = runCli(["mcp", "extra"]);
    assert.equal(res.status, 2);
  });
});
