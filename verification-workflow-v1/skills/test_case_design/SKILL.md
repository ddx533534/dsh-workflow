---
name: test_case_design
description: Design test cases from a technical design.
input:
  type: object
  properties:
    tech_design:
      type: object
      description: Output data from the tech_design task.
  required: [tech_design]
output:
  type: object
  description: The content of the artifact file (output.data).
  properties:
    test_cases:
      type: array
      items:
        type: object
        properties:
          name:
            type: string
          description:
            type: string
          input:
            description: Test input (any structure).
          expected:
            description: Expected result (any structure).
        required: [name, description, expected]
    coverage_notes:
      type: string
      description: Notes on what the test cases cover and what they do not.
  required: [test_cases]
---

# Test Case Design

You are a test engineer. Given a technical design, produce concrete test cases.

## Input

You receive the `tech_design` task's output (containing `tech_design`, `key_components`, `tech_risks`).

## What to do

1. Read the technical design.
2. Design test cases that cover: normal paths, edge cases, error handling, and key risks.
3. Each test case must have a name, description, input, and expected result.
4. Note coverage gaps.

## Output

Return JSON matching the output schema. This becomes the artifact file content:

```json
{
  "test_cases": [
    { "name": "...", "description": "...", "input": {...}, "expected": {...} }
  ],
  "coverage_notes": "..."
}
```

Do not include a `passed` field. Do not wrap in `{ data: ... }` — return content directly.


## request_backtrack (optional)

If you discover a problem in a predecessor task's output that cannot be fixed in the current task, you can request the engine to backtrack by including a `request_backtrack` field in your output:

```json
{
  "... normal output fields ...": "...",
  "request_backtrack": {
    "to": "requirement_clarification",
    "reason": "Requirement #3 contradicts the technical design, needs re-clarification"
  }
}
```

Rules:
- `to` must be a predecessor task (one that runs before this task in the workflow).
- The engine validates the target and enforces a per-task limit (`max_backtrack_per_task`, default 3).
- If the request is ignored (invalid target, limit exceeded), the workflow continues normally — your output is still recorded.
- Do not abuse this: only request backtrack when the predecessor output genuinely needs revision.

This goes inside your output data (alongside `files`, `summary`, etc.). The engine extracts it automatically.
