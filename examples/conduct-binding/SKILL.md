---
name: conduct-binding
description: Example environment binding to copy and edit for your own memory tools and repository rules.
---

# Example conduct environment binding

Copy this file to `~/.claude/skills/conduct-binding/SKILL.md` and edit the placeholders for your environment. Load it after `/conduct` when you use an external memory sink.

## Memory sink

- The decision sink is any available memory tool whose name begins with `mcp__<your-memory-server>__*`. Load that tool's schema before calling it. If the tools are unavailable, keep the decision in the repository's `.conduct/` artifacts.
- **Write first:** after the opinion and fusion stages settle a decision, save it to the sink before dispatching implementation. Follow `skills/conduct/references/decision-persistence.md`: persist the Decision, Divergence, and Discarded fields in one record per decision. Include the question, inputs, decision, divergence, and rejected options; link a superseding record to the old one.
- **Read first:** search the sink for an earlier decision on the same question before starting a new opinion stage. If a decision is overturned, save a new record that points to the superseded one.
- **Vault choice:** use the personal vault for personal repositories. For client repositories, keep client architecture decisions in that repository's `.conduct/` artifacts or an approved client sink. Do not put client decisions in a personal vault.
- **Ledger row rides the close memory:** include the slice's `.conduct/ledger.md` row verbatim in its close memory. Apply the same personal versus client sink choice as above.
- A sink write failure does not block the slice. Keep the `.conduct/` copy and continue.

## Credentials

Keep credentials out of this binding. Store keys, tokens, vault identifiers, and connection strings in the tool's approved configuration, not in skill text.
