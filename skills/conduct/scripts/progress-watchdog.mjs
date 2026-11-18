#!/usr/bin/env node
// Progress watchdog: judges whether a worker is making progress toward its goal, not just whether it is alive.
// Optional external time-based monitors see silence and counters;
// this one reads the worker transcript (Claude Code session jsonl or `codex exec --json`) and returns
//   { verdict: progressing|stalled|looping|drifting|unknown, confidence 0-100, reason, suggested_action }.
//
// - Fast path, no model: the same error over and over, the same command with the same output, one file edited
//   again and again without a test run, no tool calls at all. Strong signals decide; weak ones go to the model as hints.
// - Slow path: a cheap model (default claude-haiku-4-5 through `claude -p`, no user settings, no tools) judges the
//   window against the goal. A reply that is not the expected JSON is `unknown`, never an exception.
// - Each window is hashed; a window already judged is not judged (or logged) again.
// - Daily USD cap (CONDUCT_WATCHDOG_DAILY_USD, default 0.5); once spent, verdicts are `unknown` until tomorrow (UTC).
//
// CONDUCT_WATCHDOG picks the mode:
//   unset/shadow - append the verdict to <dir>/shadow.jsonl and print it; nothing else
//   act          - shadow, plus a {"notify": ...} line on stdout for a non-progressing verdict; the caller delivers it
//   off          - do nothing
// <dir> is $CONDUCT_WATCHDOG_DIR, else ~/.conduct/progress-watchdog (CONDUCT_HOME overrides this location). See docs/progress-watchdog.md.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { homeRoot } from "./lib/events-store.mjs";

export const DEFAULT_MODE = "shadow";
const MODES = { shadow: "shadow", act: "act", off: "off" };
export const watchdogMode = (env = process.env) => MODES[String(env.CONDUCT_WATCHDOG ?? "").trim().toLowerCase()] ?? DEFAULT_MODE;
export const stateDir = (env = process.env) => env.CONDUCT_WATCHDOG_DIR || path.join(homeRoot(), "progress-watchdog");

export const VERDICTS = ["progressing", "stalled", "looping", "drifting"];
export const DEFAULTS = { tools: 30, messages: 6, maxChars: 24_000, errorRepeat: 4, commandRepeat: 4, editChurn: 5, idleMessages: 3,
  model: "claude-haiku-4-5", dailyUsd: 0.5, perCallUsd: 0.05, actMinConfidence: 70 };

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const TEST_RE = /\b(test|tests|pytest|vitest|jest|mocha|tsc|typecheck|cargo (test|check)|go (test|vet)|make check|lint)\b/i;
const WAIT_RE = /\b(sleep|wait|watch|poll|status|checks|ps|pgrep|tail|jobq)\b/i;
const ERROR_LINE_RE = /(error|exception|traceback|fail|cannot|can't|not found|denied|refused|timed? ?out|panic)/i;

const clip = (s, n) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n) + "…" : s; };
const textOf = (content) => typeof content === "string" ? content
  : Array.isArray(content) ? content.map((c) => (typeof c === "string" ? c : c?.text ?? "")).join("\n") : "";

function toolSummary(name, input) {
  input = input && typeof input === "object" ? input : {};
  if (name === "Bash" || name === "PowerShell") return String(input.command ?? "");
  const file = input.file_path ?? input.notebook_path ?? input.path;
  if (file) return String(file);
  if (input.pattern) return String(input.pattern);
  return clip(JSON.stringify(input), 200);
}

// Normalizes one transcript (Claude Code session jsonl, or codex exec --json) into
// [{ kind: "user"|"text"|"tool", tool, input, files, output, error }]. Unparseable lines are skipped.
export function parseTranscript(text) {
  const events = [], byId = new Map();
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line.replace(/^﻿/, "")); } catch { continue; }
    if (!e || typeof e !== "object") continue;
    if (e.type === "item.completed" && e.item) { codexItem(e.item, events); continue; }
    const content = e.message?.content;
    if (e.type === "user") {
      if (typeof content === "string") { if (!e.isMeta) events.push({ kind: "user", text: content }); continue; }
      for (const c of Array.isArray(content) ? content : []) {
        if (c?.type === "tool_result") {
          const ev = byId.get(c.tool_use_id);
          if (ev) { ev.output = textOf(c.content); ev.error = c.is_error === true; }
        } else if (c?.type === "text" && !e.isMeta) events.push({ kind: "user", text: c.text });
      }
    } else if (e.type === "assistant") {
      for (const c of Array.isArray(content) ? content : []) {
        if (c?.type === "text" && c.text?.trim()) events.push({ kind: "text", text: c.text });
        else if (c?.type === "tool_use") {
          const file = c.input?.file_path ?? c.input?.notebook_path;
          const ev = { kind: "tool", tool: c.name, input: toolSummary(c.name, c.input), files: EDIT_TOOLS.has(c.name) && file ? [String(file)] : [], output: "", error: false };
          events.push(ev); byId.set(c.id, ev);
        }
      }
    }
  }
  return events;
}

function codexItem(item, events) {
  if (item.type === "agent_message" && item.text) events.push({ kind: "text", text: item.text });
  else if (item.type === "command_execution") events.push({ kind: "tool", tool: "Bash", input: String(item.command ?? ""), files: [],
    output: String(item.aggregated_output ?? ""), error: typeof item.exit_code === "number" && item.exit_code !== 0 });
  else if (item.type === "file_change") {
    const files = (Array.isArray(item.changes) ? item.changes : []).map((c) => c?.path).filter((f) => typeof f === "string");
    events.push({ kind: "tool", tool: "Edit", input: files.join(", "), files, output: "", error: false });
  }
}

const render = (ev) => ev.kind === "tool"
  ? `[tool ${ev.tool}${ev.error ? " ERROR" : ""}] ${clip(ev.input, 300)}${ev.output ? `\n  -> ${clip(ev.output.trim(), 400).replace(/\n/g, "\n     ")}` : ""}`
  : `[${ev.kind === "user" ? "user" : "assistant"}] ${clip(ev.text, 600)}`;

// The last `tools` tool calls plus the last `messages` assistant messages, oldest first, trimmed to maxChars.
// The goal is opts.goal, else the first user message of the transcript.
export function buildWindow(events, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const goal = (o.goal ?? events.find((e) => e.kind === "user")?.text ?? "").trim();
  const toolIdx = events.map((e, i) => (e.kind === "tool" ? i : -1)).filter((i) => i >= 0).slice(-o.tools);
  const textIdx = events.map((e, i) => (e.kind === "text" ? i : -1)).filter((i) => i >= 0).slice(-o.messages);
  let picked = [...new Set([...toolIdx, ...textIdx])].sort((a, b) => a - b).map((i) => events[i]);
  let text = picked.map(render).join("\n");
  while (text.length > o.maxChars && picked.length > 1) { picked = picked.slice(1); text = picked.map(render).join("\n"); }
  return { goal, events: picked, text: clip(text, o.maxChars), totalEvents: events.length };
}

export const errorSignature = (output) => {
  const lines = String(output ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const line = lines.find((l) => /(error|exception|traceback|panic)/i.test(l)) ?? lines.find((l) => ERROR_LINE_RE.test(l)) ?? lines[0] ?? "";
  return line.replace(/0x[0-9a-f]+/gi, "H").replace(/\d+/g, "N").replace(/\s+/g, " ").toLowerCase().slice(0, 160);
};

// Fast path: { decided, verdict?, confidence?, reason?, signals: [...] }. Decided verdicts skip the model.
export function fastPath(win, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const tools = win.events.filter((e) => e.kind === "tool");
  const signals = [];
  const top = (m) => [...m.entries()].sort((a, b) => b[1] - a[1])[0];

  const errors = new Map();
  for (const t of tools) if (t.error) { const s = errorSignature(t.output); if (s) errors.set(s, (errors.get(s) ?? 0) + 1); }
  const [err, errN = 0] = top(errors) ?? [];
  if (errN >= 2) signals.push({ kind: "repeated_error", count: errN, detail: err, strong: errN >= o.errorRepeat });

  const cmds = new Map();
  for (const t of tools) if (t.tool === "Bash" || t.tool === "PowerShell") { const k = `${t.input}\u0000${t.output.trim()}`; cmds.set(k, (cmds.get(k) ?? 0) + 1); }
  const [cmd, cmdN = 0] = top(cmds) ?? [];
  if (cmdN >= 2) {
    const c = cmd.split("\u0000")[0];
    signals.push({ kind: "repeated_command", count: cmdN, detail: clip(c, 160), waiting: WAIT_RE.test(c), strong: cmdN >= o.commandRepeat });
  }

  const churn = new Map(); let worst = null;
  for (const t of tools) {
    if ((t.tool === "Bash" || t.tool === "PowerShell") && TEST_RE.test(t.input)) { churn.clear(); worst = null; continue; }
    for (const f of t.files) { const n = (churn.get(f) ?? 0) + 1; churn.set(f, n); if (!worst || n > worst.count) worst = { file: f, count: n }; }
  }
  if (worst && worst.count >= o.editChurn) signals.push({ kind: "edit_churn", count: worst.count, detail: worst.file, strong: false });

  const texts = win.events.filter((e) => e.kind === "text").length;
  if (tools.length === 0 && texts >= o.idleMessages) signals.push({ kind: "no_tool_calls", count: texts, detail: "messages without any tool call", strong: false });

  // Same command + same output is the more specific signal (a CI poll also exits non-zero every time).
  const strong = signals.find((s) => s.strong && s.kind === "repeated_command") ?? signals.find((s) => s.strong);
  if (!strong) return { decided: false, signals };
  if (strong.kind === "repeated_command") {
    const verdict = strong.waiting ? "stalled" : "looping";
    return { decided: true, verdict, confidence: 80, signals,
      reason: `the same command with the same output ran ${strong.count} times: ${strong.detail}`,
      suggested_action: verdict === "stalled" ? "check what the worker is waiting for; unblock it or stop polling" : "stop the worker and re-brief it with what it keeps retrying" };
  }
  return { decided: true, verdict: "looping", confidence: 80, signals,
    reason: `the same error ${strong.count} times: ${strong.detail}`,
    suggested_action: "stop retrying the same fix; re-brief the worker with the error and a different hypothesis" };
}

const unknown = (reason, extra = {}) => ({ verdict: "unknown", confidence: 0, reason, suggested_action: "", ...extra });

// Model reply text -> verdict object. Never throws: anything off-schema is `unknown`.
export function parseVerdict(text) {
  const s = String(text ?? "").replace(/```(?:json)?/gi, "");
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return unknown(`unparseable model reply: ${clip(s.trim(), 120)}`);
  let j;
  try { j = JSON.parse(s.slice(a, b + 1)); } catch { return unknown(`unparseable model reply: ${clip(s.trim(), 120)}`); }
  const verdict = String(j?.verdict ?? "").trim().toLowerCase();
  if (!VERDICTS.includes(verdict)) return unknown(`model verdict outside the schema: ${clip(j?.verdict, 40)}`);
  const c = Number(j.confidence);
  return { verdict, confidence: Number.isFinite(c) ? Math.max(0, Math.min(100, Math.round(c))) : 0,
    reason: clip(j.reason ?? "", 500), suggested_action: clip(j.suggested_action ?? "", 300) };
}

export const SYSTEM_PROMPT = [
  "You supervise an autonomous coding worker. Judge whether it is making real progress toward its goal.",
  "Verdicts:",
  "- progressing: each step adds information or moves toward the goal (new findings, errors that change as fixes land, tests going green). Long debugging is fine if it converges.",
  "- stalled: not advancing because it waits on something outside its control: polling CI, a job, a reviewer or a question with the same answer each time, sleeping, idle.",
  "- looping: retrying its own work (edits, fixes, commands it could change) and getting the same failure, with no new information. Polling an external status is stalled, not looping.",
  "- drifting: active, but on work the goal did not ask for.",
  'Reply with ONE JSON object and nothing else: {"verdict":"progressing|stalled|looping|drifting","confidence":0-100,"reason":"one sentence citing the evidence","suggested_action":"one short instruction for the supervisor"}',
].join("\n");

export function judgePrompt(win, signals) {
  return [
    `GOAL:\n${clip(win.goal || "(no goal given; infer it from the transcript)", 2000)}`,
    "",
    `HEURISTIC SIGNALS (hints, may be wrong): ${signals.length ? JSON.stringify(signals.map(({ kind, count, detail }) => ({ kind, count, detail }))) : "none"}`,
    "",
    `LAST ${win.events.length} OF ${win.totalEvents} TRANSCRIPT EVENTS (oldest first):\n${win.text}`,
  ].join("\n");
}

// Default slow path: `claude -p` with no user settings, no tools and its own short system prompt (the default
// Claude Code prompt would cost ~7k input tokens per call); the window goes in on stdin. No shell, so on
// Windows point CONDUCT_WATCHDOG_CLI at claude.exe. Returns { text, costUsd, error? }.
// Run from inside a Claude Code session, the child inherits the parent's session variables and joins its
// context: measured 2026-11-02, a one-line prompt cost 0.27 USD and failed with "Prompt is too long" (~290k
// tokens) instead of 0.00075 USD. --max-budget-usd is checked after a request, so it does not prevent that.
const SESSION_ENV = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_CODE_(CHILD_SESSION|SESSION_.*|MESSAGING_.*|ENTRYPOINT|EXECPATH))$/;
export const judgeEnv = (env) => Object.fromEntries(Object.entries(env).filter(([k]) => !SESSION_ENV.test(k)));

export function claudeJudge(prompt, { model, maxBudgetUsd, env = process.env }) {
  const cli = env.CONDUCT_WATCHDOG_CLI || "claude";
  const args = ["-p", "--model", model, "--output-format", "json", "--setting-sources", "", "--tools", "", "--strict-mcp-config",
    "--disable-slash-commands", "--no-session-persistence", "--system-prompt", SYSTEM_PROMPT, "--max-budget-usd", maxBudgetUsd.toFixed(4)];
  const r = spawnSync(cli, args, { input: prompt, encoding: "utf8", cwd: os.tmpdir(), env: judgeEnv(env), timeout: 180_000, maxBuffer: 16 << 20 });
  if (r.error) return { text: "", costUsd: null, error: r.error.message };
  let out;
  try { out = JSON.parse(r.stdout); } catch { return { text: "", costUsd: null, error: `exit ${r.status}: ${clip((r.stderr || r.stdout).trim(), 200)}` }; }
  if (!out || typeof out !== "object") return { text: "", costUsd: null, error: `unexpected CLI output: ${clip(r.stdout.trim(), 120)}` };
  const costUsd = typeof out.total_cost_usd === "number" ? out.total_cost_usd : null;
  if (out.is_error) return { text: "", costUsd, error: clip(out.result ?? out.subtype ?? "model error", 200) };
  return { text: String(out.result ?? ""), costUsd };
}

// ---------- state: cache and daily spend ----------

const readJson = (file, fallback) => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return fallback; } };
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// Windows can briefly hold the target (EPERM/EBUSY); retry like lib/events-store.mjs does.
function writeJson(file, obj) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj));
  for (let attempt = 1; ; attempt++) {
    try { renameSync(tmp, file); return; } catch (err) {
      if (!["EPERM", "EBUSY", "ENOENT"].includes(err.code) || attempt >= 40) { rmSync(tmp, { force: true }); throw err; }
      sleepSync(Math.min(attempt * 5, 50));
    }
  }
}
const today = (now) => now.toISOString().slice(0, 10);

// Fails closed: a spend.json that exists but cannot be read counts as the whole day spent.
export function spentToday(dir, now = new Date()) {
  let s;
  try { s = JSON.parse(readFileSync(path.join(dir, "spend.json"), "utf8")); } catch (err) { return err.code === "ENOENT" ? 0 : Infinity; }
  const usd = s && typeof s === "object" && typeof s.usd === "number" ? s.usd : NaN;
  if (typeof s?.day !== "string" || !Number.isFinite(usd) || usd < 0) return Infinity;
  return s.day === today(now) ? usd : 0;
}

// Serializes read-modify-write of a state file across concurrent watchdog runs (exclusive lock file, stale after 30 s).
function withLock(dir, name, fn) {
  mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, `${name}.lock`), deadline = Date.now() + 5_000;
  for (;;) {
    try { closeSync(openSync(lock, "wx")); break; } catch (err) {
      if (err.code !== "EEXIST") throw err;
      try { if (Date.now() - statSync(lock).mtimeMs > 30_000) { rmSync(lock, { force: true }); continue; } } catch { continue; }
      if (Date.now() > deadline) return null;
      sleepSync(20);
    }
  }
  try { return fn(); } finally { rmSync(lock, { force: true }); }
}
// Reserves up to perCallUsd of what is left today; returns the reservation, 0 when nothing is left, null when the ledger stays locked.
function reserve(dir, dailyUsd, perCallUsd, now) {
  return withLock(dir, "spend", () => {
    const spent = spentToday(dir, now), left = dailyUsd - spent;
    if (!(left > 0.001)) return 0;
    const r = Math.min(perCallUsd, left);
    writeJson(path.join(dir, "spend.json"), { day: today(now), usd: spent + r });
    return r;
  });
}
// Replaces the reservation with the actual cost (never below zero).
function settle(dir, reserved, actual, now) {
  withLock(dir, "spend", () => {
    const spent = spentToday(dir, now);
    if (Number.isFinite(spent)) writeJson(path.join(dir, "spend.json"), { day: today(now), usd: Math.max(0, spent - reserved + actual) });
  });
}
const CACHE_MAX = 500;
const readCache = (dir) => { const c = readJson(path.join(dir, "cache.json"), {}); return c && typeof c === "object" && !Array.isArray(c) ? c : {}; };
function cacheGet(dir, key) { return readCache(dir)[key] ?? null; }
// Concurrent runs on the same new window may both judge it (bounded by the budget); the lock keeps entries from being lost.
function cachePut(dir, key, value) {
  withLock(dir, "cache", () => {
    const c = readCache(dir);
    c[key] = value;
    const keys = Object.keys(c);
    for (const k of keys.slice(0, Math.max(0, keys.length - CACHE_MAX))) delete c[k];
    writeJson(path.join(dir, "cache.json"), c);
  });
}

// One full watchdog pass over a transcript text. Returns the log entry; writes only under `dir`.
// deps.judge(prompt, { model, maxBudgetUsd }) -> { text, costUsd, error? } replaces the model (tests).
export function watch(text, opts = {}, deps = {}) {
  const env = opts.env ?? process.env, now = deps.now ?? new Date();
  const mode = watchdogMode(env);
  if (mode === "off") return null;
  const o = { ...DEFAULTS, model: env.CONDUCT_WATCHDOG_MODEL || DEFAULTS.model, ...opts };
  const cap = Number(env.CONDUCT_WATCHDOG_DAILY_USD ?? o.dailyUsd);
  const dailyUsd = Number.isFinite(cap) && cap >= 0 ? cap : DEFAULTS.dailyUsd;
  const dir = o.dir ?? stateDir(env);
  const win = buildWindow(parseTranscript(text), o);
  const key = createHash("sha256").update(JSON.stringify([mode, o.worker ?? o.transcript ?? null, win.goal, win.text, o.model, !!o.noFast, !!o.fastOnly])).digest("hex").slice(0, 32);
  const base = { ts: now.toISOString(), mode, transcript: o.transcript ?? null, worker: o.worker ?? null, goal: clip(win.goal, 200), window: key, events: win.events.length };

  if (!o.noCache) { const hit = cacheGet(dir, key); if (hit) return { ...base, ...hit, cached: true }; }

  const fast = fastPath(win, o);
  let result;
  if (fast.decided && !o.noFast) result = { verdict: fast.verdict, confidence: fast.confidence, reason: fast.reason, suggested_action: fast.suggested_action, source: "fast", costUsd: 0 };
  else if (o.fastOnly) result = unknown("fast path found no decisive signal (model disabled)", { source: "fast", costUsd: 0 });
  else if (!win.events.length) result = unknown("empty transcript window", { source: "fast", costUsd: 0 });
  else {
    const maxBudgetUsd = reserve(dir, dailyUsd, o.perCallUsd, now);
    if (maxBudgetUsd === null) result = unknown("spend ledger locked by another run", { source: "budget", costUsd: 0 });
    else if (!maxBudgetUsd) result = unknown(`daily budget spent (${dailyUsd} USD)`, { source: "budget", costUsd: 0 });
    else {
      const r = (deps.judge ?? claudeJudge)(judgePrompt(win, fast.signals), { model: o.model, maxBudgetUsd, env });
      // An unreported or nonsensical cost is charged at the reservation, so a silent CLI cannot run past the daily cap.
      const costUsd = typeof r?.costUsd === "number" && Number.isFinite(r.costUsd) && r.costUsd >= 0 ? r.costUsd : maxBudgetUsd;
      settle(dir, maxBudgetUsd, costUsd, now);
      result = r?.error ? unknown(`model call failed: ${r.error}`, { source: "error", costUsd }) : { ...parseVerdict(r?.text), source: "model", costUsd };
      result.model = o.model;
    }
  }
  const entry = { ...base, ...result, signals: fast.signals.map(({ kind, count, detail }) => ({ kind, count, detail })) };
  mkdirSync(dir, { recursive: true });
  appendFileSync(path.join(dir, "shadow.jsonl"), JSON.stringify(entry) + "\n");
  if (entry.verdict !== "unknown" && !o.noCache) cachePut(dir, key, { ...result, signals: entry.signals });
  return entry;
}

// act mode: the message for the conductor, or null. Delivery to the conductor is the caller's responsibility.
export function notifyFor(entry, minConfidence = DEFAULTS.actMinConfidence) {
  if (!entry || entry.cached || !["stalled", "looping", "drifting"].includes(entry.verdict) || entry.confidence < minConfidence) return null;
  return { to: "conductor", worker: entry.worker, transcript: entry.transcript, verdict: entry.verdict, confidence: entry.confidence,
    message: `progress-watchdog: worker ${entry.worker ?? entry.transcript ?? "?"} looks ${entry.verdict} (${entry.confidence}%): ${entry.reason} Suggested: ${entry.suggested_action}` };
}

// Long-lived session transcripts grow without bound; only the tail feeds the window. When the file is cut,
// the goal falls back to the first user message in the first 256 KiB (pass --goal when the brief is bigger).
export const TAIL_BYTES = 4 << 20;
export function readTranscript(file, maxBytes = TAIL_BYTES) {
  if (file === "-") return { text: readFileSync(0, "utf8") };
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    if (size <= maxBytes) return { text: readFileSync(fd, "utf8") };
    const chunk = (pos, len) => { const b = Buffer.alloc(len); return b.subarray(0, readSync(fd, b, 0, len, pos)).toString("utf8"); };
    const tail = chunk(size - maxBytes, maxBytes);
    return { text: tail.slice(tail.indexOf("\n") + 1), head: chunk(0, Math.min(256 << 10, size)) };
  } finally { closeSync(fd); }
}

const USAGE = `usage: progress-watchdog.mjs <transcript.jsonl|-> [--goal TEXT | --goal-file FILE] [--worker NAME]
  [--tools N] [--messages N] [--max-chars N] [--model M] [--dir DIR] [--fast-only] [--no-fast] [--no-cache]
env: CONDUCT_WATCHDOG=shadow|act|off  CONDUCT_WATCHDOG_DAILY_USD=0.5  CONDUCT_WATCHDOG_MODEL  CONDUCT_WATCHDOG_DIR  CONDUCT_WATCHDOG_CLI`;

export function parseArgs(argv) {
  const o = {}, num = (v, k) => { const n = Number(v); if (!Number.isInteger(n) || n <= 0) throw new Error(`${k} needs a positive integer`); return n; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === "--goal") o.goal = v();
    else if (a === "--goal-file") o.goal = readFileSync(v(), "utf8");
    else if (a === "--worker") o.worker = v();
    else if (a === "--tools") o.tools = num(v(), a);
    else if (a === "--messages") o.messages = num(v(), a);
    else if (a === "--max-chars") o.maxChars = num(v(), a);
    else if (a === "--model") o.model = v();
    else if (a === "--dir") o.dir = v();
    else if (a === "--fast-only") o.fastOnly = true;
    else if (a === "--no-fast") o.noFast = true;
    else if (a === "--no-cache") o.noCache = true;
    else if (a === "-h" || a === "--help") o.help = true;
    else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
    else if (o.transcript) throw new Error("one transcript per run");
    else o.transcript = a;
  }
  return o;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let o, text;
  try {
    o = parseArgs(process.argv.slice(2));
    if (o.help || !o.transcript) { process.stdout.write(USAGE + "\n"); process.exitCode = o.help ? 0 : 2; }
    else {
      const t = readTranscript(o.transcript);
      text = t.text;
      if (t.head && o.goal === undefined) o.goal = parseTranscript(t.head).find((e) => e.kind === "user")?.text;
    }
  } catch (err) { process.stderr.write(`progress-watchdog: ${err.message}\n${USAGE}\n`); process.exitCode = 2; }
  if (text !== undefined) main(o, text);
}

function main(o, text) {
  let entry;
  try { entry = watch(text, o); } catch (err) {
    entry = { ts: new Date().toISOString(), transcript: o.transcript, worker: o.worker ?? null, ...unknown(`watchdog failed: ${err.message}`, { source: "error", costUsd: 0 }) };
  }
  if (entry) {
    process.stdout.write(JSON.stringify(entry) + "\n");
    const note = watchdogMode() === "act" ? notifyFor(entry, Number(process.env.CONDUCT_WATCHDOG_ACT_MIN ?? DEFAULTS.actMinConfidence)) : null;
    if (note) process.stdout.write(JSON.stringify({ notify: note }) + "\n");
  }
}
