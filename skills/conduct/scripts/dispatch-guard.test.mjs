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

const SUBAGENT = { agent_id: "a1", agent_type: "general-purpose" };

test("a subagent payload is allowed for non-dispatch tools and commands", () => {
  for (const [label, env] of [["without CONDUCT_RUN_ID", envWithout()], ["with CONDUCT_RUN_ID", envWith()]]) {
    assertAllow(bash("ls", { env, extra: SUBAGENT }), `subagent Bash ls ${label}`);
    assertAllow(bash("grep -rn codex docs", { env, extra: SUBAGENT }), `subagent Bash grep ${label}`);
    assertAllow(hook(payload("Read", { file_path: "docs/a.md" }, SUBAGENT), env), `subagent Read ${label}`);
    assertAllow(hook(payload("Write", { file_path: "a.txt", content: "x" }, SUBAGENT), env), `subagent Write ${label}`);
  }
});

test("a subagent codex dispatch is denied even with CONDUCT_RUN_ID", () => {
  assertDeny(bash("codex exec x", { env: envWith(), extra: SUBAGENT }), "subagent codex with CONDUCT_RUN_ID");
  assertDeny(bash("grok -p x", { env: envWith(), extra: SUBAGENT }), "subagent grok with CONDUCT_RUN_ID");
  assertDeny(bash('bash -c "codex exec x"', { env: envWith(), extra: SUBAGENT }), "subagent bash -c codex with CONDUCT_RUN_ID");
});

const WRAPPER_DENY = [
  'jobq add -g luna --name x -- bash -c "codex exec y"', "jobq add -g luna -- grok -p y",
  "find . -maxdepth 0 -exec codex exec y \;", 'echo "codex exec y" | bash', 'echo "grok -p y" | sh',
  "c=codex; $c exec y", 'script -qc "codex exec y" /dev/null', 'eval "codex exec y"',
  "nice -n 5 codex exec y", "flock /tmp/l codex exec y", "timeout 5 codex exec y", "nohup codex exec y",
  "watch codex exec y", "ssh host codex exec y", "parallel codex exec ::: a",
];
const MENTION_ALLOW = [
  "grep -rn codex docs", "rg grok .", "which codex", "git log --grep codex", "ls ~/.codex", "jobq status -g luna",
  'echo "codex exec y"', "cat docs/codex.md | head", 'git commit -m "fix codex wrapper"', "type codex",
  'printf "%s\\n" codex', "head docs/codex.md", "tail -n 5 grok.log", "echo hi | bash", 'eval "echo hi"',
];

test("wrapper commands that run codex or grok are denied", () => {
  for (const c of WRAPPER_DENY) assertDeny(bash(c), c);
});

test("commands that only mention codex or grok stay allowed", () => {
  for (const c of MENTION_ALLOW) assertAllow(bash(c), c);
});

test("command -v codex or grok is a lookup, not a dispatch", () => {
  for (const c of ["command -v grok", "command -v codex"]) assertAllow(bash(c), c);
});

const REPLAY_ALLOW = [
  'pgrep -af "codex exec" | cut -c1-150',
  "pkill -f 'codex exec -m gpt-6-luna'",
  "node hooks/pr-proof-gate.mjs record --writer claude-opus-5-5 --reviewer codex --verdict ok",
  'node hooks/pr-proof-gate.mjs record --reviewer "gpt-6-luna (codex exec)" --verdict ok',
  "for c in node git codex; do printf '%s: ' $c; command -v $c; done",
  'for d in ./*/; do case $d in *x*) continue;; esac; echo "$d"; done; echo "codex limit reset"',
  'set -- codex x; echo "$1"',
  'G=git; $G commit -m "codex exec"',
];
const REPLAY_DENY = ['c="codex exec"; $c y', 'tmux new-session -d -s w "codex exec y"', "jobq add -g luna -- codex exec y"];

test("process lookups, flag values and loop variables that name codex or grok stay allowed", () => {
  for (const c of REPLAY_ALLOW) assertAllow(bash(c), c);
});

test("a variable or tmux session that runs codex is denied", () => {
  for (const c of REPLAY_DENY) assertDeny(bash(c), c);
});

const monitor = (command, { env, extra } = {}) => hook(payload("Monitor", { command, description: "d", timeout_ms: 1000 }, extra), env);
const heredoc = (head, body) => `${head} <<'X'\n${body}\nX`;

const COMBINED_FLAG_DENY = [
  "bash -lc 'codex exec x'", 'bash -ec "codex exec x"', "sh -euc 'grok -p x'", "bash -xc 'grok -p x'", "zsh -ic 'codex exec x'",
  "nohup bash -lc 'codex exec x' > log 2>&1 &", `ssh host 'bash -lc "codex exec x"'`, `python3 -Bc "import os; os.system('codex exec x')"`,
];

test("shell and python -c combined with other short flags (-lc, -ec, -euc, -xc, -ic, -Bc) is inspected", () => {
  for (const c of COMBINED_FLAG_DENY) assertDeny(bash(c), c);
});

test("combined shell flags with harmless code or a script file stay allowed", () => {
  for (const c of ["bash -lc 'ls -la'", 'bash -ec "npm test"', "bash -l script.sh"]) assertAllow(bash(c), c);
});

test("a Monitor command that dispatches codex is denied like Bash, also for a subagent with CONDUCT_RUN_ID", () => {
  assertDeny(monitor("codex exec x"), "Monitor codex");
  assertDeny(monitor("codex exec x", { env: envWith(), extra: SUBAGENT }), "subagent Monitor codex with CONDUCT_RUN_ID");
});

test("a Monitor command is allowed when it does not dispatch, or on the main thread with CONDUCT_RUN_ID", () => {
  assertAllow(monitor("tail -f log"), "Monitor tail");
  assertAllow(monitor("codex exec x", { env: envWith() }), "Monitor codex with CONDUCT_RUN_ID");
});

const DYNAMIC_WORD_DENY = [
  "$(which codex) exec x", '"$(command -v codex)" exec x', "`which codex` exec x",
  "C=$(which codex); $C exec x", "export C=codex; $C exec x", '"${CODEX_BIN:-codex}" exec x',
];

test("a dynamic command word ($(...), backticks, $VAR, ${VAR:-...}) is denied when the command mentions codex or grok", () => {
  for (const c of DYNAMIC_WORD_DENY) assertDeny(bash(c), c);
});

test("a dynamic command word without codex or grok, or a substitution outside command position, stays allowed", () => {
  for (const c of ["$(which node) --version", '"$HOME/bin/tool" run', "echo $(which codex)"]) assertAllow(bash(c), c);
});

test("variables assigned earlier in the command reach eval and bash -c code", () => {
  for (const c of ['CMD="codex exec x"; eval "$CMD"', 'CMD="codex exec x"; bash -c "$CMD"']) assertDeny(bash(c), c);
});

test("a variable holding a harmless command stays allowed through eval", () => {
  assertAllow(bash('CMD="ls"; eval "$CMD"'), 'CMD="ls"; eval "$CMD"');
});

const STDIN_INTERPRETER_CODE = [
  heredoc("python3 -", 'import subprocess\nsubprocess.run(["codex","exec","x"])'),
  heredoc("node --input-type=module", 'import { spawnSync } from "node:child_process";\nspawnSync("codex", ["exec","x"]);'),
  `python3 <<< 'import os; os.system("grok -p x")'`,
];

// A replay of 139.7k real commands found 529 python/node heredocs that edit text naming codex and none that start it.
test("interpreter code on stdin is the documented ceiling, like a script on disk, while shell code on stdin is still inspected", () => {
  for (const c of [...STDIN_INTERPRETER_CODE, heredoc("python3 -", "s=open('README.md').read().replace('codex exec -m x', 'codex exec -m y')")]) assertAllow(bash(c), c);
  assertDeny(bash(heredoc("bash", "codex exec x")), "bash heredoc");
});

test("a dynamic word whose value only names codex inside a path or a sentence stays allowed", () => {
  for (const c of [
    "S=/tmp/claude-1001/-home-agent-work-exo-vault-codex/pad; $S/merge-level.sh a b",
    "G=/tmp/x-codex/gitleaks; $G git --log-opts=x",
    't=$(( $(date +%s) - 1 )); [ $t -lt 0 ] && t=0; sleep $t; echo "codex limit should be reset"',
  ]) assertAllow(bash(c), c);
});

test("harmless interpreter stdin code and a reader heredoc that mentions codex stay allowed", () => {
  for (const c of [heredoc("python3 -", "print(1)"), heredoc("cat", "codex exec x")]) assertAllow(bash(c), c);
});

const RUNNER_DENY = ["pueue add -- codex exec x", "npm exec codex -- exec x", "npm exec -- @openai/codex exec x", "npm x codex exec x", "bun x codex exec x"];

test("pueue add, npm exec, npm x and bun x running codex are dispatches", () => {
  for (const c of RUNNER_DENY) assertDeny(bash(c), c);
});

test("pnpm exec codex stays denied", () => {
  assertDeny(bash("pnpm exec codex exec x"), "pnpm exec codex exec x");
});

test("runners that run something else, and codex --version through npm exec, stay allowed", () => {
  for (const c of ["pueue add -- npm test", "npm exec prettier -- --check .", "npm x tsc", "npm exec codex -- --version"]) assertAllow(bash(c), c);
});

const UNRESOLVABLE_WORD_ALLOW = [
  'G=(git -c user.name=x); "${G[@]}" fetch -q origin main',
  'run() { env "$@" node tools/x.mjs; }; run A=1',
  'eval "$1"',
  'cd w && eval "$@" 2>&1 | grep x',
  '[[ "$s1" =~ ^(Done|Failed)$ ]] && echo ok',
  "s=$(( ${2%:*}*60 + 10#${2#*:} ))",
  '"${PGD%pg_dump}pg_restore" -l "$out"',
  "xargs -P 6 -n 2 sh -c 'A=$(($0+4000)) node tools/x.mjs'",
  'env -u CLAUDE_PLUGIN_ROOT sh -c "${c/bash /ls -la }"',
  '"$@" 2>&1 | tail -1',
];

test("positional, array, pattern and arithmetic words the guard cannot resolve stay allowed when nothing names codex or grok", () => {
  for (const c of UNRESOLVABLE_WORD_ALLOW) assertAllow(bash(c), c);
});

test("arithmetic beside a codex loop word or an exempt grok call is not a substitution that runs codex", () => {
  for (const c of [
    'for t in codex claude; do echo "$t $(( $(date +%s) - 1 ))"; done',
    "end=$(( $(date +%s) + 8*3600 )); until ! grok models 2>&1 | grep -q x; do sleep 60; done",
  ]) assertAllow(bash(c), c);
  for (const c of DYNAMIC_WORD_DENY) assertDeny(bash(c), c);
});

test("a codex or grok path behind an unresolved variable is still a dispatch", () => {
  for (const c of ["$HOME/.local/bin/codex exec x", '"$NVM_BIN/codex" exec x', '"$PWD/node_modules/.bin/grok" -p x']) assertDeny(bash(c), c);
  assertAllow(bash("$HOME/.local/bin/codex --version"), "$HOME/.local/bin/codex --version");
});

test("-c inside any short flag cluster or before other flags runs the first operand as code", () => {
  for (const c of [
    "bash -cl 'codex exec x'", "bash -cx 'codex exec x'", "bash -c -l 'codex exec x'", "bash -c -- 'codex exec x'",
    "bash -o pipefail -c 'codex exec x'", "bash --rcfile f -c 'codex exec x'",
  ]) assertDeny(bash(c), c);
  for (const c of ["bash -cl 'ls -la'", "bash -x ./codex-notes.sh", "bash --norc -c 'pwd'"]) assertAllow(bash(c), c);
});

test("npm and bun commands other than exec, x and bun x that name codex stay allowed", () => {
  for (const c of ["npm install -g @openai/codex", "npm view @openai/codex version", "bun add -g @openai/codex", "npm test -- --grep codex"]) assertAllow(bash(c), c);
});

test("a 70k-character line of substitutions is decided well inside the hook timeout", () => {
  const c = "`true`;".repeat(10_000) + "bash -lc 'codex exec x'";
  const start = Date.now();
  assertDeny(bash(c), "10k backticks then bash -lc");
  assert.ok(Date.now() - start < 5_000, `took ${Date.now() - start} ms`);
});
