#!/usr/bin/env node
/**
 * Patch-only review legs (references/token-hygiene.md rule 1). The conductor builds a review pack
 * in .conduct/<slice>-review/ and the reviewer sees only that pack, inlined into one headless
 * `claude -p` call with no tools, no settings, no MCP and a cwd outside the repo.
 *
 * Usage:
 *   review-pack.mjs build <worktree> --slice <s> [--kind full|delta|final] [--base <ref>] [--delta-from <ref>]
 *                   --brief <file>... [--gate <file>] [--summary <file>...] [--ask <file>]
 *   review-pack.mjs need  <worktree> --slice <s> <path:symbol>...
 *   review-pack.mjs run   <worktree> --slice <s> [--kind ...] [--model claude-opus-5-5] [--effort medium] [--prev-sha256 <h>]
 *
 * Exit codes: 0 ok, 2 usage, 3 git or reviewer failure.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const FULL_FILE_MAX_LINES = 300;
export const SUMMARY_MAX_LINES = 40;
export const GATE_MAX_LINES = 60;
export const NEED_MAX = 5;
const NEED_MAX_LINES = 200;
// Measured on the startscreen packs (code plus prose): 156753 bytes were 66695 input tokens.
const BYTES_PER_TOKEN = 2.35;
const EXCLUDE_CONDUCT = ":(exclude).conduct";

export const REVIEWER_SYSTEM = [
  "You are a code reviewer. You have no tools and no access to the repository or the worker's session:",
  "everything you may use is in the review pack in the user message. Judge only what the pack shows.",
  "If a finding depends on code that is not in the pack, do not guess: end your answer with up to",
  `${NEED_MAX} lines \`need: <path>:<symbol>\`; the conductor adds only those fragments and asks you once more.`,
  "Be terse: per finding a title, file:line, the failing scenario, at most five lines; do not restate the pack.",
].join(" ");

const DEFAULT_ASK = [
  "Review the change against the brief. Report real defects, not style.",
  "Rate each finding P0 (wrong data, crash, security), P1 (wrong in a realistic case, or a gap the brief requires), P2 (minor).",
  "Give file:line from the patch and a concrete failing scenario for each P0/P1.",
  "First line: `Verdict: no P0, no P1` or `Verdict: <n> P0, <m> P1`.",
].join("\n");

// Kept outside the ask so a custom ask cannot drop it: on the startscreen pack a reviewer without it missed a
// `!==` where the spec said `<=`, with both lines in the pack.
const REVIEW_METHOD = [
  "Walk all four before the verdict, whatever the ask lists; report what they find even at P2.",
  "1. Brief vs code: for every rule in the brief that states a comparison, bound or count (`<=`, at most, within, until, first N, before or after), find the code that implements it and check the operator and both ends. Equality (`===`, `!==`) where the brief orders values is a defect.",
  "2. Boundaries of each changed condition and loop: empty, zero, one, the limit, first and last item, off-by-one, inclusive or exclusive ends, dates at day, month, year, leap, DST and timezone edges, a value just outside the range the code expects, and the seams where results of several calls, windows or pages are joined (overlap, gap, which value wins).",
  "3. Error paths: what each failure throws, swallows, retries or caches, and whether the brief says so.",
  "4. Code outside the pack: when a changed line's correctness depends on a caller, callee or type the pack does not show, ask with `need:` instead of assuming either way.",
  "Terse means short wording, not fewer findings: list every P2 you find.",
].join("\n");

const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const head = (text, n) => text.split("\n").slice(0, n).join("\n");
const tail = (text, n) => text.split("\n").slice(-n).join("\n");
const fence = (body) => "````\n" + body.replace(/\n?$/, "\n") + "````\n";
export const packDirFor = (worktree, slice) => join(worktree, ".conduct", `${slice}-review`);

function stampFrom(worktree, slice) {
  const file = join(worktree, ".conduct", `${slice}-diff.patch`);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").slice(0, 5).filter((l) => /^(slice-state|diff-base|diff-sha256): /.test(l));
}

function diffBase(worktree, { kind, base, deltaFrom }) {
  if (kind === "delta") {
    if (!deltaFrom) throw new Error("--kind delta needs --delta-from <ref>");
    return git(worktree, ["rev-parse", "--verify", `${deltaFrom}^{commit}`]).trim();
  }
  return git(worktree, ["merge-base", base ?? "origin/main", "HEAD"]).trim();
}

export function buildPack({ worktree, slice, kind = "full", base, deltaFrom, brief = [], gate, summary = [], ask }) {
  const root = resolve(worktree);
  const from = diffBase(root, { kind, base, deltaFrom });
  const patch = git(root, ["diff", "-U30", "--no-renames", from, "--", ".", EXCLUDE_CONDUCT]);
  const tracked = git(root, ["diff", "--name-only", "--no-renames", "--diff-filter=d", from, "--", ".", EXCLUDE_CONDUCT]).split("\n").filter(Boolean);
  const added = new Set(git(root, ["diff", "--name-only", "--no-renames", "--diff-filter=A", from, "--", ".", EXCLUDE_CONDUCT]).split("\n").filter(Boolean));
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "--", ".", EXCLUDE_CONDUCT]).split("\n").filter(Boolean);

  const parts = [];
  for (const file of [...tracked.filter((f) => !added.has(f)), ...untracked]) {
    const text = readFileSync(join(root, file), "utf8");
    if (text.split("\n").length <= FULL_FILE_MAX_LINES || untracked.includes(file)) {
      parts.push(`## File ${file} (full)\n\n${fence(text)}`);
    } else {
      // ponytail: git's funcname regex finds function bounds for C-like code only; a language it
      // misreads widens the hunk to the enclosing top-level block. Upgrade: a .gitattributes diff driver per repo.
      parts.push(`## Changed functions ${file}\n\n${fence(git(root, ["diff", "-U0", "-W", from, "--", file]))}`);
    }
  }

  const stamp = stampFrom(root, slice);
  const sections = [
    `# Review pack: ${slice} (${kind})\n\n${stamp.join("\n")}${kind === "delta" ? `\ndelta-base-commit: ${from}` : ""}\n`,
    `## Ask\n\n${ask ? readFileSync(ask, "utf8") : DEFAULT_ASK}\n`,
    `## Review method\n\n${REVIEW_METHOD}\n`,
    ...brief.map((f) => `## Brief\n\n${readFileSync(f, "utf8")}\n`),
    ...summary.map((f) => `## Worker summary (first ${SUMMARY_MAX_LINES} lines)\n\n${head(readFileSync(f, "utf8"), SUMMARY_MAX_LINES)}\n`),
    gate ? `## Gate and test output (last ${GATE_MAX_LINES} lines)\n\n${fence(tail(readFileSync(gate, "utf8"), GATE_MAX_LINES))}` : "",
    `## Patch (git diff -U30${untracked.length ? `; untracked files shown whole below: ${untracked.join(", ")}` : ""})\n\n${fence(patch)}`,
    ...parts,
  ].filter(Boolean);

  const dir = packDirFor(root, slice);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "pack.md"), sections.join("\n"));
  const manifest = { slice, kind, from, stamp, files: [...tracked, ...untracked], needs: [] };
  return { dir, manifest: writeManifestAndPrompt(dir, manifest) };
}

function writeManifestAndPrompt(dir, manifest) {
  const needs = existsSync(join(dir, "need.md")) ? "\n" + readFileSync(join(dir, "need.md"), "utf8") : "";
  const prompt = readFileSync(join(dir, "pack.md"), "utf8") + needs;
  writeFileSync(join(dir, "prompt.md"), prompt);
  const full = { ...manifest, bytes: Buffer.byteLength(prompt), tokensEstimate: Math.round(Buffer.byteLength(prompt) / BYTES_PER_TOKEN) };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(full, null, 2) + "\n");
  return full;
}

export function parseNeeds(text) {
  return [...text.matchAll(/^\s*(?:[-*]\s*)?need:\s*`?([^\s`]+)`?\s*$/gim)].map((m) => m[1]).slice(0, NEED_MAX);
}

export function addNeeds(dir, worktree, needs) {
  const root = resolve(worktree);
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  const results = needs.map((need) => {
    const at = need.lastIndexOf(":");
    const file = at > 0 ? need.slice(0, at) : "";
    const symbol = at > 0 ? need.slice(at + 1) : "";
    const rel = relative(root, resolve(root, file));
    if (!file || !symbol || isAbsolute(file) || rel.startsWith("..") || rel.startsWith(".conduct")) return { need, ok: false };
    let body;
    try {
      body = git(root, ["grep", "-n", "-W", "-F", "-e", symbol, "--", rel]);
    } catch {
      return { need, ok: false };
    }
    appendFileSync(join(dir, "need.md"), `## Need ${need}\n\n${fence(head(body, NEED_MAX_LINES))}\n`);
    return { need, ok: true };
  });
  writeManifestAndPrompt(dir, { ...manifest, needs: [...manifest.needs, ...results] });
  return results;
}

export const REVISE_ASK = "The conductor added the fragments you asked for. Reply with only the findings that change because of them, then the verdict line again.";

export function reviewerArgs(model, { effort = "medium", sessionId, resume } = {}) {
  return [
    "-p", "--model", model, "--effort", effort, "--output-format", "json",
    "--tools", "", "--setting-sources", "", "--strict-mcp-config", "--disable-slash-commands",
    "--system-prompt", REVIEWER_SYSTEM,
    ...(resume ? ["--resume", resume] : sessionId ? ["--session-id", sessionId] : ["--no-session-persistence"]),
  ];
}

export function usageRow({ slice, kind, attempt, model, packBytes }, out) {
  const u = out.usage ?? {};
  return {
    date: new Date().toISOString(), slice, kind, attempt, model, pack_bytes: packBytes,
    input: u.input_tokens ?? null, cache_read: u.cache_read_input_tokens ?? null,
    cache_write: u.cache_creation_input_tokens ?? null, output: u.output_tokens ?? null,
    cost_usd: out.total_cost_usd ?? null, turns: out.num_turns ?? null,
  };
}

function execClaude(args, input, cwd) {
  // A one-shot review re-reads its prefix at most once, within minutes: the default 1 h cache write costs 2x input, 5 min costs 1.25x.
  const env = { ...process.env, FORCE_PROMPT_CACHING_5M: "1" };
  const r = spawnSync("claude", args, { input, cwd, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`claude exited ${r.status}: ${(r.stderr || r.stdout || "").slice(0, 400)}`);
  return JSON.parse(r.stdout);
}

const costDelta = (total, before) => (typeof total === "number" && typeof before === "number" ? Math.round((total - before) * 1e6) / 1e6 : null);

const sessionStoreFor = (cwd) => join(homedir(), ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));

export function runReview({ packDir, worktree, slice, kind = "full", model = "claude-opus-5-5", effort, prevSha256, exec = execClaude }) {
  const ledger = join(resolve(worktree), ".conduct", "review-ledger.ndjson");
  const scope = kind === "delta" && prevSha256 ? `delta-from: ${prevSha256}` : "review-scope: full";
  const cwd = mkdtempSync(join(tmpdir(), "conduct-review-"));
  const sessionId = randomUUID();
  const reviewFile = join(packDir, "review.md");
  let unresolved = [];
  try {
    const manifest = JSON.parse(readFileSync(join(packDir, "manifest.json"), "utf8"));
    const stampLines = manifest.stamp.filter((l) => l.startsWith("diff-sha256:"));
    const log = (attempt, out, packBytes) => appendFileSync(ledger, JSON.stringify(usageRow({ slice, kind, attempt, model, packBytes }, out)) + "\n");
    const first = exec(reviewerArgs(model, { effort, sessionId }), readFileSync(join(packDir, "prompt.md"), "utf8"), cwd);
    log(1, first, manifest.bytes);
    const parts = [...stampLines, scope, "", first.result ?? ""];
    const needs = parseNeeds(first.result ?? "");
    if (needs.length) {
      const needBefore = existsSync(join(packDir, "need.md")) ? readFileSync(join(packDir, "need.md"), "utf8") : "";
      addNeeds(packDir, worktree, needs);
      const fragments = readFileSync(join(packDir, "need.md"), "utf8").slice(needBefore.length);
      // The retry resumes the first call, so the pack is a cache read and only the fragments are new input.
      const second = exec(reviewerArgs(model, { effort, resume: sessionId }), `${REVISE_ASK}\n\n${fragments}`, cwd);
      // A resumed session reports total_cost_usd for the whole session, so the ledger keeps this call's share.
      log(2, { ...second, total_cost_usd: costDelta(second.total_cost_usd, first.total_cost_usd) }, Buffer.byteLength(fragments));
      parts.push("", "## Revision after the requested fragments", "", second.result ?? "");
      unresolved = parseNeeds(second.result ?? "");
    }
    writeFileSync(reviewFile, parts.join("\n"));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(sessionStoreFor(cwd), { recursive: true, force: true });
  }
  return { reviewFile, unresolved };
}

function parseCli(argv) {
  const [cmd, worktree, ...rest] = argv;
  const opts = { brief: [], summary: [], needs: [] };
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    const key = { "--slice": "slice", "--kind": "kind", "--base": "base", "--delta-from": "deltaFrom", "--gate": "gate", "--ask": "ask", "--model": "model", "--prev-sha256": "prevSha256", "--effort": "effort" }[flag];
    if (key) opts[key] = rest[++i];
    else if (flag === "--brief") opts.brief.push(rest[++i]);
    else if (flag === "--summary") opts.summary.push(rest[++i]);
    else opts.needs.push(flag);
  }
  return { cmd, worktree, opts };
}

function main(argv) {
  const { cmd, worktree, opts } = parseCli(argv);
  if (!["build", "need", "run"].includes(cmd) || !worktree || !opts.slice) {
    console.error("usage: review-pack.mjs build|need|run <worktree> --slice <s> ... (see header)");
    return 2;
  }
  try {
    const dir = packDirFor(resolve(worktree), opts.slice);
    if (cmd === "build") {
      const { manifest } = buildPack({ worktree, ...opts });
      console.log(`${dir}/prompt.md ${manifest.bytes} bytes (~${manifest.tokensEstimate} tokens), ${manifest.files.length} files`);
    } else if (cmd === "need") {
      for (const r of addNeeds(dir, worktree, opts.needs)) console.log(`${r.ok ? "added" : "REFUSED"} ${r.need}`);
    } else {
      const { reviewFile, unresolved } = runReview({ packDir: dir, worktree, ...opts });
      console.log(reviewFile);
      if (unresolved.length) console.log(`unresolved needs after the one retry: ${unresolved.join(", ")}`);
    }
    return 0;
  } catch (err) {
    console.error(String(err.message ?? err));
    return 3;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = main(process.argv.slice(2));
