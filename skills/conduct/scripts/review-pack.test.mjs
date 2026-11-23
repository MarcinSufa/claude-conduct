import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPack, addNeeds, parseNeeds, reviewerArgs, usageRow, runReview } from "./review-pack.mjs";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" });

function fixtureRepo() {
  const repo = mkdtempSync(join(tmpdir(), "rp-repo-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "t");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src/small.ts"), "export const a = 1;\n");
  const big = Array.from({ length: 400 }, (_, i) => `function f${i}() {\n  return ${i};\n}\n`).join("");
  writeFileSync(join(repo, "src/big.ts"), big);
  writeFileSync(join(repo, "src/other.ts"), "export function helper() {\n  return 42;\n}\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "base");
  const base = git(repo, "rev-parse", "HEAD").trim();
  writeFileSync(join(repo, "src/small.ts"), "export const a = 2;\n");
  writeFileSync(join(repo, "src/big.ts"), big.replace("return 200;", "return -200;"));
  writeFileSync(join(repo, "src/new.ts"), "export const fresh = true;\n");
  writeFileSync(join(repo, "src/added.ts"), "export const added = 1;\n");
  git(repo, "add", "src/small.ts", "src/big.ts", "src/added.ts");
  git(repo, "commit", "-qm", "work");
  mkdirSync(join(repo, ".conduct"));
  writeFileSync(join(repo, ".conduct/brief-s1.md"), "Brief: change a to 2.\n");
  writeFileSync(join(repo, ".conduct/gate.log"), Array.from({ length: 500 }, (_, i) => `gate line ${i}`).join("\n"));
  writeFileSync(join(repo, ".conduct/summary.md"), Array.from({ length: 100 }, (_, i) => `summary ${i}`).join("\n"));
  writeFileSync(join(repo, ".conduct/s1-diff.patch"), "slice-state: v1\ndiff-base: abc\ndiff-sha256: deadbeef\n\ndiff --git ...\n");
  return { repo, base };
}

function build(repo, base, extra = {}) {
  return buildPack({
    worktree: repo, slice: "s1", base, kind: "full",
    brief: [join(repo, ".conduct/brief-s1.md")], gate: join(repo, ".conduct/gate.log"),
    summary: [join(repo, ".conduct/summary.md")], ...extra,
  });
}

test("pack holds patch, small files whole, big files as function context, nothing from the repo path", () => {
  const { repo, base } = fixtureRepo();
  const pack = build(repo, base);
  assert.equal(pack.dir, join(repo, ".conduct/s1-review"));
  const prompt = readFileSync(join(pack.dir, "prompt.md"), "utf8");
  assert.ok(!prompt.includes(repo), "prompt must not name the worktree path");
  assert.match(prompt, /-export const a = 1;/);
  assert.match(prompt, /## File src\/small\.ts \(full\)/);
  assert.match(prompt, /## File src\/new\.ts \(full\)/);
  assert.match(prompt, /## Changed functions src\/big\.ts/);
  assert.equal(prompt.split("export const added = 1;").length, 2, "a committed new file appears once, in the patch");
  assert.doesNotMatch(prompt, /function f10\(\)/, "unchanged far-away code of a big file stays out");
  assert.doesNotMatch(prompt, /helper/, "untouched files stay out");
  assert.match(prompt, /diff-sha256: deadbeef/);
});

test("gate is tail-capped and worker summary head-capped at 40 lines", () => {
  const { repo, base } = fixtureRepo();
  const pack = build(repo, base);
  const prompt = readFileSync(join(pack.dir, "prompt.md"), "utf8");
  assert.match(prompt, /gate line 499/);
  assert.doesNotMatch(prompt, /gate line 100\n/);
  assert.match(prompt, /summary 39\n/);
  assert.doesNotMatch(prompt, /summary 40\n/);
  const manifest = JSON.parse(readFileSync(join(pack.dir, "manifest.json"), "utf8"));
  assert.equal(manifest.bytes, Buffer.byteLength(prompt));
  assert.ok(manifest.files.includes("src/big.ts"));
});

test("delta pack diffs against delta-from, not the merge-base", () => {
  const { repo, base } = fixtureRepo();
  const head = git(repo, "rev-parse", "HEAD").trim();
  writeFileSync(join(repo, "src/small.ts"), "export const a = 3;\n");
  const pack = build(repo, base, { kind: "delta", deltaFrom: head });
  const prompt = readFileSync(join(pack.dir, "prompt.md"), "utf8");
  assert.match(prompt, /-export const a = 2;/);
  assert.match(prompt, /delta-base-commit: [0-9a-f]{40}/);
  assert.doesNotMatch(prompt, /src\/big\.ts/);
});

test("needs add only the named symbol's function and reject paths outside the repo", () => {
  const { repo, base } = fixtureRepo();
  const pack = build(repo, base);
  const added = addNeeds(pack.dir, repo, ["src/other.ts:helper", "../etc/passwd:root", "/etc/passwd:root"]);
  assert.deepEqual(added.map((n) => n.ok), [true, false, false]);
  const prompt = readFileSync(join(pack.dir, "prompt.md"), "utf8");
  assert.match(prompt, /## Need src\/other\.ts:helper/);
  assert.match(prompt, /return 42;/);
  assert.doesNotMatch(prompt, /root:/);
});

test("parseNeeds reads need lines, capped at five", () => {
  const text = "Verdict: ...\nneed: a.ts:foo\n- need: b.ts:bar\nneed: c:1\nneed: d:1\nneed: e:1\nneed: f:1\n";
  assert.deepEqual(parseNeeds(text), ["a.ts:foo", "b.ts:bar", "c:1", "d:1", "e:1"]);
});

test("reviewer runs with no tools, no settings, no MCP, outside the repo", () => {
  const args = reviewerArgs("claude-opus-5-5");
  const tools = args.indexOf("--tools");
  assert.equal(args[tools + 1], "");
  for (const flag of ["--strict-mcp-config", "--no-session-persistence", "--disable-slash-commands"]) assert.ok(args.includes(flag));
  assert.equal(args[args.indexOf("--setting-sources") + 1], "");
  assert.ok(!args.some((a) => a.includes("--add-dir")));
  assert.equal(args[args.indexOf("--effort") + 1], "medium");
  assert.ok(reviewerArgs("m", { resume: "u1" }).includes("--resume"));
});

test("usageRow records tokens, cost and pack size", () => {
  const row = usageRow({ slice: "s1", kind: "full", attempt: 1, model: "m", packBytes: 4000 }, {
    total_cost_usd: 0.12, num_turns: 1,
    usage: { input_tokens: 5, cache_read_input_tokens: 10, cache_creation_input_tokens: 1000, output_tokens: 300 },
  });
  assert.deepEqual(
    { in: row.input, cr: row.cache_read, cw: row.cache_write, out: row.output, usd: row.cost_usd, pack: row.pack_bytes },
    { in: 5, cr: 10, cw: 1000, out: 300, usd: 0.12, pack: 4000 },
  );
});

test("runReview retries once with the needed fragments and logs both legs", () => {
  const { repo, base } = fixtureRepo();
  const pack = build(repo, base);
  const calls = [];
  const fake = (args, input, cwd) => {
    calls.push({ args, input, cwd });
    const result = calls.length === 1 ? "Verdict: unsure\nneed: src/other.ts:helper\n" : "Verdict: no P0, no P1\n";
    return { total_cost_usd: calls.length === 1 ? 0.4 : 0.47, num_turns: 1, result, usage: { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 2, output_tokens: 3 } };
  };
  const out = runReview({ packDir: pack.dir, worktree: repo, slice: "s1", kind: "full", model: "m", exec: fake });
  assert.equal(calls.length, 2);
  assert.ok(!calls[0].cwd.startsWith(repo), "reviewer cwd is outside the worktree");
  assert.match(calls[1].input, /return 42;/);
  assert.equal(calls[1].args[calls[1].args.indexOf("--resume") + 1], calls[0].args[calls[0].args.indexOf("--session-id") + 1]);
  assert.doesNotMatch(calls[1].input, /export const a = 1;/, "the retry sends only the fragments, the pack is resumed");
  const review = readFileSync(out.reviewFile, "utf8");
  assert.match(review, /^diff-sha256: deadbeef\nreview-scope: full\n/);
  assert.match(review, /## Revision after the requested fragments\n\nVerdict: no P0, no P1/);
  const ledger = readFileSync(join(repo, ".conduct/review-ledger.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(ledger.map((r) => r.attempt), [1, 2]);
  assert.deepEqual(ledger.map((r) => r.cost_usd), [0.4, 0.07], "the resumed call logs its own cost, not the session total");
  assert.ok(existsSync(out.reviewFile));
  assert.ok(readdirSync(pack.dir).includes("review.md"));
});
