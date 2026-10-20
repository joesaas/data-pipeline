# pipe-push (generic variant)

For agents without a SKILL.md loader (e.g. Grok Bot until its skill format is
verified). Manually invoked only: do not run this workflow unless the user
explicitly asks to push generated content to their data-pipeline server.

## Workflow

1. Take the user's prompt (given with the invocation, or ask one short question).
2. Generate the content the prompt asks for, as you normally would.
3. Write the generated content to a temporary file.
4. Run the bundled sender with the `push_content` tool contract in `tool.json`
   (equivalently: `node scripts/push.mjs --prompt "<verbatim prompt>"
   --content-file <temp file> --source grok`).
5. Report the returned status (`created` / `replaced` / `deduped`) and record
   id. On failure report the HTTP status and server error; do not retry silently.

## Configuration

- `DATA_PIPELINE_BASE_URL` env var sets the server (default
  `https://agent101.uk/data-pipeline`).
- Server auth is configurable and off by default. When on, credentials come
  from `DATA_PIPELINE_ADAPTER` or `DATA_PIPELINE_API_KEY`. Never embed a real
  key in these files or in pushed content.
