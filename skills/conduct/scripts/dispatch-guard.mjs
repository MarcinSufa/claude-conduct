#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseShell, stripPrefixes } from "./conductor-guard.mjs";

const mentionsDispatch = (s) => /\b(?:codex|grok)\b/i.test(s);
const normalized = (s) => path.basename(s ?? "").toLowerCase().replace(/\.(?:exe|cmd)$/i, "");
const exemptions = new Set(["--version", "-V", "--help", "-h", "help"]);
const RUNS_COMMAND = new Set(["jobq", "pueue", "npm", "bun", "watch", "ssh", "parallel", "script", "time", "strace", "systemd-run", "tmux", "screen", "su", "runuser", "setpriv", "taskset", "chrt"]);
const READERS = new Set(["grep", "egrep", "fgrep", "rg", "ag", "which", "type", "ls", "cat", "head", "tail", "less", "more", "wc", "git", "echo", "printf"]);

function isExempt(name, args) {
  if (args.length === 1 && exemptions.has(args[0])) return true;
  if ((args[0] === "login" || args[0] === "logout") && name !== "") return true;
  return name === "grok" && args[0] === "models";
}

// ponytail: Scripts on disk and interpreter code read from files or stdin are invisible to this hook; only inline -c/-e code is inspected. Aliases and shell functions are invisible too; upgrade path is a codex/grok wrapper first in PATH that checks CONDUCT_RUN_ID.
function inspect(command, depth = 0) {
  if (depth > 3) return true;
  let commands;
  try { commands = parseShell(command); }
  catch { return mentionsDispatch(command); }
  const vars = new Map();
  for (const parsed of commands) {
    const words = parsed.words;
    let i = 0;
    while (i < words.length) {
      const assignment = /^([A-Za-z_]\w*)=(.*)$/s.exec(words[i]);
      if (!assignment) break;
      vars.set(assignment[1], assignment[2]);
      i++;
    }
    if (["export", "declare", "local", "readonly", "typeset"].includes(words[i])) {
      for (const word of words.slice(i + 1)) {
        if (word.startsWith("-")) continue;
        const assignment = /^([A-Za-z_]\w*)=(.*)$/s.exec(word);
        if (assignment) vars.set(assignment[1], assignment[2]);
      }
    }
  }
  for (const parsed of commands) if (inspectWords(parsed.words, depth, command, vars, parsed.stdin, commands)) return true;
  return false;
}

function inspectWords(inputWords, depth, raw = "", vars = new Map(), stdin = [], commands = []) {
  if (depth > 3) return true;
  let words = inputWords;
  if (!words.length) return false;
  if (normalized(words[0]) === "command" && ["-v", "-V"].includes(words[1])) return false;
  words = stripPrefixes(words);
  if (!words.length) return false;
  if (/^(?:\$|`)/.test(words[0])) {
    const expanded = expandWord(words[0], vars);
    if (expanded.substitution) return commands.some((parsed) => {
      if (["for", "select", "case"].includes(normalized(parsed.words[0]))) return false;
      const commandWords = stripPrefixes(parsed.words);
      const name = normalized(commandWords[0]);
      if ((name === "codex" || name === "grok") && isExempt(name, commandWords.slice(1))) return false;
      return parsed.words.some((part) => ["codex", "grok"].includes(normalized(part)));
    });
    if (!expanded.unknown) {
      const expandedWords = expanded.value.split(/\s+/).filter(Boolean);
      return inspectWords([...expandedWords, ...words.slice(1)], depth + 1, raw, vars, stdin, commands);
    }
    return false;
  }
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
  if (name === "npm" && ["exec", "x"].includes(args[0])) {
    args = args.slice(args[0] === "exec" && args[1] === "--" ? 2 : 1);
    const delimiter = args.indexOf("--");
    if (delimiter >= 0) args.splice(delimiter, 1);
    name = "runner";
  }
  if (name === "bun" && args[0] === "x") { args = args.slice(1); name = "runner"; }
  if (name === "pueue" && args[0] === "add") { const d = args.indexOf("--"); if (d >= 0) { args = args.slice(d + 1); name = "runner"; } }
  if (name === "runner") return inspectWords(args, depth, raw, vars, stdin, commands);
  if (name === "codex" || name === "grok") return !isExempt(name, args);
  if (READERS.has(name) || (name === "jobq" && args[0] !== "add")) return false;
  if (name === "eval") return inspect(expand(args.join(" "), vars), depth + 1);
  if (name === "find") {
    for (let i = 0; i < args.length; i++) {
      if (!["-exec", "-execdir", "-ok", "-okdir"].includes(args[i])) continue;
      let end = i + 1;
      while (end < args.length && args[end] !== ";" && args[end] !== "+") end++;
      if (inspectWords(args.slice(i + 1, end), depth, raw, vars, [], commands)) return true;
      i = end;
    }
    return false;
  }
  if (["bash", "sh", "zsh", "dash"].includes(name)) {
    for (let i = 0; i < args.length; i++) if (args[i] === "-c" || (args[i].startsWith("-") && !args[i].startsWith("--") && args[i].length > 2 && args[i].endsWith("c"))) {
      if (i + 1 >= args.length || inspect(expand(args[i + 1], vars), depth + 1)) return true;
      return false;
    }
    let hasScript = false, readStdin = false;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--") { hasScript = i + 1 < args.length; break; }
      if (arg === "-s" || (arg.startsWith("-") && !arg.startsWith("--") && arg.slice(1).includes("s"))) { readStdin = true; continue; }
      if (arg === "-o" || arg === "-O") { i++; continue; }
      if (arg.startsWith("-")) continue;
      hasScript = arg !== "-";
      break;
    }
    if (readStdin) hasScript = false;
    return !hasScript && (stdin.some(mentionsDispatch) || mentionsDispatch(raw));
  }
  const inlineFlags = { node: ["-e", "--eval", "-p", "--print"], nodejs: ["-e", "--eval", "-p", "--print"], bun: ["-e", "--eval", "-p", "--print"], perl: ["-e", "-E"], ruby: ["-e"], php: ["-r"] };
  const flags = inlineFlags[name] ?? (/^python[\d.]*$/.test(name) ? ["-c"] : null);
  if (flags) for (let i = 0; i < args.length; i++) {
    if (flags.includes(args[i]) || (args[i].startsWith("-") && !args[i].startsWith("--") && args[i].length > 2 && flags.some((f) => f.length === 2 && args[i].endsWith(f[1])))) { if (mentionsDispatch(args[i + 1] ?? "")) return true; i++; }
    else if (args[i].startsWith("-")) continue;
    else break;
  }
  const variable = /^\$\{?(\w+)\}?$/.exec(words[0]);
  if (variable) {
    const value = vars.get(variable[1]);
    return value !== undefined ? inspectWords([...value.split(/\s+/).filter(Boolean), ...args], depth + 1, raw, vars, stdin, commands) : false;
  }
  if (!RUNS_COMMAND.has(name)) return false;
  const dashDash = words.indexOf("--", 1);
  if (dashDash > 0 && inspectWords(words.slice(dashDash + 1), depth, raw, vars, [], commands)) return true;
  for (let i = 1; i < words.length; i++) {
    const laterName = normalized(words[i]);
    if (laterName === "codex" || laterName === "grok") return inspectWords(words.slice(i), depth, raw, vars, [], commands);
    if (/\s/.test(words[i]) && inspect(words[i], depth + 1)) return true;
  }
  return false;
}

function expand(code, vars) {
  return expandWord(code, vars).value;
}

function expandWord(word, vars) {
  let unknown = false;
  const value = word.replace(/\$([A-Za-z_]\w*)|\$\{([A-Za-z_]\w*)(?::-(.*?))?\}/g, (match, short, long, fallback) => {
    const name = short ?? long;
    if (vars.has(name)) {
      const value = vars.get(name);
      return long && fallback !== undefined && value === "" ? fallback : value;
    }
    if (long && fallback !== undefined) return fallback;
    unknown = true;
    return match;
  });
  const substitution = /^(?:\$\(|`)/.test(value);
  if (!substitution && value === word) unknown = true;
  return { value, unknown, substitution };
}

export function shouldDeny(payload, env = process.env) {
  if (!["Bash", "Monitor"].includes(payload?.tool_name)) return false;
  if (env.CONDUCT_RUN_ID && !payload?.agent_id) return false;
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
