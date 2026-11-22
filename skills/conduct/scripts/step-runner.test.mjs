import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const runner = fileURLToPath(new URL("./step-runner.mjs", import.meta.url));
const node = process.execPath;
const POSIX_ONLY = { skip: process.platform === "win32" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROMPT = "Implement the thing described in the brief.";

const SERVER_JS = `import net from "node:net";
import { renameSync, writeFileSync } from "node:fs";
const out = process.argv[2];
const srv = net.createServer((s) => s.end());
srv.listen(0, "127.0.0.1", () => {
  writeFileSync(out + ".tmp", JSON.stringify({ pid: process.pid, port: srv.address().port }));
  renameSync(out + ".tmp", out);
});
setInterval(() => {}, 1000);
`;

const COMMON_JS = `import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "server.mjs");
export const nextSeq = (state) => readdirSync(state).filter((f) => /^\\d{3}-(worker|check)\\.json$/.test(f)).length;
export const record = (state, seq, kind, rec) =>
  writeFileSync(path.join(state, String(seq).padStart(3, "0") + "-" + kind + ".json"),
    JSON.stringify({ kind, cwd: process.cwd(), runId: process.env.CONDUCT_RUN_ID ?? null, pid: process.pid, ...rec }));
export const serve = (state, tag) => {
  const out = path.join(state, "server-" + tag + ".json");
  spawn(process.execPath, [SERVER, out], { stdio: "ignore" }).unref();
  return out;
};
export const waitFor = (file) => new Promise((resolve) => {
  const t0 = Date.now();
  const iv = setInterval(() => { if (existsSync(file) || Date.now() - t0 > 5000) { clearInterval(iv); resolve(); } }, 20);
});
export const hang = () => setInterval(() => {}, 1000);
export const readStdin = async () => {
  let s = "";
  try { process.stdin.setEncoding("utf8"); for await (const chunk of process.stdin) s += chunk; } catch { /* no stdin */ }
  return s;
};
`;

// argv: mode state label ...placeholders
const WORKER_JS = `import { appendFileSync } from "node:fs";
import { hang, nextSeq, readStdin, record, serve, waitFor } from "./common.mjs";
const [mode, state, label, ...rest] = process.argv.slice(2);
const seq = nextSeq(state);
record(state, seq, "worker", { label, mode, argv: rest, stdin: await readStdin() });
if (mode === "ok") { process.stdout.write("WORKER-OUT\\n"); }
else if (mode === "fail7") { process.stdout.write("WORKER-FAIL\\n"); process.exitCode = 7; }
else if (mode === "limit") { process.stdout.write("You have hit your usage limit\\n"); process.exitCode = 1; }
else if (mode === "limit429") { process.stderr.write("HTTP 429 Too Many Requests\\n"); process.exitCode = 1; }
else if (mode === "limit0") { process.stdout.write("You have hit your usage limit\\n"); }
else if (mode === "hang-server") { serve(state, seq + "-w"); hang(); }
else if (mode === "daemon") { await waitFor(serve(state, seq + "-w")); }
else if (mode.startsWith("tamper=")) { appendFileSync(mode.slice("tamper=".length), "\\n// tampered\\n"); }
else { process.stderr.write("unknown worker mode " + mode + "\\n"); process.exitCode = 99; }
`;

// argv: mode state
const CHECK_JS = `import { readdirSync } from "node:fs";
import { hang, nextSeq, record, serve, waitFor } from "./common.mjs";
const [mode, state] = process.argv.slice(2);
const seq = nextSeq(state);
const priorChecks = readdirSync(state).filter((f) => /-check\\.json$/.test(f)).length;
record(state, seq, "check", { mode });
const fail = async (code) => {
  process.stdout.write("HEADMARK" + "x".repeat(5000) + "TAILMARK\\n");
  await new Promise((r) => setTimeout(r, 100));
  process.stderr.write("ERRMARK\\n");
  process.exitCode = code;
};
if (mode === "pass") process.stdout.write("CHECK-PASS\\n");
else if (mode === "fail") await fail(1);
else if (mode === "pass2") { if (priorChecks >= 1) process.stdout.write("CHECK-PASS\\n"); else await fail(1); }
else if (mode === "exit2") await fail(2);
else if (mode === "hang-server") { serve(state, seq + "-c"); hang(); }
else if (mode === "daemon-fail") { await waitFor(serve(state, seq + "-c")); await fail(1); }
else { process.stderr.write("unknown check mode " + mode + "\\n"); process.exitCode = 99; }
`;

function setup(t) {
  const root = mkdtempSync(path.join(tmpdir(), "step-runner-test-"));
  const bin = path.join(root, "bin"), state = path.join(root, "state"), home = path.join(root, "home");
  for (const d of [bin, state, home]) mkdirSync(d, { recursive: true });
  writeFileSync(path.join(bin, "server.mjs"), SERVER_JS);
  writeFileSync(path.join(bin, "common.mjs"), COMMON_JS);
  writeFileSync(path.join(bin, "worker.mjs"), WORKER_JS);
  writeFileSync(path.join(bin, "check.mjs"), CHECK_JS);
  const worker = path.join(bin, "worker.mjs"), checkJs = path.join(bin, "check.mjs");
  const ctx = {
    root, state, home, worker, checkJs, n: 0, extraCleanup: [],
    model: (mode, label = mode, extra = {}) => ({ argv: [node, worker, mode, state, label, "{effort}", "{cwd}", "{promptFile}"], stdin: "prompt", promptFile: true, ...extra }),
    agent: (o = {}) => ({ id: "implement", type: "agent", model: "fake", prompt: PROMPT, timeoutSec: 2, ...o }),
    check: (mode = "pass", o = {}) => ({ id: "check", type: "check", argv: [node, checkJs, mode, state], timeoutSec: 2, ...o }),
    wf: (steps, extra = {}) => ({ steps, models: { fake: ctx.model("ok", "fake") }, ...extra }),
    records: (kind) => readdirSync(state).filter((f) => /^\d{3}-(worker|check)\.json$/.test(f)).sort()
      .map((f) => JSON.parse(readFileSync(path.join(state, f), "utf8"))).filter((r) => !kind || r.kind === kind),
    servers: () => readdirSync(state).filter((f) => /^server-.*\.json$/.test(f)).map((f) => JSON.parse(readFileSync(path.join(state, f), "utf8"))),
    prepare: (workflow, { env = {}, pathEnv } = {}) => {
      const n = ++ctx.n;
      const wfPath = path.join(root, `wf-${n}.json`);
      writeFileSync(wfPath, typeof workflow === "string" ? workflow : JSON.stringify(workflow));
      const logPath = path.join(root, `log-${n}.ndjson`);
      const childEnv = { ...process.env, CONDUCT_HOME: home, TMPDIR: root, TEMP: root, TMP: root };
      delete childEnv.CONDUCT_RUN_ID;
      Object.assign(childEnv, env);
      if (pathEnv !== undefined) {
        for (const k of Object.keys(childEnv)) if (k.toUpperCase() === "PATH") delete childEnv[k];
        childEnv.PATH = pathEnv;
      }
      return { wfPath, logPath, childEnv };
    },
    run: (workflow, args = [], { env = {}, cwd = root, log = true, pathEnv } = {}) => {
      const { wfPath, logPath, childEnv } = ctx.prepare(workflow, { env, pathEnv });
      const r = spawnSync(node, [runner, wfPath, ...args, ...(log ? ["--log", logPath] : [])], { cwd, env: childEnv, encoding: "utf8", timeout: 60_000 });
      const lines = (r.stdout ?? "").trim().split("\n").filter(Boolean);
      let result = null;
      try { result = JSON.parse(lines.at(-1)); } catch { /* asserted by the caller */ }
      return { ...r, result, log: log ? readLog(logPath) : [], logPath };
    },
    cleanup: () => {
      for (const fn of ctx.extraCleanup) { try { fn(); } catch { /* best effort */ } }
      let pids = [];
      try { pids = [...ctx.servers().map((s) => s.pid), ...ctx.records().map((r) => r.pid)]; } catch { /* state gone */ }
      for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
  t.after(ctx.cleanup);
  return ctx;
}

function readLog(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}
// The spec names the events (start, attempt, ...) but not the key that carries the name; `type` is taken by attempt.type.
const kindOf = (e) => e.event ?? e.kind;
const events = (log, name) => log.filter((e) => kindOf(e) === name);
const real = (p) => realpathSync.native(p);

function pidAlive(pid) {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      if (stat.slice(stat.lastIndexOf(")") + 2)[0] === "Z") return false;
    } catch { return false; }
  }
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === "EPERM"; }
}
const portOpen = (port) => new Promise((resolve) => {
  const s = net.connect({ port, host: "127.0.0.1" });
  s.once("connect", () => { s.destroy(); resolve(true); });
  s.once("error", () => resolve(false));
});
async function assertServersGone(servers, expected) {
  assert.equal(servers.length, expected, `expected ${expected} grandchild servers to have started`);
  for (const { pid, port } of servers) {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && (pidAlive(pid) || await portOpen(port))) await new Promise((r) => setTimeout(r, 50));
    assert.equal(pidAlive(pid), false, `grandchild ${pid} still running`);
    assert.equal(await portOpen(port), false, `port ${port} still accepts connections`);
  }
}
const assertPidsGone = (pids) => { for (const pid of pids) assert.equal(pidAlive(pid), false, `process ${pid} still running`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await fn()) return true; await sleep(25); }
  return !!(await fn());
}

function initRepo(c, files) {
  const repo = path.join(c.root, "repo"); mkdirSync(repo);
  const git = (...a) => {
    const g = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo, encoding: "utf8" });
    assert.equal(g.status, 0, g.stderr);
    return g.stdout.trim();
  };
  git("init", "-q");
  for (const [name, { body, mode }] of Object.entries(files).map(([k, v]) => [k, typeof v === "string" ? { body: v } : v])) {
    writeFileSync(path.join(repo, name), body, mode ? { mode } : undefined);
  }
  git("add", "."); git("commit", "-q", "-m", "init");
  return { repo, git };
}

// argv: mode pidFile. hang: records its own pid and stays up. background: starts a child that inherits stdout, records its pid, exits 0.
const HELPER_JS = `import { spawn } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";
const [mode, pidFile] = process.argv.slice(2);
const writePid = (pid) => { writeFileSync(pidFile + ".tmp", String(pid)); renameSync(pidFile + ".tmp", pidFile); };
if (mode === "hang") { writePid(process.pid); setTimeout(() => {}, 30_000); }
else if (mode === "background") {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], { stdio: "inherit" });
  writePid(child.pid); child.unref(); process.stdout.write("started\\n");
}
`;

function helper(c) {
  const file = path.join(c.root, "bin", "helper.mjs");
  writeFileSync(file, HELPER_JS);
  const pidFiles = [];
  const readPid = (pidFile) => existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) : null;
  c.extraCleanup.push(() => {
    for (const pid of pidFiles.map(readPid).filter(Boolean)) {
      for (const target of [-pid, pid]) { try { process.kill(target, "SIGKILL"); } catch { /* already gone */ } }
    }
  });
  return {
    argv: (mode, name) => { const pidFile = path.join(c.state, `${name}.pid`); pidFiles.push(pidFile); return { argv: [node, file, mode, pidFile], pidFile }; },
    readPid,
  };
}

function spawnRunner(c, workflow, args = []) {
  const { wfPath, logPath, childEnv } = c.prepare(workflow);
  const child = spawn(node, [runner, wfPath, ...args, "--log", logPath], { cwd: c.root, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (d) => { stdout += d; });
  child.stderr.on("data", (d) => { stderr += d; });
  const exited = new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal })));
  c.extraCleanup.unshift(() => { try { process.kill(child.pid, "SIGKILL"); } catch { /* already gone */ } });
  return { child, exited, logPath, out: () => ({ stdout, stderr }) };
}

// ---------- validation ----------

const invalid = (c) => {
  const pre = c.check("pass", { id: "pre" });
  return {
    "missing steps": { models: { fake: c.model("ok") } },
    "empty steps": c.wf([]),
    "agent as the last step": c.wf([pre, c.agent()]),
    "agent followed by a gate": c.wf([pre, c.agent(), { id: "g", type: "gate" }, c.check()]),
    "agent followed by an agent": c.wf([pre, c.agent(), c.agent({ id: "implement2" }), c.check()]),
    "onFail on an agent": c.wf([pre, c.agent({ onFail: { retry: "pre", max: 1 } }), c.check()]),
    "retry pointing to a later step": c.wf([c.check("pass", { id: "pre", onFail: { retry: "implement", max: 1 } }), c.agent(), c.check()]),
    "retry pointing to itself": c.wf([pre, c.agent(), c.check("pass", { onFail: { retry: "check", max: 1 } })]),
    "retry naming an unknown step": c.wf([pre, c.agent(), c.check("pass", { onFail: { retry: "nope", max: 1 } })]),
    "negative max": c.wf([pre, c.agent(), c.check("pass", { onFail: { retry: "implement", max: -1 } })]),
    "non-integer max": c.wf([pre, c.agent(), c.check("pass", { onFail: { retry: "implement", max: 1.5 } })]),
    "empty retryOn": c.wf([pre, c.agent(), c.check("pass", { onFail: { retry: "implement", max: 1, retryOn: [] } })]),
    "non-integer retryOn": c.wf([pre, c.agent(), c.check("pass", { onFail: { retry: "implement", max: 1, retryOn: ["1"] } })]),
    "duplicate ids": c.wf([pre, c.agent(), c.check("pass", { id: "pre" })]),
    "empty id": c.wf([pre, c.agent({ id: "" }), c.check()]),
    "missing id": c.wf([pre, { type: "gate" }]),
    "unknown model": c.wf([pre, c.agent({ model: "nope" }), c.check()]),
    "sol is not a built-in model": { steps: [pre, c.agent({ model: "sol" }), c.check()] },
    "check with both argv and command": c.wf([pre, c.agent(), c.check("pass", { command: "node -v" })]),
    "check with neither argv nor command": c.wf([pre, c.agent(), { id: "check", type: "check" }]),
    "check with empty argv": c.wf([pre, c.agent(), c.check("pass", { argv: [] })]),
    "check with a non-string argv item": c.wf([pre, c.agent(), c.check("pass", { argv: [node, 1] })]),
    "unknown step type": c.wf([pre, { id: "x", type: "script" }]),
    "agent with both prompt and promptFile": c.wf([pre, c.agent({ promptFile: c.checkJs }), c.check()]),
    "agent with neither prompt nor promptFile": c.wf([pre, c.agent({ prompt: undefined }), c.check()]),
    "agent with a non-string effort": c.wf([pre, c.agent({ effort: 3 }), c.check()]),
    "timeoutSec 0": c.wf([pre, c.agent({ timeoutSec: 0 }), c.check()]),
    "non-integer timeoutSec": c.wf([pre, c.agent(), c.check("pass", { timeoutSec: 1.5 })]),
    "swapOrder with an unknown model": c.wf([pre, c.agent(), c.check()], { swapOrder: ["fake", "nope"] }),
    "workflow file that is not JSON": "{ not json",
  };
};
const assertRejected = (c, r, label) => {
  assert.equal(r.status, 2, `${label}: exit code (stderr: ${r.stderr})`);
  const lines = r.stderr.trim().split("\n");
  assert.equal(lines.length, 1, `${label}: exactly one stderr line, got ${JSON.stringify(r.stderr)}`);
  assert.ok(lines[0].length > 0, `${label}: stderr names the problem`);
  assert.deepEqual(c.records(), [], `${label}: no step ran`);
};

for (const label of Object.keys(invalid({ check: () => ({}), agent: () => ({}), wf: () => ({}), model: () => ({}) }))) {
  test(`invalid workflow (${label}) exits 2 with one stderr line and runs no step`, (t) => {
    const c = setup(t);
    assertRejected(c, c.run(invalid(c)[label]), label);
  });
}

test("a workflow file that does not exist exits 2", (t) => {
  const c = setup(t);
  const r = spawnSync(node, [runner, path.join(c.root, "missing.json")], { env: { ...process.env, CONDUCT_HOME: c.home }, encoding: "utf8" });
  assert.equal(r.status, 2);
});

test("--from naming a step that is not a gate, or no step at all, exits 2 and runs nothing", (t) => {
  const c = setup(t);
  const wf = c.wf([c.agent(), c.check(), { id: "ship", type: "gate" }]);
  assertRejected(c, c.run(wf, ["--from", "check", "--approved", "Marcin: ok"]), "--from check");
  assertRejected(c, c.run(wf, ["--from", "nope", "--approved", "Marcin: ok"]), "--from nope");
});

test("luna, opus and grok are built-in models and the default swap order validates without a models override", (t) => {
  const c = setup(t);
  const steps = [{ id: "hold", type: "gate" },
    c.agent({ id: "i1", model: "luna" }), c.check("pass", { id: "c1" }),
    c.agent({ id: "i2", model: "opus" }), c.check("pass", { id: "c2" }),
    c.agent({ id: "i3", model: "grok" }), c.check("pass", { id: "c3" })];
  // PATH holds only node, so a runner that wrongly passed the gate could not reach a real codex/claude/grok.
  const r = c.run({ steps, swapOrder: ["luna", "opus", "grok"] }, [], { pathEnv: path.dirname(node) });
  assert.equal(r.status, 3, r.stderr);
  assert.equal(r.result.status, "gate");
  assert.deepEqual(c.records(), []);
});

// ---------- E1 loop semantics ----------

test("E1: an always-failing check with onFail max 2 runs implement 3x and check 3x, then ends exhausted with exit 1", (t) => {
  const c = setup(t);
  const r = c.run(c.wf([c.agent(), c.check("fail", { onFail: { retry: "implement", max: 2, retryOn: [1] } })]));
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.result.status, "exhausted");
  assert.equal(r.result.message, "loop exhausted after 3");
  assert.deepEqual(r.result.runs, { implement: 3, check: 3 });
  assert.deepEqual(c.records().map((x) => x.kind), ["worker", "check", "worker", "check", "worker", "check"]);
  const retries = events(r.log, "retry");
  assert.deepEqual(retries.map((e) => [e.check, e.n, e.to]), [["check", 1, "implement"], ["check", 2, "implement"]]);
  assertPidsGone(c.records().map((x) => x.pid));
});

test("E1: a check that passes on the 2nd attempt gives runs 2/2, status success, exit 0", (t) => {
  const c = setup(t);
  const r = c.run(c.wf([c.agent(), c.check("pass2", { onFail: { retry: "implement", max: 2, retryOn: [1] } })]));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.result.status, "success");
  assert.deepEqual(r.result.runs, { implement: 2, check: 2 });
});

test("E1: a check exit code outside retryOn ends the run failed after 1/1 with no retry", (t) => {
  const c = setup(t);
  const r = c.run(c.wf([c.agent(), c.check("exit2", { onFail: { retry: "implement", max: 2, retryOn: [1] } })]));
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.result.status, "failed");
  assert.deepEqual(r.result.runs, { implement: 1, check: 1 });
  assert.deepEqual(events(r.log, "retry"), []);
});

test("onFail without retryOn retries on any non-zero exit until max is spent", (t) => {
  const c = setup(t);
  const r = c.run(c.wf([c.agent(), c.check("exit2", { onFail: { retry: "implement", max: 1 } })]));
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.result.status, "exhausted");
  assert.equal(r.result.message, "loop exhausted after 2");
  assert.deepEqual(r.result.runs, { implement: 2, check: 2 });
});

test("onFail max 0 does not retry and ends exhausted after 1", (t) => {
  const c = setup(t);
  const r = c.run(c.wf([c.agent(), c.check("fail", { onFail: { retry: "implement", max: 0 } })]));
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.result.status, "exhausted");
  assert.equal(r.result.message, "loop exhausted after 1");
  assert.deepEqual(r.result.runs, { implement: 1, check: 1 });
});

test("a failing check without onFail ends the run failed with exit 1", (t) => {
  const c = setup(t);
  const r = c.run(c.wf([c.agent(), c.check("fail")]));
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.result.status, "failed");
});

test("an agent's non-zero exit does not stop the run: the check still runs", (t) => {
  const c = setup(t);
  const r = c.run(c.wf([c.agent(), c.check("pass")], { models: { fake: c.model("fail7") } }));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.result.status, "success");
  assert.deepEqual(c.records().map((x) => x.kind), ["worker", "check"]);
  const [att] = events(r.log, "attempt").filter((e) => e.step === "implement");
  assert.equal(att.exit, 7);
  assert.equal(att.outcome, "fail");
  assert.deepEqual(events(r.log, "swap"), []);
});

test("a check run through `command` passes or fails on its exit code", (t) => {
  const c = setup(t);
  const cmd = (mode) => `"${node}" "${c.checkJs}" ${mode} "${c.state}"`;
  const ok = c.run(c.wf([c.agent(), { id: "check", type: "check", command: cmd("pass"), timeoutSec: 2 }]));
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.result.status, "success");
  const bad = c.run(c.wf([c.agent(), { id: "check", type: "check", command: cmd("fail"), timeoutSec: 2 }]));
  assert.equal(bad.status, 1, bad.stderr);
  assert.equal(bad.result.status, "failed");
  assert.equal(c.records("check").length, 2);
});

// ---------- retry prompt ----------

test("the retry prompt carries the check id, exit code, output tail (last 4000 chars) and the fixed instructions", (t) => {
  const c = setup(t);
  const r = c.run(c.wf([c.agent(), c.check("fail", { onFail: { retry: "implement", max: 1 } })]));
  assert.equal(r.result.status, "exhausted", r.stderr);
  const [first, second] = c.records("worker");
  assert.equal(first.stdin, PROMPT);
  const p = second.stdin;
  assert.ok(p.startsWith(PROMPT), "the original prompt comes first");
  assert.match(p, /\n\n## Check result \(attempt \d+\)\n/);
  assert.match(p, /The check `check` \([^\n]*check\.mjs[^\n]*\) exited 1\. It runs outside your workspace and you cannot change it\./);
  assert.ok(p.includes("TAILMARK") && p.includes("ERRMARK"), "combined stdout+stderr tail");
  assert.ok(!p.includes("HEADMARK"), "only the last 4000 chars of the output");
  assert.ok(p.includes("```"));
  assert.ok(p.trimEnd().endsWith("Do not ask questions. Fix the code so the check passes, or exit with a one-line reason why you cannot."));
  const promptFile = path.join(c.home, "runs", r.result.runId, "implement-2.prompt.md");
  assert.equal(readFileSync(promptFile, "utf8"), p);
});

// ---------- run id ----------

test("CONDUCT_RUN_ID from the parent env is the run id every step sees and the result reports", (t) => {
  const c = setup(t);
  const r = c.run(c.wf([c.agent(), c.check("pass")]), [], { env: { CONDUCT_RUN_ID: "rid-from-parent" } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.result.runId, "rid-from-parent");
  assert.deepEqual(c.records().map((x) => x.runId), ["rid-from-parent", "rid-from-parent"]);
  assert.ok(r.log.length > 0 && r.log.every((e) => e.runId === "rid-from-parent"));
  assert.ok(existsSync(path.join(c.home, "runs", "rid-from-parent", "implement-1.prompt.md")));
});

test("without CONDUCT_RUN_ID the run id is a random UUID shared by every step", (t) => {
  const c = setup(t);
  const a = c.run(c.wf([c.agent(), c.check("pass")]));
  const b = c.run(c.wf([c.agent(), c.check("pass")]));
  assert.match(a.result.runId, UUID);
  assert.match(b.result.runId, UUID);
  assert.notEqual(a.result.runId, b.result.runId);
  assert.deepEqual(c.records().map((x) => x.runId), [a.result.runId, a.result.runId, b.result.runId, b.result.runId]);
});

// ---------- model table, placeholders, effort, stdin ----------

test("{effort}, {cwd} and {promptFile} are substituted in argv items, inside an item too; the prompt goes on stdin", (t) => {
  const c = setup(t);
  const dir = path.join(c.root, "work"); mkdirSync(dir);
  const fake = c.model("ok", "fake");
  fake.argv.push("effort={effort}");
  const r = c.run(c.wf([c.agent({ effort: "low" }), c.check("pass")], { models: { fake } }), ["--cwd", dir]);
  assert.equal(r.status, 0, r.stderr);
  const [w] = c.records("worker");
  const [effort, cwd, promptFile, inline] = w.argv;
  assert.equal(effort, "low");
  assert.equal(inline, "effort=low");
  assert.equal(real(cwd), real(dir));
  const expected = path.join(c.home, "runs", r.result.runId, "implement-1.prompt.md");
  assert.equal(real(path.resolve(dir, promptFile)), real(expected));
  assert.equal(readFileSync(expected, "utf8"), PROMPT);
  assert.equal(w.stdin, PROMPT);
  const [att] = events(r.log, "attempt").filter((e) => e.step === "implement");
  assert.equal(att.model, "fake");
  assert.equal(att.effort, "low");
});

test("a model with stdin none gets no prompt on stdin but still gets the prompt file", (t) => {
  const c = setup(t);
  const r = c.run(c.wf([c.agent(), c.check("pass")], { models: { fake: c.model("ok", "fake", { stdin: "none" }) } }));
  assert.equal(r.status, 0, r.stderr);
  const [w] = c.records("worker");
  assert.equal(w.stdin, "");
  assert.equal(readFileSync(path.resolve(w.cwd, w.argv[2]), "utf8"), PROMPT);
});

test("an agent promptFile supplies the prompt", (t) => {
  const c = setup(t);
  const file = path.join(c.root, "brief.md");
  writeFileSync(file, "Prompt from a file.");
  const r = c.run(c.wf([c.agent({ prompt: undefined, promptFile: file }), c.check("pass")]));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(c.records("worker")[0].stdin, "Prompt from a file.");
});

test("a workflow models entry overrides the built-in entry of the same name", (t) => {
  const c = setup(t);
  const r = c.run({ steps: [c.agent({ model: "luna" }), c.check("pass")], models: { luna: c.model("ok", "luna-fake") } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(c.records("worker").map((w) => w.label), ["luna-fake"]);
});

// ---------- cwd and worktree ----------

test("--cwd runs every step in that directory; without --cwd/--repo steps run in the runner's cwd", (t) => {
  const c = setup(t);
  const dir = path.join(c.root, "work"); mkdirSync(dir);
  const other = path.join(c.root, "launch"); mkdirSync(other);
  assert.equal(c.run(c.wf([c.agent(), c.check("pass")]), ["--cwd", dir]).status, 0);
  assert.equal(c.run(c.wf([c.agent(), c.check("pass")]), [], { cwd: other }).status, 0);
  assert.deepEqual(c.records().map((x) => real(x.cwd)), [real(dir), real(dir), real(other), real(other)]);
});

test("--repo creates a detached worktree conduct-runs/<runId> of the repo's HEAD, runs every step there and keeps it", (t) => {
  const c = setup(t);
  const { repo, git } = initRepo(c, { "a.txt": "a\n" });
  const head = git("rev-parse", "HEAD");
  const r = c.run(c.wf([c.agent(), c.check("pass")]), ["--repo", repo]);
  if (r.result?.worktree) c.extraCleanup.unshift(() => spawnSync("git", ["-C", repo, "worktree", "remove", "--force", r.result.worktree]));
  assert.equal(r.status, 0, r.stderr);
  const wt = r.result.worktree;
  assert.ok(typeof wt === "string" && existsSync(wt), "worktree exists after the run");
  assert.equal(path.basename(wt), r.result.runId);
  assert.equal(path.basename(path.dirname(wt)), "conduct-runs");
  const inWt = (...a) => spawnSync("git", a, { cwd: wt, encoding: "utf8" }).stdout.trim();
  assert.equal(inWt("rev-parse", "HEAD"), head);
  assert.equal(inWt("rev-parse", "--abbrev-ref", "HEAD"), "HEAD", "detached");
  assert.equal(real(path.resolve(wt, inWt("rev-parse", "--git-common-dir"))), real(path.join(repo, ".git")));
  for (const x of c.records()) assert.equal(real(x.cwd), real(wt), `${x.kind} ran in the worktree`);
  assert.equal(real(c.records("worker")[0].argv[1]), real(wt), "{cwd} is the worktree");
  const [start] = events(r.log, "start");
  assert.equal(start.worktree, wt);
});

// ---------- check out of reach ----------

test("an agent that edits the check's argv[0] file ends the run check-tampered with exit 1", (t) => {
  const c = setup(t);
  const tool = path.join(c.root, "check-tool.mjs");
  writeFileSync(tool, "process.exit(0);\n");
  const r = c.run(c.wf([c.agent(), { id: "check", type: "check", argv: [tool], timeoutSec: 2 }], { models: { fake: c.model(`tamper=${tool}`, "fake") } }));
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.result.status, "check-tampered");
  assert.deepEqual(c.records("check"), []);
});

test("a `command` check is not hashed: editing its script does not end the run", (t) => {
  const c = setup(t);
  const r = c.run(c.wf([c.agent(), { id: "check", type: "check", command: `"${node}" "${c.checkJs}" pass "${c.state}"`, timeoutSec: 2 }],
    { models: { fake: c.model(`tamper=${c.checkJs}`, "fake") } }));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.result.status, "success");
  assert.equal(c.records("check").length, 1);
});

// ---------- timeout and process cleanup ----------

test("agent timeout kills the whole tree (grandchild and its port), records exit 124/timeout, swaps model and continues to the check", async (t) => {
  const c = setup(t);
  const t0 = Date.now();
  const r = c.run(c.wf([c.agent({ model: "slow" }), c.check("pass")], {
    models: { slow: c.model("hang-server", "slow"), fast: c.model("ok", "fast") }, swapOrder: ["slow", "fast"],
  }));
  assert.ok(Date.now() - t0 < 20_000, "the hard timeout fired");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.result.status, "success");
  const atts = events(r.log, "attempt").filter((e) => e.step === "implement");
  assert.equal(atts[0].outcome, "timeout");
  assert.equal(atts[0].exit, 124);
  assert.equal(atts[0].model, "slow");
  const [swap] = events(r.log, "swap");
  assert.deepEqual([swap.step, swap.from, swap.to, swap.reason], ["implement", "slow", "fast", "timeout"]);
  assert.deepEqual(c.records().map((x) => x.label ?? x.kind), ["slow", "fast", "check"]);
  assertPidsGone(c.records().map((x) => x.pid));
  await assertServersGone(c.servers(), 1);
});

test("check timeout kills the whole tree, records exit 124/timeout and counts as a failed attempt", async (t) => {
  const c = setup(t);
  const r = c.run(c.wf([c.agent(), c.check("hang-server")]));
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.result.status, "failed");
  const [att] = events(r.log, "attempt").filter((e) => e.step === "check");
  assert.equal(att.outcome, "timeout");
  assert.equal(att.exit, 124);
  assertPidsGone(c.records().map((x) => x.pid));
  await assertServersGone(c.servers(), 1);
});

test("POSIX: a daemon left behind by an agent that exited 0 is killed after the step", POSIX_ONLY, async (t) => {
  const c = setup(t);
  const r = c.run(c.wf([c.agent({ model: "d" }), c.check("pass")], { models: { d: c.model("daemon", "d") } }));
  assert.equal(r.status, 0, r.stderr);
  await assertServersGone(c.servers(), 1);
});

test("POSIX: after a looping run nothing stays running (no worker, check, daemon or listening port)", POSIX_ONLY, async (t) => {
  const c = setup(t);
  const r = c.run(c.wf([c.agent({ model: "d" }), c.check("daemon-fail", { onFail: { retry: "implement", max: 1 } })], { models: { d: c.model("daemon", "d") } }));
  assert.equal(r.result.status, "exhausted", r.stderr);
  assertPidsGone(c.records().map((x) => x.pid));
  await assertServersGone(c.servers(), 4);
});

// ---------- model swap ----------

test("a usage-limit failure swaps to the next model after the current one in swapOrder, re-runs at once, and the swap persists", (t) => {
  const c = setup(t);
  const r = c.run(c.wf([c.agent({ model: "a" }), c.check("pass2", { onFail: { retry: "implement", max: 1 } })], {
    models: { a: c.model("limit", "a"), b: c.model("ok", "b"), c: c.model("ok", "c") }, swapOrder: ["b", "a", "c"],
  }));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.result.status, "success");
  assert.deepEqual(c.records().map((x) => x.label ?? x.kind), ["a", "c", "check", "c", "check"]);
  assert.deepEqual(r.result.runs, { implement: 3, check: 2 });
  const swaps = events(r.log, "swap");
  assert.equal(swaps.length, 1);
  assert.deepEqual([swaps[0].step, swaps[0].from, swaps[0].to, swaps[0].reason], ["implement", "a", "c", "limit"]);
  const atts = events(r.log, "attempt").filter((e) => e.step === "implement");
  assert.deepEqual(atts.map((e) => [e.n, e.model, e.outcome]), [[1, "a", "limit"], [2, "c", "pass"], [3, "c", "pass"]]);
});

test("a limit failure on the last model in swapOrder ends the run no-model with exit 1 (stderr is matched too)", (t) => {
  const c = setup(t);
  const r = c.run(c.wf([c.agent({ model: "a" }), c.check("pass")], {
    models: { a: c.model("limit429", "a"), b: c.model("ok", "b") }, swapOrder: ["b", "a"],
  }));
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.result.status, "no-model");
  assert.deepEqual(c.records().map((x) => x.label ?? x.kind), ["a"]);
});

test("a limit message with exit 0 is not a swap", (t) => {
  const c = setup(t);
  const r = c.run(c.wf([c.agent({ model: "a" }), c.check("pass")], {
    models: { a: c.model("limit0", "a"), b: c.model("ok", "b") }, swapOrder: ["a", "b"],
  }));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(events(r.log, "swap"), []);
  assert.deepEqual(c.records().map((x) => x.label ?? x.kind), ["a", "check"]);
});

// ---------- gate ----------

test("a gate stops the run with exit 3 naming the step and the resume command; --from <gate> --approved resumes after it", (t) => {
  const c = setup(t);
  const wf = c.wf([c.agent(), c.check("pass"), { id: "ship", type: "gate", prompt: "Marcin approves the PR text" }, c.check("pass", { id: "post" })]);
  const stop = c.run(wf);
  assert.equal(stop.status, 3, stop.stderr);
  assert.equal(stop.result.status, "gate");
  const text = JSON.stringify(stop.result);
  assert.ok(text.includes('"ship"'), "result names the gate step");
  assert.match(text, /--from ship/);
  assert.match(text, /--approved/);
  assert.deepEqual(c.records().map((x) => x.kind), ["worker", "check"]);

  const go = c.run(wf, ["--from", "ship", "--approved", "Marcin: ok"]);
  assert.equal(go.status, 0, go.stderr);
  assert.equal(go.result.status, "success");
  const [approval] = events(go.log, "approval");
  assert.deepEqual([approval.step, approval.approved], ["ship", "Marcin: ok"]);
  assert.deepEqual(c.records().map((x) => x.kind), ["worker", "check", "check"], "only the step after the gate ran");
});

// ---------- log and result ----------

test("the NDJSON log has start, attempt, retry and end events, each with ts and runId; the result mirrors end", (t) => {
  const c = setup(t);
  const r = c.run(c.wf([c.agent(), c.check("fail", { onFail: { retry: "implement", max: 1 } })]));
  assert.equal(r.status, 1, r.stderr);
  const { log, result } = r;
  for (const e of log) {
    assert.equal(typeof e.ts, "string");
    assert.ok(!Number.isNaN(Date.parse(e.ts)), `ts ${e.ts}`);
    assert.equal(e.runId, result.runId);
  }
  assert.equal(kindOf(log[0]), "start");
  assert.equal(kindOf(log.at(-1)), "end");
  assert.ok(log[0].workflow, "start.workflow");
  assert.equal(real(log[0].cwd), real(c.root));
  const atts = events(log, "attempt");
  assert.deepEqual(atts.map((e) => [e.step, e.type, e.n]), [["implement", "agent", 1], ["check", "check", 1], ["implement", "agent", 2], ["check", "check", 2]]);
  for (const e of atts) {
    assert.equal(typeof e.exit, "number");
    assert.ok(["pass", "fail", "timeout", "limit"].includes(e.outcome), e.outcome);
    assert.equal(typeof e.ms, "number");
  }
  assert.deepEqual(atts.filter((e) => e.type === "check").map((e) => [e.exit, e.outcome]), [[1, "fail"], [1, "fail"]]);
  assert.equal(events(log, "retry").length, 1);
  const end = log.at(-1);
  assert.equal(end.status, "exhausted");
  assert.deepEqual(end.runs, { implement: 2, check: 2 });
  assert.equal(typeof end.ms, "number");
  assert.equal(result.status, end.status);
  assert.equal(result.message, end.message);
  assert.deepEqual(result.runs, end.runs);
  assert.equal(r.stdout.trim().split("\n").filter(Boolean).length >= 1, true);
});

test("without --log the log goes to <CONDUCT_HOME>/runs/<runId>/run.ndjson next to per-attempt prompt and output files", (t) => {
  const c = setup(t);
  const r = c.run(c.wf([c.agent(), c.check("pass")]), [], { log: false });
  assert.equal(r.status, 0, r.stderr);
  const dir = path.join(c.home, "runs", r.result.runId);
  const log = readLog(path.join(dir, "run.ndjson"));
  assert.equal(kindOf(log[0]), "start");
  assert.equal(kindOf(log.at(-1)), "end");
  assert.ok(readFileSync(path.join(dir, "implement-1.log"), "utf8").includes("WORKER-OUT"));
  assert.ok(readFileSync(path.join(dir, "check-1.log"), "utf8").includes("CHECK-PASS"));
  assert.equal(readFileSync(path.join(dir, "implement-1.prompt.md"), "utf8"), PROMPT);
});

// ---------- signals, stdin, stdio-holding children ----------

for (const signal of ["SIGTERM", "SIGINT"]) {
  test(`POSIX: ${signal} to the runner while a check runs kills the step's process and logs an end event`, POSIX_ONLY, async (t) => {
    const c = setup(t);
    const h = helper(c);
    const { argv, pidFile } = h.argv("hang", "step");
    const r = spawnRunner(c, { steps: [{ id: "check", type: "check", argv, timeoutSec: 60 }] });
    assert.ok(await until(() => existsSync(pidFile), 5000), "the check step started");
    const pid = h.readPid(pidFile);
    r.child.kill(signal);
    const exit = await Promise.race([r.exited, sleep(5000).then(() => null)]);
    assert.ok(exit, `the runner exited within 5 s of ${signal}`);
    assert.notEqual(exit.code, 0, "the runner does not report a clean exit");
    await until(() => !pidAlive(pid), 3000);
    assert.equal(pidAlive(pid), false, `step process ${pid} still running after the runner exited on ${signal}`);
    assert.equal(events(readLog(r.logPath), "end").length, 1, `the log has an end event after ${signal}`);
  });
}

test("an agent that exits without reading a prompt larger than the pipe buffer does not crash the runner: the limit swaps and the check runs", (t) => {
  const c = setup(t);
  const prompt = "x".repeat(300_000);
  const quick = { argv: [node, "-e", "process.stderr.write('Error: You exceeded your usage limit\\n'); process.exitCode = 1;"], stdin: "prompt" };
  const r = c.run(c.wf([c.agent({ model: "quick", prompt }), c.check("pass")], { models: { quick, b: c.model("ok", "b") }, swapOrder: ["quick", "b"] }));
  assert.doesNotMatch(r.stderr, /Unhandled 'error'|EPIPE/, "the runner did not crash on the closed stdin");
  assert.ok(r.result, `one JSON result line on stdout (stdout: ${JSON.stringify(r.stdout)})`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.result.status, "success");
  const swaps = events(r.log, "swap");
  assert.deepEqual(swaps.map((s) => [s.step, s.from, s.to, s.reason]), [["implement", "quick", "b", "limit"]]);
  assert.deepEqual(c.records().map((x) => x.label ?? x.kind), ["b", "check"]);
  assert.equal(c.records("worker")[0].stdin.length, prompt.length, "the next model got the whole prompt");
});

test("a check that exits 0 leaving a background child on its stdout passes at once, and the child is killed after the step", async (t) => {
  const c = setup(t);
  const h = helper(c);
  const { argv, pidFile } = h.argv("background", "bg");
  const t0 = Date.now();
  const r = c.run({ steps: [{ id: "check", type: "check", argv, timeoutSec: 3 }] });
  const ms = Date.now() - t0;
  const [att] = events(r.log, "attempt");
  assert.deepEqual([att?.exit, att?.outcome], [0, "pass"], `the check attempt is a pass, not a timeout (${JSON.stringify(att)})`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.result.status, "success");
  assert.ok(ms < 2500, `the run took ${ms} ms against a 3000 ms step timeout`);
  if (process.platform !== "win32") {
    const pid = h.readPid(pidFile);
    assert.ok(pid, "the background child started");
    await until(() => !pidAlive(pid), 3000);
    assert.equal(pidAlive(pid), false, `background child ${pid} still running after the step`);
  }
});

// ---------- check out of reach: relative argv[0] ----------

test("POSIX: an agent edit of a relative check argv[0] ends --repo and --cwd runs check-tampered, as when the runner starts in the repo", POSIX_ONLY, (t) => {
  const c = setup(t);
  const { repo, git } = initRepo(c, { "check.sh": { body: "#!/bin/sh\nexit 0\n", mode: 0o755 } });
  const wf = c.wf([c.agent(), { id: "check", type: "check", argv: ["./check.sh"], timeoutSec: 2 }], { models: { fake: c.model("tamper=./check.sh", "fake") } });
  const repoRun = c.run(wf, ["--repo", repo]);
  if (repoRun.result?.worktree) c.extraCleanup.unshift(() => spawnSync("git", ["-C", repo, "worktree", "remove", "--force", repoRun.result.worktree]));
  const cwdRun = c.run(wf, ["--cwd", repo]);
  git("checkout", "--", "check.sh");
  const control = c.run(wf, [], { cwd: repo });
  const statuses = { repo: repoRun.result?.status, cwd: cwdRun.result?.status, control: control.result?.status };
  assert.deepEqual(statuses, { repo: "check-tampered", cwd: "check-tampered", control: "check-tampered" });
  assert.deepEqual(c.records("check"), [], "no tampered check ran");
});

// ---------- resume and up-front rejection ----------

test("resuming after a gate keeps the pre-gate events in run.ndjson", (t) => {
  const c = setup(t);
  const env = { CONDUCT_RUN_ID: "rid-resume" };
  const wf = c.wf([c.agent(), c.check("pass"), { id: "ship", type: "gate" }, c.check("pass", { id: "post" })]);
  assert.equal(c.run(wf, [], { env, log: false }).status, 3);
  const go = c.run(wf, ["--from", "ship", "--approved", "Marcin: ok"], { env, log: false });
  assert.equal(go.status, 0, go.stderr);
  const log = readLog(path.join(c.home, "runs", "rid-resume", "run.ndjson"));
  assert.equal(kindOf(log[0]), "start");
  assert.deepEqual(events(log, "attempt").map((e) => e.step), ["implement", "check", "post"], "attempts from both invocations");
  assert.equal(events(log, "approval").length, 1);
  assert.equal(kindOf(log.at(-1)), "end");
  assert.equal(log.at(-1).status, "success");
});

test("--from naming a step that is not a gate with --repo exits 2 before creating a worktree or a run log", (t) => {
  const c = setup(t);
  const { repo, git } = initRepo(c, { "a.txt": "a\n" });
  const before = git("worktree", "list", "--porcelain");
  const r = c.run(c.wf([c.agent(), c.check(), { id: "ship", type: "gate" }]), ["--repo", repo, "--from", "check", "--approved", "Marcin: ok"]);
  assert.equal(r.status, 2, r.stderr);
  assert.equal(git("worktree", "list", "--porcelain"), before, "no worktree was added");
  assert.equal(existsSync(r.logPath), false, "no --log file was written");
  const runsDir = path.join(c.home, "runs");
  assert.deepEqual(existsSync(runsDir) ? readdirSync(runsDir) : [], [], "no run dir was created");
});

test("an agent promptFile that does not exist exits 2 before any step runs", (t) => {
  const c = setup(t);
  const r = c.run(c.wf([c.check("pass", { id: "pre" }), c.agent({ prompt: undefined, promptFile: path.join(c.root, "missing.md") }), c.check()]));
  assertRejected(c, r, "missing promptFile");
  assert.deepEqual(events(r.log, "attempt"), []);
});
