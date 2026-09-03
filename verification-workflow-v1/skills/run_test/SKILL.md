---
name: run_test
description: Execute test cases against the implemented code and collect results.
input:
  type: object
  properties:
    code:
      type: object
      description: Output data from the code task (files to test).
    test_case_design:
      type: object
      description: Output data from the test_case_design task (test cases to run).
  required: [code, test_case_design]
output:
  type: object
  description: The content of the artifact file (output.data).
  properties:
    results:
      type: array
      items:
        type: object
        properties:
          name:
            type: string
          passed:
            type: boolean
          actual:
            description: Actual result (any structure).
          error:
            type: string
            description: Error message if the test failed to run.
        required: [name, passed]
    summary:
      type: object
      properties:
        total:
          type: integer
        passed_count:
          type: integer
        failed_count:
          type: integer
      required: [total, passed_count, failed_count]
  required: [results, summary]
---

# Run Tests

You are a test runner. Execute the test cases against the implemented code and report results.

## Input

You receive:
- `code` task output (files with content)
- `test_case_design` task output (test cases with input and expected)

## What to do

1. For each test case, run it against the implemented code.
2. Compare actual result to expected.
3. Record pass/fail, actual output, and any errors.
4. Produce a summary (total / passed / failed).

## Output

Return JSON matching the output schema. This becomes the artifact file content:

```json
{
  "results": [
    { "name": "...", "passed": true, "actual": {...}, "error": "" }
  ],
  "summary": { "total": 5, "passed_count": 4, "failed_count": 1 }
}
```

Do not include a top-level `passed` field — the `verdict` task will decide the overall verdict based on these results. Do not wrap in `{ data: ... }` — return content directly.
