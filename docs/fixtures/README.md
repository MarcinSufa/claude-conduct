# Conduct event and usage parser fixtures

Captured 2026-09-05 with a throwaway `PreToolUse`/`PostToolUse`/`SubagentStart`/`SubagentStop`
hook that appended every raw payload to a scratch NDJSON file. The hook entries were removed
from `~/.claude/settings.json` after capture.

Versions: Claude Code `2.1.258`, codex-cli `0.144.3`, Node `v24.16.0`, Windows 11.

Personal data was replaced with placeholders or synthetic values. Remaining placeholders are
`<HOME>` for the home directory, `<REDACTED>` for removed content, `<USER>` for a username, and
`<HOME_SLUG>` for the home-directory slug. Session and prompt identifiers are synthetic UUIDs,
and associated paths and references use the same synthetic identifiers consistently.
Event structure, field names, and numeric usage values remain in place so the fixtures continue
to exercise the same parsers.

## Files

| File | Source |
| --- | --- |
| `hook-agent-pretooluse.json` | `PreToolUse` payload for `tool_name: "Agent"`, dispatched from the conductor session with `model: "haiku"` |
| `hook-subagent-posttooluse.json` | `PostToolUse` payload for a `Bash` call made **inside** the subagent |
| `hook-subagentstop.json` | `SubagentStop` payload for the same subagent |
| `subagent-transcript.jsonl` | the file at `agent_transcript_path` from `hook-subagentstop.json` (16 lines) |
| `codex-exec.jsonl` | stdout of `codex exec -m gpt-5.6-luna --json --sandbox read-only` (5 lines) |

## Findings from the hook capture

**Subagent `PostToolUse` includes `agent_id`.** A tool call made inside a subagent carries both
`agent_id` (identical to the `agent_id` in `SubagentStart` / `SubagentStop`, and to the id the
`Agent` tool returns) and `agent_type`. This allows spans to be attributed to each leg, not only
to the conductor session.

The discriminator is exact and mutually exclusive in this capture: a conductor-session tool
payload has `effort` and no `agent_id`; a subagent tool payload has `agent_id` + `agent_type`
and no `effort`. `session_id` is the **conductor** session in both cases, so `session_id` alone
cannot tell the two apart.

**transcript usage fields: `.message.usage` on lines with `type: "assistant"`.** Exact paths:

- `.message.usage.input_tokens` (uncached input only)
- `.message.usage.output_tokens`
- `.message.usage.cache_creation_input_tokens`
- `.message.usage.cache_read_input_tokens`
- `.message.model` carries the resolved model id (`claude-haiku-4-5-20251001`), so a leg
  reconstructed from a transcript never needs the literal `unknown`
- `.agentId` on every line ties the transcript to the leg

Billable input is `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`;
`input_tokens` on its own is 10 and 8 in this capture and is not the leg's input size.

**Dedupe is required.** Assistant lines are emitted per API block, and several lines share one
`requestId` while differing in `apiBlockIndex` (here: `apiBlockIndex` 0 and 1 for each of two
`requestId`s). The later block restates the cumulative usage for that request, so summing every
assistant line double-counts. Group by `requestId`, keep the highest `apiBlockIndex`, then sum
across requests.

The transcript format has no reliable end-of-transcript or completeness marker. A file truncated
at a line boundary is therefore indistinguishable from a complete transcript and may produce a
short, valid-looking total. Consumers must treat transcript totals as lower bounds unless an
external lifecycle signal establishes completeness.

## codex usage

The last line is `{"type":"turn.completed","usage":{...}}` with `input_tokens`,
`cached_input_tokens`, `output_tokens`, `reasoning_output_tokens`. Earlier lines are
`thread.started`, `turn.started` and `item.completed` (the agent message, and any `error` item).
`item.completed` with `item.type: "error"` is not fatal: this run also emitted an advisory error
item about the skills context budget and still completed with `output_tokens: 5`.

Codex usage sums every `turn.completed` event and uses `input_tokens` as reported. It does not add
`cached_input_tokens`: Codex reports `input_tokens` including cache, so adding the cache field would
double-count it. This differs from the transcript parser because Anthropic transcripts report
`input_tokens` excluding cache, requiring `cache_creation_input_tokens` and
`cache_read_input_tokens` to be added there.

This definition is based on two identical back-to-back Codex runs with the same model and prompt:

- run 1: `input_tokens 20407`, `cached_input_tokens 8960`
- run 2: `input_tokens 21309`, `cached_input_tokens 17152`

Cached input nearly doubled while total input changed by only 902, about 4 percent, showing that
`cached_input_tokens` is a subset of `input_tokens`, not a separate quantity to add. The exact
figures are provisional because the measurement used two runs, but the direction is clear.

## Two operational notes for the hook implementation

1. **The dump file is shared across concurrent sessions.** A second Claude Code session running
   at the same time wrote its own `PreToolUse`/`PostToolUse` lines into the same file, including
   tools this session never called. Hooks are global to `~/.claude/settings.json`, so
   `conduct-events.mjs hook` must decide per payload whether the session is activated and must
   not assume the payload belongs to the orchestration it can see.
2. **`SubagentStop` fires while the task still reads as running.** In `hook-subagentstop.json`
   the matching entry in `background_tasks` still has `status: "running"`, so that field cannot
   be used to detect leg completion; the `SubagentStop` event itself is the signal.

## Codex tool execution event fixture

Cut from a synthetic worktree event log. Kept: `thread.started`,
`turn.started`, one `agent_message`, three `command_execution` item.started/item.completed
pairs (exit codes 0, 0, 1, so one non-zero exit is present), one `file_change`
item.started/item.completed pair, and `turn.completed`. The `error` item from the source line
was dropped, it is not a tool call and out of scope for span parsing.

Every `aggregated_output` field is a synthetic string, since full command output is irrelevant
to span parsing. The file's first line carries a UTF-8
BOM immediately followed by one stray non-JSON line, `stderr: probe harness warm-up noise, not
JSON`, matching the shape codex-cli's real stdout capture sometimes has ahead of the JSON
stream; `spans-codex.mjs` must skip both without shifting the byte offsets of later lines.

## Second capture pass, 2026-09-06

A later review found that the first fixture set omitted two payloads that contradicted the proposed
event mapping, so the mapper was written against an incomplete mapping and shipped green. Both
payloads were already present in the first hook capture and were extracted without rerunning it.

| File | Source |
| --- | --- |
| `hook-agent-posttooluse.json` | `PostToolUse` for `tool_name: "Agent"`, the launch acknowledgement of a background dispatch |
| `hook-subagentstart.json` | `SubagentStart` for the same subagent |

**A background Agent `PostToolUse` is a launch acknowledgement, not a completion.** It carries
`tool_response.status: "async_launched"`, `isAsync: true`, and `duration_ms: 5`. There is no exit
code and no error flag, because nothing has finished. Treating it as the end of the leg closes
every background Claude leg five milliseconds after it starts. Completion is `SubagentStop`.

**The launch ack is the only payload carrying both identifiers.** It has `tool_use_id` and
`tool_response.agentId`, plus `tool_response.resolvedModel`, which is the real model id rather
than the alias `haiku` that `tool_input.model` carries. `SubagentStart` has `agent_id` and
`agent_type` and **no `tool_use_id` at all**. So a binding keyed on `tool_use_id` at
`SubagentStart` can never resolve.

**The order of the launch ack and `SubagentStart` is not stable.** In this dump the conductor
session emitted `PostToolUse` then `SubagentStart`, while a concurrent session emitted
`SubagentStart` then `PostToolUse`. Neither order can be assumed.

**A successful `Bash` `tool_response` carries no exit code.** The real shape is
`{stdout, stderr, interrupted: false, isImage: false, noOutputExpected: false}`. Success is
`interrupted === false`, not the presence of `exit_code: 0`. Any rule that treats a missing exit
code as failure marks every successful Bash call as interrupted.
