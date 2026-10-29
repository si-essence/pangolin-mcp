import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ALL_TOOLSETS,
  DEFAULT_TOOLSETS,
  OPERATIONS,
  openApiKeys,
  parseToolsets,
  toolNames,
  toolsForToolsets,
} from "../src/operations.js";

describe("OpenAPI coverage", () => {
  it("covers every path and operation in pangolin.openapi.json", () => {
    const spec = JSON.parse(
      readFileSync((existsSync(new URL("../pangolin.openapi.json", import.meta.url)) ? new URL("../pangolin.openapi.json", import.meta.url) : new URL("./fixtures/pangolin.routes.json", import.meta.url)), "utf8"),
    ) as {
      paths: Record<string, Record<string, unknown>>;
    };
    const specKeys: string[] = [];
    for (const [path, ops] of Object.entries(spec.paths)) {
      for (const method of Object.keys(ops)) {
        if (["get", "post", "put", "patch", "delete"].includes(method)) {
          specKeys.push(`${method.toUpperCase()} ${path}`);
        }
      }
    }
    specKeys.sort();
    expect(openApiKeys()).toEqual(specKeys);
    expect(Object.keys(spec.paths)).toHaveLength(234);
    expect(specKeys).toHaveLength(305);
    expect(OPERATIONS).toHaveLength(305);
    expect(toolNames()).toHaveLength(ALL_TOOLSETS.length);
    expect(DEFAULT_TOOLSETS).toEqual(["sites", "resources", "targets", "roles", "users", "orgs"]);
    const actions = OPERATIONS.map((row) => `${row.tool}::${row.action}`);
    expect(new Set(actions).size).toBe(actions.length);
  });

  it("keeps GET list and get ops ungated", () => {
    const reads = OPERATIONS.filter((row) => row.method === "GET");
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((row) => !row.write)).toBe(true);
  });
});

describe("toolset scoping", () => {
  it("defaults to the read-focused subset and treats all as every toolset", () => {
    expect(parseToolsets(undefined)).toEqual([...DEFAULT_TOOLSETS]);
    expect(parseToolsets("all")).toEqual([...ALL_TOOLSETS]);
    expect(toolsForToolsets(parseToolsets(undefined))).toEqual([
      "pangolin_orgs",
      "pangolin_resources",
      "pangolin_roles",
      "pangolin_sites",
      "pangolin_targets",
      "pangolin_users",
    ]);
    expect(toolsForToolsets(parseToolsets("all"))).toEqual(toolNames());
    expect(parseToolsets("ai")).toEqual(["ai"]);
    expect(toolsForToolsets(["ai"])).toEqual(["pangolin_ai"]);
  });
});
