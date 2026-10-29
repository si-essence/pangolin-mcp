#!/usr/bin/env node
/**
 * Live check against a real self-hosted Pangolin CE instance. Spawns dist/index.js over stdio.
 * Skips when PANGOLIN_URL or PANGOLIN_API_KEY is unset. Does not print the API key.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const token = process.env["PANGOLIN_API_KEY"] ?? "";
const baseUrl = process.env["PANGOLIN_URL"] ?? "";

/** @type {string[]} */
const secrets = [];
if (token.length >= 8) secrets.push(token);

/**
 * @param {string} text
 */
function redact(text) {
  let out = String(text);
  for (const secret of secrets) {
    out = out.split(secret).join("[redacted]");
    out = out.split(encodeURIComponent(secret)).join("[redacted]");
  }
  out = out.replace(/(authorization:\s*bearer\s+)\S+/gi, "Authorization: Bearer [redacted]");
  out = out.replace(
    /"(apiKey|secret|token|password|newtSecret|olmSecret|accessToken|clientSecret)"\s*:\s*"[^"]*"/gi,
    '"$1":"[redacted]"',
  );
  return out;
}

/**
 * @param {string} text
 */
function clip(text) {
  let shortened = redact(text).replace(/\s+/g, " ").trim();
  if (shortened.length > 180) shortened = `${shortened.slice(0, 177)}...`;
  return shortened;
}

const writeLine = console.log.bind(console);
const writeError = console.error.bind(console);
console.log = (line) => writeLine(redact(String(line)));
console.error = (line) => writeError(redact(String(line)));

let failed = 0;
let stopped = false;
/** @type {string[]} */
const rows = [];

/**
 * @param {string} name
 * @param {boolean} ok
 * @param {string} detail
 */
function record(name, ok, detail) {
  if (!ok) failed += 1;
  rows.push(`${ok ? "PASS" : "FAIL"}  ${name}  ${clip(detail)}`);
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @param {string[]} keys
 * @returns {string | undefined}
 */
function firstId(value, keys) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstId(item, keys);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  for (const key of keys) {
    const entry = value[key];
    if (typeof entry === "string" && entry.length > 0) return entry;
    if (typeof entry === "number" && Number.isFinite(entry)) return String(entry);
  }
  for (const nested of Object.values(value)) {
    const found = firstId(nested, keys);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function collectIds(value, key) {
  /** @type {string[]} */
  const ids = [];
  /**
   * @param {unknown} node
   */
  function walk(node) {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!isRecord(node)) return;
    const entry = node[key];
    if (typeof entry === "string" && entry.length > 0) ids.push(entry);
    if (typeof entry === "number" && Number.isFinite(entry)) ids.push(String(entry));
    for (const nested of Object.values(node)) walk(nested);
  }
  walk(value);
  return [...new Set(ids)];
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function orgIdsFrom(value) {
  return collectIds(value, "orgId");
}

/**
 * @param {Record<string, unknown> | null} json
 * @param {string[]} keys
 */
function idFrom(json, keys) {
  if (!isRecord(json)) return undefined;
  const result = json["result"];
  const data = isRecord(result) ? result["data"] : json["data"];
  return firstId(data, keys) ?? firstId(result, keys) ?? firstId(json, keys);
}

/**
 * @param {import("@modelcontextprotocol/sdk/client/index.js").Client} client
 * @param {string} name
 * @param {Record<string, unknown>} args
 */
async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  const block = Array.isArray(result.content) ? result.content[0] : undefined;
  const text = block && typeof block === "object" && "text" in block ? String(block.text) : "";
  if (token.length >= 8 && text.includes(token)) {
    throw new Error("secret leaked into tool output");
  }
  if (/HTTP 402|quota or payment/i.test(text)) {
    stopped = true;
    throw new Error("quota-or-402");
  }
  /** @type {Record<string, unknown> | null} */
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { isError: result.isError === true, text, json };
}

async function main() {
  if (baseUrl.trim().length === 0 || token.trim().length < 8) {
    writeLine("SKIP  live-check  PANGOLIN_URL and PANGOLIN_API_KEY are unset.");
    return;
  }

  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    cwd: root,
    env: {
      ...process.env,
      PANGOLIN_URL: baseUrl,
      PANGOLIN_API_KEY: token,
      PANGOLIN_ALLOW_WRITES: "true",
      PANGOLIN_TOOLSETS: "all",
      PANGOLIN_CACHE_TTL_SEC: "0",
      PANGOLIN_PER_MINUTE: "120",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "live-check", version: "0" });
  await client.connect(transport);

  const stamp = Date.now().toString(36);
  const orgId = `mcp-${stamp}`.slice(0, 32);
  /** @type {string | undefined} */
  let siteId;
  /** @type {string | undefined} */
  let roleId;
  /** @type {string | undefined} */
  let resourceId;
  /** @type {string | undefined} */
  let targetId;
  /** @type {string | undefined} */
  let domainId;
  let orgCreated = false;
  let orgTouched = false;

  /**
   * @param {string} id
   */
  async function deleteOrg(id) {
    return call(client, "pangolin_orgs", {
      action: "delete_org",
      params: { orgId: id },
      confirm: true,
    });
  }

  try {
    const listed = await client.listTools();
    record("list_tools", listed.tools.length > 0, `${listed.tools.length} tools`);

    const orgs = await call(client, "pangolin_orgs", { action: "list_orgs" });
    record("pangolin_orgs list_orgs", !orgs.isError, orgs.text);

    for (const leftover of orgIdsFrom(orgs.json).filter((id) => id.startsWith("mcp"))) {
      const cleaned = await deleteOrg(leftover);
      record(
        `cleanup leftover org ${leftover}`,
        !cleaned.isError,
        cleaned.text,
      );
    }

    const orgBody = {
      orgId,
      name: `mcp-live-${stamp}`.slice(0, 255),
      subnet: "100.90.128.0/24",
      utilitySubnet: "192.0.2.0/24",
    };

    const previewOrg = await call(client, "pangolin_orgs", {
      action: "create_org",
      body: orgBody,
    });
    record(
      "pangolin_orgs create_org preview",
      previewOrg.json?.["executed"] === false && previewOrg.json?.["dry_run"] === true,
      previewOrg.text,
    );

    const createdOrg = await call(client, "pangolin_orgs", {
      action: "create_org",
      body: orgBody,
      confirm: true,
    });
    orgCreated = !createdOrg.isError;
    orgTouched = orgTouched || orgCreated;
    record("pangolin_orgs create_org confirm", orgCreated, createdOrg.text);

    const previewSite = await call(client, "pangolin_sites", {
      action: "create_org_site",
      params: { orgId },
      body: { name: `site-${stamp}`, type: "local" },
    });
    record(
      "pangolin_sites create_org_site preview",
      previewSite.json?.["executed"] === false,
      previewSite.text,
    );

    const createdSite = await call(client, "pangolin_sites", {
      action: "create_org_site",
      params: { orgId },
      body: { name: `site-${stamp}`, type: "local" },
      confirm: true,
    });
    siteId = idFrom(createdSite.json, ["siteId", "id"]);
    if (!createdSite.isError) orgTouched = true;
    record(
      "pangolin_sites create_org_site confirm",
      Boolean(siteId) && !createdSite.isError,
      createdSite.text,
    );

    if (siteId !== undefined) {
      const got = await call(client, "pangolin_sites", {
        action: "get_site",
        params: { siteId },
      });
      record("pangolin_sites get_site", !got.isError, got.text);
      const updated = await call(client, "pangolin_sites", {
        action: "update_site",
        params: { siteId },
        body: { name: `site-${stamp}-renamed` },
        confirm: true,
      });
      record("pangolin_sites update_site confirm", !updated.isError, updated.text);
    } else {
      record("pangolin_sites get_site", false, "no site id");
      record("pangolin_sites update_site confirm", false, "no site id");
    }

    const previewRole = await call(client, "pangolin_roles", {
      action: "create_org_role",
      params: { orgId },
      body: { name: `role-${stamp}` },
    });
    record(
      "pangolin_roles create_org_role preview",
      previewRole.json?.["executed"] === false,
      previewRole.text,
    );
    const createdRole = await call(client, "pangolin_roles", {
      action: "create_org_role",
      params: { orgId },
      body: { name: `role-${stamp}` },
      confirm: true,
    });
    roleId = idFrom(createdRole.json, ["roleId", "id"]);
    if (!createdRole.isError) orgTouched = true;
    record(
      "pangolin_roles create_org_role confirm",
      Boolean(roleId) && !createdRole.isError,
      createdRole.text,
    );
    if (roleId !== undefined) {
      const gotRole = await call(client, "pangolin_roles", {
        action: "get_role",
        params: { roleId },
      });
      record("pangolin_roles get_role", !gotRole.isError, gotRole.text);
      const updatedRole = await call(client, "pangolin_roles", {
        action: "update_role",
        params: { roleId },
        body: { name: `role-${stamp}-renamed` },
        confirm: true,
      });
      record("pangolin_roles update_role confirm", !updatedRole.isError, updatedRole.text);
    } else {
      record("pangolin_roles get_role", false, "no role id");
      record("pangolin_roles update_role confirm", false, "no role id");
    }

    const domains = await call(client, "pangolin_domains", {
      action: "list_org_domains",
      params: { orgId },
    });
    domainId = idFrom(domains.json, ["domainId"]);
    record(
      "pangolin_domains list_org_domains",
      !domains.isError && Boolean(domainId),
      domains.text,
    );

    const resourceBody = domainId
      ? {
          name: `res-${stamp}`,
          domainId,
          mode: "http",
          subdomain: `mcp-${stamp}`.slice(0, 32),
        }
      : { name: `res-${stamp}`, mode: "tcp", proxyPort: 18080 };

    const previewResource = await call(client, "pangolin_resources", {
      action: "create_org_public_resource",
      params: { orgId },
      body: resourceBody,
    });
    record(
      "pangolin_resources create_org_public_resource preview",
      previewResource.json?.["executed"] === false,
      previewResource.text,
    );
    const createdResource = await call(client, "pangolin_resources", {
      action: "create_org_public_resource",
      params: { orgId },
      body: resourceBody,
      confirm: true,
    });
    resourceId = idFrom(createdResource.json, ["resourceId", "id"]);
    if (!createdResource.isError) orgTouched = true;
    record(
      "pangolin_resources create_org_public_resource confirm",
      Boolean(resourceId) && !createdResource.isError,
      createdResource.text,
    );

    if (resourceId !== undefined) {
      const gotRes = await call(client, "pangolin_resources", {
        action: "get_public_resource",
        params: { resourceId },
      });
      record("pangolin_resources get_public_resource", !gotRes.isError, gotRes.text);
      const updatedRes = await call(client, "pangolin_resources", {
        action: "update_public_resource",
        params: { resourceId },
        body: { name: `res-${stamp}-renamed` },
        confirm: true,
      });
      record(
        "pangolin_resources update_public_resource confirm",
        !updatedRes.isError,
        updatedRes.text,
      );
      if (siteId !== undefined) {
        const createdTarget = await call(client, "pangolin_resources", {
          action: "create_public_resource_target",
          params: { resourceId },
          body: { siteId: Number(siteId) || siteId, ip: "127.0.0.1", port: 8080, method: "http" },
          confirm: true,
        });
        targetId = idFrom(createdTarget.json, ["targetId", "id"]);
        record(
          "pangolin_resources create_public_resource_target confirm",
          !createdTarget.isError,
          createdTarget.text,
        );
      } else {
        record("pangolin_resources create_public_resource_target confirm", false, "no site id");
      }
    } else {
      record("pangolin_resources get_public_resource", false, "no resource id");
      record("pangolin_resources update_public_resource confirm", false, "no resource id");
      record("pangolin_resources create_public_resource_target confirm", false, "no resource id");
    }

    const users = await call(client, "pangolin_users", {
      action: "list_org_users",
      params: { orgId },
    });
    record("pangolin_users list_org_users", !users.isError, users.text);

    const keys = await call(client, "pangolin_api_keys", {
      action: "list_org_api_keys",
      params: { orgId },
    });
    record("pangolin_api_keys list_org_api_keys", !keys.isError, keys.text);

    const logs = await call(client, "pangolin_logs", {
      action: "get_org_logs_request",
      params: { orgId },
    });
    record("pangolin_logs get_org_logs_request", !logs.isError, logs.text);

    // Phase 2: API key (secret redaction), share link (access token) and live error paths.
    const keyPreview = await call(client, "pangolin_api_keys", {
      action: "create_org_api_key",
      params: { orgId },
      body: { name: `live-key-${stamp}` },
    });
    record(
      "pangolin_api_keys create_org_api_key preview",
      !keyPreview.isError && keyPreview.json?.["executed"] === false,
      keyPreview.text,
    );
    const keyMade = await call(client, "pangolin_api_keys", {
      action: "create_org_api_key",
      params: { orgId },
      body: { name: `live-key-${stamp}` },
      confirm: true,
    });
    const newKeyId = idFrom(keyMade.json, ["apiKeyId", "id"]);
    record(
      "pangolin_api_keys create_org_api_key confirm (secret redacted)",
      !keyMade.isError && !/"apiKey(Secret)?":"[^\[]/.test(keyMade.text),
      keyMade.text,
    );
    if (newKeyId !== undefined) {
      const keyDel = await call(client, "pangolin_api_keys", {
        action: "delete_org_api_key",
        params: { orgId, apiKeyId: newKeyId },
        confirm: true,
      });
      record("pangolin_api_keys delete_org_api_key confirm", !keyDel.isError, keyDel.text);
    } else {
      record("pangolin_api_keys delete_org_api_key confirm", false, "no api key id");
    }
    if (resourceId !== undefined) {
      const linkMade = await call(client, "pangolin_resources", {
        action: "create_public_resource_access_token",
        params: { resourceId },
        body: { validForSeconds: 600, title: `live-link-${stamp}` },
        confirm: true,
      });
      const tokenId = idFrom(linkMade.json, ["accessTokenId", "id"]);
      record(
        "pangolin_resources create_public_resource_access_token confirm (share link)",
        !linkMade.isError && !/"accessToken":"[^\[]/.test(linkMade.text),
        linkMade.text,
      );
      if (tokenId !== undefined) {
        const tokDel = await call(client, "pangolin_access_tokens", {
          action: "delete_access_token",
          params: { accessTokenId: tokenId },
          confirm: true,
        });
        record("pangolin_access_tokens delete_access_token confirm", !tokDel.isError, tokDel.text);
      }
    }
    const missing = await call(client, "pangolin_sites", {
      action: "get_site",
      params: { siteId: 999999999 },
    });
    record(
      "error path: unknown site is a clean error without stack",
      missing.isError && !/stack|\/workspace\//i.test(missing.text),
      missing.text,
    );

    const ai = await call(client, "pangolin_ai", {
      action: "list_org_ai_providers",
      params: { orgId },
    });
    record(
      "pangolin_ai list_org_ai_providers (enterprise on CE may fail)",
      true,
      ai.isError ? `CE/enterprise: ${ai.text}` : ai.text,
    );

    if (targetId !== undefined) {
      const deletedTarget = await call(client, "pangolin_targets", {
        action: "delete_target",
        params: { targetId },
        confirm: true,
      });
      record("pangolin_targets delete_target confirm", !deletedTarget.isError, deletedTarget.text);
    }

    if (resourceId !== undefined) {
      const deletedRes = await call(client, "pangolin_resources", {
        action: "delete_public_resource",
        params: { resourceId },
        confirm: true,
      });
      record(
        "pangolin_resources delete_public_resource confirm",
        !deletedRes.isError,
        deletedRes.text,
      );
    }

    if (roleId !== undefined) {
      const roles = await call(client, "pangolin_roles", {
        action: "list_org_roles",
        params: { orgId },
      });
      const otherRoleId = collectIds(roles.json, "roleId").find((id) => id !== roleId);
      const reassignTo = otherRoleId !== undefined ? Number(otherRoleId) : Number(roleId) + 1;
      const deletedRole = await call(client, "pangolin_roles", {
        action: "delete_role",
        params: { roleId },
        body: { roleId: reassignTo },
        confirm: true,
      });
      record("pangolin_roles delete_role confirm", !deletedRole.isError, deletedRole.text);
    }

    if (siteId !== undefined) {
      const deletedSite = await call(client, "pangolin_sites", {
        action: "delete_site",
        params: { siteId },
        confirm: true,
      });
      record("pangolin_sites delete_site confirm", !deletedSite.isError, deletedSite.text);
    }

    if (orgCreated || orgTouched) {
      const deletedOrg = await deleteOrg(orgId);
      record("pangolin_orgs delete_org confirm", !deletedOrg.isError, deletedOrg.text);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "live-check failed";
    record("live-check", false, message);
    if (orgCreated || orgTouched) {
      try {
        await deleteOrg(orgId);
      } catch {
        writeError("cleanup delete_org failed");
      }
    }
  } finally {
    await client.close();
  }

  for (const row of rows) writeLine(row);
  writeLine(`failed=${failed}`);
  if (stopped) {
    process.exit(1);
  }
  if (failed > 0) process.exit(1);
}

await main();
