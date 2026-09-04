# 技术方案：子 Agent 执行器 + 主 Agent 编排

> 状态：待评审，未动代码
> 关联代码：`engine/loop.js`、`protocol/schema.json`、`templates/workflow_template.json`、`README.md`、`SKILL.md`、各子 skill 的 `SKILL.md`
> 参考文档：`/Users/dudongxu/Desktop/projects/coding-loop/coding-workflow-skill-design.md`

---

## 1. 问题

当前所有 task 由顶层 Agent 自己扮演：收到 `NEED_SKILL` → read SKILL.md → 思考 → 产出 → `--output` 喂回引擎。一次完整流程（含回环）可能执行 12+ 个 task，所有交互（input、SKILL.md prompt、工具调用、思考过程、产出）全堆在主 Agent 同一个上下文里，最终爆上下文。

**根因**：task 和执行者绑定——每个 task 的 handler 指向一个 skill prompt，主 Agent 每次都自己演，无法把思考过程卸载出去。

## 2. 核心设计

### 2.1 解耦 task 和 executor

- **task** = 工作流里的一个步骤（code、code_review、run_test、verdict）
- **agent** = 一个有状态、可复用的执行角色（planner、coder、verifier）
- **executor** = task 声明它由谁执行（主 Agent 自己 / 某个子 Agent）

task 的 `handler` 保留（做什么），新增 `executor`（谁来做）：

```json
{
  "name": "code",
  "handler": { "type": "skill", "ref": "skills/code" },
  "executor": "subagent:coder",
  ...
}
```

### 2.2 executor 取值

| 值 | 含义 | 上下文 |
|----|------|--------|
| `"self"` 或不填 | 主 Agent 自己执行（当前行为，兼容） | 思考过程进主 Agent 上下文 |
| `"subagent:<agent_id>"` | 起名为 `<agent_id>` 的子 Agent 执行 | 思考过程在子 Agent 上下文里，不进主 Agent |

### 2.3 子 Agent 复用

同一个 `executor: "subagent:coder"` 出现在多个 task 里时，共享同一个子 Agent 实例。回环重跑同一个 task 时，同一个子 Agent 继续——它记得上一轮自己做了什么、为什么失败，上下文连续。

**允许同一个 agent_id 跨 task 出现**：比如 code 和 code_review 可以用同一个 `subagent:coder`（reviewer 就是 coder 自己回头看），由声明者在 workflow.json 里决定。

**子 Agent 权限默认全有**：read/write/bash/grep 等所有工具，不额外限制。

## 3. 主 Agent 的定位

> **主 Agent 是编排者 + 翻译 + 用户接口。不做执行。**

| 职责 | 说明 |
|------|------|
| 翻译 | 把用户自然语言需求翻译成 workflow.json 声明 |
| 编排 | 驱动 `--step` 循环、起/复用子 Agent |
| 传话 | 收子 Agent 产出 → 直传 `--output` 喂回引擎（**不判断、不加工**） |
| 接口 | 审批问用户、最终结果报用户 |

主 Agent **不做**：不写代码、不跑测试、不 review、不思考技术方案、不判断子 Agent 产出——全交给子 Agent。

### 主 Agent 上下文里只有什么

```
引擎输出消息（NEED_SKILL / DONE / FINISHED 等，含精简摘要）
+ --output 喂回的 JSON（子 Agent 产出的精简结果，如 changed_files + summary）
+ 和用户的对话（审批、报告）
```

**没有任何子 Agent 的思考过程、工具调用、中间状态进入主 Agent 上下文。**

- 子 Agent 直接产出引擎期望的 JSON 格式（如 `{ files, summary }` 或 `{ data, passed }`），主 Agent 零加工直传。
- side-effect 模式的 output 只有 `changed_files` + `summary`，不是全文。全文在真实仓库里，由后续 task 的子 Agent 自己用工具读。
- artifact 模式的 output 只有 `file` 路径，引擎的 `gatherInput` 负责读文件内容传给下一个子 Agent。

## 4. 完整执行架构

```
用户
  ↓ "/verification-workflow 给登录加 JWT"
主 Agent（顶层，长期存活）
  ├── 理解需求 → 生成 workflow.json（声明，填 executor 字段）
  ├── 循环调 --step → 收引擎输出
  ├── 收到 NEED_SKILL + executor: subagent:planner
  │     → 起 planner 子 Agent（首次）或 send_message（复用）
  │     → 传 input + SKILL.md prompt
  │     → 收子 Agent 产出（引擎格式 JSON）
  │     → --output 喂回引擎（直传，不加工）
  ├── 收到 NEED_SKILL + executor: subagent:coder
  │     → 起 coder 子 Agent → 同上
  ├── 收到 NEED_APPROVAL → 问用户 → --approve / --reject
  ├── 收到 LOOP_BACK → 继续 --step（引擎已移指针）
  └── 收到 FINISHED → 向用户汇报

planner 子 Agent（plan 阶段复用，独立上下文）
  ├── requirement_clarification task
  ├── tech_design task
  └── test_case_design task

coder 子 Agent（code 阶段 + 回环复用，独立上下文）
  ├── code task（第 1 轮）
  ├── code task（回环第 2 轮）← 记得第 1 轮做了什么
  └── code_review task

verifier 子 Agent（验证阶段复用，独立上下文）
  ├── run_test task
  └── verdict task
```

## 5. 默认 executor 分配

| 阶段 | task | executor |
|------|------|----------|
| plan | requirement_clarification | `subagent:planner` |
| plan | tech_design | `subagent:planner` |
| plan | test_case_design | `subagent:planner` |
| code | code | `subagent:coder` |
| code | code_review | `subagent:coder` |
| verify | run_test | `subagent:verifier` |
| verify | verdict | `subagent:verifier` |

3 个子 Agent，各自有独立上下文，跨 task 复用，回环时上下文连续。

## 6. 引擎改动

只改 `executeHandler` 里 skill 类型的分支——输出 `NEED_SKILL` 时多带 `executor` 信息。

### 6.1 executeHandler 改动

当前（L277-282）：

```js
if (handler.type === 'skill') {
  return { kind: 'skill', ref: handler.ref, input };
}
```

改为：

```js
if (handler.type === 'skill') {
  const executor = task.executor || 'self';
  if (executor === 'self') {
    // 当前行为不变
    return { kind: 'skill', ref: handler.ref, input };
  }
  if (executor.startsWith('subagent:')) {
    const agentId = executor.slice('subagent:'.length);
    const knownAgents = workflow.context.known_agents || [];
    const reuse = knownAgents.includes(agentId);
    if (!reuse) {
      workflow.context.known_agents = [...knownAgents, agentId];
    }
    return {
      kind: 'skill',
      ref: handler.ref,
      input,
      executor: { mode: 'subagent', agent_id: agentId, reuse },
    };
  }
  throw new Error(`Unknown executor: ${executor}`);
}
```

### 6.2 step() 里 emit 变化

当前（L959-964）：

```js
emit({
  type: 'NEED_SKILL',
  task: task.name,
  ref: result.ref,
  input: result.input,
});
```

改为：

```js
emit({
  type: 'NEED_SKILL',
  task: task.name,
  ref: result.ref,
  input: result.input,
  ...(result.executor ? { executor: result.executor } : {}),
});
```

`executor` 为 `self` 时不带 `executor` 字段（兼容当前行为）。

### 6.3 context 加 known_agents 字段

`workflow.context` 新增：

```json
{
  "known_agents": ["planner", "coder", "verifier"]
}
```

引擎维护这个列表，用于判断 `reuse: true/false`。`saveWorkflow` 时一起持久化。

### 6.4 不改的部分

- `ensureArtifactsDir` / `writeArtifact` / `readArtifact`：产物目录逻辑刚改完，不动。
- `processOutput` / `gatherInput`：产出处理和 input 收集逻辑不变。子 Agent 产出的 JSON 格式和当前主 Agent 产出格式一样（都是引擎期望的格式），引擎处理无差别。
- `checkLoops` / `checkRequestBacktrack` / `advance`：回环/推进逻辑不变。
- `saveWorkflow` / `loadWorkflow`：持久化逻辑不变。
- 审批流程：不变。

## 7. Agent 驱动循环变化

当前（README 里）：

```
收到 NEED_SKILL
  → read SKILL.md
  → 思考
  → --output '<json>'
```

改为：

```
收到 NEED_SKILL
  ├── 无 executor 字段（= self）
  │     → read SKILL.md → 思考 → --output '<json>'   ← 当前行为
  │
  └── 有 executor 字段
        ├── executor.reuse == false
        │     → subagent(prompt = read SKILL.md 内容, input = NEED_SKILL.input)
        │     → 收子 Agent 最终产出
        │     → --output '<子 Agent 产出的 JSON>'   ← 直传，不加工
        │
        └── executor.reuse == true
              → send_message(agent_id, "新任务：<input JSON>")
              → 收子 Agent 最终产出
              → --output '<子 Agent 产出的 JSON>'   ← 直传，不加工
```

## 8. schema.json 变更

### Task 新增 executor 字段

```json
"executor": {
  "type": "string",
  "description": "Who executes this task. 'self' = main Agent (default, current behavior). 'subagent:<agent_id>' = a named sub-agent. Same agent_id across tasks shares one sub-agent instance (reused, with continuous context). Sub-agents have full tool access by default.",
  "default": "self"
}
```

### Context 新增 known_agents 字段

```json
"known_agents": {
  "type": "array",
  "items": { "type": "string" },
  "description": "Runtime. List of sub-agent IDs that have been created. Used to determine reuse vs create on subsequent NEED_SKILL outputs."
}
```

## 9. workflow_template.json 变更

每个 task 加 `executor` 字段：

```json
{
  "name": "requirement_clarification",
  "phase": "plan",
  "handler": { "type": "skill", "ref": "skills/requirement_clarification" },
  "executor": "subagent:planner",
  "depends_on": []
},
{
  "name": "tech_design",
  "phase": "plan",
  "handler": { "type": "skill", "ref": "skills/tech_design" },
  "executor": "subagent:planner",
  "depends_on": ["requirement_clarification"]
},
{
  "name": "test_case_design",
  "phase": "plan",
  "handler": { "type": "skill", "ref": "skills/test_case_design" },
  "executor": "subagent:planner",
  "depends_on": ["tech_design"]
},
{
  "name": "code",
  "phase": "code",
  "handler": { "type": "skill", "ref": "skills/code" },
  "executor": "subagent:coder",
  "depends_on": ["test_case_design"],
  "requires_approval": true
},
{
  "name": "code_review",
  "phase": "code",
  "handler": { "type": "skill", "ref": "skills/code_review" },
  "executor": "subagent:coder",
  "depends_on": ["code"]
},
{
  "name": "run_test",
  "phase": "verify",
  "handler": { "type": "skill", "ref": "skills/run_test" },
  "executor": "subagent:verifier",
  "depends_on": ["code_review"]
},
{
  "name": "verdict",
  "phase": "verify",
  "handler": { "type": "skill", "ref": "skills/verdict" },
  "executor": "subagent:verifier",
  "depends_on": ["run_test"]
}
```

context 加 `known_agents: []`。

## 10. 子 SKILL.md 变化

各子 skill 的 SKILL.md **内容不用改**——它们已经是"收到 input → 思考 → 产出引擎格式 JSON"的风格。无论执行者是主 Agent 还是子 Agent，读的都是同一个 SKILL.md，产出格式要求一样。

唯一可选的改动：在 SKILL.md 里加一句提醒"你是在子 Agent 上下文里执行，你的思考过程不会传给上层"，让子 Agent 知道自己产出要自包含。但这不是必须的。

## 11. 改动范围汇总

| 文件 | 改动 | 工作量 |
|------|------|--------|
| `engine/loop.js` | `executeHandler` skill 分支加 executor 逻辑；`step()` emit 带 executor 字段；context 初始化加 known_agents | 小 |
| `protocol/schema.json` | Task 加 `executor` 字段；Context 加 `known_agents` 字段 | 小 |
| `templates/workflow_template.json` | 7 个 task 加 executor 字段；context 加 known_agents | 小 |
| `README.md` | 更新 Agent 驱动循环、执行架构说明 | 小 |
| `SKILL.md` | 更新使用指南说明 executor 机制 | 小 |
| 子 skill SKILL.md | 不改 | — |

**不改**：产物目录逻辑、产出处理、input 收集、回环/审批/backtrack/推进逻辑、持久化逻辑。

## 12. 上下文隔离效果验证

一次完整流程（7 task + 1 次回环，共 10+ 次执行）：

**主 Agent 上下文**（全程不变）：
```
+ 生成 workflow.json 的对话（用户需求 → 声明）
+ 10+ 条引擎输出消息（NEED_SKILL/DONE/LOOP_BACK/FINISHED，每条含精简摘要）
+ 10+ 条 --output 喂回的 JSON（子 Agent 产出的精简结果）
+ 审批对话
```

**planner 子 Agent 上下文**（plan 阶段 3 个 task）：
```
+ 3 次 task 的 input（tech_design 全文、test_case 全文等）
+ 3 次 SKILL.md prompt
+ 工具调用（探查仓库）
+ 思考过程 + 产出
```

**coder 子 Agent 上下文**（code + code_review，含回环 2 轮）：
```
+ 2 次 code task 的 input + 产出
+ 2 次 code_review task 的 input + 产出
+ 工具调用（读写真实仓库）
+ 思考过程（记得第 1 轮改了什么、为什么回环）
```

**verifier 子 Agent 上下文**（run_test + verdict）：
```
+ run_test 的 input + 测试执行结果
+ verdict 的 input + 判定产出
```

主 Agent 上下文只含精简摘要，不爆。子 Agent 各自隔离，互不干扰。

## 13. 待确认

1. **子 Agent 的 SKILL.md 怎么传给子 Agent？** 主 Agent `read` SKILL.md 内容，作为 prompt 传给 `subagent`？还是子 Agent 自己 `read`？
2. **子 Agent 复用时，新任务的 input 怎么传？** `send_message` 带新 input，还是子 Agent 自己从某个地方拿？
3. **先做 executor 机制还是先做 verdict 的 remaining_issues 汇总？** 两者独立，可分步。

---

## 附：从参考文档吸收的点

| 参考文档的点 | 是否吸收 | 说明 |
|---|---|---|
| 子 Agent 之间禁止直接通信 | ✅ 已有 | 当前 task 间只通过 depends_on 单向传 input |
| 循环由程序控制 | ✅ 已有 | checkLoops 引擎判定，不靠 prompt |
| Issue 汇总机制（remaining_issues） | ⏳ 待做 | verdict 产出加 issues，回环时传给 code task |
| 统一 AgentResult 协议 | ⏳ 部分 | 当前 output 已有 artifact/side-effect 两模式，可加 issues |
| Checkpoint 边界明确化 | ❌ 不做 | 当前每次 --step 都写盘，够用 |
| 两类状态分离 | ✅ 已隐性实现 | workflow.json 是流程状态，模型上下文由 harness 管 |
| A2A 协议 | ❌ 不做 | 当前是单进程内 prompt 编排，不需要网络协议层 |
| SQLite 存储 | ❌ 不做 | JSON 文件够用 |
| Harness Adapter | ❌ 不做 | 引擎是独立 Node 脚本，天然隔离 harness API |
