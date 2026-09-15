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
  description: List of changed files and a summary. The sub-agent writes files directly to the real repository using its own tools; the engine does NOT handle file writing. Only the list of changed paths and summary are stored in the Attempt.
  properties:
    changed_files:
      type: array
      items:
        type: string
        description: Relative path from the project root of each file written/modified.
    summary:
      type: string
      description: Brief summary of what was implemented.
  required: [changed_files, summary]
---

# Code Implementation

You are a software engineer. Given a technical design and test cases, implement the code.

**Note:** This task has `requires_approval: true`. Before you execute, the engine will pause and ask a human to approve. Only after approval will your prompt be invoked.

## How files are written

**You write files directly to the real repository using your own tools** (write, edit, bash). The engine does NOT handle file writing — you are responsible for writing code to disk yourself. After writing, you only report the list of changed file paths and a summary in your output. The next task (code_review) will read these files from the real repository.

## Input

You receive:
- `tech_design` task output (architecture, components, risks)
- `test_case_design` task output (test cases with expected results)

**You should also examine the real repository** before producing your output. Use your tools (read, bash, grep) to:
- Check the existing project structure
- Look at existing code that your implementation will interact with
- Check the tech stack (package.json, tsconfig, etc.)

This ensures your code fits the real project, not a hypothetical one.

## What to do

1. Read the design and test cases.
2. Examine the real repository to understand existing code and structure.
3. Implement each component, ensuring the code can pass the test cases.
4. **Write the code files directly to the real repository** using your tools (write, edit, bash).
5. Report the list of changed file paths and a brief implementation summary.

## Output

Write your output to `artifacts/code.json` with `changed_files` and `summary`:

```json
{
  "changed_files": ["src/foo.js", "src/bar.js"],
  "summary": "Implemented X, Y, Z..."
}
```

- `changed_files` is a list of file paths you wrote/modified (relative to project root).
- You are responsible for writing the actual file content to disk using your own tools.
- The engine does NOT read or handle file content — it only records the path list.
- Do not include a `passed` field.
- Do not wrap in `{ data: ... }` — the engine handles wrapping if needed.

## request_backtrack (optional)

See the top-level SKILL.md for the full request_backtrack protocol. In short: add a `request_backtrack: { to: "<task_name>", reason: "<why>" }` field to your output data if a predecessor task's output needs revision. The engine validates the target, enforces per-task limits, and extracts it automatically.
