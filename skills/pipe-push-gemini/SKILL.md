---
name: pipe-push-gemini
description: "Manually invoked only. Generates content from the user's prompt for the user's data-pipeline server and assembles the exact push payload (the original prompt and the generated content as a pair). Use only when the user explicitly invokes pipe-push."
---

# pipe-push (Gemini Apps variant)

Prepare a push to the user's data-pipeline server. The server stores the
original prompt and the generated content as a pair.

This file is self-contained: the workflow, the API reference, and a payload
example are all below. No other files are needed.

## Platform constraint (read first)

Gemini Apps skills cannot run scripts that access the internet, so this
variant cannot send the HTTP request itself. Your job is to generate the
content and assemble the exact payload; the user runs one command outside
Gemini to complete the push. Never claim the record was pushed until the
user shows you the server's response.

## Workflow

1. Take the user's prompt: the invocation argument if given, otherwise ask
   one short question for it.
2. Generate the content the prompt asks for, as you normally would. This
   skill does not change how you generate.
3. Assemble the JSON payload exactly as specified in the API reference
   below:
   - `prompt`: the user's original prompt, verbatim.
   - `content`: the generated content.
   - `source_agent`: `"gemini"`.
   - `content_format`: `"markdown"` unless the content is plainly another
     format.
   - Add `external_id` only when the user wants this push to update a
     specific existing record. Add `title` only when the user gave one.
4. Hand the user two things, in this order:
   - The payload as a JSON code block, to save as `payload.json`.
   - This command, ready to copy and run in any terminal:

     ```bash
     curl -s -X POST "https://agent101.uk/data-pipeline/api/v1/records" \
       -H "Content-Type: application/json" \
       -d @payload.json
     ```

     If the user has set a different `DATA_PIPELINE_BASE_URL`, replace the
     host part with `<base>/api/v1/records` accordingly.
5. When the user pastes back the server's response, report the result: the
   `status` (`created`, `replaced`, or `deduped`) and the record `id`. On
   an error response, report the HTTP status and the server's error
   message. Do not silently retry, and do not invent a status or id.

## Configuration

- Server base URL: `https://agent101.uk/data-pipeline` by default
  (`DATA_PIPELINE_BASE_URL` when the user sets one).
- Auth is configurable on the server and off by default. If the server
  answers 401, auth is on: tell the user the push command needs an
  `X-API-Key` header with their own key. Never write a real key into this
  skill or into the content being pushed.

## API reference

Base: `{DATA_PIPELINE_BASE_URL}/api/v1` over HTTPS, JSON. The server mounts
the API under a project base path (default `/data-pipeline`, so the full
push URL looks like `https://agent101.uk/data-pipeline/api/v1/records`);
the unprefixed `/api/v1` paths also work.

### POST /api/v1/records

Required: `prompt` (string, ≤ 64 KB), `content` (string, ≤ 1 MB).
Optional: `external_id` (≤ 128 chars, upsert key within the caller's
identity), `title`, `content_format` (`markdown` | `text` | `html` |
`json`), `source_agent`, `skill_version`, `tags` (string array),
`metadata` (object), `schema_version` (currently 1).

Response: `{ "id": "...", "status": "created | replaced | deduped", "created_at": "..." }`

- With `external_id`: same content → `deduped`; changed content →
  `replaced` (same id, original `created_at` kept).
- Without: an identical content hash under the same identity → `deduped`.

### Errors

| Status | Meaning |
|---|---|
| 400 | Validation failed; body names the `field` |
| 401 | Auth is on and the key is missing or invalid |
| 413 | `prompt` or `content` over the size limit |
| 429 | Rate limit exceeded |

### Read endpoints

- `GET /api/v1/records?source_agent=&tag=&limit=&offset=` → `{ items, total, limit, offset }`
- `GET /api/v1/records/:id` → the full record
- `DELETE /api/v1/records/:id` → 204 (with auth on, only the owner's token)
- `GET /api/v1/health` → `{ "ok": true }`, no auth

## Payload example

```json
{
  "prompt": "Summarize today's Aave governance activity in one short paragraph.",
  "content": "Aave's governance forum saw one new proposal today...",
  "source_agent": "gemini",
  "content_format": "markdown"
}
```
