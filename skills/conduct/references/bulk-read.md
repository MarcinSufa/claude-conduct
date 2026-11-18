# bulk-read: usage

The rule (never Read a big file into the driving session) is summarized in SKILL.md and detailed in
references/token-hygiene.md. This file holds the invocation details.

`node "${CLAUDE_SKILL_DIR}/scripts/bulk-read.mjs" <file>... --question "<q>" [--model flash|luna] [--max-bullets 40] [--json] [--dry-run]`

- `flash` = DeepSeek v4 Flash via `DEEPSEEK_API_KEY` (default); `luna` = Luna via
  `OPENAI_PLATFORM_KEY`. The script pins its own model ids, separate from the routing table.
- Bullets cite `path:line` (`path:pN` for PDFs, whose lines reach the worker prefixed `pN|`).
- PDFs need PyMuPDF (`import fitz`) in `python3` (`python` on Windows); `BULK_READ_PYTHON`
  overrides the interpreter. Without it a PDF exits 3.
- stderr carries model, chunks, token counts, dropped uncited lines, bullets cut by
  `--max-bullets` and a cost estimate, never file contents. Under `--json` the bullets and those
  metrics go to stdout as one object instead.
- A billed run refuses more than 20 chunks (`BULK_READ_MAX_CHUNKS`); `--dry-run` shows the plan
  and warns.
- Configure denied paths with `BULK_READ_DENY_PATHS`, a semicolon-separated list. A path is refused
  when it contains any configured value, case-insensitively. For example, `example-org` matches
  `example-org-tools`; no deny list is configured by default.
