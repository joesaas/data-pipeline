---
name: pipe-push
description: "Manually invoked only. Pushes the content you generate from the user's prompt to the user's data-pipeline server via its API, storing the original prompt and the generated content as a pair. Use only when the user explicitly invokes pipe-push."
disable-model-invocation: true
argument-hint: "[the prompt to generate from]"
---

# pipe-push

Push generated content to the user's data-pipeline server. The server stores
the original prompt and the generated content as a pair.

## Workflow

1. Take the user's prompt: the invocation argument if given, otherwise ask one
   short question for it.
2. Generate the content the prompt asks for, as you normally would. This skill
   does not change how you generate.
3. Write the generated content to a temporary file.
4. Run the bundled sender (do not hand-write an HTTP request):

```bash
node "${CLAUDE_SKILL_DIR}/scripts/push.mjs" \
  --prompt "<the user's original prompt, verbatim>" \
  --content-file <temp file> \
  --source claude-code
```

Set `--source` to the runtime you are running in (`claude-code`, `codex`,
`gemini`, `grok`, `muse`, or `other`). Add `--external-id <id>` only when the
user wants this push to update a specific existing record. Add `--title` only
when the user gave one.

5. Report the result to the user: the status (`created`, `replaced`, or
   `deduped`) and the record id from the script output. On failure, report the
   HTTP status and the server's error message; do not silently retry.

## Configuration

- `DATA_PIPELINE_BASE_URL`: server base URL (default `http://localhost:8080/data-pipeline`).
- Auth is configurable on the server and off by default. When the server has
  auth on, credentials come from `DATA_PIPELINE_ADAPTER` (an executable that
  returns auth headers as JSON) or `DATA_PIPELINE_API_KEY`. Never write a real
  key into this skill or into the content being pushed.
- Field and error reference: `references/api.md`.
