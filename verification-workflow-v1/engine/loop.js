#!/usr/bin/env node
'use strict';

/**
 * verification-workflow / engine/loop.js
 *
 * Single-step loop engine for the plan-code-verify workflow protocol.
 * Supports: approval gates (requires_approval), externalized artifacts,
 *           two loop trigger types (output_field, approval_rejected).
 *
 * Modules (co-located in this file):
 *   1. loader        — read & validate workflow.json, build in-memory object
 *   2. executor      — dispatch handler (skill → delegate to Agent; script → run directly)
 *   3. engine        — serial task driver, depends_on ordering, gather/validate input-output
 *   4. loop_controller — check loops after each task, jump_to on trigger (two trigger types)
 *   5. checkpointer  — incremental persistence of workflow.json after each Attempt
 *
 * Usage (driven by the Agent in a step loop):
 *   node loop.js --workflow <path> --step
 *     → executes the current task; skill handlers print NEED_SKILL; approval-gated tasks print NEED_APPROVAL
 *   node loop.js --workflow <path> --step --output '<json>'
 *     → feeds a skill's output back, writes artifact file, writes Attempt, advances
 *   node loop.js --workflow <path> --step --approve
 *     → approves the current approval-gated task, then proceeds to execute it
 *   node loop.js --workflow <path> --step --reject "<reason>"
 *     → rejects the current approval-gated task, records Attempt with status=fail, triggers approval_rejected loop
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
  if (!workflow.run_name || typeof workflow.run_name !== 'string') {
    throw new Error('workflow.run_name is required (English short name)');
  }
  if (!/^[a-z][a-z0-9_]*$/.test(workflow.run_name)) {
    throw new Error(`workflow.run_name must match ^[a-z][a-z0-9_]*$, got: ${workflow.run_name}`);
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

  // --- loops reference valid tasks + trigger_type validity ---
  for (const loop of (workflow.loops || [])) {
    const tt = loop.trigger_type || 'output_field';
    if (!['output_field', 'approval_rejected'].includes(tt)) {
      throw new Error(`Loop has invalid trigger_type: ${tt}`);
    }
    if (!names.has(loop.trigger_task)) {
      throw new Error(`Loop trigger_task unknown: ${loop.trigger_task}`);
    }
    if (!names.has(loop.target_task)) {
      throw new Error(`Loop target_task unknown: ${loop.target_task}`);
    }
    if (tt === 'output_field' && !loop.trigger_field) {
      throw new Error(`Loop with trigger_type=output_field must have trigger_field: ${loop.trigger_task}`);
    }
  }

  // --- ensure context exists ---
  if (!workflow.context) {
    workflow.context = {
      current_phase: null,
      current_task: null,
      loop_counts: {},
      backtrack_counts: {},
      backtrack_log: [],
      known_agents: [],
      terminated: false,
      terminate_reason: null,
    };
  }
  // Ensure backtrack fields exist even if context was loaded from old workflow.json
  if (!workflow.context.backtrack_counts) workflow.context.backtrack_counts = {};
  if (!workflow.context.backtrack_log) workflow.context.backtrack_log = [];
  // Ensure known_agents exists for executor tracking
  if (!workflow.context.known_agents) workflow.context.known_agents = [];

  return { workflow, workflowDir };
}

/**
 * Topologically order tasks by depends_on (serial execution).
 * Falls back to declaration order when no dependency constraints.
 * @param {object[]} tasks
 * @returns {object[]}
 */
function orderTasks(tasks) {
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
 * Find the next task to execute.
 * - If context.current_task is set, resume from there.
 * - Otherwise find the first task whose last attempt wasn't success.
 *
 * NOTE: A task with requires_approval that has a pending Attempt (approval_status=null)
 * is "in progress" — findNextTask returns it so the engine can re-enter the approval flow.
 *
 * @param {object} workflow
 * @returns {object|null}
 */
function findNextTask(workflow) {
  const ctx = workflow.context;
  if (ctx.terminated) return null;

  const ordered = orderTasks(workflow.tasks);

  // If current_task is set, resume from it
  if (ctx.current_task) {
    const idx = ordered.findIndex(t => t.name === ctx.current_task);
    if (idx >= 0) {
      return ordered[idx];
    }
  }

  // Otherwise find the first task without a successful last attempt
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
// ARTIFACTS — externalized output files
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ensure artifacts_dir exists. On first execution (artifacts_dir is null),
 * create the artifacts/ subdirectory inside the run directory.
 *
 * The run directory itself is created by the Agent when generating workflow.json,
 * so the engine only needs to create the artifacts/ subdirectory.
 *
 * @param {object} workflow
 * @param {string} workflowDir — the run directory (where .workflow.json lives)
 * @returns {string} — the artifacts_dir path (relative to workflowDir)
 */
function ensureArtifactsDir(workflow, workflowDir) {
  if (workflow.artifacts_dir) {
    const absArtifacts = path.resolve(workflowDir, workflow.artifacts_dir);
    if (!fs.existsSync(absArtifacts)) {
      fs.mkdirSync(absArtifacts, { recursive: true });
    }
    return workflow.artifacts_dir;
  }

  // First execution: create artifacts/ subdirectory inside the run directory
  const relDir = 'artifacts';
  const absDir = path.resolve(workflowDir, relDir);
  fs.mkdirSync(absDir, { recursive: true });
  workflow.artifacts_dir = relDir;
  return relDir;
}

/**
 * Write an artifact file and return its relative path.
 *
 * @param {object} workflow
 * @param {string} workflowDir
 * @param {string} taskName
 * @param {number} attemptNum
 * @param {object} data — the payload to write (output.data)
 * @returns {string} — relative path of the written file
 */
function writeArtifact(workflow, workflowDir, taskName, attemptNum, data) {
  const relArtifactsDir = ensureArtifactsDir(workflow, workflowDir);
  const filename = `${taskName}_attempt${attemptNum}.json`;
  const relPath = path.join(relArtifactsDir, filename);
  const absPath = path.resolve(workflowDir, relPath);
  fs.writeFileSync(absPath, JSON.stringify(data, null, 2), 'utf8');
  return relPath;
}

/**
 * Read an artifact file and return its content (the data payload).
 * Used by gatherInput to fetch predecessor outputs.
 *
 * @param {string} workflowDir
 * @param {string} relFilePath
 * @returns {object|null}
 */
function readArtifact(workflowDir, relFilePath) {
  if (!relFilePath) return null;
  const absPath = path.resolve(workflowDir, relFilePath);
  if (!fs.existsSync(absPath)) return null;
  const raw = fs.readFileSync(absPath, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. EXECUTOR — dispatch handler
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute a task's handler.
 * - skill: do NOT execute here; return a NEED_SKILL directive for the Agent.
 *   If the task has an `executor` field (e.g. "subagent:coder"), the directive
 *   includes executor info (agent_id, reuse) so the Agent knows whether to
 *   create a new sub-agent or send_message to an existing one.
 * - script: run via bash, read JSON output from stdout.
 *
 * @param {object} task
 * @param {object} input  — assembled input data
 * @param {string} skillRoot — path to the verification-workflow skill root
 * @param {object} workflow — the workflow object (for known_agents tracking)
 * @returns {{kind:'skill', ref:string, input:object, executor?:object} | {kind:'script', output:object, failed?:boolean}}
 */
function executeHandler(task, input, skillRoot, workflow) {
  const handler = task.handler;

  if (handler.type === 'skill') {
    const executorDecl = task.executor || 'self';
    if (executorDecl === 'self') {
      // Main Agent executes directly (current behavior)
      return { kind: 'skill', ref: handler.ref, input };
    }
    if (executorDecl.startsWith('subagent:')) {
      const agentId = executorDecl.slice('subagent:'.length);
      const knownAgents = workflow.context.known_agents || [];
      const reuse = knownAgents.includes(agentId);
      if (!reuse) {
        // First time seeing this agent_id — record it
        if (!workflow.context.known_agents) {
          workflow.context.known_agents = [];
        }
        workflow.context.known_agents.push(agentId);
      }
      return {
        kind: 'skill',
        ref: handler.ref,
        input,
        executor: { mode: 'subagent', agent_id: agentId, reuse },
      };
    }
    throw new Error(`Unknown executor '${executorDecl}' for task '${task.name}'`);
  }

  if (handler.type === 'script') {
    const scriptPath = path.resolve(skillRoot, handler.ref);
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
 * Two modes:
 *   - Artifact mode (output.file): pass the artifact file PATH (not content).
 *   - Side-effect mode (output.changed_files): pass changed_files + summary directly.
 *
 * Input carries file paths, not file content — the main Agent's context stays
 * clean (no business data). The sub-agent reads the files itself.
 *
 * @param {object} workflow
 * @param {object} task
 * @param {string} workflowDir
 * @returns {object} — keyed map of predecessor name → { file: "<path>" } or { changed_files, summary }
 */
function gatherInput(workflow, task, workflowDir) {
  const input = {};
  for (const depName of (task.depends_on || [])) {
    const dep = getTask(workflow, depName);
    const hist = (dep && dep.history) || [];
    const last = hist[hist.length - 1];
    if (last && last.status === 'success' && last.output) {
      if (last.output.file) {
        // Artifact mode: pass the file path, NOT the content
        input[depName] = { file: last.output.file };
      } else if (last.output.changed_files) {
        // Side-effect mode: pass changed_files + summary directly
        input[depName] = {
          changed_files: last.output.changed_files,
        };
        if (last.output.summary) {
          input[depName].summary = last.output.summary;
        }
      } else {
        input[depName] = null;
      }
    } else {
      input[depName] = null;
    }
  }
  return input;
}

/**
 * Minimal schema check.
 * @param {object} value
 * @param {object} schema
 * @returns {true | string}
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
 * Process a task's output: decide whether to write files to the real repo
 * (side-effect mode) or externalize to an artifact file (default mode).
 *
 * Rule:
 *   - If output.data contains a `files` array → write each file to the real
 *     repo, store only { changed_files, summary } in the Attempt output.
 *     No artifact file is created.
 *   - Otherwise → externalize output.data to an artifact file, store
 *     { file } in the Attempt output.
 *
 * `passed` (if present in the envelope) is always kept in the Attempt output
 * regardless of mode, so loop_controller can read it without touching files.
 *
 * @param {object} workflow
 * @param {string} workflowDir
 * @param {string} taskName
 * @param {number} attemptNum
 * @param {object} outputEnvelope — { data, passed? }
 * @returns {object} — the output object to store in the Attempt
 */
function processOutput(workflow, workflowDir, taskName, attemptNum, outputEnvelope) {
  const data = (outputEnvelope && outputEnvelope.data) || {};
  const output = {};

  // Check for files in data first, then at envelope top level.
  // This handles both { data: { files: [...] } } and { files: [...] } formats.
  const files = Array.isArray(data.files) ? data.files
    : (Array.isArray(outputEnvelope && outputEnvelope.files) ? outputEnvelope.files : null);
  const summary = data.summary || (outputEnvelope && outputEnvelope.summary);

  if (files && files.length > 0) {
    // Side-effect mode: write files to the real repo (project_root), not the run directory
    const projectRoot = workflow.project_root || '../..';
    const changedFiles = [];
    for (const f of files) {
      if (f.path && typeof f.content === 'string') {
        const absPath = path.resolve(workflowDir, projectRoot, f.path);
        fs.mkdirSync(path.dirname(absPath), { recursive: true });
        fs.writeFileSync(absPath, f.content, 'utf8');
        changedFiles.push(f.path);
      }
    }
    output.changed_files = changedFiles;
    if (summary) {
      output.summary = summary;
    }
  } else {
    // Default mode: externalize to artifact file
    output.file = writeArtifact(workflow, workflowDir, taskName, attemptNum, data);
  }

  // Carry passed if present (stays in workflow.json, not in file)
  if (outputEnvelope && 'passed' in outputEnvelope) {
    output.passed = outputEnvelope.passed;
  }

  // Extract request_backtrack from data if present (stays in workflow.json, not in file)
  if (data.request_backtrack && data.request_backtrack.to) {
    output.request_backtrack = {
      to: data.request_backtrack.to,
      reason: data.request_backtrack.reason || '',
    };
  }

  return output;
}

/**
 * Write an Attempt into the task's history.
 * Uses processOutput to handle files-write vs artifact-externalize.
 *
 * @param {object} workflow
 * @param {string} workflowDir
 * @param {object} task
 * @param {string} status — 'success' | 'fail'
 * @param {object} outputEnvelope — { data, passed? } from the handler/skill
 * @param {object|null} approval — { approval_status, approved_by, approved_at, reject_reason } or null
 * @returns {object} — the written Attempt
 */
function recordAttempt(workflow, workflowDir, task, status, outputEnvelope, approval) {
  if (!task.history) task.history = [];
  const attemptNum = task.history.length + 1;
  const now = new Date().toISOString();
  if (!task.started_at) task.started_at = now;
  task.finished_at = now;

  const output = processOutput(workflow, workflowDir, task.name, attemptNum, outputEnvelope);

  const attempt = {
    attempt: attemptNum,
    status,
    output,
  };

  // Attach approval fields if this task requires approval
  if (approval) {
    attempt.approval_status = approval.approval_status;
    attempt.approved_by = approval.approved_by || null;
    attempt.approved_at = approval.approved_at || null;
    attempt.reject_reason = approval.reject_reason || null;
  }

  task.history.push(attempt);
  return attempt;
}

/**
 * Advance context.current_task to the next uncompleted task.
 * @param {object} workflow
 * @param {object} justFinishedTask
 */
function advance(workflow, justFinishedTask) {
  const ordered = orderTasks(workflow.tasks);
  const idx = ordered.findIndex(t => t.name === justFinishedTask.name);
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
  workflow.context.current_task = null;
  workflow.context.current_phase = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. LOOP_CONTROLLER — check loops, jump_to on trigger (two trigger types)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check all loops against the just-completed task.
 *
 * Two trigger types:
 *   - output_field: read trigger_field from last Attempt, compare to trigger_when.
 *   - approval_rejected: check if last Attempt approval_status == 'rejected'.
 *
 * @param {object} workflow
 * @param {object} task — the task that just finished
 * @returns {{triggered: boolean, loop?: object, exhausted?: boolean}}
 */
function checkLoops(workflow, task) {
  const loops = workflow.loops || [];
  for (const loop of loops) {
    if (loop.trigger_task !== task.name) continue;

    const hist = task.history || [];
    const last = hist[hist.length - 1];
    if (!last) continue;

    const triggerType = loop.trigger_type || 'output_field';
    let shouldTrigger = false;

    if (triggerType === 'output_field') {
      const fieldValue = resolvePath(last, loop.trigger_field);
      shouldTrigger = (fieldValue === loop.trigger_when);
    } else if (triggerType === 'approval_rejected') {
      shouldTrigger = (last.approval_status === 'rejected');
    }

    if (shouldTrigger) {
      const loopKey = `${loop.trigger_task}→${loop.target_task}`;
      const counts = workflow.context.loop_counts || {};
      const current = counts[loopKey] || 0;
      if (current >= loop.max_iterations) {
        return { triggered: false, exhausted: true, loop };
      }
      counts[loopKey] = current + 1;
      workflow.context.loop_counts = counts;
      const target = getTask(workflow, loop.target_task);
      workflow.context.current_task = target.name;
      workflow.context.current_phase = target.phase;

      // Mark all tasks AFTER target_task (in declaration order) as stale.
      // Their previous results were based on stale predecessor outputs.
      // We keep the history for audit but mark each Attempt as stale so
      // findNextTask/advance know to re-run them.
      // For simplicity, we clear started_at/finished_at and mark last attempt
      // as stale by setting a flag. But since we want to keep it simple:
      // we clear history of downstream tasks (they will be re-run fresh).
      // The rejected/failed attempts on the trigger task itself are preserved.
      const ordered = orderTasks(workflow.tasks);
      const targetIdx = ordered.findIndex(t => t.name === target.name);
      for (let i = targetIdx + 1; i < ordered.length; i++) {
        // Clear downstream task history — they need full re-run.
        // Their previous artifacts remain on disk for reference.
        ordered[i].history = [];
        ordered[i].started_at = null;
        ordered[i].finished_at = null;
      }

      return { triggered: true, loop };
    }
  }
  return { triggered: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4b. BACKTRACK CONTROLLER — check request_backtrack from LLM output
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if the LLM requested a backtrack via output.request_backtrack.
 *
 * Rules:
 *   - Only allowed to backtrack to a predecessor task (target must be before current).
 *   - Per-task counting: backtrack_counts[task.name] must be < max_backtrack_per_task.
 *   - If triggered: jump_to target (same as checkLoops — clear downstream history).
 *   - If ignored (invalid target / not predecessor): record in backtrack_log, normal advance.
 *   - If exhausted (per-task limit reached): record in backtrack_log, normal advance.
 *
 * checkLoops has priority: if checkLoops already triggered, this function is not called.
 *
 * @param {object} workflow
 * @param {object} task — the task that just finished
 * @returns {{triggered: boolean, ignored?: boolean, exhausted?: boolean, info?: object}}
 */
function checkRequestBacktrack(workflow, task) {
  const hist = task.history || [];
  const last = hist[hist.length - 1];
  if (!last || !last.output || !last.output.request_backtrack) {
    return { triggered: false };
  }

  const req = last.output.request_backtrack;
  const now = new Date().toISOString();

  // Helper to record in backtrack_log
  function logBacktrack(from, to, reason, result, attempt) {
    if (!workflow.context.backtrack_log) workflow.context.backtrack_log = [];
    workflow.context.backtrack_log.push({ from, to, reason, result, attempt, timestamp: now });
  }

  // 1. Validate target task exists
  const target = getTask(workflow, req.to);
  if (!target) {
    logBacktrack(task.name, req.to, req.reason, 'ignored', last.attempt);
    return { triggered: false, ignored: true, reason: `unknown target: ${req.to}` };
  }

  // 2. Validate target is a predecessor (only allow backward jumps)
  const ordered = orderTasks(workflow.tasks);
  const currentIdx = ordered.findIndex(t => t.name === task.name);
  const targetIdx = ordered.findIndex(t => t.name === req.to);
  if (targetIdx >= currentIdx) {
    logBacktrack(task.name, req.to, req.reason, 'ignored', last.attempt);
    return { triggered: false, ignored: true, reason: `target must be before current task` };
  }

  // 3. Per-task count check
  const maxPerTask = workflow.max_backtrack_per_task || 3;
  const counts = workflow.context.backtrack_counts || {};
  const current = counts[task.name] || 0;
  if (current >= maxPerTask) {
    logBacktrack(task.name, req.to, req.reason, 'exhausted', last.attempt);
    return { triggered: false, exhausted: true, reason: `max_backtrack_per_task exceeded for ${task.name}` };
  }

  // 4. Count + jump_to (same logic as checkLoops)
  counts[task.name] = current + 1;
  workflow.context.backtrack_counts = counts;

  // Clear downstream history (same as checkLoops)
  for (let i = targetIdx + 1; i < ordered.length; i++) {
    ordered[i].history = [];
    ordered[i].started_at = null;
    ordered[i].finished_at = null;
  }

  workflow.context.current_task = target.name;
  workflow.context.current_phase = target.phase;

  logBacktrack(task.name, req.to, req.reason, 'triggered', last.attempt);

  return {
    triggered: true,
    from: task.name,
    to: req.to,
    reason: req.reason,
    iteration: current + 1,
    max: maxPerTask,
  };
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
 * Save the workflow state back to its JSON file (atomic write).
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
 * Modes (all via --step):
 *  (a) Plain --step:
 *      - If task.requires_approval and no pending Attempt with approval_status=null → create pending Attempt, output NEED_APPROVAL.
 *      - If task.requires_approval and there IS a pending Attempt (approval_status=null) → output NEED_APPROVAL (re-ask).
 *      - If skill handler (and not approval-gated or already approved) → output NEED_SKILL.
 *      - If script handler → execute, write artifact, write Attempt, check loops, advance.
 *  (b) --step --approve:
 *      - Set the pending Attempt's approval_status=approved, then execute the task.
 *  (c) --step --reject "<reason>":
 *      - Set the pending Attempt's approval_status=rejected, status=fail, write Attempt, check loops (approval_rejected).
 *  (d) --step --output '<json>':
 *      - Write the skill's output to artifact file, write Attempt, check loops, advance.
 *
 * @param {string} workflowPath
 * @param {object} opts — { outputJson, approve, rejectReason }
 */
function step(workflowPath, opts) {
  const { outputFilePath, approve, rejectReason, agentId } = opts;
  // Resolve output: prefer --output-file (path), fall back to --output (inline JSON)
  let outputJson = opts.outputJson;
  if (outputFilePath) {
    try {
      outputJson = fs.readFileSync(outputFilePath, 'utf8');
    } catch (e) {
      emit({ type: 'ERROR', message: `Cannot read --output-file: ${e.message}` });
      return;
    }
  }
  const { workflow, workflowDir } = loadWorkflow(workflowPath);
  const skillRoot = workflowDir;
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

  ctx.current_task = task.name;
  ctx.current_phase = task.phase;

  // ── Ensure artifacts_dir is set on first execution ──
  ensureArtifactsDir(workflow, workflowDir);

  // ── Get or create the "current" Attempt for this task ──
  // The current Attempt is the last one in history if it's still pending (no result yet),
  // or a new one if the last one has a result.
  const hist = task.history || [];
  const lastAttempt = hist[hist.length - 1];
  const hasPendingAttempt = lastAttempt && !('status' in lastAttempt);

  // ═══════════════════════════════════════════════════════════════════════════
  // APPROVAL FLOW (only for tasks with requires_approval=true)
  // ═══════════════════════════════════════════════════════════════════════════
  if (task.requires_approval) {
    // Find the pending attempt (approval_status === null)
    const pendingAttempt = lastAttempt && lastAttempt.approval_status === null ? lastAttempt : null;

    if (rejectReason !== null && rejectReason !== undefined) {
      // ── Mode (c): --reject ──
      if (!pendingAttempt) {
        emit({ type: 'ERROR', message: `Cannot reject: no pending approval for task '${task.name}'` });
        return;
      }
      const now = new Date().toISOString();
      pendingAttempt.approval_status = 'rejected';
      pendingAttempt.approved_at = now;
      pendingAttempt.reject_reason = rejectReason;
      pendingAttempt.status = 'fail';
      task.finished_at = now;
      saveWorkflow(workflow, workflowPath);

      // Check loops — approval_rejected type will trigger
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
          reason: 'approval_rejected',
        });
        return;
      }
      // No loop configured for rejection — terminate
      ctx.terminated = true;
      ctx.terminate_reason = `approval_rejected_no_loop: ${task.name}`;
      saveWorkflow(workflow, workflowPath);
      emit({ type: 'TERMINATED', reason: ctx.terminate_reason });
      return;
    }

    if (approve) {
      // ── Mode (b): --approve ──
      if (!pendingAttempt) {
        emit({ type: 'ERROR', message: `Cannot approve: no pending approval for task '${task.name}'` });
        return;
      }
      pendingAttempt.approval_status = 'approved';
      pendingAttempt.approved_at = new Date().toISOString();
      pendingAttempt.approved_by = 'human';
      saveWorkflow(workflow, workflowPath);
      // Now fall through to normal execution below
    } else if (outputJson === null || outputJson === undefined) {
      // ── Mode (a): no output, no approve, no reject → need approval ──
      if (!pendingAttempt) {
        // Create a pending Attempt (no status yet, just approval_status=null)
        if (!task.history) task.history = [];
        const attemptNum = task.history.length + 1;
        const now = new Date().toISOString();
        if (!task.started_at) task.started_at = now;
        const pendingAttemptObj = {
          attempt: attemptNum,
          approval_status: null,
          approved_by: null,
          approved_at: null,
          reject_reason: null,
        };
        task.history.push(pendingAttemptObj);
        task.finished_at = now;
        saveWorkflow(workflow, workflowPath);
        emit({ type: 'NEED_APPROVAL', task: task.name, attempt: attemptNum });
        return;
      } else {
        // Pending attempt already exists — re-ask
        emit({ type: 'NEED_APPROVAL', task: task.name, attempt: pendingAttempt.attempt });
        return;
      }
    }
    // If approved, fall through to execution
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // OUTPUT FEEDBACK MODE (d): Agent feeds back a skill result
  // ═══════════════════════════════════════════════════════════════════════════
  if (outputJson !== null && outputJson !== undefined) {
    let outputEnvelope;
    try {
      outputEnvelope = JSON.parse(outputJson);
    } catch (e) {
      emit({ type: 'ERROR', message: `--output is not valid JSON: ${e.message}` });
      return;
    }
    if (!outputEnvelope || typeof outputEnvelope !== 'object') {
      emit({ type: 'ERROR', message: 'output must be a JSON object' });
      return;
    }
    // Normalize: if no 'data' field, wrap the whole object into data.
    // Sub-agent output may be { clarified_requirement: "..." } without data wrapper.
    // Also handles { files: [...] } and { passed: true, ... } formats.
    if (!('data' in outputEnvelope)) {
      const { passed, ...rest } = outputEnvelope;
      outputEnvelope = { data: rest };
      if (passed !== undefined) outputEnvelope.passed = passed;
    }

    // Validate data against task.output schema if present
    const v = validateAgainstSchema(outputEnvelope.data, task.output);
    if (v !== true) {
      emit({ type: 'ERROR', message: `output schema validation failed: ${v}` });
      return;
    }

    // Find the pending attempt (for approval tasks, this is the approved one; for others, create new)
    let attempt;
    if (task.requires_approval && lastAttempt && lastAttempt.approval_status === 'approved' && !('status' in lastAttempt)) {
      // Fill in the approved pending attempt with execution result
      attempt = lastAttempt;
      attempt.status = 'success';
      attempt.output = processOutput(workflow, workflowDir, task.name, attempt.attempt, outputEnvelope);
      const now = new Date().toISOString();
      task.finished_at = now;
    } else {
      // Normal task: record a fresh attempt
      attempt = recordAttempt(workflow, workflowDir, task, 'success', outputEnvelope, null);
    }

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

    // Check request_backtrack (LLM-initiated, after loops didn't trigger)
    const btResult = checkRequestBacktrack(workflow, task);
    if (btResult.triggered) {
      saveWorkflow(workflow, workflowPath);
      emit({
        type: 'BACKTRACK',
        from: btResult.from,
        to: btResult.to,
        reason: btResult.reason,
        iteration: btResult.iteration,
        max: btResult.max,
      });
      return;
    }
    if (btResult.ignored || btResult.exhausted) {
      saveWorkflow(workflow, workflowPath);
      emit({
        type: 'BACKTRACK_IGNORED',
        from: task.name,
        reason: btResult.reason,
      });
      // Continue to advance (request ignored, normal flow)
    }

    advance(workflow, task);
    saveWorkflow(workflow, workflowPath);
    emit({ type: 'DONE', task: task.name, status: 'success', output: attempt.output, ...(agentId ? { agent_id: agentId } : {}) });
    return;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EXECUTION MODE (a): execute or delegate
  // ═══════════════════════════════════════════════════════════════════════════
  const input = gatherInput(workflow, task, workflowDir);

  const iv = validateAgainstSchema(input, task.input);
  if (iv !== true) {
    emit({ type: 'ERROR', message: `input schema validation failed: ${iv}` });
    return;
  }

  const result = executeHandler(task, input, skillRoot, workflow);

  if (result.kind === 'skill') {
    // Save workflow (known_agents may have been updated by executeHandler)
    saveWorkflow(workflow, workflowPath);
    emit({
      type: 'NEED_SKILL',
      task: task.name,
      ref: result.ref,
      input: result.input,
      ...(result.executor ? { executor: result.executor } : {}),
    });
    return;
  }

  if (result.kind === 'script') {
    const status = result.failed ? 'fail' : 'success';

    // For approval tasks, fill the pending approved attempt; otherwise record fresh
    let attempt;
    if (task.requires_approval && lastAttempt && lastAttempt.approval_status === 'approved' && !('status' in lastAttempt)) {
      attempt = lastAttempt;
      attempt.status = status;
      attempt.output = processOutput(workflow, workflowDir, task.name, attempt.attempt, result.output);
      task.finished_at = new Date().toISOString();
    } else {
      attempt = recordAttempt(workflow, workflowDir, task, status, result.output, null);
    }

    saveWorkflow(workflow, workflowPath);

    if (status === 'fail') {
      ctx.terminated = true;
      ctx.terminate_reason = `task_failed: ${task.name}`;
      saveWorkflow(workflow, workflowPath);
      emit({ type: 'FAILED', task: task.name, output: attempt.output });
      return;
    }

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

    // Check request_backtrack (LLM-initiated, after loops didn't trigger)
    const btResult = checkRequestBacktrack(workflow, task);
    if (btResult.triggered) {
      saveWorkflow(workflow, workflowPath);
      emit({
        type: 'BACKTRACK',
        from: btResult.from,
        to: btResult.to,
        reason: btResult.reason,
        iteration: btResult.iteration,
        max: btResult.max,
      });
      return;
    }
    if (btResult.ignored || btResult.exhausted) {
      saveWorkflow(workflow, workflowPath);
      emit({
        type: 'BACKTRACK_IGNORED',
        from: task.name,
        reason: btResult.reason,
      });
      // Continue to advance (request ignored, normal flow)
    }

    advance(workflow, task);
    saveWorkflow(workflow, workflowPath);
    emit({ type: 'DONE', task: task.name, status: 'success', output: attempt.output, ...(agentId ? { agent_id: agentId } : {}) });
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
    artifacts_dir: workflow.artifacts_dir,
    terminated: workflow.context.terminated,
    terminate_reason: workflow.context.terminate_reason,
    loop_counts: workflow.context.loop_counts,
    backtrack_counts: workflow.context.backtrack_counts || {},
    backtrack_log: workflow.context.backtrack_log || [],
    known_agents: workflow.context.known_agents || [],
    task_progress: workflow.tasks.map(t => {
      const hist = t.history || [];
      const last = hist[hist.length - 1];
      const durationMs = (t.started_at && t.finished_at)
        ? new Date(t.finished_at).getTime() - new Date(t.started_at).getTime()
        : null;
      return {
        name: t.name,
        phase: t.phase,
        requires_approval: t.requires_approval || false,
        attempts: hist.length,
        last_status: last ? (last.status || 'pending_approval') : 'pending',
        last_approval_status: last ? (last.approval_status || null) : null,
        started_at: t.started_at || null,
        finished_at: t.finished_at || null,
        duration_ms: durationMs,
      };
    }),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function parseArgs(argv) {
  const args = { workflow: null, step: false, status: false, output: null, outputFile: null, approve: false, reject: null, agentId: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--workflow') { args.workflow = argv[++i]; }
    else if (a === '--step') { args.step = true; }
    else if (a === '--status') { args.status = true; }
    else if (a === '--output') { args.output = argv[++i]; }
    else if (a === '--output-file') { args.outputFile = argv[++i]; }
    else if (a === '--approve') { args.approve = true; }
    else if (a === '--reject') { args.reject = argv[++i]; }
    else if (a === '--agent-id') { args.agentId = argv[++i]; }
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
      step(args.workflow, {
        outputJson: args.output,
        outputFilePath: args.outputFile,
        approve: args.approve,
        rejectReason: args.reject,
        agentId: args.agentId,
      });
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
