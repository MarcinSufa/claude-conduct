# Conductor guard

(opt-in)

The Iron Rule ("the conductor never implements") is a prompt rule in `SKILL.md`. Starting the conductor through
`scripts/conductor.sh` turns it into a structural rule: the session gets `skills/conduct/settings/conductor-settings.json`,
whose PreToolUse hook (`skills/conduct/scripts/conductor-guard.mjs`, Node, no dependencies) blocks the main thread from
writing code. Subagents stay unguarded, because Claude subagents are the workers.

```bash
scripts/conductor.sh                               # interactive; every claude argument passes through
scripts/conductor.sh --model claude-opus-5-5 -n conductor-x
CONDUCT_BRIEF_DIR=~/notes/briefs scripts/conductor.sh   # extra artifact dirs (path-delimiter separated)
```

Without the launcher: `CONDUCT_SKILL_DIR=<repo>/skills/conduct claude --settings <repo>/skills/conduct/settings/conductor-settings.json`.
If `CONDUCT_SKILL_DIR` is unset the hook looks in `~/.claude/skills/conduct`; if the guard script is missing there,
every write-capable tool call fails (exit 2) instead of silently running unguarded.

**What the main thread may still do:** read anything; write `.md/.txt/.json/.jsonl/.ndjson/.patch/.diff/.log` under
`.conduct/`, the OS temp dir and `$CONDUCT_BRIEF_DIR`; write `.md/.txt` under any `briefs/`, `specs/`, `plans/` or `docs/`
directory, `~/.claude/plans/` and Claude's memory dirs; run git orchestration (worktree, merge, commit without `-a`);
run the gate and repo scripts; dispatch workers (`codex exec`, `grok`, `cursor-agent`, worker scripts, Agent/Task subagents).

**What it blocks:** Edit/Write/MultiEdit/NotebookEdit outside that allowlist, and Bash that writes files: `>`/`>>`/`&>`
redirects to non-artifacts, `tee`, `sed -i`, `perl -i`/`ruby -i`, `cp`/`mv`/`install`/`ln`/`rsync` into the tree,
`rm`/`truncate`/`touch`/`dd of=`, `git apply`/`git am`/`patch`/`git commit -a`, formatters in write mode
(`prettier --write`, `eslint --fix`, `black`...), `curl -o`/`wget`, `find -delete`/`-exec`, inline interpreter code
that writes or spawns (`python -c`, `node -e`, heredocs), code piped into an interpreter, running a file the conductor
can write (`bash .conduct/x.md`), and the same inside `bash -c`, `eval`, `$(...)`, backticks, `xargs`, `sudo`, `env`.
The block message tells the model to write a brief and dispatch a worker.

**Subagents:** Claude Code sets `agent_id` in hook input only inside a subagent (`agent_type` alone marks the main
thread of an `--agent` session, which stays guarded). The guard passes any call with `agent_id`. This is also why
the settings carry no `permissions.deny`: deny rules bind subagents too (verified on 2.1.292: a denied `Edit` is
"disabled for this session, in subagents as well as here"), which would disarm the Claude workers.

**Known escapes (the Bash part is a heuristic, not a sandbox):** running a script or package task that writes
(`npm run fix`, `make`, `node tools/gen.mjs`); `git checkout/restore/reset/stash/merge` rewriting files; `sed`'s `w`
command; obfuscated inline code (`node -e "require('f'+'s')..."` beats the pattern list); symlinks out of `.conduct/`;
variables in paths are treated as unknown (blocked, not resolved); a subagent the conductor spawns can write anything,
by design. The guard narrows the easy path; the review legs and the ledger still catch the rest.

**Modes (`CONDUCT_GUARD`, read from the environment of the claude process, so the model cannot flip it):**

| `CONDUCT_GUARD` | Effect |
| --- | --- |
| unset or `shadow` | **default** - blocks nothing, appends each would-be denial to the shadow log |
| `enforce` or `on` | blocks (the deny message tells the model to brief and dispatch a worker) |
| `off` | guard disabled |

> Shadow is the default. To enforce the guard, set `CONDUCT_GUARD=enforce` for a launch, or change
> `DEFAULT_MODE` in `skills/conduct/scripts/conductor-guard.mjs` from `"shadow"` to `"enforce"`.
> Unknown values fall back to the default.

Starting plain `claude` also turns it off: the guard exists only in sessions started with this settings file.

**Shadow log:** `~/.conduct/conductor-guard-shadow.ndjson` (`$CONDUCT_HOME/conductor-guard-shadow.ndjson` when
`CONDUCT_HOME` is set). `EXOLOOP_HOME` is a legacy fallback for an optional external runner. One JSON object per line, one
line per call the guard would have blocked:

```json
{"ts":"2026-11-02T10:00:00.000Z","sessionId":"<claude session id>","cwd":"/path/to/repo","tool":"Edit","input":"src/a.ts","reason":"Edit on src/a.ts - not a conductor artifact"}
```

`input` is the file path for edit tools and the first 300 characters of the command for Bash. Review it with:

```bash
node -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").filter(Boolean).map(JSON.parse);const by=k=>Object.entries(l.reduce((a,x)=>(a[x[k]]=(a[x[k]]||0)+1,a),{})).sort((a,b)=>b[1]-a[1]);console.log("would-block:",l.length,"sessions:",new Set(l.map(x=>x.sessionId)).size);console.log("by tool:",by("tool"));console.log("by reason:",by("reason").slice(0,20))' ~/.conduct/conductor-guard-shadow.ndjson
```

Look for false positives in `by reason` (writes the conductor should be allowed to make) before switching to enforce.
