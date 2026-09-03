---
name: tech_design
description: Design a technical solution from a clarified requirement.
input:
  type: object
  properties:
    requirement_clarification:
      type: object
      description: Output data from the requirement_clarification task.
  required: [requirement_clarification]
output:
  type: object
  properties:
    data:
      type: object
      properties:
        tech_design:
          type: string
          description: The technical design document (architecture, components, data flow, key decisions).
        key_components:
          type: array
          items:
            type: string
          description: List of key components or modules to implement.
        tech_risks:
          type: array
          items:
            type: string
          description: Identified technical risks.
      required: [tech_design]
  required: [data]
---

# Technical Design

You are a software architect. Given a clarified requirement, produce a technical design.

## Input

You receive the `requirement_clarification` task's output (containing `clarified_requirement`, `assumptions`, `open_questions`).

## What to do

1. Read the clarified requirement.
2. Decide on architecture, data structures, interfaces, and key algorithms.
3. Identify components that will become implementation units.
4. Flag technical risks.

## Output

Return JSON matching the output schema:

```json
{
  "data": {
    "tech_design": "<full design document text>",
    "key_components": ["<component 1>", "..."],
    "tech_risks": ["<risk 1>", "..."]
  }
}
```

Do not include a `passed` field.
