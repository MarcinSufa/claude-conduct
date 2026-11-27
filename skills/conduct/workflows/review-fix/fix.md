Fix the defects listed in `.conduct/review-<run id>.md`, where `<run id>` is the value of the `CONDUCT_RUN_ID` environment variable. If that file contains only `NO FINDINGS`, change nothing and exit.

For each finding:

1. Check the claim against the code. If it is wrong, leave the code as is and say why in one line in your output.
2. Write a test that reproduces it and see it fail.
3. Fix the root cause in the shared code, not only the caller named in the finding.

Do not edit or delete the review file, and do not weaken or delete existing tests. Do not commit. When the tests pass, exit.
