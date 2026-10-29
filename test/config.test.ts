import { describe, expect, it } from "vitest";
import { CONNECTOR_NAME, CONNECTOR_VERSION } from "../src/constants.js";
import { loadConfig } from "../src/config.js";
import { ConnectorError } from "../src/errors.js";
import { DEFAULT_TOOLSETS } from "../src/operations.js";

const KEY = "super-secret/key+value=99";
const URL = "http://127.0.0.1:3003";

function messageOf(error: unknown): string {
  expect(error).toBeInstanceOf(ConnectorError);
  if (!(error instanceof ConnectorError)) throw error;
  return error.message;
}

function catchError(run: () => unknown): unknown {
  try {
    return run();
  } catch (error) {
    return error;
  }
}

describe("loadConfig", () => {
  it("requires PANGOLIN_URL", () => {
    const message = messageOf(catchError(() => loadConfig({}, [])));
    expect(message).toContain("PANGOLIN_URL");
    expect(message).toContain("required");
  });

  it("applies defaults when the URL is set", () => {
    const config = loadConfig({ PANGOLIN_URL: URL }, []);
    expect(config.apiKey).toBeUndefined();
    expect(config.baseUrl).toBe(URL);
    expect(config.allowWrites).toBe(false);
    expect(config.toolsets).toEqual([...DEFAULT_TOOLSETS]);
    expect(config.perMinute).toBe(30);
    expect(config.timeoutMs).toBe(20_000);
    expect(config.contact).toBe("contact@example.com");
    expect(config.transport).toBe("stdio");
    expect(config.port).toBe(3000);
    expect(config.cacheTtlSec).toBe(60);
    expect(config.userAgent).toBe(`${CONNECTOR_NAME}/${CONNECTOR_VERSION} (contact@example.com)`);
  });

  it("lets --http override the transport", () => {
    expect(
      loadConfig({ PANGOLIN_URL: URL, MCP_TRANSPORT: "stdio" }, ["node", "app", "--http"])
        .transport,
    ).toBe("http");
    expect(loadConfig({ PANGOLIN_URL: URL, MCP_TRANSPORT: "http" }, []).transport).toBe("http");
  });

  it("strips a trailing /v1 from the base url", () => {
    const config = loadConfig({ PANGOLIN_URL: "http://127.0.0.1:3003/v1/" }, []);
    expect(config.baseUrl).toBe("http://127.0.0.1:3003");
  });

  it("enables writes only when PANGOLIN_ALLOW_WRITES is the literal true", () => {
    expect(
      loadConfig({ PANGOLIN_URL: URL, PANGOLIN_ALLOW_WRITES: "true" }, []).allowWrites,
    ).toBe(true);
    expect(
      loadConfig({ PANGOLIN_URL: URL, PANGOLIN_ALLOW_WRITES: "yes" }, []).allowWrites,
    ).toBe(false);
  });

  it("parses PANGOLIN_TOOLSETS", () => {
    expect(loadConfig({ PANGOLIN_URL: URL, PANGOLIN_TOOLSETS: "sites,roles" }, []).toolsets).toEqual(
      ["sites", "roles"],
    );
    expect(loadConfig({ PANGOLIN_URL: URL, PANGOLIN_TOOLSETS: "all" }, []).toolsets).toContain("ai");
  });

  it("rejects an unknown toolset", () => {
    const message = messageOf(
      catchError(() => loadConfig({ PANGOLIN_URL: URL, PANGOLIN_TOOLSETS: "nope" }, [])),
    );
    expect(message).toContain("PANGOLIN_TOOLSETS");
    expect(message).not.toContain("nope");
  });

  it("refuses Pangolin Cloud hosts", () => {
    for (const host of [
      "https://pangolin.net",
      "https://api.pangolin.net",
      "https://app.pangolin.net/v1",
    ]) {
      const message = messageOf(catchError(() => loadConfig({ PANGOLIN_URL: host }, [])));
      expect(message).toContain("cloud_host");
      expect(message).toContain("self-hosted");
      expect(message).not.toContain("https://api.pangolin.net/docs");
    }
  });

  it("reports invalid fields without the rejected value or the api key", () => {
    const message = messageOf(
      catchError(() =>
        loadConfig(
          { PANGOLIN_URL: URL, PANGOLIN_API_KEY: KEY, PORT: "nope", MCP_TRANSPORT: "sse" },
          [],
        ),
      ),
    );
    expect(message).toContain("PORT");
    expect(message).toContain("MCP_TRANSPORT");
    expect(message).not.toContain(KEY);
    expect(message).not.toContain("nope");
    expect(message).not.toContain("sse");
  });

  it("rejects a short api key without echoing it", () => {
    const message = messageOf(
      catchError(() => loadConfig({ PANGOLIN_URL: URL, PANGOLIN_API_KEY: "short" }, [])),
    );
    expect(message).toContain("PANGOLIN_API_KEY");
    expect(message).not.toContain("short");
  });

  it("rejects a base url or contact that contains the api key", () => {
    const inUrl = messageOf(
      catchError(() =>
        loadConfig({ PANGOLIN_API_KEY: KEY, PANGOLIN_URL: `https://example.invalid/${KEY}` }, []),
      ),
    );
    expect(inUrl).toContain("contains_secret");
    expect(inUrl).not.toContain(KEY);

    const inContact = messageOf(
      catchError(() =>
        loadConfig(
          { PANGOLIN_URL: URL, PANGOLIN_API_KEY: KEY, PANGOLIN_CONTACT: `me+${KEY}@example.com` },
          [],
        ),
      ),
    );
    expect(inContact).toContain("contains_secret");
    expect(inContact).not.toContain(KEY);
  });
});
