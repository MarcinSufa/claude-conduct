#!/usr/bin/env node
// Copies the skills in this repository into ~/.claude/skills/.
//
// Refuses to overwrite a directory that is a symlink or a junction, because that
// is the linked install, where the repository is already the file Claude reads.
// Copying over it would replace the link with a stale copy and silently detach
// the skill from version control.
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(repoRoot, "skills");
const target = join(homedir(), ".claude", "skills");

if (!existsSync(source)) {
  console.error(`no skills directory at ${source}`);
  process.exit(1);
}

mkdirSync(target, { recursive: true });

let copied = 0;
let skipped = 0;

for (const name of readdirSync(source)) {
  const from = join(source, name);
  const to = join(target, name);

  if (existsSync(to)) {
    const stat = lstatSync(to);
    if (stat.isSymbolicLink()) {
      console.log(`skip  ${name}  (linked install: the repo is already live)`);
      skipped += 1;
      continue;
    }
  }

  cpSync(from, to, { recursive: true });
  console.log(`copy  ${name}  ->  ${to}`);
  copied += 1;
}

console.log(`\n${copied} copied, ${skipped} left as links.`);
if (copied > 0) {
  console.log("Copies go stale. Prefer the linked install described in README.md.");
}
