# Step runner

`skills/conduct/scripts/step-runner.mjs` runs one task's ordered step loop. It accepts a JSON workflow:

```json
{
  "steps": [
    { "id": "implement", "type": "agent", "model": "luna", "effort": "high", "prompt": "...", "timeoutSec": 1800 },
    { "id": "check", "type": "check", "argv": ["node", "--test"], "timeoutSec": 600,
      "onFail": { "retry": "implement", "max": 2, "retryOn": [1] } },
    { "id": "ship", "type": "gate", "prompt": "Marcin approves the PR text" }
  ],
  "models": { "luna": { "argv": ["codex", "exec", "..."] } },
  "swapOrder": ["luna", "opus", "grok"]
}
```

## Workflow fields

`steps` must be a non-empty list with unique non-empty `id` values. Step types are `agent`, `check`, and `gate`.

- An `agent` names a model and has exactly one of `prompt` or `promptFile`. A relative prompt file is resolved from the workflow file's directory. It can specify `effort` and positive-integer `timeoutSec` (default 1800). Every agent must be followed immediately by a check. The runner writes each rendered prompt to `<runDir>/<step>-<attempt>.prompt.md`.
- A `check` has exactly one of a non-empty string-array `argv` or string `command`; commands run through the platform shell. Its timeout defaults to 600 seconds. `protect` may name a non-empty list of files or directories relative to the run's working directory, or absolute paths. Protected directories include files and links recursively and skip `.git`; a link is compared by its target path and, for a file target, the target's bytes. For argv checks, the runner also protects each later argv item that names an existing regular file; placeholders containing `{` are skipped. Any protected file edit or removal, or any file added under a protected directory, ends the run as `check-tampered`. A check can have `onFail: { "retry": "earlier-step-id", "max": 2, "retryOn": [1] }`. `max` is the number of retries, and omitted `retryOn` retries any non-zero exit. The retry prompt is the original prompt, then, when the workspace is a git repo, a "Your changes so far" section (`git diff` against the HEAD the run started from, first 8000 characters, plus untracked file names), then only the latest check result section and the last 4000 combined output characters. It says: "You cannot change the check or its files; changing them ends the run."
- A `gate` may have a prompt. It pauses the workflow unless resumed with approval; gates are the only pause point.

## Models and swaps

Built-in model entries are merged with `models` in the workflow; a workflow entry replaces that name's built-in entry entirely. An entry has `argv`, optional `stdin` (`prompt` or `none`), and optional `effort`. `{cwd}`, `{effort}`, and `{promptFile}` are replaced in each argv item; `{promptFile}` is always available. The prompt file is written even when stdin is `none`.

| Name | Command | Default effort | Prompt input |
| --- | --- | --- | --- |
| `luna` | `codex exec -m gpt-6-luna -c model_reasoning_effort={effort} --skip-git-repo-check --sandbox workspace-write -C {cwd} -` | high | stdin |
| `opus` | `claude -p --model opus --effort {effort} --permission-mode bypassPermissions --output-format text` | medium | stdin |
| `grok` | `grok -m grok-4.6 --prompt-file {promptFile} --cwd {cwd} --reasoning-effort {effort} --permission-mode bypassPermissions --max-turns 80 --output-format plain` | high | prompt file |

Effort precedence is step, model entry, then `medium`. A model entry may set `limitPattern` to a regular expression string, compiled case-insensitively, to replace the default limit-message matcher. The default swap order is `luna`, `opus`, `grok`; Sol is not a swap-in. On Windows, Grok resolves to `%USERPROFILE%\.grok\bin\grok.exe` when present. A timed-out agent or a non-zero agent output whose last 4000 characters match the default usage, rate, quota, credit, spending-limit, or payment-required patterns (or the model's `limitPattern`) swaps to the next model after the current model in `swapOrder` and retries immediately. The swap persists for the step. A model outside the order or at its end cannot swap; the run ends `no-model`. The runner keeps at most the last 256 KiB of combined child output in memory. The complete output is still written to the step log, and the retry prompt and limit scan use the retained tail.

## Running, gate, and resume

```text
node skills/conduct/scripts/step-runner.mjs workflow.json [--repo DIR | --cwd DIR] [--from GATE --approved "who: text"] [--run-id ID] [--log FILE]
```

`--repo` creates a detached worktree at `<os.tmpdir()>/conduct-runs/<runId>` from the repo's `HEAD`, runs steps there, and keeps it. `--cwd` uses the given directory without a worktree; by default the current directory is used. `--run-id ID` sets the run ID and takes precedence over `CONDUCT_RUN_ID`; absent both, the runner generates a UUID. A run ID may use only letters, digits, dot, underscore and hyphen, and cannot be only dots; any other ID exits 2. Each child inherits the selected ID.

A gate returns its `step` and complete `resume` command. The command includes `--run-id ID` and works in cmd, PowerShell, and bash. It preserves the original working directory or worktree with `--cwd`. To resume manually, pass `--from <gate-id> --approved "<who: text>"` with `--run-id ID` or `CONDUCT_RUN_ID` set. The ID must identify a run log containing a `start` event and a gate stop at that step, and the workflow file must have the `workflowHash` recorded at start; invalid resumes exit 2 before creating a run directory. A gate stop writes `state.json` in the run directory with retry counters, the current model for each agent step, and the run's base HEAD. Resume restores these values, so retries already spent and model swaps remain in effect. The runner continues to use the original base HEAD for retry diffs.

Each step has a hard timeout. Timeout records exit 124 and outcome `timeout`. On POSIX the child runs in its own process group, which the runner kills after the step, including on success. A descendant that calls `setsid` or double-forks can escape the group kill; cgroups or `PR_SET_CHILD_SUBREAPER` are the upgrade paths. On Windows, timeout and best-effort cleanup use `taskkill /pid <pid> /T /F`. After agent and check steps, the runner makes one timed, 10-second CIM process query and attempts to kill descendants whose parent chain is still visible and whose creation times are consistent with that chain. Query failures and timeouts are recorded as `warning` events. The query costs about 1.5 to 2.5 seconds per step, mostly PowerShell startup. Cleanup cannot follow a chain through an exited parent, so descendants in that case may survive; Windows Job Objects are the upgrade path. If stdio remains open after a kill or process exit, the runner destroys the streams after a two-second grace period. `--approved` requires `--from` naming a gate.

## Log and exit codes

The default NDJSON log is `<homeRoot()>/runs/<runId>/run.ndjson`; `--log` overrides it. Each event has `event`, `ts`, and `runId`. `start` includes `workflow`, `cwd`, optional `worktree`, `workflowHash` (SHA-256 of the workflow file bytes), `base` (git HEAD at run start, or `null` outside a git workspace), and `checks` (a map from check ID to file paths and their SHA-256 hashes). `attempt` includes `step`, `type`, `n`, optional `model`/`effort`, `argv` (the rendered child argv, without prompt text), `exit`, `outcome`, and `ms`. Agent attempts in a git workspace also include `diffHash` (SHA-256 of `git diff <base>` after the attempt) and `untracked` (the count of untracked files). Other events are `swap` (`step`, `from`, `to`, `reason`), `retry` (`check`, `n`, `to`), `approval` (`step`, `approved`), `warning` (`message`, for Windows process-query failures), and `end` (`status`, optional `message`/`failedStep`, `runs`, `ms`). Each step attempt also writes combined stdout and stderr to `<runDir>/<step>-<attempt>.log`. The CLI prints one JSON result line with the end fields plus `runId` and `worktree`.

| Exit | Meaning |
| --- | --- |
| 0 | success |
| 1 | failed, exhausted, no-model, or check-tampered |
| 2 | invalid workflow or arguments |
| 3 | stopped at a gate |
| 129 | interrupted by SIGHUP |
| 130 | interrupted by SIGINT |
| 143 | interrupted by SIGTERM |

Interruption ends the run with status `interrupted`.

Before each agent attempt, the runner hashes check executables it can resolve from `argv[0]`, existing regular files named by later argv items of argv checks, and files named by `protect`. A changed or missing-afterward protected file ends the run as `check-tampered`; additions under a protected directory do too. `protect` applies to both argv and command checks.

## Review-fix workflow

`skills/conduct/workflows/review-fix/` runs one review and fix round on the working tree:

```text
node skills/conduct/scripts/step-runner.mjs skills/conduct/workflows/review-fix/workflow.json --cwd <repo>
```

1. `review` (Luna, high) writes the findings for the diff against the default branch's merge base to `.conduct/review-<runId>.md`, or the single line `NO FINDINGS`. `review-written` fails the run when the file is missing.
2. `fix` (Opus, medium) fixes each finding test first. `tests` runs `npm test` with `package.json` protected and retries `fix` twice.
3. `clear-review` deletes the review file, so a fixer that writes `NO FINDINGS` itself cannot pass the next check. `rereview` reviews again, and `clean` passes only when the file is exactly `NO FINDINGS`. Findings retry `fix` twice; a missing file fails the run.
4. `approve` stops at a gate. The runner never commits.

The review file lives in `.conduct/`, which the target repo should ignore. Workflows have no variables, so for a repo whose tests are not `npm test`, copy the folder and change the `tests` command; the prompt files resolve from the workflow's own directory.

## Dispatch guard

`dispatch-guard.mjs` is an optional PreToolUse hook for Bash and Monitor. It denies codex/grok dispatch outside a step-runner run, and denies dispatch from subagents. It is not installed by the runner or this repository change. To enable it by hand, add a `PreToolUse` hook with a `Bash|Monitor` matcher in your `settings.json`, for example:

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Bash|Monitor",
      "hooks": [{
        "type": "command",
        "command": "node /absolute/path/to/skills/conduct/scripts/dispatch-guard.mjs"
      }]
    }]
  }
}
```

The hook parses shell commands using the conductor guard's shell parser and prefix handling. Keep `CONDUCT_RUN_ID` in the hook process environment for permitted in-run dispatch. A `CONDUCT_RUN_ID=...` assignment written inside a Bash command does not enable it. Wrapper programs and `--` after them are followed; npm exec, npm x, bun x, and pueue add are followed as wrappers. Other commands that only mention codex or grok as an argument are allowed. Scripts on disk and code an interpreter reads from a file or stdin are outside the inspection ceiling; inline interpreter code inspected includes `-c`, `-e`, `-E`, `-p`, and `-r`. Shell code read from stdin is still inspected. Command words that start with `$` or a backtick are resolved from assignments earlier in the same command; a `$(...)` or backtick word denies when a lookup in the command names codex or grok, and an unresolved word denies only when its path ends in codex or grok. Aliases and functions are not visible (PATH wrapper is the upgrade path).
