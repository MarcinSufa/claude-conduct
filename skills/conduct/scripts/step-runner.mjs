#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync, statSync, lstatSync, readlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { homeRoot } from "./lib/events-store.mjs";

const DEFAULT_SWAP = ["luna", "opus", "grok"];
const BUILT_INS = {
  luna: { argv: ["codex", "exec", "-m", "gpt-6-luna", "-c", "model_reasoning_effort={effort}", "--skip-git-repo-check", "--sandbox", "workspace-write", "-C", "{cwd}", "-"], stdin: "prompt", effort: "high" },
  opus: { argv: ["claude", "-p", "--model", "opus", "--effort", "{effort}", "--permission-mode", "bypassPermissions", "--output-format", "text"], stdin: "prompt", effort: "medium" },
  grok: { argv: ["grok", "-m", "grok-4.6", "--prompt-file", "{promptFile}", "--cwd", "{cwd}", "--reasoning-effort", "{effort}", "--permission-mode", "bypassPermissions", "--max-turns", "80", "--output-format", "plain"], stdin: "none", effort: "high" },
};
const LIMIT = /usage limit|rate.?limit(?:ed| reached| exceeded)|\b429 Too Many Requests\b|quota (?:exceeded|reached)|exceeded your (?:current )?quota|insufficient credit|spending limit|payment required/i;
const issue = (s) => { const err = new Error(s); err.name = "WorkflowError"; throw err; };
const isInt = (v) => Number.isInteger(v);
const shellQuote = (v) => /^[A-Za-z0-9_./:=@%+-]+$/.test(String(v)) ? String(v) : process.platform === "win32" ? `"${String(v).replaceAll('"', '""')}"` : `'${String(v).replaceAll("'", "'\\''")}'`;

export function validateWorkflow(wf) {
  if (!wf || typeof wf !== "object" || !Array.isArray(wf.steps) || wf.steps.length === 0) issue("steps must be a non-empty array");
  if (wf.models !== undefined && (!wf.models || typeof wf.models !== "object" || Array.isArray(wf.models))) issue("models must be an object");
  const models = { ...BUILT_INS, ...(wf.models ?? {}) };
  const ids = new Map();
  wf.steps.forEach((s, i) => {
    if (!s || typeof s !== "object" || typeof s.id !== "string" || !s.id.trim()) issue(`step ${i + 1} needs a non-empty id`);
    if (ids.has(s.id)) issue(`duplicate step id ${s.id}`);
    ids.set(s.id, i);
    if (!["agent", "check", "gate"].includes(s.type)) issue(`step ${s.id} has unknown type`);
    if (s.timeoutSec !== undefined && (!isInt(s.timeoutSec) || s.timeoutSec <= 0)) issue(`step ${s.id} timeoutSec must be a positive integer`);
    if (s.onFail !== undefined && s.type !== "check") issue(`onFail is only valid on check ${s.id}`);
    if (s.type === "agent") {
      if (typeof s.model !== "string" || !Object.hasOwn(models, s.model)) issue(`step ${s.id} has unknown model ${s.model}`);
      if ((typeof s.prompt === "string") === (typeof s.promptFile === "string")) issue(`agent ${s.id} needs exactly one string prompt or promptFile`);
      if (s.effort !== undefined && typeof s.effort !== "string") issue(`agent ${s.id} effort must be a string`);
      if (i + 1 >= wf.steps.length || wf.steps[i + 1].type !== "check") issue(`agent ${s.id} must be followed by a check`);
    }
    if (s.type === "check") {
      const hasArgv = s.argv !== undefined, hasCommand = s.command !== undefined;
      if (hasArgv === hasCommand) issue(`check ${s.id} needs exactly one of argv or command`);
      if (hasArgv && (!Array.isArray(s.argv) || !s.argv.length || s.argv.some((a) => typeof a !== "string"))) issue(`check ${s.id} argv must be a non-empty string array`);
      if (hasCommand && typeof s.command !== "string") issue(`check ${s.id} command must be a string`);
      if (s.protect !== undefined && (!Array.isArray(s.protect) || !s.protect.length || s.protect.some((p) => typeof p !== "string" || !p.trim()))) issue(`check ${s.id} protect must be a non-empty string array`);
      if (s.onFail !== undefined) {
        const f = s.onFail;
        if (!f || typeof f !== "object" || typeof f.retry !== "string" || !isInt(f.max) || f.max < 0) issue(`check ${s.id} onFail needs retry and non-negative integer max`);
        if (!ids.has(f.retry) || ids.get(f.retry) >= i) issue(`check ${s.id} retry must name an earlier step`);
        if (f.retryOn !== undefined && (!Array.isArray(f.retryOn) || !f.retryOn.length || f.retryOn.some((x) => !isInt(x)))) issue(`check ${s.id} retryOn must be a non-empty integer array`);
      }
    }
    if (s.type === "gate" && (s.prompt !== undefined && typeof s.prompt !== "string")) issue(`gate ${s.id} prompt must be a string`);
  });
  for (const [name, model] of Object.entries(models)) {
    if (!model || !Array.isArray(model.argv) || !model.argv.length || model.argv.some((x) => typeof x !== "string")) issue(`model ${name} argv must be a non-empty string array`);
    if (model.stdin !== undefined && !["prompt", "none"].includes(model.stdin)) issue(`model ${name} stdin must be prompt or none`);
    if (model.limitPattern !== undefined) {
      if (typeof model.limitPattern !== "string" || !model.limitPattern) issue(`model ${name} limitPattern must be a non-empty string`);
      try { new RegExp(model.limitPattern, "i"); } catch { issue(`model ${name} limitPattern must be a valid regular expression`); }
    }
  }
  if (wf.swapOrder !== undefined && (!Array.isArray(wf.swapOrder) || wf.swapOrder.some((n) => typeof n !== "string" || !Object.hasOwn(models, n)))) issue("swapOrder entries must name models");
  return { models, swapOrder: wf.swapOrder ?? DEFAULT_SWAP };
}

function event(logFile, runId, name, data = {}) {
  const e = { event: name, ts: new Date().toISOString(), runId, ...data };
  appendFileSync(logFile, JSON.stringify(e) + "\n");
  return e;
}

const digest = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
// A link is compared by its target path and, when that is a file, the file's bytes; anything else absent or non-file is null.
function signature(file) {
  try {
    const st = lstatSync(file);
    const content = existsSync(file) && statSync(file).isFile() ? digest(file) : null;
    return st.isSymbolicLink() ? `link:${readlinkSync(file)}:${content}` : content;
  } catch { return null; }
}
function filesUnder(target) {
  try {
    const st = lstatSync(target);
    if (st.isFile() || st.isSymbolicLink()) return [target];
    if (!st.isDirectory()) return [];
  } catch { return [target]; }
  const files = [];
  for (const name of readdirSync(target)) {
    if (name === ".git") continue;
    files.push(...filesUnder(path.join(target, name)));
  }
  return files;
}
function hashChecks(steps, cwd) {
  const hashes = new Map();
  for (const s of steps.filter((x) => x.type === "check")) {
    const files = new Map(), dirs = new Set();
    const add = (file) => { const resolved = path.resolve(cwd, file); files.set(resolved, signature(resolved)); };
    if (s.argv) {
      const exe = resolveExecutable(s.argv[0], cwd);
      if (exe && statSync(exe).isFile()) add(exe);
      for (const arg of s.argv.slice(1)) if (!arg.includes("{")) {
        const candidate = path.resolve(cwd, arg);
        try { if (statSync(candidate).isFile()) add(candidate); } catch {}
      }
    }
    for (const item of s.protect ?? []) {
      const target = path.resolve(cwd, item);
      try { if (statSync(target).isDirectory()) dirs.add(target); } catch {}
      for (const file of filesUnder(target)) add(file);
    }
    hashes.set(s.id, { files, dirs });
  }
  return hashes;
}

function resolveExecutable(exe, cwd = process.cwd()) {
  if (!exe || exe.includes("{")) return null;
  const extensions = process.platform === "win32" && !path.extname(exe) ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";") : [""];
  const hasPath = exe.includes("/") || exe.includes("\\");
  const dirs = path.isAbsolute(exe) || hasPath ? [path.resolve(cwd, exe)] :
    (process.env.PATH ?? "").split(path.delimiter).flatMap((p) => extensions.map((ext) => path.join(p, exe + ext)));
  return dirs.find((p) => { try { return existsSync(p) && readFileSync(p).length >= 0; } catch { return false; } }) ?? null;
}

function checksUnchanged(before) {
  for (const { files, dirs } of before.values()) {
    for (const [file, hash] of files) {
      if (hash === null ? existsSync(file) : signature(file) !== hash) return false;
    }
    for (const dir of dirs) {
      for (const file of filesUnder(dir)) if (!files.has(path.resolve(file))) return false;
    }
  }
  return true;
}

function killTree(child, force = false) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  } else {
    try { process.kill(-child.pid, "SIGKILL"); } catch { if (force) { try { child.kill("SIGKILL"); } catch {} } }
  }
}

function killWindowsDescendants(pid, started) {
  // ponytail: Best-effort cleanup cannot follow chains through exited parents; Job Objects are the upgrade path.
  const script = "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate | Select-Object ProcessId,ParentProcessId,@{Name='CreationDate';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress";
  const query = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 10_000 });
  if (query.error || query.status !== 0 || !query.stdout) return query.error?.message ?? (query.signal ? `process query timed out or was terminated (${query.signal})` : `process query failed with status ${query.status}`);
  try {
    const rows = JSON.parse(query.stdout);
    const processes = Array.isArray(rows) ? rows : [rows];
    const byId = new Map(processes.map((p) => [Number(p.ProcessId), p]));
    const rootStarted = new Date(byId.get(pid)?.CreationDate ?? started);
    const descendants = processes.filter((p) => {
      if (!p.CreationDate || Number.isNaN(new Date(p.CreationDate).getTime()) || new Date(p.CreationDate) < rootStarted) return false;
      let parent = Number(p.ParentProcessId), childDate = new Date(p.CreationDate);
      const seen = new Set();
      while (parent && !seen.has(parent)) {
        if (parent === pid) return true;
        seen.add(parent);
        const parentProcess = byId.get(parent);
        if (!parentProcess?.CreationDate || Number.isNaN(new Date(parentProcess.CreationDate).getTime()) || new Date(parentProcess.CreationDate) > childDate) return false;
        childDate = new Date(parentProcess.CreationDate);
        parent = Number(parentProcess.ParentProcessId);
      }
      return false;
    });
    for (const p of descendants) spawnSync("taskkill", ["/pid", String(p.ProcessId), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    return null;
  } catch (err) { return `could not parse process query: ${err.message}`; }
}

function runChild(argv, opts) {
  return new Promise((resolve) => {
    let command = argv[0], args = argv.slice(1);
    if (process.platform === "win32" && !command.includes("/") && !command.includes("\\")) command = resolveExecutable(command, opts.cwd) ?? command;
    if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command)) {
      const quote = (s) => `"${String(s).replace(/(\\*)"/g, "$1$1\\\"").replace(/\\+$/, "$&$&")}"`;
      args = ["/d", "/s", "/c", `"${[command, ...args].map(quote).join(" ")}"`];
      command = process.env.ComSpec || "cmd.exe";
    }
    const windowsVerbatimArguments = process.platform === "win32" && command === (process.env.ComSpec || "cmd.exe") || opts.windowsVerbatimArguments;
    if (opts.signalCode?.()) { resolve({ exit: 1, output: "", timedOut: false, interrupted: true }); return; }
    const child = spawn(command, args, {
      cwd: opts.cwd, env: opts.env, stdio: [opts.stdin === "none" ? "ignore" : "pipe", "pipe", "pipe"],
      detached: process.platform !== "win32", windowsHide: true, windowsVerbatimArguments,
    });
    const outputChunks = [], outputLimit = 256 * 1024;
    let outputBytes = 0, timedOut = false, closed = false, exitCode, timer, grace;
    const rootStarted = new Date();
    const finish = (code) => {
      if (closed) return; closed = true; clearTimeout(timer); clearTimeout(grace);
      for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.destroy();
      resolve({ exit: timedOut ? 124 : (code ?? 1), output: Buffer.concat(outputChunks, outputBytes).toString(), timedOut, interrupted: Boolean(opts.signalCode?.()) });
    };
    const append = (chunk) => {
      appendFileSync(opts.outputFile, chunk);
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputChunks.push(bytes);
      outputBytes += bytes.length;
      if (outputBytes > outputLimit * 2) {
        let trim = outputBytes - outputLimit;
        while (trim > 0) {
          if (outputChunks[0].length <= trim) trim -= outputChunks.shift().length;
          else { outputChunks[0] = outputChunks[0].subarray(trim); trim = 0; }
        }
        outputBytes = outputLimit;
      }
    };
    child.stdout.on("data", append); child.stderr.on("data", append);
    child.on("error", (err) => { append(Buffer.from(err.message)); });
    child.stdin?.on("error", () => {});
    opts.setChild?.(child);
    if (opts.stdin !== "none") child.stdin.end(opts.input);
    timer = setTimeout(() => { timedOut = true; killTree(child, true); clearTimeout(grace); grace = setTimeout(() => finish(124), 2000); }, opts.timeoutSec * 1000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      exitCode = code;
      if (process.platform !== "win32") killTree(child);
      else if (opts.onWarning) {
        const warning = killWindowsDescendants(child.pid, rootStarted);
        if (warning) opts.onWarning(warning);
      }
      clearTimeout(grace); grace = setTimeout(() => finish(exitCode), 2000);
    });
    child.on("close", (code) => {
      if (process.platform !== "win32") killTree(child);
      finish(exitCode ?? code);
    });
  });
}

function workspaceChanges(cwd, base) {
  if (!base) return "";
  const git = (...a) => spawnSync("git", ["-C", cwd, ...a], { encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 }).stdout ?? "";
  const diff = git("diff", base), untracked = git("ls-files", "--others", "--exclude-standard");
  if (!diff && !untracked) return "";
  const shown = diff.length > 8000 ? `${diff.slice(0, 8000)}\n[diff truncated, ${diff.length} chars in total]\n` : diff;
  return `\n\n## Your changes so far\nEarlier attempts in this run already changed the workspace. Build on them, do not redo them.\n\`\`\`diff\n${shown}\`\`\`\n${untracked ? `Untracked files:\n${untracked}` : ""}`;
}

function promptFor(step, workflowDir, retry) {
  let prompt = step.prompt;
  if (step.promptFile) prompt = readFileSync(path.resolve(workflowDir, step.promptFile), "utf8");
  return prompt + (retry?.changes ?? "") + (retry ?`\n\n## Check result (attempt ${retry.n})\nThe check \`${retry.check}\` (${retry.description}) exited ${retry.exit}. You cannot change the check or its files; changing them ends the run.\n\`\`\`\n${retry.output.slice(-4000)}\n\`\`\`\nDo not ask questions. Fix the code so the check passes, or exit with a one-line reason why you cannot.` : "");
}

export async function runWorkflow(wf, options = {}) {
  const { models, swapOrder } = validateWorkflow(wf);
  if (options.approved && !options.from) issue("--approved requires --from");
  let at = -1;
  if (options.from) {
    at = wf.steps.findIndex((s) => s.id === options.from);
    if (at < 0 || wf.steps[at].type !== "gate" || !options.approved) issue("--from must name a gate and include --approved text");
  }
  const workflowPath = options.workflowPath ?? path.resolve("workflow.json");
  if (options.from && !(options.runId || process.env.CONDUCT_RUN_ID)) issue("--from requires --run-id or CONDUCT_RUN_ID");
  for (const s of wf.steps) if (s.type === "agent" && s.promptFile) {
    const promptPath = path.resolve(path.dirname(workflowPath), s.promptFile);
    if (!existsSync(promptPath) || !statSync(promptPath).isFile()) issue(`missing promptFile ${s.promptFile}`);
  }
  const runId = options.runId || process.env.CONDUCT_RUN_ID || randomUUID();
  if (!/^[A-Za-z0-9._-]+$/.test(runId) || /^\.+$/.test(runId)) issue(`run id ${JSON.stringify(runId)} may use only letters, digits, dot, underscore and hyphen`);
  const runDir = path.join(homeRoot(), "runs", runId);
  const logFile = options.log ?? path.join(runDir, "run.ndjson");
  let prior = [], state;
  if (options.from) {
    try { prior = readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)); }
    catch { issue(`--from run ${runId} has no valid run log`); }
    const lastEnd = prior.filter((e) => e.event === "end").at(-1), start = prior.find((e) => e.event === "start");
    if (start?.workflowHash && start.workflowHash !== digest(workflowPath)) issue(`--from run ${runId}: the workflow file changed since the run started`);
    if (!start || lastEnd?.status !== "gate" || lastEnd.step !== options.from) issue(`--from gate ${options.from} was not the last gate stop for run ${runId}`);
    try { state = JSON.parse(readFileSync(path.join(runDir, "state.json"), "utf8")); }
    catch { issue(`--from run ${runId} is missing a valid state.json`); }
  }
  const started = Date.now();
  let cwd = options.cwd ?? process.cwd(), worktree;
  if (options.repo) {
    worktree = path.join(os.tmpdir(), "conduct-runs", runId);
    mkdirSync(path.dirname(worktree), { recursive: true });
    const git = spawnSync("git", ["-C", options.repo, "worktree", "add", "--detach", worktree, "HEAD"], { encoding: "utf8", windowsHide: true });
    if (git.status !== 0) throw new Error((git.stderr || "git worktree add failed").trim());
    cwd = worktree;
  }
  mkdirSync(runDir, { recursive: true });
  mkdirSync(path.dirname(logFile), { recursive: true });
  if (!options.from) writeFileSync(logFile, "");
  const runs = Object.fromEntries(wf.steps.map((s) => [s.id, 0]));
  const existingFiles = options.from && existsSync(runDir) ? readdirSync(runDir) : [];
  const priorRuns = Object.fromEntries(wf.steps.map((step) => {
    const pattern = new RegExp(`^${step.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(\\d+)\\.(?:log|prompt\\.md)$`);
    const prior = existingFiles.map((name) => pattern.exec(name)).filter(Boolean).reduce((max, match) => Math.max(max, Number(match[1])), 0);
    return [step.id, prior];
  }));
  const retries = Object.create(null), currentModel = Object.create(null), retryInfo = Object.create(null);
  for (const s of wf.steps) if (s.type === "agent") currentModel[s.id] = s.model;
  let base = null;
  if (options.from) {
    Object.assign(retries, state.retries ?? {});
    Object.assign(currentModel, state.currentModel ?? {});
    base = state.base ?? null;
  }
  if (!options.from) {
    const head = spawnSync("git", ["-C", cwd, "rev-parse", "--verify", "HEAD"], { encoding: "utf8", windowsHide: true });
    base = head.status === 0 ? head.stdout.trim() : null;
    const checks = Object.fromEntries([...hashChecks(wf.steps, cwd)].map(([id, snapshot]) => [id, Object.fromEntries([...snapshot.files].map(([file, hash]) => [path.relative(cwd, file) || ".", hash]))]));
    event(logFile, runId, "start", { workflow: workflowPath, cwd, ...(worktree ? { worktree } : {}), workflowHash: digest(workflowPath), base, checks });
  }
  let idx = 0, final = { status: "success", runs };
  if (options.from) {
    event(logFile, runId, "approval", { step: options.from, approved: options.approved });
    idx = at + 1;
  }
  while (idx < wf.steps.length) {
    if (signalCode) { final = { status: "interrupted", runs }; break; }
    const step = wf.steps[idx];
    if (step.type === "gate") {
      const command = `node ${shellQuote(fileURLToPath(import.meta.url))} ${shellQuote(workflowPath)} --cwd ${shellQuote(cwd)} --from ${shellQuote(step.id)} --approved ${shellQuote("<who: text>")}${options.log ? ` --log ${shellQuote(options.log)}` : ""}`;
      const resume = `${command} --run-id ${shellQuote(runId)}`;
      writeFileSync(path.join(runDir, "state.json"), JSON.stringify({ retries, currentModel, base }, null, 2));
      final = { status: "gate", step: step.id, resume, runs }; break;
    }
    const n = ++runs[step.id] + priorRuns[step.id], begin = Date.now();
    const before = step.type === "agent" ? hashChecks(wf.steps, cwd) : null;
    const modelName = step.type === "agent" ? currentModel[step.id] : null;
    const model = modelName ? models[modelName] : null;
    const effort = step.type === "agent" ? (step.effort ?? model.effort ?? "medium") : undefined;
    let input = "", argv;
    if (step.type === "agent") {
      input = promptFor(step, path.dirname(workflowPath), retryInfo[step.id]);
      const promptFile = path.join(runDir, `${step.id}-${n}.prompt.md`);
      writeFileSync(promptFile, input);
      argv = model.argv.map((a) => a.replaceAll("{cwd}", cwd).replaceAll("{effort}", effort).replaceAll("{promptFile}", promptFile));
      if (process.platform === "win32" && modelName === "grok") {
        const grokExe = path.join(os.homedir(), ".grok", "bin", "grok.exe");
        if (existsSync(grokExe)) argv[0] = grokExe;
      }
    } else if (step.argv) argv = step.argv;
    else argv = process.platform === "win32" ? [process.env.ComSpec || "cmd.exe", "/d", "/s", "/c", `"${step.command}"`] : ["/bin/sh", "-c", step.command];
    const outputFile = path.join(runDir, `${step.id}-${n}.log`);
    writeFileSync(outputFile, "");
    if (signalCode) { final = { status: "interrupted", runs }; break; }
    const result = await runChild(argv, { cwd, env: { ...process.env, CONDUCT_RUN_ID: runId }, stdin: step.type === "agent" ? (model.stdin ?? "prompt") : "none", input, timeoutSec: step.timeoutSec ?? (step.type === "agent" ? 1800 : 600), outputFile, setChild: (child) => { liveChild = child; }, onWarning: (message) => event(logFile, runId, "warning", { message }), signalCode: () => signalCode });
    const limitPattern = model?.limitPattern ? new RegExp(model.limitPattern, "i") : LIMIT;
    const outcome = result.timedOut ? "timeout" : step.type === "agent" && result.exit !== 0 && limitPattern.test(result.output.slice(-4000)) ? "limit" : result.exit === 0 ? "pass" : "fail";
    const attempt = { step: step.id, type: step.type, n, ...(modelName ? { model: modelName, effort } : {}), argv, exit: result.exit, outcome, ms: Date.now() - begin };
    if (step.type === "agent" && base) {
      const diff = spawnSync("git", ["-C", cwd, "diff", base], { encoding: "buffer", windowsHide: true, maxBuffer: 64 * 1024 * 1024 }).stdout ?? Buffer.alloc(0);
      const untracked = spawnSync("git", ["-C", cwd, "ls-files", "--others", "--exclude-standard"], { encoding: "utf8", windowsHide: true }).stdout ?? "";
      attempt.diffHash = createHash("sha256").update(diff).digest("hex");
      attempt.untracked = untracked.split(/\r?\n/).filter(Boolean).length;
    }
    event(logFile, runId, "attempt", attempt);
    liveChild = null;
    if (result.interrupted) { final = { status: "interrupted", runs }; break; }
    if (step.type === "agent" && !checksUnchanged(before)) { final = { status: "check-tampered", failedStep: step.id, runs }; break; }
    if (step.type === "agent" && ["timeout", "limit"].includes(outcome)) {
      const at = swapOrder.indexOf(modelName);
      if (at < 0 || at + 1 >= swapOrder.length) { final = { status: "no-model", failedStep: step.id, runs }; break; }
      const next = swapOrder[at + 1];
      event(logFile, runId, "swap", { step: step.id, from: modelName, to: next, reason: outcome });
      currentModel[step.id] = next;
      continue;
    }
    if (step.type === "check" && result.exit !== 0) {
      const f = step.onFail;
      const allowed = f && (!f.retryOn || f.retryOn.includes(result.exit));
      if (f && retries[step.id] === undefined) retries[step.id] = 0;
      if (allowed && retries[step.id] < f.max) {
        retries[step.id]++;
        const retry = wf.steps.find((s) => s.id === f.retry);
        const output = result.output;
        retryInfo[retry.id] = { n: runs[step.id], check: step.id, description: step.argv ? step.argv.join(" ") : step.command, exit: result.exit, output, changes: workspaceChanges(cwd, base) };
        event(logFile, runId, "retry", { check: step.id, n: retries[step.id], to: f.retry });
        idx = idsIndex(wf.steps, f.retry); continue;
      }
      if (allowed) final = { status: "exhausted", message: `loop exhausted after ${runs[step.id]}`, runs };
      else final = { status: "failed", failedStep: step.id, runs };
      break;
    }
    idx++;
  }
  final.ms = Date.now() - started;
  event(logFile, runId, "end", final);
  return { ...final, runId, worktree: worktree ?? null };
}

const idsIndex = (steps, id) => steps.findIndex((s) => s.id === id);
let liveChild = null, signalCode = 0;

function parseArgs(args) {
  if (!args.length) throw new Error("usage: step-runner.mjs <workflow.json> [--repo dir | --cwd dir] [--from id --approved text] [--run-id id] [--log file]");
  const out = { workflow: args[0] };
  for (let i = 1; i < args.length; i++) {
    const key = args[i];
    if (!["--repo", "--cwd", "--from", "--approved", "--run-id", "--log"].includes(key) || !args[i + 1]) throw new Error(`invalid argument ${key}`);
    out[key.slice(2)] = args[++i];
  }
  if (out.repo && out.cwd) throw new Error("--repo and --cwd cannot be combined");
  return out;
}

async function main() {
  let args, result;
  try {
    args = parseArgs(process.argv.slice(2));
    const file = path.resolve(args.workflow);
    let wf;
    try { wf = JSON.parse(readFileSync(file, "utf8")); } catch (err) { err.name = "WorkflowError"; throw err; }
    const handlers = new Map([["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]);
    const listeners = new Map([...handlers].map(([signal, code]) => {
      const listener = () => { signalCode = code; if (liveChild) killTree(liveChild, true); };
      process.on(signal, listener);
      return [signal, listener];
    }));
    result = await runWorkflow(wf, { workflowPath: file, repo: args.repo, cwd: args.cwd ? path.resolve(args.cwd) : undefined, from: args.from, approved: args.approved, runId: args["run-id"], log: args.log ? path.resolve(args.log) : undefined });
    for (const [signal, listener] of listeners) process.off(signal, listener);
    process.stdout.write(JSON.stringify(result) + "\n");
    process.exitCode = result.status === "success" ? 0 : result.status === "gate" ? 3 : signalCode || 1;
  } catch (err) {
    process.stderr.write(`${err.name === "WorkflowError" ? "step-runner: invalid workflow: " : "step-runner: "}${err.message}\n`);
    process.exitCode = err.name === "WorkflowError" || err.message.startsWith("invalid argument") || err.message.startsWith("usage:") || err.message === "--repo and --cwd cannot be combined" ? 2 : 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
