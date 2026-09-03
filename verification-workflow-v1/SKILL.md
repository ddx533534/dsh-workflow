---
name: verification-workflow-v1
description: A protocol-driven plan-code-verify loop with configurable phases, tasks, and loops.
disable-model-invocation: true
---

# Verification Workflow

This skill provides a protocol-driven workflow for plan → code → verify loops.

## What this skill provides

- `protocol/schema.json` — the JSON Schema for the workflow protocol
- `templates/workflow_template.json` — a pre-filled declaration with the 7 default tasks
- `engine/loop.js` — the single-step loop engine that drives execution
- `skills/` — sub-skills referenced by task handlers (self-contained, each declares its own input/output schema)

## How to use

1. The user triggers this skill with `/verification-workflow <requirement>`.
2. The Agent generates a `workflow.json` based on the user's requirement, using `templates/workflow_template.json` as the starting point.
3. The Agent drives execution by repeatedly calling `node engine/loop.js --step`:
   - For `handler.type == "script"`: the engine executes the script directly.
   - For `handler.type == "skill"`: the engine outputs `NEED_SKILL: <ref>, INPUT: <json>` and exits. The Agent reads the sub-skill's `SKILL.md` at `<ref>/SKILL.md`, thinks per its prompt, produces output, then feeds it back via `node engine/loop.js --step --output "<json>"`.
   - When all tasks are done: the engine outputs `FINISHED`.
4. Loop backtracks (e.g. verify fail → code) are decided by the engine, not the Agent. The engine checks the `loops` config and jumps `current_task` back to the target when triggered, up to `max_iterations`.

## Protocol summary

See `protocol/schema.json` for the full definition. Core structure:

- **Workflow** — root: `{ version, phases[], tasks[], loops[], context }`
- **Phase** — major stage: `{ name, tasks[] }`
- **Task** — concrete task: `{ name, phase, handler{type,ref}, depends_on?, input?, output?, started_at, finished_at, history[] }`
- **Attempt** — execution record: `{ attempt, status:"success"|"fail", output:{data, passed?} }`
- **Loop** — backtrack config: `{ trigger_task, trigger_field, trigger_when, target_task, max_iterations }`
- **Context** — runtime state: `{ current_phase, current_task, loop_counts{}, terminated, terminate_reason }`

Handler types:
- `skill` — a sub-skill under `skills/`, executed by the Agent reading its prompt
- `script` — an external script executed via bash

Adding a new task requires only a JSON declaration in `workflow.json`; the engine logic does not change.
