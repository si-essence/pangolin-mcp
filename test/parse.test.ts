import { describe, expect, it } from "vitest";
import {
  envelopeToResult,
  isAbsoluteFsPath,
  parseEnvelope,
  stripPathsInText,
  stripServerPaths,
} from "../src/parse.js";

describe("stripServerPaths", () => {
  it("drops absolute filesystem paths, path-bearing keys, and stack", () => {
    expect(isAbsoluteFsPath("/usr/src/app/pangolin.db")).toBe(true);
    expect(isAbsoluteFsPath("site.json")).toBe(false);
    const stripped = stripServerPaths({
      name: "Edge",
      leak: "/tmp/pangolin.db",
      stack: "Error\n    at /home/box/pangolin/server.ts:12:3",
      filename: "/opt/pangolin/x.log",
      keep: "edge.json",
    });
    expect(stripped).toEqual({ name: "Edge", keep: "edge.json" });
    expect(stripPathsInText("see /tmp/secret.db here")).toContain("[omitted-path]");
  });
});

describe("parseEnvelope", () => {
  it("returns data, message, and pagination and drops stack", () => {
    const envelope = parseEnvelope({
      data: { orgs: [{ orgId: "a" }], pagination: { total: 1, limit: 10, offset: 0 } },
      success: true,
      error: false,
      message: "ok",
      status: 200,
      stack: "/home/box/pangolin/oops.ts",
    });
    expect(envelope.data).toEqual({
      orgs: [{ orgId: "a" }],
      pagination: { total: 1, limit: 10, offset: 0 },
    });
    expect(envelope.message).toBe("ok");
    expect(envelope.pagination).toEqual({ total: 1, limit: 10, offset: 0 });
    const result = JSON.stringify(stripServerPaths(envelopeToResult(envelope)));
    expect(result).not.toContain("stack");
    expect(result).not.toContain("/home/box");
  });
});
