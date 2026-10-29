import { z } from "zod";
import { ConnectorError } from "./errors.js";

const MAX_DEPTH = 32;

const PATH_BEARING_KEYS = new Set([
  "filename",
  "filepath",
  "file_path",
  "realpath",
  "document_root",
  "script_filename",
  "stack",
]);

const envelopeRecordSchema = z.record(z.string(), z.unknown());

export interface PangolinEnvelope {
  data: unknown;
  message: string | undefined;
  pagination: unknown;
  success: boolean;
  error: boolean;
  status: number | undefined;
}

export function isAbsoluteFsPath(value: string): boolean {
  if (value.startsWith("/") && !value.startsWith("//")) {
    return (
      /^\/(?:tmp|var|home|root|data|datastore|opt|usr|etc|mnt|srv|app|config)\b/i.test(value) ||
      /\.(?:txt|html|htm|json|png|ico|jpg|jpeg|gif|webp|bin|php|log)$/i.test(value)
    );
  }
  if (/^[A-Za-z]:[\\/]/.test(value)) return true;
  if (value.startsWith("\\\\")) return true;
  return false;
}

export function stripPathsInText(text: string): string {
  return text
    .split(/(\s+)/)
    .map((part) => (isAbsoluteFsPath(part) ? "[omitted-path]" : part))
    .join("");
}

export function stripServerPaths(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return null;
  if (typeof value === "string") return isAbsoluteFsPath(value) ? undefined : value;
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    const items: unknown[] = [];
    for (const item of value) {
      const stripped = stripServerPaths(item, depth + 1);
      if (stripped !== undefined) items.push(stripped);
    }
    return items;
  }
  if (typeof value !== "object") return null;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key.toLowerCase() === "stack") continue;
    if (PATH_BEARING_KEYS.has(key.toLowerCase())) {
      if (
        key.toLowerCase() === "filename" &&
        typeof entry === "string" &&
        !isAbsoluteFsPath(entry)
      ) {
        out["filename"] = entry;
      }
      continue;
    }
    const stripped = stripServerPaths(entry, depth + 1);
    if (stripped === undefined) continue;
    out[key] = stripped;
  }
  return out;
}

export function asJsonObject(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = entry;
    return out;
  }
  if (Array.isArray(value)) return { items: value };
  if (typeof value === "string") return { text: value };
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return { value };
  }
  return { value: null };
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function parseEnvelope(value: unknown): PangolinEnvelope {
  const record = envelopeRecordSchema.safeParse(value);
  if (!record.success) {
    return {
      data: value,
      message: undefined,
      pagination: undefined,
      success: true,
      error: false,
      status: undefined,
    };
  }
  const body = record.data;
  const data = body["data"];
  let pagination = body["pagination"];
  if (
    pagination === undefined &&
    data !== null &&
    typeof data === "object" &&
    !Array.isArray(data)
  ) {
    const nested = envelopeRecordSchema.safeParse(data);
    if (nested.success) pagination = nested.data["pagination"];
  }
  return {
    data,
    message: asString(body["message"]),
    pagination,
    success: asBoolean(body["success"]) ?? true,
    error: asBoolean(body["error"]) ?? false,
    status: asNumber(body["status"]),
  };
}

export function envelopeToResult(envelope: PangolinEnvelope): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (envelope.data !== undefined) out["data"] = envelope.data;
  if (envelope.message !== undefined && envelope.message.length > 0) {
    out["message"] = envelope.message;
  }
  if (envelope.pagination !== undefined) out["pagination"] = envelope.pagination;
  if (envelope.status !== undefined) out["status"] = envelope.status;
  return out;
}

export function messageFromErrorBody(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    const envelope = parseEnvelope(parsed);
    if (envelope.message !== undefined && envelope.message.length > 0) {
      return stripPathsInText(envelope.message);
    }
  } catch {
    return stripPathsInText(text);
  }
  return stripPathsInText(text);
}

export function assertEnvelopeOk(envelope: PangolinEnvelope, label: string): void {
  if (!envelope.success || envelope.error) {
    const detail =
      envelope.message !== undefined && envelope.message.length > 0
        ? envelope.message
        : "the Integration API returned an error envelope.";
    throw new ConnectorError("upstream", `${label}: ${stripPathsInText(detail)}`);
  }
}
