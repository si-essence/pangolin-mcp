# Live check against Pangolin Community Edition

Run on 27 Oct 2026 (Africa/Accra) against a real, self-built Pangolin Community Edition
server **1.25.3** (the same release as `pangolin.openapi.json`), on the box, with no
sign-up and no Docker:

- Pangolin CE built from the public source (`fosrl/pangolin`) and run with Node on SQLite.
- Integration API on `http://127.0.0.1:3003`. Dashboard URL on this instance is `http://localhost:3002`.
- A root Integration API key from `PANGOLIN_ROOT_API_KEY` (sourced via `/workspace/research/pangolin-live/live.env`; the key is not printed here).
- The env-created root key starts with no granted actions (every call is 403), so all 199 action ids were granted to it directly in the local SQLite (`apiKeyActions`). That is instance setup, not a connector change.
- This instance had no `serverAdmin` user. Pangolin's `createOrg` path, when called with a root API key, assigns ownership to the server admin and rolls back if none exists. A throwaway internal user (`mcp-live-admin`) was inserted into the local SQLite so `create_org` could be exercised. That is instance setup, not a connector change.

Command: `PANGOLIN_URL=... PANGOLIN_API_KEY=... npm run live-check` (spawns `dist/index.js` over stdio with `PANGOLIN_TOOLSETS=all`, `PANGOLIN_ALLOW_WRITES=true`).

Result: **failed=0**, 20 tools listed, 33 checks passed (includes a second phase added after the first run).

Exercised for real (reads and confirmed writes, with previews checked first):

- list tools (20)
- list orgs
- create org (preview then confirm) with `orgId`, `name`, `subnet`, `utilitySubnet`
- site create / get / update / delete
- role create / get / update / delete (delete body `roleId` is the *replacement* role, not the role being deleted)
- list org domains (`domain1` / `localhost`)
- public resource create / get / update / delete, with `mode=http`, `domainId`, and a **subdomain** (a resource on the bare dashboard host `localhost` is rejected by CE with HTTP 409)
- public resource target create and delete (`127.0.0.1:8080` on the throwaway site)
- org API key create (preview, then confirm; the secret and `lastChars` come back as `[redacted]`) and delete
- public resource share link (access token) create and delete
- an unknown site id returns a clean `not-found` error with no server `stack` or filesystem path
- list org users, API keys, request logs
- list org AI providers (empty list; this **read** works on CE)
- delete the throwaway org and everything it created

Secrets: the API key was not printed. Resource, role, site, and org payloads had no `apiKey` / token / password / newt / olm secrets. Envelope `stack` was not returned.

NOT exercised live (covered only by mock-server unit tests): the other ~278 of the 305 operations, including clients, policies, identity providers, user invites, certificates, blueprints, redirects, labels, remote exit nodes, private resources, health/openapi meta, and write-side AI gateway routes (create provider / model / budget / virtual key). HTTP 401/403/404/422/429 mapping is mock-tested.

Enterprise vs CE: `list_org_ai_providers` succeeded on this CE instance (empty `providers`). Other AI gateway writes were not called. If those fail on CE, treat them as edition limits, not connector bugs.

Instance notes that the live script had to match:

- `create_org` needs a server admin when the caller is a root API key.
- HTTP public resources need `mode` plus `domainId`. A resource whose `fullDomain` equals the dashboard hostname is a 409; use a subdomain.
- `DELETE /role/{roleId}` body `roleId` is the role to reassign users to, and it must differ from the path id.
