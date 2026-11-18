import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_MODE, buildWindow, errorSignature, fastPath, judgeEnv, notifyFor, parseArgs, parseTranscript, parseVerdict, readTranscript, spentToday, watch, watchdogMode,
} from "./progress-watchdog.mjs";

const toPath = (u) => fileURLToPath(new URL(u, import.meta.url));
const cli = toPath("./progress-watchdog.mjs");
const fixtures = toPath("../../../docs/fixtures/progress-watchdog/");
const fixture = (name) => readFileSync(path.join(fixtures, name), "utf8");
const tmp = () => mkdtempSync(path.join(tmpdir(), "pw-"));
const NOW = new Date("2026-11-02T12:00:00Z");

// A model double: records prompts, answers with `reply`, reports `costUsd`.
function fakeJudge(reply = '{"verdict":"progressing","confidence":77,"reason":"tests go green","suggested_action":"none"}', costUsd = 0.002) {
  const calls = [];
  const judge = (prompt, opts) => { calls.push({ prompt, opts }); return typeof reply === "function" ? reply(prompt) : { text: reply, costUsd }; };
  return { judge, calls };
}
const run = (text, o = {}, judge = fakeJudge().judge, env = {}) => watch(text, { dir: o.dir ?? tmp(), env, ...o }, { judge, now: NOW });

const cc = (...items) => items.map((x) => JSON.stringify(x)).join("\n");
const ask = (text) => ({ type: "user", message: { role: "user", content: text } });
const use = (id, name, input) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
const result = (id, content, is_error = false) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error }] } });
const say = (text) => ({ type: "assistant", message: { content: [{ type: "text", text }] } });

test("parseTranscript: Claude Code jsonl pairs tool_use with tool_result and keeps errors", () => {
  const ev = parseTranscript(cc(ask("goal: fix it"), say("looking"), use("t1", "Bash", { command: "npm test" }),
    result("t1", [{ type: "text", text: "boom" }], true), use("t2", "Edit", { file_path: "/r/a.ts" }), result("t2", "ok")) + "\nnot json\n");
  assert.deepEqual(ev.map((e) => e.kind), ["user", "text", "tool", "tool"]);
  assert.deepEqual(ev[2], { kind: "tool", tool: "Bash", input: "npm test", files: [], output: "boom", error: true });
  assert.deepEqual(ev[3].files, ["/r/a.ts"]);
});

test("parseTranscript: codex exec --json items (command_execution, file_change, agent_message)", () => {
  const ev = parseTranscript(readFileSync(toPath("../../../docs/fixtures/codex-exec-tools.jsonl"), "utf8"));
  assert.ok(ev.some((e) => e.kind === "text"));
  const cmds = ev.filter((e) => e.kind === "tool" && e.tool === "Bash");
  assert.ok(cmds.length > 0 && cmds.every((c) => typeof c.output === "string"));
  assert.ok(ev.some((e) => e.tool === "Edit" && e.files.length === 2));
});

test("parseTranscript: malformed but valid JSON never throws; meta user records are not the goal", () => {
  const ev = parseTranscript(cc({ type: "user", isMeta: true, message: { content: "<command-name>/clear</command-name>" } }, ask("real goal"),
    { type: "assistant", message: { content: [null, { type: "tool_use", id: "n", name: "Bash", input: null }, { type: "tool_use", id: "e", name: "Edit" }] } },
    { type: "user", message: { content: [null, { type: "tool_result", tool_use_id: "zz" }] } }, { type: "user", message: null }, null, 5, "str",
    { type: "item.completed", item: { type: "file_change", changes: [null, { path: 3 }, { path: "/r/a.ts" }] } },
    { type: "item.completed", item: { type: "command_execution" } }));
  assert.equal(buildWindow(ev).goal, "real goal");
  assert.deepEqual(ev.filter((e) => e.kind === "tool").map((e) => e.input), ["", "{}", "/r/a.ts", ""]);
});

test("buildWindow keeps the last N tool calls and M messages, trims to maxChars, takes the goal from the first user message", () => {
  const items = [ask("the goal")];
  for (let i = 0; i < 50; i++) items.push(use(`t${i}`, "Bash", { command: `echo ${i}` }), result(`t${i}`, "x".repeat(100)));
  for (let i = 0; i < 10; i++) items.push(say(`m${i}`));
  const ev = parseTranscript(cc(...items));
  const w = buildWindow(ev, { tools: 20, messages: 3 });
  assert.equal(w.goal, "the goal");
  assert.equal(w.events.filter((e) => e.kind === "tool").length, 20);
  assert.deepEqual(w.events.filter((e) => e.kind === "text").map((e) => e.text), ["m7", "m8", "m9"]);
  assert.match(w.events[0].input, /echo 30/);
  const small = buildWindow(ev, { tools: 20, messages: 3, maxChars: 1000 });
  assert.ok(small.text.length <= 1001 && small.events.length < w.events.length);
  assert.equal(buildWindow(ev, { goal: "explicit" }).goal, "explicit");
});

test("errorSignature ignores numbers so line:col changes do not hide a repeat", () => {
  assert.equal(errorSignature("FAIL x\nTypeError: undefined at a.ts:14:22"), errorSignature("FAIL x\nTypeError: undefined at a.ts:15:52"));
  assert.notEqual(errorSignature("TypeError: a"), errorSignature("RangeError: a"));
});

test("fast path: the same error 4+ times decides looping without the model", () => {
  const f = fastPath(buildWindow(parseTranscript(fixture("error-loop.jsonl"))));
  assert.equal(f.decided, true);
  assert.equal(f.verdict, "looping");
  assert.match(f.reason, /typeerror/);
});

test("fast path: polling the same command with the same output decides stalled", () => {
  const f = fastPath(buildWindow(parseTranscript(fixture("waiting-codex.jsonl"))));
  assert.equal(f.decided, true);
  assert.equal(f.verdict, "stalled");
  const items = [ask("g")];
  for (let i = 0; i < 4; i++) items.push(use(`t${i}`, "Bash", { command: "make build" }), result(`t${i}`, "same"));
  assert.equal(fastPath(buildWindow(parseTranscript(cc(...items)))).verdict, "looping");
});

test("fast path: edit churn without tests and no tool calls are hints, not decisions", () => {
  const churn = [ask("g")];
  for (let i = 0; i < 5; i++) churn.push(use(`t${i}`, "Edit", { file_path: "/r/a.ts" }), result(`t${i}`, "ok"));
  const f = fastPath(buildWindow(parseTranscript(cc(...churn))));
  assert.equal(f.decided, false);
  assert.deepEqual(f.signals.map((s) => s.kind), ["edit_churn"]);
  const tested = [...churn.slice(0, 7), use("x", "Bash", { command: "node --test" }), result("x", "ok"), ...churn.slice(7)];
  assert.deepEqual(fastPath(buildWindow(parseTranscript(cc(...tested)))).signals, []);
  const testedAfter = [...churn, use("y", "Bash", { command: "npm test" }), result("y", "ok"), use("z", "Edit", { file_path: "/r/a.ts" }), result("z", "ok")];
  assert.deepEqual(fastPath(buildWindow(parseTranscript(cc(...testedAfter)))).signals, [], "a test run clears earlier churn");
  const idle = fastPath(buildWindow(parseTranscript(cc(ask("g"), say("a"), say("b"), say("c")))));
  assert.equal(idle.decided, false);
  assert.equal(idle.signals[0].kind, "no_tool_calls");
});

test("fast path: healthy fixtures (progress, long debugging, drift) are not decided by the fast path", () => {
  for (const name of ["progress.jsonl", "tricky-debug.jsonl", "drift.jsonl"]) assert.equal(fastPath(buildWindow(parseTranscript(fixture(name)))).decided, false, name);
});

test("parseVerdict: valid JSON, fenced JSON, prose around JSON, clamps confidence", () => {
  assert.deepEqual(parseVerdict('{"verdict":"looping","confidence":91,"reason":"r","suggested_action":"s"}'), { verdict: "looping", confidence: 91, reason: "r", suggested_action: "s" });
  assert.equal(parseVerdict('Sure:\n```json\n{"verdict":"Drifting","confidence":"140"}\n```').verdict, "drifting");
  assert.equal(parseVerdict('{"verdict":"stalled","confidence":140}').confidence, 100);
});

test("parseVerdict: a bad reply is unknown, never an exception", () => {
  for (const bad of [undefined, "", "I think it is fine", "{not json}", '{"verdict":"great"}', "[1,2]", "null", '{"confidence":5}']) {
    const v = parseVerdict(bad);
    assert.equal(v.verdict, "unknown", String(bad));
    assert.equal(v.confidence, 0);
  }
});

test("slow path: the model judges the window against the goal; cost goes to the daily ledger", () => {
  const dir = tmp(), m = fakeJudge();
  const e = run(fixture("drift.jsonl"), { dir }, m.judge);
  assert.equal(m.calls.length, 1);
  assert.match(m.calls[0].prompt, /GOAL:\nFix the login bug/);
  assert.equal(m.calls[0].opts.model, "claude-haiku-4-5");
  assert.equal(m.calls[0].opts.maxBudgetUsd, 0.05);
  assert.equal(e.verdict, "progressing");
  assert.equal(e.source, "model");
  assert.equal(spentToday(dir, NOW), 0.002);
});

test("model errors and garbage replies are logged as unknown; an unreported cost is charged at the per-call cap", () => {
  const dir = tmp();
  const e = run(fixture("progress.jsonl"), { dir }, () => ({ text: "", costUsd: null, error: "spawn claude ENOENT" }));
  assert.equal(e.verdict, "unknown");
  assert.equal(e.source, "error");
  assert.equal(spentToday(dir, NOW), 0.05);
  assert.equal(run(fixture("progress.jsonl"), {}, fakeJudge("no idea").judge).verdict, "unknown");
});

test("daily budget: once spent, no model call and verdict unknown; a new UTC day resets it", () => {
  const dir = tmp(), m = fakeJudge(undefined, 0.3);
  const env = { CONDUCT_WATCHDOG_DAILY_USD: "0.5" };
  run(fixture("progress.jsonl"), { dir }, m.judge, env);
  const second = run(fixture("drift.jsonl"), { dir }, m.judge, env);
  assert.equal(m.calls[1].opts.maxBudgetUsd, 0.05);
  assert.equal(second.source, "model");
  writeFileSync(path.join(dir, "spend.json"), JSON.stringify({ day: "2026-11-02", usd: 0.5 }));
  const third = run(fixture("tricky-debug.jsonl"), { dir }, m.judge, env);
  assert.equal(m.calls.length, 2);
  assert.equal(third.verdict, "unknown");
  assert.equal(third.source, "budget");
  assert.equal(spentToday(dir, new Date("2026-11-03T00:00:01Z")), 0);
  writeFileSync(path.join(dir, "spend.json"), JSON.stringify({ day: "2026-11-02", usd: 0.48 }));
  run(fixture("tricky-debug.jsonl"), { dir }, m.judge, env);
  assert.ok(Math.abs(m.calls[2].opts.maxBudgetUsd - 0.02) < 1e-9, "per-call cap shrinks to what is left");
});

test("budget state fails closed: a corrupt ledger means spent; bad caps and costs cannot widen the budget", () => {
  const dir = tmp(), m = fakeJudge();
  writeFileSync(path.join(dir, "spend.json"), "{corrupt");
  assert.equal(spentToday(dir, NOW), Infinity);
  assert.equal(run(fixture("drift.jsonl"), { dir }, m.judge).source, "budget");
  for (const bad of [null, [], {}, { day: "2026-11-02", usd: null }, { day: "2026-11-01", usd: "lots" }, { day: 5, usd: 0 }, { day: "2026-11-02", usd: -1 }]) {
    writeFileSync(path.join(dir, "spend.json"), JSON.stringify(bad));
    assert.equal(spentToday(dir, NOW), Infinity, JSON.stringify(bad));
  }
  writeFileSync(path.join(dir, "spend.json"), JSON.stringify({ day: "2026-11-01", usd: 9 }));
  assert.equal(spentToday(dir, NOW), 0);
  const d2 = tmp();
  writeFileSync(path.join(d2, "spend.json"), JSON.stringify({ day: "2026-11-02", usd: 0.49 }));
  run(fixture("drift.jsonl"), { dir: d2 }, m.judge, { CONDUCT_WATCHDOG_DAILY_USD: "Infinity" });
  assert.ok(Math.abs(m.calls[0].opts.maxBudgetUsd - 0.01) < 1e-9, "Infinity falls back to the 0.5 default");
  const d3 = tmp();
  run(fixture("drift.jsonl"), { dir: d3 }, fakeJudge(undefined, -5).judge);
  assert.equal(spentToday(d3, NOW), 0.05, "a negative cost is charged at the reservation");
});

test("concurrent runs: a held ledger lock means no model call", () => {
  const dir = tmp(), m = fakeJudge();
  writeFileSync(path.join(dir, "spend.lock"), "");
  const e = watch(fixture("drift.jsonl"), { dir, env: {} }, { judge: m.judge, now: NOW });
  assert.equal(m.calls.length, 0);
  assert.equal(e.source, "budget");
  assert.match(e.reason, /locked/);
});

test("cache: the same window is judged and logged once; a new event makes a new window", () => {
  const dir = tmp(), m = fakeJudge();
  const text = fixture("progress.jsonl");
  run(text, { dir }, m.judge);
  const again = run(text, { dir }, m.judge);
  assert.equal(m.calls.length, 1);
  assert.equal(again.cached, true);
  assert.equal(readFileSync(path.join(dir, "shadow.jsonl"), "utf8").trim().split("\n").length, 1);
  run(text + JSON.stringify(say("one more step")) + "\n", { dir }, m.judge);
  assert.equal(m.calls.length, 2);
  run(text, { dir, noCache: true }, m.judge);
  assert.equal(m.calls.length, 3);
  run(text, { dir }, m.judge, { CONDUCT_WATCHDOG: "act" });
  assert.equal(m.calls.length, 4, "a window cached in shadow is judged again in act, so act can notify");
  run(text, { dir, worker: "other" }, m.judge);
  assert.equal(m.calls.length, 5, "the cache is per worker");
});

test("--no-cache neither reads nor writes the cache; a null cache file is treated as empty", () => {
  const dir = tmp(), m = fakeJudge();
  run(fixture("progress.jsonl"), { dir, noCache: true }, m.judge);
  assert.equal(existsSync(path.join(dir, "cache.json")), false);
  writeFileSync(path.join(dir, "cache.json"), "null");
  assert.equal(run(fixture("progress.jsonl"), { dir }, m.judge).source, "model");
  assert.equal(run(fixture("progress.jsonl"), { dir }, m.judge).cached, true);
});

test("unknown verdicts are not cached, so the window is retried", () => {
  const dir = tmp(), m = fakeJudge("garbage");
  run(fixture("progress.jsonl"), { dir }, m.judge);
  run(fixture("progress.jsonl"), { dir }, m.judge);
  assert.equal(m.calls.length, 2);
});

test("shadow mode writes only shadow.jsonl, cache.json and spend.json under its dir and returns no notify", () => {
  assert.equal(DEFAULT_MODE, "shadow");
  const dir = tmp();
  const e = run(fixture("error-loop.jsonl"), { dir });
  assert.equal(e.mode, "shadow");
  assert.equal(e.source, "fast");
  assert.deepEqual(readdirSync(dir).sort(), ["cache.json", "shadow.jsonl"]);
  const logged = JSON.parse(readFileSync(path.join(dir, "shadow.jsonl"), "utf8"));
  assert.equal(logged.verdict, "looping");
  run(fixture("drift.jsonl"), { dir });
  assert.deepEqual(readdirSync(dir).sort(), ["cache.json", "shadow.jsonl", "spend.json"]);
});

test("modes: unset/unknown -> shadow, act, off does nothing", () => {
  for (const v of [undefined, "", "shadow", "bogus"]) assert.equal(watchdogMode({ CONDUCT_WATCHDOG: v }), "shadow", String(v));
  assert.equal(watchdogMode({ CONDUCT_WATCHDOG: "ACT" }), "act");
  const dir = tmp(), m = fakeJudge();
  assert.equal(run(fixture("drift.jsonl"), { dir }, m.judge, { CONDUCT_WATCHDOG: "off" }), null);
  assert.equal(m.calls.length, 0);
  assert.deepEqual(readdirSync(dir), []);
});

test("notifyFor: only confident non-progressing, non-cached verdicts produce a conductor message", () => {
  const e = { verdict: "looping", confidence: 80, reason: "same error.", suggested_action: "re-brief", worker: "luna-x" };
  assert.match(notifyFor(e).message, /worker luna-x looks looping \(80%\)/);
  assert.equal(notifyFor({ ...e, confidence: 50 }), null);
  assert.equal(notifyFor({ ...e, verdict: "progressing" }), null);
  assert.equal(notifyFor({ ...e, verdict: "unknown" }), null);
  assert.equal(notifyFor({ ...e, cached: true }), null);
});

test("judgeEnv drops the parent Claude Code session variables and keeps auth and the rest", () => {
  const env = judgeEnv({ CLAUDECODE: "1", CLAUDE_PID: "9", CLAUDE_EFFORT: "high", CLAUDE_CODE_CHILD_SESSION: "1", CLAUDE_CODE_SESSION_ID: "s",
    CLAUDE_CODE_SESSION_ATTENDED: "1", CLAUDE_CODE_MESSAGING_SOCKET: "/s", CLAUDE_CODE_MESSAGING_TOKEN: "t", CLAUDE_CODE_ENTRYPOINT: "cli",
    CLAUDE_CODE_EXECPATH: "/x", CLAUDE_CODE_OAUTH_TOKEN: "o", CLAUDE_CONFIG_DIR: "/c", ANTHROPIC_BASE_URL: "u", PATH: "/bin" });
  assert.deepEqual(Object.keys(env).sort(), ["ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR", "PATH"]);
});

test("parseArgs", () => {
  assert.deepEqual(parseArgs(["t.jsonl", "--goal", "g", "--tools", "20", "--no-fast"]), { transcript: "t.jsonl", goal: "g", tools: 20, noFast: true });
  assert.throws(() => parseArgs(["--tools", "0"]), /positive integer/);
  assert.throws(() => parseArgs(["--bogus"]), /unknown option/);
  assert.throws(() => parseArgs(["a", "b"]), /one transcript/);
});

const cliEnv = (dir) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CONDUCT_WATCHDOG")));
  return { ...env, CONDUCT_WATCHDOG: "shadow", CONDUCT_WATCHDOG_DAILY_USD: "0.5", CONDUCT_WATCHDOG_DIR: dir, CONDUCT_WATCHDOG_CLI: path.join(dir, "no-such-cli") };
};

test("readTranscript keeps only the tail of a big file and returns the head for the goal", () => {
  const dir = tmp(), file = path.join(dir, "t.jsonl");
  const filler = Array.from({ length: 400 }, (_, i) => JSON.stringify(say(`step ${i} ${"x".repeat(80)}`))).join("\n");
  writeFileSync(file, cc(ask("the goal")) + "\n" + filler + "\n");
  const t = readTranscript(file, 4096);
  assert.ok(t.text.length <= 4096 && t.head.includes("the goal"));
  assert.ok(t.text.split("\n").filter(Boolean).every((l) => JSON.parse(l)), "the tail starts on a whole line");
  assert.equal(readTranscript(file).head, undefined);
});

test("CLI: shadow run prints the entry; act mode adds a notify line; --fast-only never calls a model", () => {
  const dir = tmp();
  const env = cliEnv(dir);
  const r = spawnSync(process.execPath, [cli, path.join(fixtures, "error-loop.jsonl"), "--worker", "w1"], { encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].verdict, "looping");
  const a = spawnSync(process.execPath, [cli, path.join(fixtures, "waiting-codex.jsonl"), "--worker", "w2"], { encoding: "utf8", env: { ...env, CONDUCT_WATCHDOG: "act" } });
  const notify = a.stdout.trim().split("\n").map((l) => JSON.parse(l))[1]?.notify;
  assert.equal(notify?.to, "conductor");
  assert.equal(notify.verdict, "stalled");
  const f = spawnSync(process.execPath, [cli, path.join(fixtures, "drift.jsonl"), "--fast-only"], { encoding: "utf8", env });
  assert.equal(JSON.parse(f.stdout).verdict, "unknown");
  assert.equal(existsSync(path.join(dir, "spend.json")), false);
  const u = spawnSync(process.execPath, [cli], { encoding: "utf8", env });
  assert.equal(u.status, 2);
});

test("CLI: a missing model CLI degrades to unknown instead of crashing", () => {
  const dir = tmp();
  const r = spawnSync(process.execPath, [cli, path.join(fixtures, "drift.jsonl")], { encoding: "utf8",
    env: cliEnv(dir) });
  assert.equal(r.status, 0, r.stderr);
  const e = JSON.parse(r.stdout);
  assert.equal(e.verdict, "unknown");
  assert.equal(e.source, "error");
});
