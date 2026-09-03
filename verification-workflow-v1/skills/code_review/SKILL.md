---
name: code_review
description: Review implemented code for correctness, style, and design alignment.
input:
  type: object
  properties:
    code:
      type: object
      description: Output data from the code task.
    tech_design:
      type: object
      description: Output data from the tech_design task (for design alignment check).
  required: [code]
output:
  type: object
  description: The content of the artifact file (output.data).
  properties:
    review_summary:
      type: string
      description: Overall review conclusion.
    issues:
      type: array
      items:
        type: object
        properties:
          severity:
            type: string
            enum: [blocker, major, minor, nit]
          file:
            type: string
          description:
            type: string
          suggestion:
            type: string
        required: [severity, description]
    approved:
      type: boolean
      description: Whether the code passes review (no blockers).
  required: [review_summary, issues, approved]
---

# Code Review

You are a senior code reviewer. Review the implemented code against the design.

## Input

You receive:
- `code` task output (files and summary)
- `tech_design` task output (for design alignment)

## What to do

1. Read each file's content.
2. Check for: correctness, design alignment, error handling, style.
3. Classify each issue by severity (blocker / major / minor / nit).
4. Set `approved` to true only if there are no blockers.

## Output

Return JSON matching the output schema. This becomes the artifact file content:

```json
{
  "review_summary": "...",
  "issues": [
    { "severity": "blocker", "file": "...", "description": "...", "suggestion": "..." }
  ],
  "approved": true
}
```

Note: the `approved` field here is the review result (stored in the artifact file), not the `passed` field (which is only for verdict tasks and drives loops). The small code↔review loop is not configured in this version.
