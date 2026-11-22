import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("./dispatch-guard.mjs", import.meta.url));
const DENY = {
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: "dispatch-guard: codex/grok dispatch outside a step-runner run (CONDUCT_RUN_ID unset); start it through step-runner.mjs",
  },
};

const envWithout = () => { const e = { ...process.env }; delete e.CONDUCT_RUN_ID; return e; };
const envWith = () => ({ ...envWithout(), CONDUCT_RUN_ID: "run-1" });
const hook = (input, env = envWithout()) => spawnSync(process.execPath, [cli], { input, env, encoding: "utf8", timeout: 10_000 });
const payload = (tool_name, tool_input, extra = {}) => JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s", cwd: process.cwd(), tool_name, tool_input, ...extra });
const bash = (command, { env, extra } = {}) => hook(payload("Bash", { command }, extra), env);

function assertDeny(r, label) {
  assert.equal(r.status, 0, `${label}: exit (stderr: ${r.stderr})`);
  let out;
  try { out = JSON.parse(r.stdout); } catch { assert.fail(`${label}: expected deny JSON, got ${JSON.stringify(r.stdout)}`); }
  assert.deepEqual(out, DENY, label);
}
function assertAllow(r, label) {
  assert.equal(r.status, 0, `${label}: exit (stderr: ${r.stderr})`);
  assert.equal(r.stdout, "", `${label}: allowed means no output`);
}

const quote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
const nest = (cmd, levels) => { let c = cmd; for (let k = 0; k < levels; k++) c = `bash -c ${quote(c)}`; return c; };

const E1_FORMS = [
  "codex exec x", 'bash -c "codex exec x"', "env codex exec x", "/usr/local/bin/codex exec x",
  "npx codex exec x", "codex -m x exec y", "codex e x", "xargs codex exec",
];
const MORE_DENY = ["grok -p x", "CONDUCT_RUN_ID=1 codex exec x", "echo hi && codex exec x", "(codex exec x)", "$(codex exec x)"];
const SPEC_ALLOW = ["codex --version", "codex login status", "grok --help", "echo codex", 'git commit -m "codex exec"', "grep -r grok .", "cat docs/codex.md"];

test("the E1 base form and all 7 E1 bypasses are denied without CONDUCT_RUN_ID", () => {
  for (const c of E1_FORMS) assertDeny(bash(c), c);
});

test("grok -p, an inline CONDUCT_RUN_ID=1 assignment, && chains, subshells and $() substitutions are denied", () => {
  for (const c of MORE_DENY) assertDeny(bash(c), c);
});

test("the deny reason names CONDUCT_RUN_ID and step-runner.mjs", () => {
  const out = JSON.parse(bash("codex exec x").stdout);
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /CONDUCT_RUN_ID/);
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /step-runner\.mjs/);
});

test("the spec's allow list passes without CONDUCT_RUN_ID", () => {
  for (const c of SPEC_ALLOW) assertAllow(bash(c), c);
});

test("version, help, login/logout and grok models are not dispatches", () => {
  for (const c of ["codex -V", "codex -h", "codex help", "codex --help", "codex login", "codex login --api-key x", "codex logout",
    "grok --version", "grok -V", "grok -h", "grok help", "grok login", "grok models"]) assertAllow(bash(c), c);
});

test("models is exempt only for grok: codex models is a dispatch", () => {
  assertDeny(bash("codex models"), "codex models");
});

test("every deny form is allowed when CONDUCT_RUN_ID is set in the hook env", () => {
  for (const c of [...E1_FORMS, ...MORE_DENY]) assertAllow(bash(c, { env: envWith() }), c);
});

test("a subagent payload (agent_id) without CONDUCT_RUN_ID is still denied", () => {
  assertDeny(bash("codex exec x", { extra: { agent_id: "a1", agent_type: "general-purpose" } }), "subagent codex");
  assertDeny(bash("grok -p x", { extra: { agent_id: "a1" } }), "subagent grok");
});

test("the executable is the lowercased basename with .exe/.cmd stripped", () => {
  for (const c of ["CODEX exec x", "codex.exe exec x", "Codex.EXE exec x", "codex.cmd exec x", "./bin/grok.exe -p x", "/opt/x/grok -p x"]) assertDeny(bash(c), c);
});

test("npx, pnpm dlx, bunx and the @openai/codex package name count as codex", () => {
  for (const c of ["pnpm dlx codex exec x", "bunx codex exec x", "npx @openai/codex exec x", "npx -y @openai/codex exec x"]) assertDeny(bash(c), c);
});

test("sh, zsh, dash and bash -c code is parsed recursively", () => {
  for (const c of ["sh -c 'codex exec x'", 'zsh -c "grok -p x"', "dash -c 'echo a; codex exec x'", nest("codex exec x", 2)]) assertDeny(bash(c), c);
  for (const c of ["bash -c 'echo hi'", "sh -c 'echo codex'", nest("echo hi", 2)]) assertAllow(bash(c), c);
});

test("shell nesting deeper than 3 levels is denied even when the innermost command is harmless", () => {
  assertDeny(bash(nest("echo hi", 5)), "5 levels");
});

test("inline interpreter code that mentions codex or grok is denied; other inline code is allowed", () => {
  for (const c of [`node -e "require('child_process').spawn('codex')"`, `python3 -c "import os; os.system('grok -p x')"`, `perl -e 'system("codex exec x")'`]) assertDeny(bash(c), c);
  for (const c of ['node -e "console.log(1)"', "python3 -c 'print(2)'"]) assertAllow(bash(c), c);
});

test("an unparseable command is denied when it mentions codex or grok and allowed otherwise", () => {
  for (const c of ['echo "codex', "grok -p 'x"]) assertDeny(bash(c), c);
  assertAllow(bash('echo "hi'), "unterminated quote without codex/grok");
});

test("non-Bash tools are allowed", () => {
  assertAllow(hook(payload("Write", { file_path: "run.sh", content: "codex exec x" })), "Write");
  assertAllow(hook(payload("Edit", { file_path: "a.sh", old_string: "a", new_string: "codex exec x" })), "Edit");
  assertAllow(hook(payload("Read", { file_path: "docs/codex.md" })), "Read");
});

test("unreadable stdin exits 2", () => {
  assert.equal(hook("not json").status, 2);
  assert.equal(hook("").status, 2);
});
