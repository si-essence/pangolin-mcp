import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { describe, expect, it } from "vitest";
import { OPERATIONS, toolIsWrite, toolNames, type Operation } from "../src/operations.js";
import {
  BASE,
  TOKEN,
  expectAuth,
  jsonFetch,
  jsonResponse,
  pangolinOk,
  runtimeFor,
} from "./harness.js";
import { connectServer } from "./mcp.js";
import { readToolText } from "./result.js";

const TOOL_NAMES = toolNames();
const WRITE_OPS = OPERATIONS.filter((operation) => operation.write);
const READ_OPS = OPERATIONS.filter((operation) => !operation.write);

function leakyResponse(): Response {
  return jsonResponse({
    data: {
      id: "org-1",
      name: `hello ${TOKEN}`,
      apiKey: TOKEN,
      password: "hunter2-secret-value",
      newtSecret: "newt-secret-value-xx",
      olmSecret: "olm-secret-value-xx",
      accessToken: "share-link-secret-token",
      clientSecret: "idp-client-secret-xx",
      apiKeyId: "key-id-keep",
      orgId: "org-keep",
      stack: "Error\n    at /usr/src/app/server.ts:9:1",
      path: "/home/box/pangolin/data.sqlite",
    },
    success: true,
    error: false,
    message: "ok",
    status: 200,
    stack: "/var/lib/pangolin/oops.js",
  });
}

function argsFor(operation: Operation): Record<string, unknown> {
  const args: Record<string, unknown> = { action: operation.action };
  if (Object.keys(operation.sampleParams).length > 0) args["params"] = operation.sampleParams;
  if (Object.keys(operation.sampleQuery).length > 0) args["query"] = operation.sampleQuery;
  if (operation.sampleBody !== undefined) args["body"] = operation.sampleBody;
  return args;
}

async function withClient(
  fetchImpl: typeof fetch,
  extra: NodeJS.ProcessEnv,
  run: (client: Client) => Promise<void>,
): Promise<void> {
  const runtime = runtimeFor(fetchImpl, extra);
  const connected = await connectServer(runtime);
  try {
    await run(connected.client);
  } finally {
    await connected.close();
  }
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean; json: Record<string, unknown> | null }> {
  const result = readToolText(await client.callTool({ name, arguments: args }));
  expect(result.text).not.toContain(TOKEN);
  if (result.isError) return { ...result, json: null };
  return { ...result, json: JSON.parse(result.text) as Record<string, unknown> };
}

describe("pangolin tools", () => {
  it("publishes every tool with a description and confirm on writes", async () => {
    const { fetchImpl } = jsonFetch(() => pangolinOk());
    await withClient(fetchImpl, {}, async (client) => {
      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name).sort();
      expect(names).toEqual(TOOL_NAMES);
      for (const tool of listed.tools) {
        expect((tool.description ?? "").trim().length).toBeGreaterThan(20);
        const schema = JSON.stringify(tool.inputSchema);
        if (toolIsWrite(tool.name)) expect(schema).toContain("confirm");
        else expect(schema).not.toContain("confirm");
      }
    });
  });

  it("scopes the published set to PANGOLIN_TOOLSETS", async () => {
    const { fetchImpl } = jsonFetch(() => pangolinOk());
    await withClient(fetchImpl, { PANGOLIN_TOOLSETS: "sites,roles" }, async (client) => {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
        "pangolin_roles",
        "pangolin_sites",
      ]);
    });
    await withClient(fetchImpl, { PANGOLIN_TOOLSETS: undefined }, async (client) => {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
        "pangolin_orgs",
        "pangolin_resources",
        "pangolin_roles",
        "pangolin_sites",
        "pangolin_targets",
        "pangolin_users",
      ]);
      expect(listed.tools.some((tool) => tool.name === "pangolin_ai")).toBe(false);
    });
  });

  it("redacts secrets, ids stay, and stack plus filesystem paths are dropped", async () => {
    const { fetchImpl, calls } = jsonFetch((captured) => {
      expectAuth(captured);
      return leakyResponse();
    });
    await withClient(fetchImpl, {}, async (client) => {
      const listed = await call(client, "pangolin_orgs", { action: "list_orgs" });
      expect(listed.isError).toBe(false);
      const raw = JSON.stringify(listed.json);
      expect(raw).toContain("[redacted]");
      expect(raw).toContain("key-id-keep");
      expect(raw).toContain("org-keep");
      expect(raw).not.toContain("/usr/src");
      expect(raw).not.toContain("/home/box");
      expect(raw).not.toContain("/var/lib");
      expect(raw).not.toContain("stack");
      expect(raw).not.toContain(TOKEN);
      expect(raw).not.toContain("hunter2-secret-value");
      expect(raw).not.toContain("newt-secret-value-xx");
      expect(raw).not.toContain("share-link-secret-token");
      expect(calls[0]?.url).toBe(`${BASE}/v1/orgs`);
      expect(calls[0]?.authorization).toBe(`Bearer ${TOKEN}`);
    });
  });

  it("previews org create without calling upstream, then executes with confirm", async () => {
    const { fetchImpl, calls } = jsonFetch(() => pangolinOk({ orgId: "org-1" }));
    await withClient(fetchImpl, {}, async (client) => {
      const preview = await call(client, "pangolin_orgs", {
        action: "create_org",
        body: { orgId: "mcp1", name: "MCP", subnet: "10.0.0.0/24", utilitySubnet: "10.0.1.0/24" },
      });
      expect(preview.json).toMatchObject({
        executed: false,
        dry_run: true,
        blocked: false,
        method: "PUT",
        path: "v1/org",
      });
      expect(calls).toHaveLength(0);
      const created = await call(client, "pangolin_orgs", {
        action: "create_org",
        body: { orgId: "mcp1", name: "MCP", subnet: "10.0.0.0/24", utilitySubnet: "10.0.1.0/24" },
        confirm: true,
      });
      expect(created.json).toMatchObject({ executed: true, dry_run: false });
      expect(calls[0]?.method).toBe("PUT");
    });
  });

  it("blocks writes when PANGOLIN_ALLOW_WRITES is not true", async () => {
    const { fetchImpl, calls } = jsonFetch(() => pangolinOk());
    await withClient(fetchImpl, { PANGOLIN_ALLOW_WRITES: "false" }, async (client) => {
      const result = await call(client, "pangolin_orgs", {
        action: "delete_org",
        params: { orgId: "org-sample" },
        confirm: true,
      });
      expect(result.json).toMatchObject({ executed: false, blocked: true, method: "DELETE" });
      expect(calls).toHaveLength(0);
    });
  });

  it("warns on public resources, access tokens, deletes, api keys, and blueprints", async () => {
    const { fetchImpl } = jsonFetch(() => pangolinOk());
    await withClient(fetchImpl, {}, async (client) => {
      const resource = await call(client, "pangolin_resources", {
        action: "create_org_public_resource",
        params: { orgId: "org-sample" },
        body: { name: "web", mode: "http" },
      });
      expect(JSON.stringify(resource.json)).toContain("public resource");
      const token = await call(client, "pangolin_access_tokens", {
        action: "delete_access_token",
        params: { accessTokenId: "accesstoken-sample" },
      });
      expect(JSON.stringify(token.json)).toContain("access tokens");
      const key = await call(client, "pangolin_api_keys", {
        action: "create_org_api_key",
        params: { orgId: "org-sample" },
        body: { name: "mcp" },
      });
      expect(JSON.stringify(key.json)).toContain("API key");
      const blueprint = await call(client, "pangolin_blueprints", {
        action: "apply_org_blueprint",
        params: { orgId: "org-sample" },
        body: { blueprint: "sample" },
      });
      expect(JSON.stringify(blueprint.json)).toContain("blueprint");
    });
  });
});

describe("every registered tool", () => {
  it("has a coverage case for each published name", async () => {
    const { fetchImpl } = jsonFetch(() => pangolinOk());
    await withClient(fetchImpl, {}, async (client) => {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual(TOOL_NAMES);
    });
    const covered = [...new Set(OPERATIONS.map((operation) => operation.tool))].sort();
    expect(covered).toEqual(TOOL_NAMES);
  });

  it("sends method, URL, and Bearer auth on the happy path and never echoes the key", async () => {
    const invoked = new Set<string>();
    for (const operation of OPERATIONS) {
      const { fetchImpl, calls } = jsonFetch((captured) => {
        expectAuth(captured);
        return leakyResponse();
      });
      await withClient(fetchImpl, {}, async (client) => {
        const args = operation.write
          ? { ...argsFor(operation), confirm: true }
          : argsFor(operation);
        const result = await call(client, operation.tool, args);
        expect(result.isError, `${operation.tool} ${operation.action}`).toBe(false);
        expect(result.text).not.toContain(TOKEN);
        expect(result.text).not.toContain("stack");
        expect(JSON.stringify(result.json)).not.toContain("/usr/src");
        expect(calls.length).toBeGreaterThan(0);
        expect(calls[0]?.authorization).toBe(`Bearer ${TOKEN}`);
        expect(calls[0]?.method).toBe(operation.method);
        expect(calls[0]?.url.startsWith(`${BASE}/v1`)).toBe(true);
        invoked.add(operation.tool);
      });
    }
    expect([...invoked].sort()).toEqual(TOOL_NAMES);
    expect(READ_OPS.length + WRITE_OPS.length).toBe(305);
  });

  it("previews every write without calling upstream, then executes with confirm true", async () => {
    for (const operation of WRITE_OPS) {
      const { fetchImpl, calls } = jsonFetch(() => leakyResponse());
      await withClient(fetchImpl, {}, async (client) => {
        const preview = await call(client, operation.tool, argsFor(operation));
        expect(preview.isError, `${operation.tool} ${operation.action}`).toBe(false);
        expect(preview.json).toMatchObject({
          executed: false,
          dry_run: true,
          blocked: false,
          method: operation.method,
        });
        expect(typeof preview.json?.["path"]).toBe("string");
        expect(String(preview.json?.["path"]).startsWith("v1")).toBe(true);
        expect(calls).toHaveLength(0);

        const executed = await call(client, operation.tool, {
          ...argsFor(operation),
          confirm: true,
        });
        expect(executed.isError, `${operation.tool} ${operation.action} confirm`).toBe(false);
        expect(executed.json).toMatchObject({ executed: true, dry_run: false });
        expect(calls.length).toBeGreaterThan(0);
        expect(calls[0]?.method).toBe(operation.method);
        expect(calls[0]?.authorization).toBe(`Bearer ${TOKEN}`);
      });
    }
  });

  it("rejects confirm false and the string true", async () => {
    const { fetchImpl } = jsonFetch(() => pangolinOk());
    await withClient(fetchImpl, {}, async (client) => {
      const asFalse = await call(client, "pangolin_orgs", {
        action: "delete_org",
        params: { orgId: "org-sample" },
        confirm: false,
      });
      expect(asFalse.isError).toBe(true);
      const asString = await call(client, "pangolin_orgs", {
        action: "delete_org",
        params: { orgId: "org-sample" },
        confirm: "true",
      });
      expect(asString.isError).toBe(true);
    });
  });
});

describe("error paths", () => {
  it("maps 401, 403, 404, 422, 400, and 429 with Retry-After", async () => {
    const cases: {
      status: number;
      body: unknown;
      needle: string;
      retry?: string;
    }[] = [
      {
        status: 401,
        body: { success: false, error: true, message: `Unauthorized ${TOKEN}`, stack: "/tmp/x.js" },
        needle: "401",
      },
      {
        status: 403,
        body: { success: false, error: true, message: "forbidden", stack: "/usr/src/app/x.ts" },
        needle: "does not have that action granted",
      },
      {
        status: 404,
        body: { success: false, error: true, message: "Org not found" },
        needle: "404",
      },
      {
        status: 422,
        body: { success: false, error: true, message: "name should not be empty" },
        needle: "name should not be empty",
      },
      {
        status: 400,
        body: { success: false, error: true, message: "invalid body" },
        needle: "400",
      },
      {
        status: 429,
        body: { success: false, error: true, message: "Slow down" },
        needle: "429",
        retry: "12",
      },
    ];
    for (const testCase of cases) {
      const { fetchImpl } = jsonFetch(
        () =>
          new Response(JSON.stringify(testCase.body), {
            status: testCase.status,
            headers: {
              "content-type": "application/json",
              ...(testCase.retry === undefined ? {} : { "retry-after": testCase.retry }),
            },
          }),
      );
      await withClient(fetchImpl, {}, async (client) => {
        const result = await call(client, "pangolin_orgs", { action: "list_orgs" });
        expect(result.isError).toBe(true);
        expect(result.text).toContain(testCase.needle);
        expect(result.text).not.toContain(TOKEN);
        expect(result.text).not.toContain("/tmp");
        expect(result.text).not.toContain("/usr/src");
        if (testCase.status === 429) expect(result.text.toLowerCase()).toContain("rate");
      });
    }
  });
});
