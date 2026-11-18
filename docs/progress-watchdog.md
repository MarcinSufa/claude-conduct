# Progress watchdog

(shadow)

Other optional time-based monitors, such as shell watchdogs, queue runners, or external orchestration tools, measure time
and counters: a worker that is busy but going nowhere looks healthy to them. `skills/conduct/scripts/progress-watchdog.mjs`
(Node, no dependencies) reads a worker transcript and judges progress against the goal:

```bash
node skills/conduct/scripts/progress-watchdog.mjs ~/.claude/projects/<proj>/<session>.jsonl --goal-file .conduct/brief-x.md --worker luna-x
node skills/conduct/scripts/progress-watchdog.mjs .conduct/luna-x.jsonl --goal "fix the login bug"   # codex exec --json output
tail -n 200 worker.jsonl | node skills/conduct/scripts/progress-watchdog.mjs - --fast-only            # no model at all
```

It prints one JSON line: `verdict` (`progressing|stalled|looping|drifting|unknown`), `confidence` 0-100, `reason`,
`suggested_action`, `source` (`fast|model|budget|error`), `costUsd` and the fast-path `signals`.

1. **Window:** the last 30 tool calls (`--tools`) and 6 assistant messages (`--messages`), cut to 24000 characters
   (`--max-chars`, about 6k tokens). The goal is `--goal`/`--goal-file`, else the first user message.
2. **Fast path, no model:** the same error 4+ times -> `looping`; the same command with the same output 4+ times ->
   `stalled` when it polls (`sleep`, `gh pr checks`, `status`...), else `looping`. One file edited 5+ times without a
   test run in between, or messages without tool calls, are passed to the model as hints only.
3. **Slow path:** `claude -p --model claude-haiku-4-5` with no user settings, no tools, no MCP, no skills and a short
   system prompt (about 0.004 to 0.017 USD per window in the 2026-11-02 E2E). The child gets the environment without the
   parent session's `CLAUDE_CODE_*` session variables: with them, a `claude -p` started inside a Claude Code session joins
   the parent's context (measured: 0.27 USD and "Prompt is too long" for a one-line prompt). A reply off the schema is
   `unknown`.
4. **Cache:** a window already judged is not judged or logged again (`cache.json`, last 500). `unknown` is not cached.
5. **Budget:** `CONDUCT_WATCHDOG_DAILY_USD` (default `0.5`) per UTC day in `spend.json`. Each call reserves
   min(0.05, what is left) under a lock file before it starts and passes it as `--max-budget-usd`; the reservation is then
   replaced by the reported cost (no cost reported: the reservation stays). A corrupt ledger counts as spent. Once the day
   is spent the verdict is `unknown`. `claude -p` checks `--max-budget-usd` after a request, so one call can still overshoot it.

| `CONDUCT_WATCHDOG` | behaviour |
| --- | --- |
| unset or `shadow` | **default** - appends the verdict to `shadow.jsonl` and prints it; no kills, no messages |
| `act` | as shadow, plus a `{"notify":{"to":"conductor","message":...}}` line on stdout for `stalled/looping/drifting` at confidence >= `CONDUCT_WATCHDOG_ACT_MIN` (70). The script sends nothing; the caller delivers it |
| `off` | does nothing |

State lives in `$CONDUCT_WATCHDOG_DIR`, else `~/.conduct/progress-watchdog/` (`$CONDUCT_HOME/progress-watchdog/` when
`CONDUCT_HOME` is set). `EXOLOOP_HOME` is a legacy fallback for an optional external runner. State files are:
`shadow.jsonl`, `cache.json`, `spend.json`. Other knobs: `--model`/`CONDUCT_WATCHDOG_MODEL`, `CONDUCT_WATCHDOG_CLI`
(path to the `claude` binary; no shell is used, so on Windows point it at `claude.exe`), `--fast-only`, `--no-fast`
(always ask the model), `--no-cache`.

**Wiring (not done by this repo):** call it next to an existing time-based check, so it only runs on workers that are
alive. After a monitor confirms a worker is still running, run it on that worker's transcript with the brief as
`--goal-file`. A queue runner can call it from a stall hook with the job log. A scheduler can check recent transcripts
periodically. The cache makes repeated runs on an unchanged transcript free. In `act` mode, deliver the `notify` line
through an external message channel or record it in the ledger.

**Review the shadow log:**

```bash
node -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").filter(Boolean).map(JSON.parse);const by=k=>Object.entries(l.reduce((a,x)=>(a[x[k]]=(a[x[k]]||0)+1,a),{}));console.log("entries:",l.length,"usd:",l.reduce((s,x)=>s+(x.costUsd||0),0).toFixed(3));console.log("by verdict:",by("verdict"));console.log("by source:",by("source"))' ~/.conduct/progress-watchdog/shadow.jsonl
```
