import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CONNECTOR_NAME } from "../src/constants.js";
import { jsonFetch, pangolinOk, runtimeFor } from "./harness.js";
import { connectServer } from "./mcp.js";

describe("server", () => {
  it("publishes default tools when PANGOLIN_TOOLSETS is unset", async () => {
    const { fetchImpl } = jsonFetch(() => pangolinOk());
    const runtime = runtimeFor(fetchImpl, { PANGOLIN_TOOLSETS: undefined });
    const { client, close } = await connectServer(runtime);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
        "pangolin_orgs",
        "pangolin_resources",
        "pangolin_roles",
        "pangolin_sites",
        "pangolin_targets",
        "pangolin_users",
      ]);
    } finally {
      await close();
    }
  });

  it("keeps the package name aligned with package.json", () => {
    const pkg = z
      .object({ name: z.string() })
      .parse(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")));
    expect(pkg.name).toBe(CONNECTOR_NAME);
  });
});
