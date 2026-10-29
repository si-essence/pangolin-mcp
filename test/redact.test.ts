import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/log.js";
import { isSecretFieldName, redact, redactUnknown } from "../src/redact.js";
import { createRuntime } from "../src/runtime.js";
import { connectServer } from "./mcp.js";
import { jsonResponse } from "./harness.js";
import { readToolText } from "./result.js";

const KEY = "super-secret/key+value=99";
const ENCODED = encodeURIComponent(KEY);

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function assertNoKey(label: string, text: string): void {
  expect(text, label).not.toContain(KEY);
  expect(text, label).not.toContain(ENCODED);
}

describe("redact", () => {
  it("treats secret field names as secrets and leaves id fields", () => {
    expect(isSecretFieldName("apiKey")).toBe(true);
    expect(isSecretFieldName("newtSecret")).toBe(true);
    expect(isSecretFieldName("password")).toBe(true);
    expect(isSecretFieldName("token")).toBe(true);
    expect(isSecretFieldName("clientSecret")).toBe(true);
    expect(isSecretFieldName("key")).toBe(true);
    expect(isSecretFieldName("apiKeyId")).toBe(false);
    expect(isSecretFieldName("orgId")).toBe(false);
    expect(isSecretFieldName("siteId")).toBe(false);
    expect(isSecretFieldName("virtualApiKeyId")).toBe(false);
  });

  it("strips the secret, its url encoding, query params, and bearer tokens", () => {
    const raw = [
      `key=${KEY}`,
      `encoded=${ENCODED}`,
      `https://upstream.test/lookup?api_key=${KEY}&x=1`,
      `Authorization: Bearer ${KEY}`,
    ].join("\n");
    const cleaned = redact(raw, [KEY]);
    assertNoKey("redact", cleaned);
    expect(cleaned).toContain("api_key=[redacted]");
    expect(cleaned).toContain("Bearer [redacted]");
  });

  it("redacts nested password, api key, newt and olm secrets", () => {
    const cleaned = JSON.stringify(
      redactUnknown(
        {
          password: "hunter2-secret-value",
          apiKey: KEY,
          newtSecret: "newt-secret-value-xx",
          olmSecret: "olm-secret-value-xx",
          apiKeyId: "keep-id",
          title: `see ${KEY}`,
        },
        [KEY],
      ),
    );
    assertNoKey("nested", cleaned);
    expect(cleaned).toContain("[redacted]");
    expect(cleaned).toContain("keep-id");
    expect(cleaned).not.toContain("hunter2-secret-value");
    expect(cleaned).not.toContain("newt-secret-value-xx");
  });

  it("redacts secrets in tool errors and never logs the raw key", async () => {
    const lines: string[] = [];
    const fetchImpl: typeof fetch = (input) => {
      expect(requestUrl(input)).not.toContain(KEY);
      return Promise.resolve(
        jsonResponse({ success: false, error: true, message: `fail ${KEY}`, stack: "/tmp/x.js" }, 500),
      );
    };
    const runtime = createRuntime(
      loadConfig(
        {
          PANGOLIN_API_KEY: KEY,
          PANGOLIN_URL: "https://pangolin.test",
          PANGOLIN_CACHE_TTL_SEC: "0",
          PANGOLIN_TOOLSETS: "orgs",
        },
        [],
      ),
      { fetchImpl, logger: createLogger([KEY], (line) => lines.push(line)) },
    );
    const { client, close } = await connectServer(runtime);
    try {
      const result = readToolText(
        await client.callTool({
          name: "pangolin_orgs",
          arguments: { action: "list_orgs" },
        }),
      );
      expect(result.isError).toBe(true);
      assertNoKey("tool error", result.text);
      expect(result.text).not.toContain("/tmp");
      for (const line of lines) assertNoKey("log", line);
    } finally {
      await close();
    }
  });
});
