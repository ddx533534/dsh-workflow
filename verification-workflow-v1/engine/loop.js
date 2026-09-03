#!/usr/bin/env node
'use strict';

/**
 * verification-workflow / engine/loop.js
 *
 * Single-step loop engine for the plan-code-verify workflow protocol.
 *
 * Modules (co-located in this file):
 *   1. loader        — read & validate workflow.json, build in-memory object
 *   2. executor      — dispatch handler (skill → delegate to Agent; script → run directly)
 *   3. engine        — serial task driver, depends_on ordering, gather/validate input-output
 *   4. loop_controller — check loops after each task, jump_to on trigger
 *   5. checkpointer  — incremental persistence of workflow.json after each Attempt
 *
 * Usage (driven by the Agent in a step loop):
 *   node loop.js --workflow <path> --step
 *     → executes the current task; for skill handlers, prints NEED_SKILL and exits
 *   node loop.js --workflow <path> --step --output '<json>'
 *     → feeds a skill's output back, writes the Attempt, advances
 *   node loop.js --workflow <path> --status
 *     → prints current workflow status without executing
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ─────────────────────────────────────────────────────────────────────────────
// 1. LOADER — read, parse, validate
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load and validate a workflow JSON file.
 * @param {string} workflowPath
 * @returns {{workflow: object, workflowDir: string}}
 */
function loadWorkflow(workflowPath) {
  const abs = path.resolve(workflowPath);
  const raw = fs.readFileSync(abs, 'utf8');
  const workflow = JSON.parse(raw);
  const workflowDir = path.dirname(abs);

  // --- structural validation ---
  if (workflow.version !== '1.0') {
    throw new Error(`Unsupported protocol version: ${workflow.version}`);
  }
  if (!Array.isArray(workflow.phases) || workflow.phases.length === 0) {
    throw new Error('workflow.phases must be a non-empty array');
  }
  if (!Array.isArray(workflow.tasks) || workflow.tasks.length === 0) {
    throw new Error('workflow.tasks must be a non-empty array');
  }

  // --- task name uniqueness ---
  const names = new Set();
  for (const t of workflow.tasks) {
    if (names.has(t.name)) {
      throw new Error(`Duplicate task name: ${t.name}`);
    }
    names.add(t.name);
  }

  // --- phase.task references exist ---
  for (const p of workflow.phases) {
    for (const tn of (p.tasks || [])) {
      if (!names.has(tn)) {
        throw new Error(`Phase '${p.name}' references unknown task: ${tn}`);
      }
    }
  }

  // --- task.phase is a declared phase ---
  const phaseNames = new Set(workflow.phases.map(p => p.name));
  for (const t of workflow.tasks) {
    if (!phaseNames.has(t.phase)) {
      throw new Error(`Task '${t.name}' references unknown phase: ${t.phase}`);
    }
  }

  // --- depends_on references exist ---
  for (const t of workflow.tasks) {
    for (const dep of (t.depends_on || [])) {
      if (!names.has(dep)) {
        throw new Error(`Task '${t.name}' depends_on unknown task: ${dep}`);
      }
    }
  }

  // --- loops reference valid tasks ---
  for (const loop of (workflow.loops || [])) {
    if (!names.has(loop.trigger_task)) {
      throw new Error(`Loop trigger_task unknown: ${loop.trigger_task}`);
    }
    if (!names.has(loop.target_task)) {
      throw new Error(`Loop target_task unknown: ${loop.target_task}`);
    }
  }

  // --- ensure context exists ---
  if (!workflow.context) {
    workflow.context = {
      current_phase: null,
      current_task: null,
      loop_counts: {},
      terminated: false,
      terminate_reason: null,
    };
  }

  return { workflow, workflowDir };
}

/**
 * Topologically order tasks by depends_on (serial execution).
 * Falls back to declaration order when no dependency constraints.
 * @param {object[]} tasks
 * @returns {object[]}
 */
function orderTasks(tasks) {
  // Simple: respect declaration order. depends_on must point to earlier tasks.
  // (The engine validates that depends_on targets already-ran tasks at runtime.)
  return tasks;
}

/**
 * Find a task by name.
 * @param {object} workflow
 * @param {string} name
 * @returns {object}
 */
function getTask(workflow, name) {
  return workflow.tasks.find(t => t.name === name);
}

/**
 * Find the first task that has not yet completed (no history or last attempt failed).
 * If context.current_task is set and not yet done, resume from there.
 * @param {object} workflow
 * @returns {object|null}
 */
function findNextTask(workflow) {
  const ctx = workflow.context;
  if (ctx.terminated) return null;

  const ordered = orderTasks(workflow.tasks);

  // If current_task is set, resume from it (it may have been jumped back to by a loop)
  if (ctx.current_task) {
    const idx = ordered.findIndex(t => t.name === ctx.current_task);
    if (idx >= 0) {
      return ordered[idx];
    }
  }

  // Otherwise find the first task without a successful attempt
  for (const t of ordered) {
    const hist = t.history || [];
    const last = hist[hist.length - 1];
    if (!last || last.status !== 'success') {
      return t;
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. EXECUTOR — dispatch handler
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute a task's handler.
 * - skill: do NOT execute here; return a NEED_SKILL directive for the Agent.
 * - script: run via bash, read JSON output from stdout.
 *
 * @param {object} task
 * @param {object} input  — assembled input data
 * @param {string} skillRoot — path to the verification-workflow skill root
 * @returns {{kind:'skill', ref:string, input:object} | {kind:'script', output:object}}
 */
function executeHandler(task, input, skillRoot) {
  const handler = task.handler;

  if (handler.type === 'skill') {
    // Delegate to Agent: the engine signals which skill to run and with what input.
    return { kind: 'skill', ref: handler.ref, input };
  }

  if (handler.type === 'script') {
    const scriptPath = path.resolve(skillRoot, handler.ref);
    // Pass input as JSON via stdin, read JSON output from stdout.
    const inputJson = JSON.stringify(input || {});
    let stdout;
    try {
      stdout = execSync(`node ${scriptPath}`, {
        input: inputJson,
        encoding: 'utf8',
        timeout: 60000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      // Non-zero exit → fail
      return {
        kind: 'script',
        output: { data: { error: e.message, stderr: e.stderr || '' }, passed: false },
        failed: true,
      };
    }
    let output;
    try {
      output = JSON.parse(stdout);
    } catch (e) {
      return {
        kind: 'script',
        output: { data: { error: `script stdout not valid JSON: ${e.message}` }, passed: false },
        failed: true,
      };
    }
    return { kind: 'script', output };
  }

  throw new Error(`Unknown handler type: ${handler.type}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. ENGINE — serial task driver
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Gather input for a task from its depends_on predecessors' latest outputs.
 * @param {object} workflow
 * @param {object} task
 * @returns {object} — keyed map of predecessor name → its last output.data
 */
function gatherInput(workflow, task) {
  const input = {};
  for (const depName of (task.depends_on || [])) {
    const dep = getTask(workflow, depName);
    const hist = (dep && dep.history) || [];
    const last = hist[hist.length - 1];
    if (last && last.status === 'success') {
      input[depName] = last.output ? last.output.data : null;
    } else {
      input[depName] = null;
    }
  }
  return input;
}

/**
 * Minimal schema check: if task.input is set, ensure input has the required top-level keys.
 * (Full JSON Schema validation is intentionally lightweight here; a real validator lib
 *  like ajv can be swapped in without changing the call site.)
 * @param {object} input
 * @param {object} schema
 * @returns {true | string} — true if ok, error string if not
 */
function validateAgainstSchema(value, schema) {
  if (!schema) return true;
  if (schema.type === 'object' && Array.isArray(schema.required)) {
    if (typeof value !== 'object' || value === null) {
      return `expected object, got ${typeof value}`;
    }
    for (const key of schema.required) {
      if (!(key in value)) {
        return `missing required field: ${key}`;
      }
    }
  }
  return true;
}

/**
 * Write an Attempt into the task's history and set timestamps.
 * @param {object} task
 * @param {string} status — 'success' | 'fail'
 * @param {object} output — { data, passed? }
 */
function recordAttempt(task, status, output) {
  if (!task.history) task.history = [];
  const attemptNum = task.history.length + 1;
  const now = new Date().toISOString();
  if (!task.started_at) task.started_at = now;
  task.finished_at = now;
  task.history.push({ attempt: attemptNum, status, output });
}

/**
 * Advance context.current_task to the next uncompleted task.
 * Called after a successful attempt (or after a failed attempt that doesn't trigger a loop).
 * @param {object} workflow
 * @param {object} justFinishedTask
 */
function advance(workflow, justFinishedTask) {
  const ordered = orderTasks(workflow.tasks);
  const idx = ordered.findIndex(t => t.name === justFinishedTask.name);
  // Find next task whose last attempt isn't success
  for (let i = idx + 1; i < ordered.length; i++) {
    const t = ordered[i];
    const hist = t.history || [];
    const last = hist[hist.length - 1];
    if (!last || last.status !== 'success') {
      workflow.context.current_task = t.name;
      workflow.context.current_phase = t.phase;
      return;
    }
  }
  // Nothing left
  workflow.context.current_task = null;
  workflow.context.current_phase = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. LOOP_CONTROLLER — check loops, jump_to on trigger
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check all loops against the just-completed task.
 * If a loop triggers, set context.current_task back to target_task (jump_to).
 *
 * @param {object} workflow
 * @param {object} task — the task that just finished
 * @returns {{triggered: boolean, loop?: object, exhausted?: boolean}}
 */
function checkLoops(workflow, task) {
  const loops = workflow.loops || [];
  for (const loop of loops) {
    if (loop.trigger_task !== task.name) continue;

    // Read trigger_field from the task's last attempt output.
    // Path like "output.passed"
    const hist = task.history || [];
    const last = hist[hist.length - 1];
    if (!last) continue;

    const fieldValue = resolvePath(last, loop.trigger_field);
    if (fieldValue === loop.trigger_when) {
      const loopKey = `${loop.trigger_task}→${loop.target_task}`;
      const counts = workflow.context.loop_counts || {};
      const current = counts[loopKey] || 0;
      if (current >= loop.max_iterations) {
        return { triggered: false, exhausted: true, loop };
      }
      counts[loopKey] = current + 1;
      workflow.context.loop_counts = counts;
      // jump_to: move execution pointer back to target_task
      const target = getTask(workflow, loop.target_task);
      workflow.context.current_task = target.name;
      workflow.context.current_phase = target.phase;
      return { triggered: true, loop };
    }
  }
  return { triggered: false };
}

/**
 * Resolve a dotted path like "output.passed" from an object.
 * @param {object} obj
 * @param {string} dotted
 * @returns {any}
 */
function resolvePath(obj, dotted) {
  return dotted.split('.').reduce((acc, key) => {
    if (acc == null) return undefined;
    return acc[key];
  }, obj);
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. CHECKPOINTER — incremental persistence
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Save the workflow state back to its JSON file (incremental, after every Attempt).
 * @param {object} workflow
 * @param {string} workflowPath
 */
function saveWorkflow(workflow, workflowPath) {
  const tmp = workflowPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(workflow, null, 2), 'utf8');
  fs.renameSync(tmp, workflowPath);
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP ORCHESTRATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run one step of the workflow.
 *
 * Modes:
 *  (a) --step without --output: the engine looks at current_task.
 *      - script handler: execute, write Attempt, save, advance, print DONE.
 *      - skill handler:  print NEED_SKILL and exit (Agent will execute and call back).
 *  (b) --step with --output '<json>': the engine writes the Attempt for the current
 *      skill task using the provided output, then saves, checks loops, advances.
 *
 * @param {string} workflowPath
 * @param {string|null} outputJson — provided when Agent feeds back a skill result
 */
function step(workflowPath, outputJson) {
  const { workflow, workflowDir } = loadWorkflow(workflowPath);
  const skillRoot = workflowDir; // workflow.json lives at the skill root
  const ctx = workflow.context;

  if (ctx.terminated) {
    emit({ type: 'TERMINATED', reason: ctx.terminate_reason });
    return;
  }

  const task = findNextTask(workflow);
  if (!task) {
    ctx.terminated = true;
    ctx.terminate_reason = 'completed';
    saveWorkflow(workflow, workflowPath);
    emit({ type: 'FINISHED' });
    return;
  }

  // Set current pointers
  ctx.current_task = task.name;
  ctx.current_phase = task.phase;

  // ── Mode (b): Agent feeds back a skill output ──
  if (outputJson !== null && outputJson !== undefined) {
    let output;
    try {
      output = JSON.parse(outputJson);
    } catch (e) {
      emit({ type: 'ERROR', message: `--output is not valid JSON: ${e.message}` });
      return;
    }
    // Validate output envelope: must have data, optional passed
    if (!output || typeof output !== 'object' || !('data' in output)) {
      emit({ type: 'ERROR', message: 'output must be { data, passed? }; missing data' });
      return;
    }
    // Validate against task.output schema if present
    const v = validateAgainstSchema(output, task.output);
    if (v !== true) {
      emit({ type: 'ERROR', message: `output schema validation failed: ${v}` });
      return;
    }
    recordAttempt(task, 'success', output);
    saveWorkflow(workflow, workflowPath);

    // Check loops
    const loopResult = checkLoops(workflow, task);
    if (loopResult.exhausted) {
      ctx.terminated = true;
      ctx.terminate_reason = `max_iterations_exceeded: ${loopResult.loop.trigger_task}→${loopResult.loop.target_task}`;
      saveWorkflow(workflow, workflowPath);
      emit({ type: 'TERMINATED', reason: ctx.terminate_reason });
      return;
    }
    if (loopResult.triggered) {
      saveWorkflow(workflow, workflowPath);
      emit({
        type: 'LOOP_BACK',
        from: task.name,
        to: loopResult.loop.target_task,
        iteration: workflow.context.loop_counts[`${loopResult.loop.trigger_task}→${loopResult.loop.target_task}`],
        max: loopResult.loop.max_iterations,
      });
      return;
    }

    // Advance to next task
    advance(workflow, task);
    saveWorkflow(workflow, workflowPath);
    emit({ type: 'DONE', task: task.name, status: 'success' });
    return;
  }

  // ── Mode (a): execute or delegate ──
  const input = gatherInput(workflow, task);

  // Validate input if schema present
  const iv = validateAgainstSchema(input, task.input);
  if (iv !== true) {
    emit({ type: 'ERROR', message: `input schema validation failed: ${iv}` });
    return;
  }

  const result = executeHandler(task, input, skillRoot);

  if (result.kind === 'skill') {
    // Delegate: tell the Agent which skill to run and with what input
    emit({
      type: 'NEED_SKILL',
      task: task.name,
      ref: result.ref,
      input: result.input,
    });
    return;
  }

  if (result.kind === 'script') {
    const status = result.failed ? 'fail' : 'success';
    recordAttempt(task, status, result.output);
    saveWorkflow(workflow, workflowPath);

    if (status === 'fail') {
      // A failed script task terminates the workflow (no loop configured for script fails here)
      ctx.terminated = true;
      ctx.terminate_reason = `task_failed: ${task.name}`;
      saveWorkflow(workflow, workflowPath);
      emit({ type: 'FAILED', task: task.name, output: result.output });
      return;
    }

    // Check loops (scripts could also drive loops if their output has passed)
    const loopResult = checkLoops(workflow, task);
    if (loopResult.exhausted) {
      ctx.terminated = true;
      ctx.terminate_reason = `max_iterations_exceeded: ${loopResult.loop.trigger_task}→${loopResult.loop.target_task}`;
      saveWorkflow(workflow, workflowPath);
      emit({ type: 'TERMINATED', reason: ctx.terminate_reason });
      return;
    }
    if (loopResult.triggered) {
      saveWorkflow(workflow, workflowPath);
      emit({
        type: 'LOOP_BACK',
        from: task.name,
        to: loopResult.loop.target_task,
        iteration: workflow.context.loop_counts[`${loopResult.loop.trigger_task}→${loopResult.loop.target_task}`],
        max: loopResult.loop.max_iterations,
      });
      return;
    }

    advance(workflow, task);
    saveWorkflow(workflow, workflowPath);
    emit({ type: 'DONE', task: task.name, status: 'success' });
    return;
  }
}

/**
 * Print status without executing.
 * @param {string} workflowPath
 */
function status(workflowPath) {
  const { workflow } = loadWorkflow(workflowPath);
  const task = findNextTask(workflow);
  emit({
    type: 'STATUS',
    current_task: task ? task.name : null,
    current_phase: task ? task.phase : null,
    terminated: workflow.context.terminated,
    terminate_reason: workflow.context.terminate_reason,
    loop_counts: workflow.context.loop_counts,
    task_progress: workflow.tasks.map(t => ({
      name: t.name,
      phase: t.phase,
      attempts: (t.history || []).length,
      last_status: (t.history || []).slice(-1)[0]?.status || 'pending',
      started_at: t.started_at || null,
      finished_at: t.finished_at || null,
    })),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

function emit(obj) {
  // All engine output is a single JSON line on stdout for the Agent to parse.
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function parseArgs(argv) {
  const args = { workflow: null, step: false, status: false, output: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--workflow') { args.workflow = argv[++i]; }
    else if (a === '--step') { args.step = true; }
    else if (a === '--status') { args.status = true; }
    else if (a === '--output') { args.output = argv[++i]; }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.workflow) {
    emit({ type: 'ERROR', message: 'Missing --workflow <path>' });
    process.exit(1);
  }
  if (!fs.existsSync(args.workflow)) {
    emit({ type: 'ERROR', message: `workflow file not found: ${args.workflow}` });
    process.exit(1);
  }
  try {
    if (args.status) {
      status(args.workflow);
    } else if (args.step) {
      step(args.workflow, args.output);
    } else {
      emit({ type: 'ERROR', message: 'Must specify --step or --status' });
      process.exit(1);
    }
  } catch (e) {
    emit({ type: 'ERROR', message: e.message, stack: e.stack });
    process.exit(1);
  }
}

main();
