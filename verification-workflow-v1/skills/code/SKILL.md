---
name: code
description: Implement code based on the technical design and test cases.
input:
  type: object
  properties:
    tech_design:
      type: object
      description: Output data from the tech_design task.
    test_case_design:
      type: object
      description: Output data from the test_case_design task.
  required: [tech_design, test_case_design]
output:
  type: object
  description: The content of the artifact file (output.data).
  properties:
    files:
      type: array
      items:
        type: object
        properties:
          path:
            type: string
          content:
            type: string
        required: [path, content]
    summary:
      type: string
      description: Brief summary of what was implemented.
  required: [files, summary]
---

# Code Implementation

You are a software engineer. Given a technical design and test cases, implement the code.

**Note:** This task has `requires_approval: true`. Before you execute, the engine will pause and ask a human to approve. Only after approval will your prompt be invoked.

## Input

You receive:
- `tech_design` task output (architecture, components, risks)
- `test_case_design` task output (test cases with expected results)

## What to do

1. Read the design and test cases.
2. Implement each component, ensuring the code can pass the test cases.
3. Produce a list of files with their full content.
4. Write a brief implementation summary.

## Output

Return JSON matching the output schema. This becomes the artifact file content:

```json
{
  "files": [
    { "path": "src/foo.js", "content": "..." }
  ],
  "summary": "Implemented X, Y, Z..."
}
```

Do not include a `passed` field. Do not wrap in `{ data: ... }` — return content directly.
