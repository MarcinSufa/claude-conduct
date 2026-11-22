<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/hero-dark.png">
    <img src="docs/assets/hero-light.png" width="880" alt="conduct, a Claude Code skill: one model plans, other vendors build. A 3D stage of cute robots shows an example team, left to right. Opus 5.5, the conductor in a necktie, stands at a podium and points as BRIEF sheets fly to GPT Luna, the worker typing the diff on a typewriter. The lane forks forward to four dim, translucent robots labelled DeepSeek, GLM, OpenRouter and any CLI: optional workers, plug in. The DIFF sheets reach Grok, the reviewer, who holds a sheet in one hand and a hand-held magnifying glass in the other, and a dashed FINDINGS lane returns from Grok to Opus. Next comes a GATE written first by Grok, a sign with a green check and an open barrier, and at the end You, a person, holds the HAND-OFF folder.">
  </picture>
</p>

<p align="center">
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <img alt="Claude Code skill" src="https://img.shields.io/badge/Claude_Code-skill-6f42c1.svg">
  <img alt="Status: usable" src="https://img.shields.io/badge/status-usable-brightgreen.svg">
</p>

**A multi-vendor workflow for software changes, with a human in control.**

Conduct keeps planning, implementation, acceptance checks, and review independent. A conductor turns a task into a brief and coordinates vendor tools. Workers make changes in worktrees; the operator decides what to merge.

[What it is](#what-it-is) · [Install](#install) · [How it works](#how-it-works) · [The binding](#the-binding) · [Requirements](#requirements) · [Guard and watchdog](#conductor-guard-and-progress-watchdog) · [Security](#security) · [License](#license)

| Conductor | Gate | Worker |
| --- | --- | --- |
| Never implements | Written by a vendor other than the implementer | Builds in an isolated worktree |

The optional progress watchdog defaults to a `0.5` USD daily budget, configurable with `CONDUCT_WATCHDOG_DAILY_USD`.

## What it is

Conduct is a Claude Code skill for coordinating multi-model software work. It separates the conductor, who briefs and adjudicates, from workers, who implement. Independent vendor opinions inform non-trivial decisions, a vendor other than the implementer authors the gate before implementation, and cross-vendor review checks the finished patch.

The repo contains the portable `/conduct` skill, its helper scripts, test fixtures, and this documentation. Environment-specific memory rules belong in a separate binding.

## Install

Clone this repository and enter its directory:

```sh
git clone https://github.com/MarcinSufa/claude-conduct
cd claude-conduct
```

Then copy the skill into Claude Code's skill directory:

```sh
node scripts/install.mjs
```

For a live install on macOS or Linux, create a symbolic link:

```sh
mkdir -p "$HOME/.claude/skills"
ln -s "$PWD/skills/conduct" "$HOME/.claude/skills/conduct"
```

On Windows, create a directory junction:

```cmd
mkdir "%USERPROFILE%\.claude\skills" 2>nul
mklink /J "%USERPROFILE%\.claude\skills\conduct" "%CD%\skills\conduct"
```

The binding is optional. To configure a memory sink for your environment, copy and edit the example:

```sh
cp -R examples/conduct-binding "$HOME/.claude/skills/conduct-binding"
```

Edit `~/.claude/skills/conduct-binding/SKILL.md` for your tools. The example is outside `skills/` because the installer copies every directory in `skills/`.

## Try it

In Claude Code, type:

```text
/conduct add input validation to the signup form
```

Conduct turns the request into a brief and gathers independent opinions for non-trivial choices.
It writes an acceptance gate before implementation, then dispatches a worker to build in a worktree.
The worker runs against the gate; an independent vendor reviews the patch.
You review the result and decide whether to merge it.

## step-runner and exoloop

Exoloop is the separate multi-task runner backed by ExoVault; it is unchanged.
Step-runner runs one task's step loop, such as a conduct slice or `@start` stage 3.
Dispatch-guard keeps codex and grok dispatch inside a step-runner run.
See the [step-runner guide](docs/step-runner.md) for workflows and setup.

## How it works

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/how-it-works-dark.png">
    <img src="docs/assets/how-it-works-light.png" width="880" alt="One slice in ten steps, with an example team where any vendor can take a role. Top row: 01 Brief and 02 Worktree by Opus 5.5 as conductor, 03 independent opinions from GPT Luna and Grok, 04 Fuse by Opus into one decision, 05 Gate, a test Grok writes first and sees fail. Bottom row: 06 Build by GPT Luna in the worktree until the gate is green, 07 cross-vendor Review of the diff by Grok, 08 Adjudicate by Opus, which sends fixes back to Build, 09 Hand off by Opus after a whole-branch review, 10 Close with ledger, preflight and teardown while you merge. Trivial slices may skip steps 03 to 05 and record the skip.">
  </picture>
</p>

The full loop has ten steps:

1. **Brief** the task, scope, open choices, and desired outcome.
2. **Create a worktree** for the slice.
3. **Gather opinions** from two vendors for non-trivial decisions, after checking memory for prior decisions when a sink is configured.
4. **Fuse** the opinions, capture divergence, settle the plan, and persist the decision when a sink is configured.
5. **Write the gate** with a vendor other than the implementer, before code exists.
6. **Implement** through a worker in the worktree; run the gate to green.
7. **Review** the patch with task-level and cross-vendor review.
8. **Adjudicate** findings and route any fixes to a worker.
9. **Hand off** the reviewed result and rule-to-choice notes to the operator.
10. **Close** with a ledger row, preflight, and teardown; the operator merges.

The skill defines a documented escape hatch for trivial or mechanical slices and requires recording any skipped opinion, fusion, or gate step.

## The binding

The doctrine in `/conduct` is portable. A binding supplies only environment-specific choices, such as which memory tools form the decision sink and how personal and client repositories store decisions. Keeping these separate lets the skill install without overwriting a reader's own environment configuration. See the [example binding](examples/conduct-binding/SKILL.md).

## Requirements

- Claude Code is required to load and use the skill.
- Node.js is required for the helper scripts and tests.
- Minimal setup is Claude Code with Claude subagents as workers. Cross-vendor review still requires another vendor: [the skill says](skills/conduct/SKILL.md#cross-vendor-independence-rule), "Claude-on-Claude does not satisfy independence," and the close preflight requires review coverage with no skip accepted.
- Codex, Grok, and other CLIs can provide the required cross-vendor legs.
- Git worktrees are used to isolate implementation slices.

## Conductor guard and progress watchdog

The optional [conductor guard](docs/conductor-guard.md) adds a hook that can block the main session from writing implementation code. Its default mode is shadow, which records would-be blocks without blocking. Use it with the documented limits in mind: the Bash checks are heuristic, not a sandbox.

The optional [progress watchdog](docs/progress-watchdog.md) evaluates a worker transcript for progress, stalls, loops, and drift. Shadow mode records a verdict without taking action. It can be wired into an existing time-based worker monitor; that integration is outside this repository.

## Security

Keep credentials out of skill files and bindings. Store vendor keys, tokens, vault identifiers, and connection strings in approved tool configuration. Report security issues through GitHub's private vulnerability reporting for this repository.

## License

Conduct is released under the [MIT License](LICENSE).
