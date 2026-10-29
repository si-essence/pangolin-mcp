#!/usr/bin/env node
/**
 * Generate src/operations.ts from pangolin.openapi.json.
 * Run: node scripts/gen-operations.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const spec = JSON.parse(readFileSync(join(root, "pangolin.openapi.json"), "utf8"));

/** @type {Record<string, string>} */
const TAG_TO_TOOLSET = {
  Site: "sites",
  "Resource Target": "targets",
  "Public Resource": "resources",
  "Public Resource (Legacy)": "resources",
  "Private Resource": "resources",
  "Private Resource (Legacy)": "resources",
  Organization: "orgs",
  Domain: "domains",
  Role: "roles",
  User: "users",
  "User Invitation": "users",
  Client: "clients",
  "Public Resource Policy": "policies",
  "Public Resource Policy (Legacy)": "policies",
  Rule: "resources",
  "Access Token": "access_tokens",
  "Identity Provider (Global)": "identity_providers",
  "Identity Provider (Organization Only)": "identity_providers",
  "API Key": "api_keys",
  "Site Provisioning Key": "api_keys",
  Blueprint: "blueprints",
  SSH: "ssh",
  Logs: "logs",
  "Event Streaming Destination": "logs",
  "Alert Rule": "logs",
  "Health Check": "meta",
  Certificate: "certificates",
  "AI Provider": "ai",
  "AI Model": "ai",
  "AI Budget": "ai",
  "Virtual API Key": "ai",
  Redirect: "redirects",
  Label: "labels",
  "Remote Exit Node": "remote_exit_nodes",
};

const DEFAULT_TOOLSETS = ["sites", "resources", "targets", "roles", "users", "orgs"];

const HTTP = new Set(["get", "post", "put", "patch", "delete"]);
const METHODS = ["get", "post", "put", "patch", "delete"];

/**
 * @param {string} value
 */
function slug(value) {
  return String(value)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .toLowerCase();
}

/**
 * @param {string} path
 */
function staticParts(path) {
  if (path === "/") return [];
  return path.split("/").filter(Boolean).flatMap((seg) => {
    if (/^\{.+\}$/.test(seg)) return [];
    return [slug(seg.replace(/\.(json|yaml)$/i, "_$1"))];
  });
}

/**
 * @param {string} path
 */
function paramParts(path) {
  return path.split("/").filter(Boolean).flatMap((seg) => {
    const match = /^\{(.+)\}$/.exec(seg);
    return match && match[1] !== undefined ? [slug(match[1])] : [];
  });
}

/**
 * @param {string} method
 * @param {string} path
 * @param {string} summary
 */
function verbFor(method, path, summary) {
  const text = String(summary || "").trim();
  const first = (text.split(/\s+/)[0] || "").toLowerCase();
  const trailingParam = /\{[^}]+\}$/.test(path);
  const lastStatic = path.split("/").filter(Boolean).filter((seg) => !seg.startsWith("{")).pop() || "";
  if (method === "DELETE") return "delete";
  if (method === "PATCH") return "patch";
  if (method === "GET") {
    if (first === "list") return "list";
    if (first === "get" || first === "pick" || first === "check" || first === "verify") return first;
    if (first === "return" || first === "read" || first === "health") return "get";
    if (!trailingParam && /s$/i.test(lastStatic) && !/status|defaults|address/i.test(lastStatic)) {
      return "list";
    }
    return "get";
  }
  if (method === "PUT") {
    if (
      ["create", "attach", "detach", "replace", "set", "regenerate", "apply"].includes(first)
    ) {
      return first;
    }
    if (path.includes("/re-key/")) return "regenerate";
    if (path.endsWith("/attach")) return "attach";
    if (path.endsWith("/detach")) return "detach";
    return trailingParam ? "replace" : "create";
  }
  if (method === "POST") {
    if (
      [
        "create",
        "update",
        "add",
        "remove",
        "restart",
        "approve",
        "reject",
        "reset",
        "apply",
        "block",
        "rebuild",
        "regenerate",
      ].includes(first)
    ) {
      return first;
    }
    const last = lastStatic.toLowerCase();
    if (last === "add") return "add";
    if (last === "remove") return "remove";
    if (last === "approve") return "approve";
    if (last === "reject") return "reject";
    if (last === "restart") return "restart";
    if (last === "password" || last === "pincode" || last === "header-auth") return "set";
    if (last === "access-token") return "create";
    if (path.includes("regenerate")) return "regenerate";
    return "update";
  }
  return method.toLowerCase();
}

/**
 * @param {string} verb
 * @param {string[]} statics
 */
function compactAction(verb, statics) {
  const parts = statics.flatMap((part) => {
    if (part === verb) return [];
    if (part.startsWith(`${verb}_`)) return [part.slice(verb.length + 1)];
    return [part];
  });
  return [verb, ...parts].filter(Boolean).join("_") || verb;
}

/**
 * @param {string} method
 * @param {string} path
 * @param {string} summary
 */
function actionFrom(method, path, summary) {
  if (path === "/") return "get_health";
  const verb = verbFor(method, path, summary);
  return compactAction(verb, staticParts(path));
}

/**
 * @param {string} toolset
 */
function toolNameFor(toolset) {
  return `pangolin_${toolset}`;
}

/**
 * @param {string} method
 * @param {string} path
 * @param {string} summary
 * @param {string} tag
 */
function warningsFor(method, path, summary, tag) {
  /** @type {string[]} */
  const out = [];
  const lowerPath = path.toLowerCase();
  const lowerSummary = String(summary || "").toLowerCase();
  const write = method !== "GET";

  if (method === "DELETE") {
    if (/\/org\/\{orgid\}$/.test(lowerPath) || lowerPath.includes("/admin/org")) {
      out.push("This deletes an organization and the sites, resources, users, and keys inside it.");
    } else if (lowerPath.includes("/site/") || /\/org\/\{orgid\}\/site$/.test(lowerPath)) {
      out.push("This deletes a site and its associated resources.");
    } else if (lowerPath.includes("resource")) {
      out.push("This deletes a resource and can drop public exposure.");
    } else if (lowerPath.includes("/user")) {
      out.push("This deletes a user or invitation.");
    } else if (lowerPath.includes("/role")) {
      out.push("This deletes a role and its grants.");
    } else if (lowerPath.includes("/client")) {
      out.push("This deletes a client.");
    } else if (lowerPath.includes("/domain")) {
      out.push("This deletes a domain.");
    } else if (lowerPath.includes("/idp")) {
      out.push("This deletes an identity provider.");
    } else if (lowerPath.includes("api-key")) {
      out.push("This deletes an API key. Existing clients that use it will fail.");
    } else {
      out.push("This deletes data on the Pangolin server. It may be irreversible.");
    }
  }

  if (write && (tag.startsWith("Public Resource") || lowerPath.includes("public-resource"))) {
    out.push("Creating or changing a public resource can expose an internal host on the internet.");
  }
  if (write && (lowerPath.includes("/target") || lowerPath.endsWith("/target"))) {
    out.push("A target points traffic at a host. A wrong address exposes or breaks a service.");
  }
  if (write && (lowerPath.includes("access-token") || tag === "Access Token")) {
    out.push("Share links and access tokens let anyone with the token reach the resource.");
  }
  if (write && lowerPath.includes("/rule")) {
    out.push("Resource rules change who can reach the resource.");
  }
  if (
    write &&
    (lowerPath.includes("/password") ||
      lowerPath.includes("/pincode") ||
      lowerPath.includes("header-auth") ||
      lowerPath.includes("whitelist") ||
      lowerPath.includes("access-control") ||
      /sso|mfa|bypass/.test(lowerSummary))
  ) {
    out.push("This changes authentication or bypass settings for a resource.");
  }
  if (write && (lowerPath.includes("/api-key") || tag === "API Key")) {
    out.push("API key create, update, or action grants change credentials. Secrets are redacted in output.");
  }
  if (write && (lowerPath.includes("invitation") || tag === "User Invitation")) {
    out.push("This sends or changes a user invitation.");
  }
  if (write && lowerPath.includes("/certificate/") && method === "POST") {
    out.push("Restarting a certificate can interrupt TLS for the domain until the new cert is live.");
  }
  if (write && (lowerPath.includes("/blueprint") || tag === "Blueprint")) {
    out.push("Applying a blueprint can create or change many org objects at once.");
  }
  if (write && lowerPath.includes("regenerate") && /secret/.test(lowerPath + lowerSummary)) {
    out.push("Regenerating a newt, olm, or exit-node secret disconnects existing tunnels until they are updated.");
  }
  return [...new Set(out)];
}

/**
 * @param {string} method
 * @param {string} path
 * @param {string} summary
 * @param {object} op
 */
function responseKind(method, path, summary, op) {
  const content = op.requestBody?.content ?? {};
  if (Object.keys(content).some((key) => key.includes("multipart"))) return "multipart";
  const ok = op.responses?.["200"] ?? op.responses?.["201"] ?? op.responses?.["204"] ?? {};
  const out = ok.content ?? {};
  const keys = Object.keys(out);
  if (
    keys.some(
      (key) =>
        key.startsWith("image/") ||
        key.startsWith("video/") ||
        key.includes("octet") ||
        key.includes("zip") ||
        key.includes("binary"),
    )
  ) {
    return "file";
  }
  if (
    !keys.length &&
    (method === "DELETE" || method === "PUT" || method === "POST" || method === "PATCH")
  ) {
    return "empty";
  }
  void path;
  void summary;
  return "json";
}

/**
 * @param {string} name
 */
function sampleForParam(name) {
  const lower = name.toLowerCase();
  if (lower.includes("email")) return "user@example.com";
  if (lower === "domain") return "app.example.invalid";
  if (lower.includes("id")) {
    const stem = lower.replace(/id$/, "").replace(/_+$/, "");
    return `${stem || "id"}-sample`;
  }
  return "sample";
}

/**
 * @param {unknown} schema
 * @param {number} depth
 * @returns {unknown}
 */
function sampleFromSchema(schema, depth = 0) {
  if (!schema || typeof schema !== "object" || depth > 8) return {};
  const node = /** @type {Record<string, unknown>} */ (schema);
  if (typeof node.$ref === "string") return {};
  if (Array.isArray(node.allOf) && node.allOf[0]) return sampleFromSchema(node.allOf[0], depth + 1);
  if (Array.isArray(node.oneOf) && node.oneOf[0]) return sampleFromSchema(node.oneOf[0], depth + 1);
  if (Array.isArray(node.anyOf) && node.anyOf[0]) return sampleFromSchema(node.anyOf[0], depth + 1);
  if (node.type === "array") return [sampleFromSchema(node.items ?? { type: "string" }, depth + 1)];
  if (node.type === "integer" || node.type === "number") return 1;
  if (node.type === "boolean") return true;
  if (node.type === "string") {
    if (node.format === "email") return "user@example.com";
    if (node.format === "date-time") return "2026-01-01T00:00:00.000Z";
    if (node.format === "ipv4-cidr") return "10.80.0.0/24";
    if (node.enum && Array.isArray(node.enum) && typeof node.enum[0] === "string") return node.enum[0];
    return "sample";
  }
  if (node.type === "object" || node.properties) {
    const required = Array.isArray(node.required) ? node.required : [];
    const properties = /** @type {Record<string, unknown>} */ (node.properties ?? {});
    /** @type {Record<string, unknown>} */
    const out = {};
    const keys = required.length > 0 ? required : Object.keys(properties).slice(0, 4);
    for (const key of keys) {
      if (typeof key !== "string") continue;
      out[key] = sampleFromSchema(properties[key], depth + 1);
    }
    if (required.includes("name") && out.name === undefined) out.name = "mcp-live";
    return out;
  }
  return {};
}

/**
 * @param {object} op
 */
function sampleBody(op) {
  const content = op.requestBody?.content;
  if (!content) return undefined;
  const json = content["application/json"];
  if (!json) return undefined;
  if (json.example && typeof json.example === "object") return json.example;
  if (json.schema) return sampleFromSchema(json.schema);
  return undefined;
}

/**
 * @param {string} method
 * @param {string} path
 * @param {string} summary
 */
function isWrite(method, path, summary) {
  if (method === "GET") return false;
  const text = `${summary} ${path}`.toLowerCase();
  if (path === "/" || path.startsWith("/openapi.")) return false;
  if (/^(list|get|check|verify)\b/.test(String(summary || "").trim().toLowerCase())) return false;
  if (text.includes("read-only")) return false;
  return true;
}

/**
 * @param {string} method
 * @param {string} path
 */
function isDestructive(method, path) {
  if (method !== "DELETE") return false;
  return true;
}

/** @type {object[]} */
const rows = [];
const seenActions = new Map();

for (const [path, item] of Object.entries(spec.paths)) {
  for (const method of METHODS) {
    const op = item[method];
    if (!op) continue;
    if (!HTTP.has(method)) continue;
    const tag = (op.tags && op.tags[0]) || "Health Check";
    const toolset = TAG_TO_TOOLSET[tag];
    if (!toolset) {
      throw new Error(`Unmapped Pangolin tag ${tag} on ${method.toUpperCase()} ${path}`);
    }
    const summary = String(op.summary || op.description || `${method.toUpperCase()} ${path}`)
      .replace(/\s+/g, " ")
      .trim();
    let action = actionFrom(method.toUpperCase(), path, summary);
    const actionKey = `${toolset}::${action}`;
    if (seenActions.has(actionKey)) {
      const extra = paramParts(path).join("_");
      const candidate = extra.length > 0 ? `${action}_${extra}` : `${action}_${method}`;
      action = seenActions.has(`${toolset}::${candidate}`) ? `${action}_${method}_${rows.length}` : candidate;
    }
    seenActions.set(`${toolset}::${action}`, `${method} ${path}`);

    const allParams = [...(item.parameters || []), ...(op.parameters || [])];
    const pathParams = [];
    const queryParams = [];
    const headerParams = [];
    const sampleParams = {};
    const sampleQuery = {};
    for (const param of allParams) {
      if (!param || typeof param !== "object") continue;
      if (param.in === "path") {
        pathParams.push(param.name);
        sampleParams[param.name] = sampleForParam(param.name);
      } else if (param.in === "query") {
        queryParams.push(param.name);
        if (param.required) sampleQuery[param.name] = sampleForParam(param.name);
      } else if (param.in === "header") {
        headerParams.push(param.name);
      }
    }
    for (const match of path.matchAll(/\{([^}]+)\}/g)) {
      const name = match[1];
      if (name !== undefined && !pathParams.includes(name)) {
        pathParams.push(name);
        sampleParams[name] = sampleForParam(name);
      }
    }

    const write = isWrite(method.toUpperCase(), path, summary);
    const kind = responseKind(method.toUpperCase(), path, summary, op);
    const body = sampleBody(op);

    rows.push({
      method: method.toUpperCase(),
      path,
      operationId: action,
      action,
      tool: toolNameFor(toolset),
      toolset,
      tag,
      write,
      destructive: isDestructive(method.toUpperCase(), path),
      kind,
      summary,
      pathParams,
      queryParams,
      extraHeaders: headerParams,
      warnings: write ? warningsFor(method.toUpperCase(), path, summary, tag) : [],
      sampleParams,
      sampleQuery,
      sampleBody: body,
    });
  }
}

rows.sort((a, b) => {
  const tool = a.tool.localeCompare(b.tool);
  if (tool !== 0) return tool;
  const action = a.action.localeCompare(b.action);
  if (action !== 0) return action;
  return `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`);
});

if (rows.length !== 305) {
  console.warn(`Expected 305 operations, generated ${rows.length}`);
}

const toolsets = [...new Set(rows.map((row) => row.toolset))].sort();
/** @type {Record<string, { operations: number, tags: string[] }>} */
const counts = {};
for (const toolset of toolsets) {
  const subset = rows.filter((row) => row.toolset === toolset);
  counts[toolset] = {
    operations: subset.length,
    tags: [...new Set(subset.map((row) => row.tag))].sort(),
  };
}

/**
 * @param {unknown} value
 */
function ts(value) {
  return JSON.stringify(value);
}

/**
 * @param {object} row
 */
function emitRow(row) {
  const options = [
    `action: ${ts(row.action)}`,
    `toolset: ${ts(row.toolset)}`,
    `tag: ${ts(row.tag)}`,
    `operationId: ${ts(row.operationId)}`,
    `write: ${row.write}`,
    `destructive: ${row.destructive}`,
    `kind: ${ts(row.kind)}`,
    `summary: ${ts(row.summary)}`,
    `pathParams: ${ts(row.pathParams)}`,
    `queryParams: ${ts(row.queryParams)}`,
    `extraHeaders: ${ts(row.extraHeaders)}`,
    `warnings: ${ts(row.warnings)}`,
    `sampleParams: ${ts(row.sampleParams)}`,
    `sampleQuery: ${ts(row.sampleQuery)}`,
  ];
  if (row.sampleBody !== undefined) options.push(`sampleBody: ${ts(row.sampleBody)}`);
  return `  row(${ts(row.method)}, ${ts(row.path)}, ${ts(row.tool)}, {\n    ${options.join(",\n    ")},\n  })`;
}

const header = `/** Generated by scripts/gen-operations.mjs from pangolin.openapi.json. Do not edit by hand. */

import { ConnectorError } from "./errors.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type ResponseKind = "json" | "empty" | "file" | "multipart";

export interface Operation {
  readonly method: HttpMethod;
  readonly path: string;
  readonly tool: string;
  readonly action: string;
  readonly toolset: string;
  readonly tag: string;
  readonly operationId: string;
  readonly write: boolean;
  readonly destructive: boolean;
  readonly kind: ResponseKind;
  readonly summary: string;
  readonly pathParams: readonly string[];
  readonly queryParams: readonly string[];
  readonly extraHeaders: readonly string[];
  readonly warnings: readonly string[];
  readonly sampleParams: Readonly<Record<string, string>>;
  readonly sampleQuery: Readonly<Record<string, string>>;
  readonly sampleBody: unknown;
}

function row(
  method: HttpMethod,
  path: string,
  tool: string,
  options: {
    action: string;
    toolset: string;
    tag: string;
    operationId: string;
    write: boolean;
    destructive: boolean;
    kind: ResponseKind;
    summary: string;
    pathParams: readonly string[];
    queryParams: readonly string[];
    extraHeaders: readonly string[];
    warnings: readonly string[];
    sampleParams: Readonly<Record<string, string>>;
    sampleQuery: Readonly<Record<string, string>>;
    sampleBody?: unknown;
  },
): Operation {
  return {
    method,
    path,
    tool,
    action: options.action,
    toolset: options.toolset,
    tag: options.tag,
    operationId: options.operationId,
    write: options.write,
    destructive: options.destructive,
    kind: options.kind,
    summary: options.summary,
    pathParams: options.pathParams,
    queryParams: options.queryParams,
    extraHeaders: options.extraHeaders,
    warnings: options.warnings,
    sampleParams: options.sampleParams,
    sampleQuery: options.sampleQuery,
    sampleBody: options.sampleBody,
  };
}

export const DEFAULT_TOOLSETS = ${ts(DEFAULT_TOOLSETS)} as const;

export const ALL_TOOLSETS = ${ts(toolsets)} as const;

export const TOOLSET_COUNTS: Readonly<
  Record<string, { readonly operations: number; readonly tags: readonly string[] }>
> = ${ts(counts)};

export const OPERATIONS: readonly Operation[] = [
${rows.map(emitRow).join(",\n")},
];

export function toolNames(): string[] {
  return [...new Set(OPERATIONS.map((operation) => operation.tool))].sort();
}

export function operationsForTool(name: string): Operation[] {
  return OPERATIONS.filter((operation) => operation.tool === name);
}

export function toolIsWrite(name: string): boolean {
  return OPERATIONS.some((operation) => operation.tool === name && operation.write);
}

export function openApiKeys(): string[] {
  return OPERATIONS.map((operation) => \`\${operation.method} \${operation.path}\`).sort();
}

export function requireOp(tool: string, action: string): Operation {
  const found = OPERATIONS.find((operation) => operation.tool === tool && operation.action === action);
  if (found === undefined) {
    throw new ConnectorError("input", \`Unknown Pangolin operation \${tool} \${action}.\`);
  }
  return found;
}

export function parseToolsets(raw: string | undefined): readonly string[] {
  if (raw === undefined || raw.trim() === "") return [...DEFAULT_TOOLSETS];
  const trimmed = raw.trim();
  if (trimmed === "all") return [...ALL_TOOLSETS];
  const wanted = trimmed
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const allowed = new Set<string>(ALL_TOOLSETS);
  const unknown = wanted.filter((name) => !allowed.has(name));
  if (unknown.length > 0) {
    throw new ConnectorError("config", "Unknown PANGOLIN_TOOLSETS value.");
  }
  return [...new Set(wanted)];
}

export function toolsForToolsets(enabled: readonly string[]): string[] {
  const allow = new Set(enabled);
  return toolNames().filter((name) => {
    const operation = OPERATIONS.find((row) => row.tool === name);
    return operation !== undefined && allow.has(operation.toolset);
  });
}
`;

writeFileSync(join(root, "src/operations.ts"), header);
console.log(
  `wrote src/operations.ts (${rows.length} operations, ${toolsets.length} toolsets, default ${DEFAULT_TOOLSETS.length})`,
);
