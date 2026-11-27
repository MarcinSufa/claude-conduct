You are reviewing a change before it is merged. Review only: do not change any file except the review file below, and do not commit.

The change is everything between the merge base of HEAD with the default branch (`origin/HEAD`, else `main` or `master`) and the working tree, including uncommitted edits and untracked files: `git diff $(git merge-base HEAD origin/HEAD)` plus `git ls-files --others --exclude-standard`. Read the surrounding code you need.

Look for defects the change introduces: wrong behavior, missed edge cases, broken callers, security holes, data loss, tests that no longer test what their name says.

Write the review to `.conduct/review-<run id>.md`, where `<run id>` is the value of the `CONDUCT_RUN_ID` environment variable. Overwrite the file if it exists.

- If you found defects: one numbered finding per defect, most severe first, each with the file and line, the exact setup and action that trigger it, and what goes wrong compared to what should happen.
- If you found none: the file contains exactly the line `NO FINDINGS` and nothing else.

Style findings and suggestions that are not defects do not count as findings.
