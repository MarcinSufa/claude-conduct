# Codex (GPT Luna / Sol) worker contract

Read this before dispatching a Luna or Sol leg (`codex exec`), for either implementation or review.

- Model: **always pass `-m` explicitly** with the Luna id for execute/check legs and the Sol id
  for decision-grade legs, both taken from the routing table. `~/.codex/config.toml` is GLOBAL and
  its default can change under you; never rely on a bare `codex exec`. Subscription auth (ChatGPT
  login) only, **never set `OPENAI_API_KEY`**. If a model id errors, report to the operator instead
  of silently falling back.
- Dispatch headless: `codex exec -m <model> "<prompt>" < /dev/null` with cwd = the task/slice worktree.
  **Stdin MUST be closed** or the run hangs on "Reading additional input from stdin...".
  **Never spawn codex from an Electron main process or any long-lived app** - documented native
  spawn-crash history on this machine; shell only.
- Feed it the same task-brief file the Claude workers use. Capture BOTH: the verdict with
  `--output-last-message .conduct/<vendor>-<slice>.md` (read it whole) AND the event stream with
  `--json > .conduct/<vendor>-<slice>.jsonl` (never read it as the verdict; conduct-events parses
  it for usage, program 2 for spans). Both flags together are verified on codex 0.144 (still listed
  in `codex exec --help` on 0.159.2).
- **Luna per-token API route: RETIRED.** Do not pass `-p luna-api`.
  Run every Luna leg on the ChatGPT subscription: `codex exec -m gpt-6-luna -c model_reasoning_effort=high
  --skip-git-repo-check --sandbox read-only --output-last-message .conduct/luna-<slice>.md "<prompt>" < /dev/null`.
  Effort is selectable on the subscription too. A "Quota exceeded" from the old API profile says nothing
  about the subscription limit.
- **Running vitest inside the Windows sandbox (verified 2026-09-25, codex 0.155.1, vitest 4.0.18 /
  vite 7.3.1; still true 2026-10-26 on codex 0.162.1, where the run hangs after the error instead
  of exiting):** under `-s workspace-write` with `[windows] sandbox = "unelevated"`, every spawn
  with stdio pipes fails `spawn EPERM` (esbuild service, vite's `net use` probe, vitest fork pool);
  `network_access=true` does not help, and `elevated` fails its ACL refresh without admin. Tell the
  leg to run `node ~/.codex/tools/vitest-sandbox/vitest.mjs run <filter>` from the
  package dir instead of `npx vitest`: it swaps esbuild for in-process esbuild-wasm, turns the sync
  `net use` throw into a callback error, and adds `--pool=threads --configLoader runner`. Proof: Luna
  reported the same `13 failed | 67 passed (80)` as an unsandboxed run, identical failing tests.
  `~/.codex/AGENTS.md` carries the same rule, so a Luna leg finds the wrapper unprompted (verified
  in a sample-memory root with jsdom + react plugin: `180 passed (180)`, same as unsandboxed). Do not write "your
  sandbox cannot run vitest" into briefs any more. Configs using `__dirname` get cwd, so run from
  the directory holding the vitest config. Limits: `build`-based paths (plugins needing fs, dep optimizer) and pool forks still cannot run;
  esbuild-wasm is pinned to 0.27.3, so bump it in that folder if a repo's vite ships another esbuild.
  Windows only: on Linux (codex 0.156.1) plain `vitest run` passes inside
  `codex sandbox -P :workspace` with the default fork pool, so legs there need no wrapper.
- Trusted for implementation legs, not just review: an adversarial review found 4 FATAL + 6 MAJOR
  findings that three Claude legs missed.
- Its findings come back as **text for you to adjudicate** - one review leg, not gospel.
- Any **code** codex writes gets the same per-task review as a Claude worker's code.
