# data-pipeline API quick reference

Base: `/api/v1` over HTTPS, JSON. Full design: `docs/design.md` in the repo.

## POST /api/v1/records

Required: `prompt` (string, ≤ 64 KB), `content` (string, ≤ 1 MB).
Optional: `external_id` (≤ 128 chars, upsert key within the caller's identity),
`title`, `content_format` (`markdown` | `text` | `html` | `json`),
`source_agent`, `skill_version`, `tags` (string array), `metadata` (object),
`schema_version` (currently 1).

Response: `{ "id": "...", "status": "created | replaced | deduped", "created_at": "..." }`

- With `external_id`: same content → `deduped`; changed content → `replaced`
  (same id, original `created_at` kept).
- Without: an identical content hash under the same identity → `deduped`.

## Errors

| Status | Meaning |
|---|---|
| 400 | Validation failed; body names the `field` |
| 401 | Auth is on and the key is missing or invalid |
| 413 | `prompt` or `content` over the size limit |
| 429 | Rate limit exceeded |

## Read endpoints

- `GET /api/v1/records?source_agent=&tag=&limit=&offset=` → `{ items, total, limit, offset }`
- `GET /api/v1/records/:id` → the full record
- `DELETE /api/v1/records/:id` → 204 (with auth on, only the owner's token)
- `GET /api/v1/health` → `{ "ok": true }`, no auth
