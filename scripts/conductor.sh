#!/usr/bin/env bash
# Starts Claude Code as a conduct conductor: the session gets settings/conductor-settings.json, whose
# PreToolUse hook (conductor-guard.mjs) blocks the main thread from writing code. Subagents stay unguarded.
# Usage: scripts/conductor.sh [any claude arguments...]   e.g. scripts/conductor.sh --model claude-opus-5-5
# Env: CONDUCT_BRIEF_DIR adds artifact dirs; CONDUCT_GUARD=shadow (default) only logs would-be denials,
# CONDUCT_GUARD=enforce blocks, CONDUCT_GUARD=off disables the guard (see docs/conductor-guard.md).
set -euo pipefail
f=$0
while [ -L "$f" ]; do
  d=$(dirname "$f")
  f=$(readlink "$f")
  case $f in /*) ;; *) f="$d/$f" ;; esac
done
SKILL_DIR=$(cd "$(dirname "$f")/../skills/conduct" && pwd -P)
export CONDUCT_SKILL_DIR="$SKILL_DIR"
exec claude --settings "$SKILL_DIR/settings/conductor-settings.json" "$@"
