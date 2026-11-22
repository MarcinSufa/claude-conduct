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
- A `check` has exactly one of a non-empty string-array `argv` or string `command`; commands run through the platform shell. Its timeout defaults to 600 seconds. A check can have `onFail: { "retry": "earlier-step-id", "max": 2, "retryOn": [1] }`. `max` is the number of retries, and omitted `retryOn` retries any non-zero exit. The retry prompt is the original prompt plus only the latest check result section and the last 4000 combined output characters.
- A `gate` may have a prompt. It pauses the workflow unless resumed with approval; gates are the only pause point.

## Models and swaps

Built-in model entries are merged with `models` in the workflow; a workflow entry replaces that name's built-in entry entirely. An entry has `argv`, optional `stdin` (`prompt` or `none`), and optional `effort`. `{cwd}`, `{effort}`, and `{promptFile}` are replaced in each argv item; `{promptFile}` is always available. The prompt file is written even when stdin is `none`.

| Name | Command | Default effort | Prompt input |
| --- | --- | --- | --- |
| `luna` | `codex exec -m gpt-6-luna -c model_reasoning_effort={effort} --skip-git-repo-check --sandbox workspace-write -C {cwd} -` | high | stdin |
| `opus` | `claude -p --model opus --effort {effort} --permission-mode bypassPermissions --output-format text` | medium | stdin |
| `grok` | `grok -m grok-4.6 --prompt-file {promptFile} --cwd {cwd} --reasoning-effort {effort} --permission-mode bypassPermissions --max-turns 80 --output-format plain` | high | prompt file |

Effort precedence is step, model entry, then `medium`. The default swap order is `luna`, `opus`, `grok`; Sol is not a swap-in. On Windows, Grok resolves to `%USERPROFILE%\.grok\bin\grok.exe` when present. A timed-out agent or a non-zero agent output matching a usage, rate, quota, payment, billing, spending, credit, or exceeded-limit message swaps to the next model after the current model in `swapOrder` and retries immediately. The swap persists for the step. A model outside the order or at its end cannot swap; the run ends `no-model`.

## Running, gate, and resume

```text
node skills/conduct/scripts/step-runner.mjs workflow.json [--repo DIR | --cwd DIR] [--from GATE --approved "who: text"] [--log FILE]
```

`--repo` creates a detached worktree at `<os.tmpdir()>/conduct-runs/<runId>` from the repo's `HEAD`, runs steps there, and keeps it. `--cwd` uses the given directory without a worktree; by default the current directory is used. `CONDUCT_RUN_ID` supplies the run ID; otherwise the runner generates a UUID. Each child inherits it. A gate returns its `step` and complete `resume` command; rerun with `--from <gate-id> --approved "<who: text>"` to record approval and continue after that gate.

Each step has a hard timeout. Timeout records exit 124 and outcome `timeout`. On POSIX the child runs in its own process group, which the runner kills after the step, including on success. On Windows, timeout uses `taskkill /pid <pid> /T /F`. Windows can only kill descendants while the root process is alive; a root that exits after leaving descendants can outlive cleanup. Windows Job Objects are the upgrade path.

## Log and exit codes

The default NDJSON log is `<homeRoot()>/runs/<runId>/run.ndjson`; `--log` overrides it. Each event has `event`, `ts`, and `runId`. Events are `start` (`workflow`, `cwd`, optional `worktree`), `attempt` (`step`, `type`, `n`, optional `model`/`effort`, `exit`, `outcome`, `ms`), `swap` (`step`, `from`, `to`, `reason`), `retry` (`check`, `n`, `to`), `approval` (`step`, `approved`), and `end` (`status`, optional `message`/`failedStep`, `runs`, `ms`). Each step attempt also writes combined stdout and stderr to `<runDir>/<step>-<attempt>.log`. The CLI prints one JSON result line with the end fields plus `runId` and `worktree`.

| Exit | Meaning |
| --- | --- |
| 0 | success |
| 1 | failed, exhausted, no-model, or check-tampered |
| 2 | invalid workflow or arguments |
| 3 | stopped at a gate |

Before each agent attempt, the runner hashes check executables it can resolve from `argv[0]`. A changed or missing-afterward executable ends the run as `check-tampered`; command-string checks are not hashed.

## Dispatch guard

`dispatch-guard.mjs` is an optional PreToolUse hook for Bash. It denies codex/grok dispatch outside a step-runner run, and denies dispatch from subagents. It is not installed by the runner or this repository change. To enable it by hand, add a `PreToolUse` hook with a `Bash` matcher in your `settings.json`, for example:

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Bash",
      "hooks": [{
        "type": "command",
        "command": "node /absolute/path/to/skills/conduct/scripts/dispatch-guard.mjs"
      }]
    }]
  }
}
```

The hook parses shell commands using the conductor guard's shell parser and prefix handling. Keep `CONDUCT_RUN_ID` in the hook process environment for permitted in-run dispatch. A `CONDUCT_RUN_ID=...` assignment written inside a Bash command does not enable it.
