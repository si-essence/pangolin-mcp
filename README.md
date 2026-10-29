# pangolin-mcp (Pangolin MCP connector)

MCP connector for a self-hosted [Pangolin](https://github.com/fosrl/pangolin) Community Edition Integration API. It speaks that REST API over stdio and over stateless Streamable HTTP on localhost.

Pangolin Community Edition is AGPL-3.0 software. This connector is MIT. It only calls the public Integration REST API on the server you configure. It is not affiliated with Fossorial or Pangolin. Bring your own API key from your self-hosted instance (org-scoped or root).

This connector covers all 234 paths and 305 operations in `pangolin.openapi.json` (Pangolin CE 1.25.3). Operations are grouped into 20 toolsets. Enable a subset with `PANGOLIN_TOOLSETS` so the model only sees the tools you need.

Self-hosted Community Edition only. There is no default base URL. `PANGOLIN_URL` is required and must be your Integration API origin, for example `https://api.example.com` or `http://127.0.0.1:3003`. A trailing `/v1` is stripped. Calls go to `{PANGOLIN_URL}/v1`. Hosts on `pangolin.net` are refused.

## Setup

```bash
npm install
npm run ci
npm start
npm run start:http
```

`npm start` speaks stdio. `npm run start:http` serves Streamable HTTP at `http://127.0.0.1:3000/mcp` and `GET /health`. HTTP mode has no authentication. Keep it on localhost.

Create an API key in Pangolin (org API keys, or a root key on CE). The connector sends it as `Authorization: Bearer` and never prints it.

```json
{
  "mcpServers": {
    "pangolin": {
      "command": "node",
      "args": ["/workspace/connectors/pangolin/dist/index.js"],
      "env": {
        "PANGOLIN_URL": "http://127.0.0.1:3003",
        "PANGOLIN_API_KEY": "...",
        "PANGOLIN_ALLOW_WRITES": "false",
        "PANGOLIN_TOOLSETS": "sites,resources,targets,roles,users,orgs",
        "PANGOLIN_CONTACT": "you@example.com"
      }
    }
  }
}
```

Docker (HTTP, no authentication, localhost only):

```bash
docker build -t pangolin-mcp .
docker run -p 3000:3000 \
  -e PANGOLIN_URL=http://host.docker.internal:3003 \
  -e PANGOLIN_API_KEY=... \
  pangolin-mcp
```

Do not put the API key in the image.

Regenerate the operations registry after an OpenAPI bump:

```bash
npm run gen:operations
```

## Config

| Variable                 | Meaning                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------ |
| `PANGOLIN_URL`           | Required. Self-hosted Integration API origin. `/v1` is appended. Cloud hosts are refused.        |
| `PANGOLIN_API_KEY`       | API key. Sent as `Authorization: Bearer`.                                                        |
| `PANGOLIN_ALLOW_WRITES`  | Must be the literal `true` before a confirmed write is sent.                                     |
| `PANGOLIN_TOOLSETS`      | Comma list of toolsets, or `all`. Default `sites,resources,targets,roles,users,orgs`.            |
| `PANGOLIN_PER_MINUTE`    | Local request budget. Default 30.                                                                |
| `PANGOLIN_TIMEOUT_MS`    | Upstream timeout. Default 20000.                                                                 |
| `PANGOLIN_CACHE_TTL_SEC` | GET cache TTL. Default 60. Writes clear the cache.                                               |
| `PANGOLIN_CONTACT`       | Contact token in the User-Agent.                                                                 |
| `MCP_TRANSPORT`          | `stdio` or `http`. `--http` overrides.                                                           |
| `PORT`                   | HTTP port. Default 3000.                                                                         |

## Safety

GET operations, and POST or PUT ops whose summaries are list or get, run without `confirm`. Every other write is gated.

A write needs `confirm: true` and `PANGOLIN_ALLOW_WRITES=true`. Otherwise the tool returns a dry-run preview of the method, path, query, and body. Secrets are redacted. Extra preview warnings cover public resource exposure, share links and access tokens, rules, targets, deletes of org, site, resource, user, role, client, domain, IdP, or API key, API key create and action grants, user invites, auth and bypass changes, certificate restart, and blueprint apply.

Pangolin wraps JSON in `{ data, success, error, message, status }`. The connector returns `data`, `message`, and `pagination`. It never returns `stack` or server filesystem paths. Field names `apiKey`, `secret`, `token`, `password`, `newtSecret`, `olmSecret`, `accessToken`, `clientSecret`, and other secret/token/password/key names are redacted. Id fields such as `apiKeyId` and `orgId` are kept.

HTTP 401 means the key was rejected. HTTP 403 means the key does not have that action granted. HTTP 400 and 422 are validation errors. HTTP 429 includes Retry-After.

## Tools

Default `PANGOLIN_TOOLSETS` publishes 6 tools. `PANGOLIN_TOOLSETS=all` publishes 20 tools (305 operations). Each tool takes `action` plus `params`, `query`, `body`, and optional `confirm`.

| Toolset             | Tool                         | Operations | Tags                                                                 | Default |
| ------------------- | ---------------------------- | ---------- | -------------------------------------------------------------------- | ------- |
| sites               | `pangolin_sites`             | 11         | Site                                                                 | yes     |
| resources           | `pangolin_resources`         | 123        | Public Resource, Public Resource (Legacy), Private Resource, Private Resource (Legacy) | yes     |
| targets             | `pangolin_targets`           | 3          | Resource Target                                                      | yes     |
| roles               | `pangolin_roles`             | 6          | Role                                                                 | yes     |
| users               | `pangolin_users`             | 12         | User, User Invitation                                                | yes     |
| orgs                | `pangolin_orgs`              | 10         | Organization                                                         | yes     |
| domains             | `pangolin_domains`           | 5          | Domain                                                               | no      |
| clients             | `pangolin_clients`           | 17         | Client                                                               | no      |
| policies            | `pangolin_policies`          | 37         | Public Resource Policy, Public Resource Policy (Legacy)              | no      |
| access_tokens       | `pangolin_access_tokens`     | 2          | Access Token                                                         | no      |
| identity_providers  | `pangolin_identity_providers`| 9          | Identity Provider (Global)                                           | no      |
| api_keys            | `pangolin_api_keys`          | 5          | API Key                                                              | no      |
| blueprints          | `pangolin_blueprints`        | 3          | Blueprint                                                            | no      |
| logs                | `pangolin_logs`              | 10         | Logs                                                                 | no      |
| labels              | `pangolin_labels`            | 6          | Label                                                                | no      |
| certificates        | `pangolin_certificates`      | 2          | Certificate                                                          | no      |
| redirects           | `pangolin_redirects`         | 6          | Redirect                                                             | no      |
| ai                  | `pangolin_ai`                | 34         | AI Provider, AI Model, AI Budget, Virtual API Key                    | no      |
| remote_exit_nodes   | `pangolin_remote_exit_nodes` | 1          | Remote Exit Node                                                     | no      |
| meta                | `pangolin_meta`              | 3          | Health Check, OpenAPI                                                | no      |

Example. List orgs, then create one after previewing:

```json
{ "action": "list_orgs" }
```

```json
{ "action": "create_org", "body": { "orgId": "lab", "name": "Lab", "subnet": "100.90.128.0/24", "utilitySubnet": "192.0.2.0/24" } }
```

```json
{ "action": "create_org", "body": { "orgId": "lab", "name": "Lab", "subnet": "100.90.128.0/24", "utilitySubnet": "192.0.2.0/24" }, "confirm": true }
```

## Live check

`npm run live-check` talks to a real Pangolin CE when `PANGOLIN_URL` and `PANGOLIN_API_KEY` are set. It lists orgs, creates a throwaway org (preview then confirm), then creates, reads, updates, and deletes a site, a role, and a public resource with a target where the CE API allows it. It lists users, domains, API keys, and logs, then deletes the org. If those variables are unset, it prints a skip message and exits 0.

`LIVE-CHECK.md` records the real run against Pangolin CE 1.25.3 built from source on the box.

## Attribution

Pangolin is AGPL-3.0 (Community Edition). This connector is MIT and is not a derivative of Pangolin source. It is an independent HTTP client of the Integration API.

## License

MIT, see [LICENSE](LICENSE). This is an independent, unofficial connector and is not endorsed by the Pangolin project or its owners.

The upstream pangolin.openapi.json comes from a AGPL-3.0 project, so it is not shipped here. `src/operations.ts` was generated from it, and tests fall back to a route-only fixture in `test/fixtures/`. To regenerate, download the spec from the upstream project into the repo root (it is gitignored) and run `node scripts/gen-operations.mjs`.
