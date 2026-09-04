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
2. The Agent generates a `workflow.json` based on the user's requirement, using `templates/workflow_template.json` as the starting point. The Agent creates a run directory `.verification-workflow/run_<YYYYMMDDHHmmss>/` and writes the workflow to `.verification-workflow/run_<ts>/.workflow.json`.
3. The Agent drives execution by repeatedly calling `node engine/loop.js --step`:
   - For `handler.type == "script"`: the engine executes the script directly.
   - For `handler.type == "skill"`: the engine outputs `NEED_SKILL: <ref>, INPUT: <json>, EXECUTOR: <info>` and exits. The Agent handles it based on the `executor` field:
     - No `executor` (= self): the Agent reads the sub-skill's `SKILL.md` at `<ref>/SKILL.md`, thinks per its prompt, produces output, then feeds it back via `--output "<json>"`.
     - `executor.reuse == false`: the Agent creates a new sub-agent (via `subagent`), passing the skill ref and input. The sub-agent reads the SKILL.md itself, thinks, and returns the result. The Agent feeds it back via `--output "<json>"` (no processing).
     - `executor.reuse == true`: the Agent sends the new input to the existing sub-agent (via `send_message`), receives the result, and feeds it back via `--output "<json>"` (no processing).
   - When all tasks are done: the engine outputs `FINISHED`.
4. Loop backtracks (e.g. verify fail → code) are decided by the engine, not the Agent. The engine checks the `loops` config and jumps `current_task` back to the target when triggered, up to `max_iterations`.
5. The main Agent is the orchestrator + user interface. It does not execute tasks itself (unless `executor: self`). Sub-agent thinking, tool calls, and intermediate state stay in the sub-agent's context, preventing main Agent context overflow.

## Protocol summary

See `protocol/schema.json` for the full definition. Core structure:

- **Workflow** — root: `{ version, run_name, artifacts_dir?, project_root?, phases[], tasks[], loops[], context }`
- **Phase** — major stage: `{ name, tasks[] }`
- **Task** — concrete task: `{ name, phase, handler{type,ref}, executor?, depends_on?, input?, output?, started_at, finished_at, history[] }`
- **Attempt** — execution record: `{ attempt, status:"success"|"fail", output:{data, passed?} }`
- **Loop** — backtrack config: `{ trigger_task, trigger_field, trigger_when, target_task, max_iterations }`
- **Context** — runtime state: `{ current_phase, current_task, loop_counts{}, known_agents[], terminated, terminate_reason }`

Handler types:
- `skill` — a sub-skill under `skills/`, executed by the Agent or a sub-agent reading its prompt
- `script` — an external script executed via bash

Executor types (task.executor):
- `self` (default) — main Agent executes directly
- `subagent:<agent_id>` — a named sub-agent executes; same agent_id across tasks shares one sub-agent instance (reused, continuous context)

Adding a new task requires only a JSON declaration in `workflow.json`; the engine logic does not change.
