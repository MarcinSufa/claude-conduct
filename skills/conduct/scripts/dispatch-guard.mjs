#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseShell, stripPrefixes } from "./conductor-guard.mjs";

const mentionsDispatch = (s) => /\b(?:codex|grok)\b/i.test(s);
const normalized = (s) => path.basename(s ?? "").toLowerCase().replace(/\.(?:exe|cmd)$/i, "");
const exemptions = new Set(["--version", "-V", "--help", "-h", "help"]);

function isExempt(name, args) {
  if (args.length === 1 && exemptions.has(args[0])) return true;
  if ((args[0] === "login" || args[0] === "logout") && name !== "") return true;
  return name === "grok" && args[0] === "models";
}

function inspect(command, depth = 0) {
  if (depth > 3) return true;
  let commands;
  try { commands = parseShell(command); }
  catch { return mentionsDispatch(command); }
  for (const parsed of commands) {
    const words = stripPrefixes(parsed.words);
    if (!words.length) continue;
    let name = normalized(words[0]), args = words.slice(1);
    if (/^@openai\/codex(?:@.*)?$/i.test(words[0])) name = "codex";
    if (name === "npx" || name === "bunx") {
      const packageName = args.find((x) => x === "codex" || /^@openai\/codex(?:@.*)?$/i.test(x));
      if (packageName) { name = "codex"; args = args.slice(args.indexOf(packageName) + 1); }
    }
    if (name === "pnpm" && args[0] === "dlx") {
      const packageName = args.slice(1).find((x) => x === "codex" || /^@openai\/codex(?:@.*)?$/i.test(x));
      if (packageName) { name = "codex"; args = args.slice(args.indexOf(packageName) + 1); }
    }
    if (name === "codex" || name === "grok") {
      if (!isExempt(name, args)) return true;
      continue;
    }
    if (["bash", "sh", "zsh", "dash"].includes(name)) {
      for (let i = 0; i < args.length; i++) if (args[i] === "-c") {
        if (i + 1 >= args.length || inspect(args[i + 1], depth + 1)) return true;
        break;
      }
      continue;
    }
    const inlineFlags = { node: ["-e", "--eval", "-p", "--print"], nodejs: ["-e", "--eval", "-p", "--print"], bun: ["-e", "--eval", "-p", "--print"], perl: ["-e", "-E"], ruby: ["-e"], php: ["-r"] };
    const flags = inlineFlags[name] ?? (/^python[\d.]*$/.test(name) ? ["-c"] : null);
    if (flags) for (let i = 0; i < args.length; i++) {
      if (flags.includes(args[i])) { if (mentionsDispatch(args[i + 1] ?? "")) return true; i++; }
      else if (args[i].startsWith("-")) continue;
      else break;
    }
  }
  return false;
}

export function shouldDeny(payload, env = process.env) {
  if (payload?.agent_id) return true;
  if (env.CONDUCT_RUN_ID) return false;
  if (payload?.tool_name !== "Bash") return false;
  const raw = String(payload.tool_input?.command ?? "");
  return inspect(raw);
}

const DENY = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "dispatch-guard: codex/grok dispatch outside a step-runner run (CONDUCT_RUN_ID unset); start it through step-runner.mjs" } };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let payload;
  try { payload = JSON.parse(readFileSync(0, "utf8")); }
  catch (err) {
    process.stderr.write(`dispatch-guard: unreadable hook input (${err.message}); blocking to stay safe\n`);
    process.exit(2);
  }
  if (shouldDeny(payload)) process.stdout.write(JSON.stringify(DENY) + "\n");
}
