import { definedQuery, fillOpenApiPath, jsonValueSchema } from "./json.js";
import type { QueryMap } from "./http.js";
import type { Operation } from "./operations.js";
import { assertEnvelopeOk, envelopeToResult, parseEnvelope } from "./parse.js";
import type { Runtime } from "./runtime.js";
import { withWrite } from "./write-gate.js";

export interface CallArgs {
  readonly params?: Readonly<Record<string, string | number | boolean>> | undefined;
  readonly query?: Readonly<Record<string, string | number | boolean>> | undefined;
  readonly body?: unknown;
  readonly confirm?: true | undefined;
}

function asQuery(
  record: Readonly<Record<string, string | number | boolean>> | undefined,
): QueryMap | undefined {
  if (record === undefined) return undefined;
  const mapped: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(record)) mapped[key] = value;
  return definedQuery(mapped);
}

function asParams(
  record: Readonly<Record<string, string | number | boolean>> | undefined,
): Record<string, string | number> {
  if (record === undefined) return {};
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "boolean") out[key] = String(value);
    else out[key] = value;
  }
  return out;
}

export async function callPangolin(
  runtime: Runtime,
  operation: Operation,
  args: CallArgs = {},
): Promise<Record<string, unknown>> {
  const path = fillOpenApiPath(operation.path, asParams(args.params));
  const query = asQuery(args.query);
  const ttlSec = operation.write ? 0 : runtime.cacheTtlSec;

  const run = async (): Promise<Record<string, unknown>> => {
    return execute(runtime, operation, path, query, args, ttlSec);
  };

  if (!operation.write) return run();

  return withWrite(
    runtime,
    args.confirm,
    {
      method: operation.method,
      path,
      query,
      body: args.body,
      summary: operation.summary,
      warnings: operation.warnings,
    },
    run,
  );
}

async function execute(
  runtime: Runtime,
  operation: Operation,
  path: string,
  query: QueryMap | undefined,
  args: CallArgs,
  ttlSec: number,
): Promise<Record<string, unknown>> {
  if (operation.kind === "empty") {
    if (operation.method === "POST") {
      if (args.body === undefined) {
        const sent = await runtime.client.postEmpty({ path, query });
        return unwrap(sent.body);
      }
      const json = await runtime.client.postJson({ path, query, body: args.body }, jsonValueSchema);
      return unwrap(json);
    }
    if (operation.method === "PUT") {
      if (args.body === undefined) {
        const sent = await runtime.client.putEmpty({ path, query });
        return unwrap(sent.body);
      }
      const json = await runtime.client.putJson({ path, query, body: args.body }, jsonValueSchema);
      return unwrap(json);
    }
    if (operation.method === "PATCH") {
      if (args.body === undefined) {
        const sent = await runtime.client.patchEmpty({ path, query });
        return unwrap(sent.body);
      }
      const json = await runtime.client.patchJson(
        { path, query, body: args.body },
        jsonValueSchema,
      );
      return unwrap(json);
    }
    if (args.body === undefined) {
      const sent = await runtime.client.delete({ path, query });
      return unwrap(sent.body);
    }
    const json = await runtime.client.deleteJson({ path, query, body: args.body }, jsonValueSchema);
    return unwrap(json);
  }

  if (operation.method === "GET") {
    const json = await runtime.client.getJson({ path, query, ttlSec }, jsonValueSchema);
    return unwrap(json);
  }
  if (operation.method === "POST") {
    const json = await runtime.client.postJson(
      { path, query, body: args.body ?? {} },
      jsonValueSchema,
    );
    return unwrap(json);
  }
  if (operation.method === "PUT") {
    const json = await runtime.client.putJson(
      { path, query, body: args.body ?? {} },
      jsonValueSchema,
    );
    return unwrap(json);
  }
  if (operation.method === "PATCH") {
    const json = await runtime.client.patchJson(
      { path, query, body: args.body ?? {} },
      jsonValueSchema,
    );
    return unwrap(json);
  }
  const json = await runtime.client.deleteJson(
    { path, query, body: args.body ?? {} },
    jsonValueSchema,
  );
  return unwrap(json);
}

function unwrap(json: unknown): Record<string, unknown> {
  const envelope = parseEnvelope(json);
  assertEnvelopeOk(envelope, "pangolin-mcp");
  return envelopeToResult(envelope);
}
