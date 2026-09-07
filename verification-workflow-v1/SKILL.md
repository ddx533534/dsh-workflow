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
2. The Agent generates a `workflow.json` by **templating** — it does NOT inspect the repository, read code, or collect business data. It only fills in `run_name` (from the user's requirement) and uses the template's default phases/tasks/loops/executor config. The Agent creates a run directory `.verification-workflow/run_<YYYYMMDDHHmmss>/` and writes the workflow to `.verification-workflow/run_<ts>/.workflow.json`.
3. The Agent drives execution by repeatedly calling `node engine/loop.js --step`, maintaining an `agent_id_map` (declared_name → real agent_id) for sub-agent reuse. **The main Agent never touches the repository** — all business data collection (reading code, grepping, running commands) is done by sub-agents in their own context:
   - For `handler.type == "script"`: the engine executes the script directly.
   - For `handler.type == "skill"`: the engine outputs `NEED_SKILL: <ref>, INPUT: <json>, EXECUTOR: <info>` and exits. The Agent handles it based on the `executor` field:
     - No `executor` (= self): the Agent reads the sub-skill's `SKILL.md` at `<ref>/SKILL.md`, thinks per its prompt, produces output, then feeds it back via `--output "<json>"`.
     - Has `executor`: the Agent looks up `executor.agent_id` (declared name, e.g. "planner") in its `agent_id_map`. **The main Agent does NOT read SKILL.md itself** — it passes the `ref` path and `input` to the sub-agent, which reads SKILL.md on its own:
       - Not in map → create: `subagent(prompt="Read <ref>/SKILL.md and follow its instructions. Input: <input JSON>", description=declared_name)` → harness returns a real agent_id → store `agent_id_map[declared_name] = real_id` → sub-agent reads SKILL.md, thinks, writes output to a file → Agent feeds back via `--output-file "<path>" --agent-id "<real_id>"`.
       - In map → reuse: `send_message(agent_id=real_id, message="New task: read <ref>/SKILL.md. Input: <input JSON>")` → sub-agent reads SKILL.md (or reuses its earlier reading), writes output to a file → Agent feeds back via `--output-file "<path>" --agent-id "<real_id>"`.
     - The Agent does not read SKILL.md, does not process the output — it only passes paths and file paths. `--agent-id` is optional but enables log verification: consecutive `DONE` outputs with the same `agent_id` confirm sub-agent reuse.
   - When all tasks are done: the engine outputs `FINISHED`.
4. Loop backtracks (e.g. verify fail → code) are decided by the engine, not the Agent. The engine checks the `loops` config and jumps `current_task` back to the target when triggered, up to `max_iterations`. On re-run, the engine outputs `reuse: true` (it saw the declared name before), and the Agent reuses the existing sub-agent — which still has the context from the previous round.
5. The main Agent is a **pure flow scheduler + user interface**. It does NOT: inspect the repository, read code, collect business data, judge sub-agent output, or think about business logic. It only: translates the user's requirement into a workflow.json declaration, drives the `--step` loop, creates/reuses sub-agents, relays output, and communicates with the user. The main Agent's context holds only: the user's requirement, the workflow.json declaration, engine output messages (with compact summaries), `--output` JSON (compact results), the `agent_id_map`, and user dialogue — **no repository content, no code, no business data.**

> **Two kinds of id**: The engine only tracks **declared names** (from workflow.json's `executor` field, stored in `context.known_agents`). The main Agent maintains the mapping from declared names to **real agent_ids** returned by harness. The engine never holds real ids — they are runtime references that belong in the Agent's context, not in workflow.json.

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
- `subagent:<name>` — a named sub-agent executes. `<name>` is a **declared name** (e.g. "planner"), not a harness agent_id. Same declared name across tasks shares one sub-agent instance. The main Agent maps declared names to real agent_ids via `agent_id_map`.

Adding a new task requires only a JSON declaration in `workflow.json`; the engine logic does not change.
