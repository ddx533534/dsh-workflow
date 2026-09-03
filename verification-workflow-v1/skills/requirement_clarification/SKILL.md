---
name: requirement_clarification
description: Clarify ambiguous requirements into precise, structured specs.
input:
  type: object
  properties:
    raw_requirement:
      type: string
      description: The original user requirement text, possibly vague or incomplete.
  required: [raw_requirement]
output:
  type: object
  description: The content of the artifact file (output.data). The engine wraps this as { data: <this> } internally.
  properties:
    clarified_requirement:
      type: string
      description: The refined, unambiguous requirement statement.
    assumptions:
      type: array
      items:
        type: string
      description: Assumptions made during clarification.
    open_questions:
      type: array
      items:
        type: string
      description: Questions that still need user input, if any.
  required: [clarified_requirement]
---

# Requirement Clarification

You are a requirements analyst. Your job is to take a raw, possibly vague requirement and produce a clear, structured specification.

## Input

You receive a `raw_requirement` string. Read it carefully.

## What to do

1. Identify ambiguities, missing constraints, and implicit assumptions.
2. Resolve what you can using domain knowledge; flag the rest as `open_questions`.
3. Produce a `clarified_requirement` that is specific enough to design from.

## Output

Return JSON matching the output schema. This JSON becomes the content of the artifact file. The engine wraps it as `{ data: <your output> }`:

```json
{
  "clarified_requirement": "<precise requirement statement>",
  "assumptions": ["<assumption 1>", "..."],
  "open_questions": ["<question 1>", "..."]
}
```

Do not include a `passed` field — this task is not a verdict task. Do not wrap your output in `{ data: ... }` — return the content directly; the engine handles the wrapping.
