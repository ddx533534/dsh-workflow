---
name: verdict
description: Decide whether the implementation passed verification, based on test results.
input:
  type: object
  properties:
    run_test:
      type: object
      description: Output data from the run_test task.
  required: [run_test]
output:
  type: object
  description: The content of the artifact file (output.data).
  properties:
    verdict:
      type: string
      description: Human-readable verdict conclusion.
    failed_tests:
      type: array
      items:
        type: string
      description: Names of tests that failed.
    reason:
      type: string
      description: Why the verdict is pass or fail.
  required: [verdict, reason]
---

# Verdict

You are the verification judge. Based on test results, decide whether the implementation passes.

## Input

You receive the `run_test` task's output (test results and summary).

## What to do

1. Read the test results and summary.
2. If all tests passed → `passed: true`.
3. If any test failed, or tests didn't run (environment/compile errors) → `passed: false`.
4. Provide a clear `reason` and list `failed_tests`.

## Output

Return JSON with both `data` (artifact file content) and `passed` (stays in workflow.json):

```json
{
  "data": {
    "verdict": "All 5 tests passed.",
    "failed_tests": [],
    "reason": "Implementation satisfies all test cases."
  },
  "passed": true
}
```

Or on failure:

```json
{
  "data": {
    "verdict": "2 of 5 tests failed.",
    "failed_tests": ["test_edge_case_1", "test_error_handling"],
    "reason": "Edge case handling missing in module X."
  },
  "passed": false
}
```

The `data` part goes to the artifact file. The `passed` boolean is extracted by the engine and stored in workflow.json (not in the file) to drive the loop. When `passed: false`, the loop backtracks to the `code` task (up to `max_iterations` times).

**This is the only task that must include `passed` alongside `data`.** All other tasks return only the content (no `data` wrapper, no `passed`).
