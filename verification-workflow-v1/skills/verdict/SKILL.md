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
  properties:
    data:
      type: object
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
    passed:
      type: boolean
      description: The overall pass/fail flag. When false, the configured loop triggers a backtrack to 'code'.
  required: [data, passed]
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

Return JSON matching the output schema. **You MUST include the `passed` field** — it drives the loop:

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

The `passed: false` value triggers the loop configured in workflow.json, which backtracks to the `code` task (up to `max_iterations` times).
