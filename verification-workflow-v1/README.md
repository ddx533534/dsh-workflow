# Verification Workflow v1

一个协议驱动的 **计划 → 编码 → 验证** 循环工作流，以 skill 形式打包。支持可配置的阶段与任务、标准化协议、验证失败自动回环、零代码扩展。

---

## 目录

- [设计目标](#设计目标)
- [架构总览](#架构总览)
- [目录结构](#目录结构)
- [协议规范](#协议规范)
- [执行模型](#执行模型)
- [回环机制](#回环机制)
- [可扩展性](#可扩展性)
- [引擎参考](#引擎参考)
- [子 Skill](#子-skill)
- [使用指南](#使用指南)
- [设计决策记录](#设计决策记录)

---

## 设计目标

1. **协议驱动**：整个工作流由一份 JSON 声明完整描述。引擎读声明、驱动执行——绝不硬编码任务逻辑。
2. **循环感知**：验证失败时自动回退到编码阶段，上限可配置。
3. **零代码扩展**：新增任务或阶段只需改 JSON 声明，引擎逻辑不变。
4. **历史保留**：每次执行（含回环重跑）都记录在案，永不覆盖。
5. **skill/script 混合执行体**：每个任务的执行体可以是子 skill（由 Agent 通过大模型执行）或外部脚本（由 bash 执行）。
6. **增量持久化**：每次 Attempt 后即写盘，支持崩溃恢复。

---

## 架构总览

设计是一个单 skill，内含三层概念结构：

```
Workflow（一次完整运行）
  └─ Phase（大阶段：plan | code | verify，可扩展）
       └─ Task（具体任务，串行执行）
            └─ Attempt（单次执行记录，回环重跑时追加）
```

引擎与 Agent 以**单步循环**模式协作：

```
用户 (/verification-workflow <需求>)
  │
  ▼
Agent 加载 skill → 基于模板 + 用户需求生成 workflow.json
  │
  ▼  （单步循环）
Agent 调用:  node engine/loop.js --workflow workflow.json --step
  │
  ├─ script 执行体 → 引擎直接执行，写 Attempt，推进
  ├─ skill 执行体  → 引擎输出 NEED_SKILL，退出
  │      │
  │      ▼
  │   Agent 读取 skills/<ref>/SKILL.md，按 prompt 思考，产出 output
  │      │
  │      ▼
  │   Agent 调用: node engine/loop.js --step --output '<json>'
  │      → 引擎写 Attempt，检查回环，推进
  │
  └─ 全部完成 → 引擎输出 FINISHED
```

**核心原则**：引擎决定*跑什么*、*要不要回环*。Agent 决定*怎么执行 skill*（通过大模型）。引擎绝不直接调大模型。

---

## 目录结构

```
verification-workflow-v1/
├── SKILL.md                              # 顶层 skill 入口（disable-model-invocation: true）
├── agents/
│   └── openai.yaml                       # Agent 接口配置
├── protocol/
│   └── schema.json                       # 工作流协议的 JSON Schema
├── templates/
│   └── workflow_template.json            # 预填的声明模板，含 7 个默认任务
├── engine/
│   └── loop.js                           # 单步循环引擎（5 个模块合一处）
└── skills/                               # 子 skill（harness 不识别，被 handler 引用）
    ├── requirement_clarification/SKILL.md
    ├── tech_design/SKILL.md
    ├── test_case_design/SKILL.md
    ├── code/SKILL.md
    ├── code_review/SKILL.md
    ├── run_test/SKILL.md
    └── verdict/SKILL.md
```

### 两层 "skill" 的区分

| 层次 | 是什么 | harness 识别？ |
|---|---|---|
| **顶层 skill**（`verification-workflow-v1`） | 用户用 `/verification-workflow` 触发的 skill。提供协议、引擎、模板、子 skill。 | 是——`disable-model-invocation: true`，仅显式触发。 |
| **子 skill**（`skills/<name>/`） | 被 task handler 引用的 prompt + 资源包。自包含：各自声明 input/output schema。 | 否——由 Agent 用 `read` 工具加载，不走 `skill()` 工具。 |

---

## 协议规范

完整定义见 [`protocol/schema.json`](protocol/schema.json)。以下为摘要。

### Workflow（根对象）

```json
{
  "version": "1.0",
  "phases":  [ Phase ],
  "tasks":   [ Task ],
  "loops":   [ Loop ],
  "context": Context
}
```

- `phases` 和 `tasks` 是分开的数组。Phase 的 `tasks` 字段只存 name 引用；Task 本体在 `tasks` 数组里。
- `loops` 是全局的（不挂在 Phase 下），因为回环可以跨大阶段。
- `context` 是运行时状态，由引擎填充。

### Phase（大阶段）

```json
{
  "name": "plan",
  "tasks": ["requirement_clarification", "tech_design", "test_case_design"]
}
```

- `name`：大阶段标识。**不是固定枚举**——可扩展（将来可加 `"deploy"`）。
- `tasks`：属于该阶段的 task name 有序列表。

### Task（核心单元）

```json
{
  "name": "code",
  "phase": "code",
  "handler": { "type": "skill", "ref": "skills/code" },
  "depends_on": ["test_case_design"],
  "input":  { /* JSON Schema，可选 */ },
  "output": { /* JSON Schema，可选 */ },
  "started_at":  "2025-09-03T10:00:00Z",
  "finished_at": "2025-09-03T10:05:00Z",
  "history": [ Attempt ]
}
```

| 字段 | 状态 | 说明 |
|---|---|---|
| `name` | 声明态 | 全局唯一。与 `phase` 联合确定一个 task。 |
| `phase` | 声明态 | 所属大阶段。 |
| `handler` | 声明态 | 执行体：`{ type, ref }`。 |
| `depends_on` | 声明态，可选 | 前置 task name 列表。声明串行顺序。 |
| `input` / `output` | 声明态，可选 | JSON Schema 契约。若 handler 是子 skill，可由子 skill 的 SKILL.md 自行声明（自包含），workflow.json 可省略。 |
| `started_at` / `finished_at` | 运行态 | 首次执行开始时间 + 末次执行结束时间。`finished_at - started_at` = 该 task 总耗时（含回环重跑）。 |
| `history` | 运行态 | Attempt 数组。回环重跑时**追加**，永不覆盖。 |

### Handler（执行体）

```json
{ "type": "skill",  "ref": "skills/requirement_clarification" }
{ "type": "script", "ref": "scripts/run_test.py" }
```

- `ref` 是**相对路径**，相对于 skill 根目录。
- `skill`：Agent 读取 `<ref>/SKILL.md`，按其 prompt 思考，产出 output。
- `script`：引擎通过 bash 执行，input 以 JSON 写入 stdin，output 从 stdout 读 JSON。

### Attempt（单次执行记录）

```json
{
  "attempt": 2,
  "status": "success",
  "output": { "data": { ... }, "passed": false }
}
```

- `attempt`：序号，从 1 开始。回环重跑时递增。
- `status`：`"success"` 或 `"fail"`。只有这两种状态。
- `output`：**统一外壳** `{ data, passed? }`：
  - `data`：真正的产出物。结构由 task 的 output schema 定义。
  - `passed`：可选布尔值。只有判定类 task（如 verdict）才填。当为 `false` 且有回环引用 `output.passed` 时，触发回环。

### Loop（回环配置）

```json
{
  "trigger_task": "verdict",
  "trigger_field": "output.passed",
  "trigger_when": false,
  "target_task": "code",
  "max_iterations": 3
}
```

- `trigger_task`：检查哪个 task 的输出。
- `trigger_field`：取该 task **最后一次** Attempt 的输出的点号路径。如 `"output.passed"`。
- `trigger_when`：字段值等于此值时触发回环。
- `target_task`：回退到哪个 task。
- `max_iterations`：上限。超过则终止工作流，`terminate_reason: "max_iterations_exceeded"`。

### Context（运行时上下文）

```json
{
  "current_phase": "code",
  "current_task": "code",
  "loop_counts": { "verdict→code": 1 },
  "terminated": false,
  "terminate_reason": null
}
```

- `loop_counts`：键名格式为 `"<trigger_task>→<target_task>"`。
- `terminated` / `terminate_reason`：工作流结束时设置（完成、失败、或超过回环上限）。

---

## 执行模型

### 单步模式

引擎**不会**在一个进程里跑完整个工作流。它**每次调用只跑一个 task**。Agent 通过反复调 `--step` 来驱动循环。

这个设计选择确保：
- 引擎绝不直接调大模型（skill 执行委托给 Agent）。
- 状态在每步后完整持久化到 `workflow.json`（崩溃恢复）。
- 复用 Agent 已有的 `bash` 和 `read` 工具——不需要新能力。

### 单步流程

```
Agent: node engine/loop.js --step
  │
  引擎读 workflow.json
  引擎找到 current_task（或下一个未完成的 task）
  │
  ├─ handler.type == "script"
  │    引擎执行脚本（stdin=JSON，stdout=JSON）
  │    引擎写 Attempt，保存 workflow.json
  │    引擎检查回环
  │    → 输出: DONE / LOOP_BACK / TERMINATED
  │
  ├─ handler.type == "skill"
  │    引擎输出: NEED_SKILL { task, ref, input }
  │    引擎退出（不执行）
  │
  │    Agent 读取 <ref>/SKILL.md
  │    Agent 按 prompt 思考，产出 output JSON
  │
  │    Agent: node engine/loop.js --step --output '<json>'
  │    引擎写 Attempt，保存 workflow.json
  │    引擎检查回环
  │    → 输出: DONE / LOOP_BACK / TERMINATED
  │
  └─ 没有更多 task
       → 输出: FINISHED
```

### 串行执行与数据流

Task 按声明顺序执行。`depends_on` 声明显式前置。

当一个 task 运行时，引擎从其 `depends_on` 前驱的**最近一次成功** Attempt 产出中**收集 input**：

```
input = {
  "<前驱_task_name>": <前驱的最近 output.data>,
  ...
}
```

这就是 task 间的数据流动机制——每个 task 的产出自动作为其后继 task 的输入。

---

## 回环机制

### 什么时候触发回环？

**每个** task 完成后，引擎检查所有 `loops` 配置。如果刚完成的 task 是某个 loop 的 `trigger_task`，引擎从其最后一次 Attempt 读取 `trigger_field`，与 `trigger_when` 比较。

### 触发后发生什么？

1. 引擎递增 `loop_counts["<trigger_task>→<target_task>"]`。
2. 若计数超过 `max_iterations` → 工作流**终止**，`terminate_reason: "max_iterations_exceeded"`。
3. 否则，引擎把 `context.current_task` 设回 `target_task`（**jump_to**）。
4. 下一次 `--step` 时，从 `target_task` 恢复执行。其之前的 history 保留；追加一条新 Attempt。

### 默认回环

模板声明了一条回环：

```
verdict.passed == false  →  回退到 code （上限 3 次）
```

含义：验证失败时，工作流回退到 `code` task 重新实现。3 次失败后终止。

### 将来：小回环（code ↔ review）

协议支持加第二条回环，引擎无需改动：

```json
{
  "trigger_task": "code_review",
  "trigger_field": "output.data.approved",
  "trigger_when": false,
  "target_task": "code",
  "max_iterations": 2
}
```

只需往 `loops` 数组加一条。引擎已支持多条回环。

---

## 可扩展性

### 新增一个 task

1. 在 `skills/<new_task>/SKILL.md` 创建子 skill（含 input/output schema + prompt）。
2. 在 `workflow.json` 的 `tasks` 数组加一条：
   ```json
   {
     "name": "<new_task>",
     "phase": "verify",
     "handler": { "type": "skill", "ref": "skills/<new_task>" },
     "depends_on": ["<前驱>"]
   }
   ```
3. 把 task name 加到对应 phase 的 `tasks` 数组里。

**引擎代码不变。** 引擎只认 `handler.type + handler.ref`、`depends_on`、`loops`——全是声明式的。

### 新增一个大阶段

1. 在 `phases` 数组加一条 Phase（如 `{ "name": "deploy", "tasks": ["deploy"] }`）。
2. 在 `tasks` 数组加对应的 task。

### 新增一条回环

往 `loops` 数组加一条。引擎在每个 task 完成后检查所有回环。

### 新增一种 handler 类型

目前支持 `skill`、`script`。要加新类型（如 `llm_direct`），在 `engine/loop.js` 的 `executeHandler` 函数里加一个分支。这是唯一需要改引擎代码的扩展点。

---

## 引擎参考

文件：[`engine/loop.js`](engine/loop.js)

### 五个合一的模块

| 模块 | 职责 |
|---|---|
| **loader** | 读取并校验 `workflow.json`。检查：版本、phase 引用、task name 唯一性、depends_on 合法性、loop 引用。 |
| **executor** | 分发 handler。`skill` → 返回 `NEED_SKILL` 指令（委托 Agent）。`script` → 通过 bash 执行（stdin=JSON，stdout=JSON）。 |
| **engine** | 串行任务驱动。找下一个 task、从 depends_on 收集 input、按 schema 校验、调 executor、记 Attempt、推进。 |
| **loop_controller** | 每个 task 完成后检查所有回环。触发时：计数、jump_to 目标。超限时：终止。 |
| **checkpointer** | 每次 Attempt 后保存 `workflow.json`（原子写：临时文件 + rename）。 |

### CLI

```bash
# 查看状态（不执行）
node engine/loop.js --workflow <path> --status

# 执行一步（script 执行体直接跑；skill 执行体输出 NEED_SKILL）
node engine/loop.js --workflow <path> --step

# 喂回 skill 的产出（Agent 执行完子 skill 后）
node engine/loop.js --workflow <path> --step --output '<json>'
```

### 输出协议

所有引擎输出都是 stdout 上一行 JSON：

| `type` | 何时 | 关键字段 |
|---|---|---|
| `NEED_SKILL` | skill 执行体等待 Agent 执行 | `task`, `ref`, `input` |
| `DONE` | task 成功完成，已推进 | `task`, `status` |
| `LOOP_BACK` | 回环触发，已跳回目标 | `from`, `to`, `iteration`, `max` |
| `FINISHED` | 所有 task 完成 | — |
| `FAILED` | script task 失败，工作流终止 | `task`, `output` |
| `TERMINATED` | 工作流终止（超回环上限或其他） | `reason` |
| `STATUS` | 状态查询响应 | `current_task`, `task_progress[]`, `loop_counts` |
| `ERROR` | 校验或运行时错误 | `message` |

---

## 子 Skill

每个子 skill 位于 `skills/<name>/SKILL.md`，**自包含**：在 YAML frontmatter 里声明自己的 `input`/`output` JSON Schema，外加 prompt 正文。

| 子 skill | 大阶段 | output 有 `passed`？ | 说明 |
|---|---|---|---|
| `requirement_clarification` | plan | 否 | 将模糊需求澄清为结构化规格。 |
| `tech_design` | plan | 否 | 从澄清后的需求设计技术方案。 |
| `test_case_design` | plan | 否 | 从技术方案设计测试用例。 |
| `code` | code | 否 | 基于方案 + 测试用例实现代码。 |
| `code_review` | code | 否（有 `approved`） | 审查代码正确性与方案对齐度。 |
| `run_test` | verify | 否 | 执行测试用例，收集结果。 |
| `verdict` | verify | **是** | 基于测试结果判定通过/失败。`passed: false` 触发回环。 |

只有 `verdict` 产出驱动回环的 `passed` 字段。这是有意为之：`passed` 是 verdict task 的**业务产出**，不是协议通用字段。

---

## 使用指南

### 给最终用户

```
/verification-workflow <你的需求>
```

Agent 会：
1. 根据你的需求生成 `workflow.json`。
2. 逐步驱动 plan → code → verify 三个大阶段。
3. 验证失败时自动回退到 code（最多 3 次）。
4. 汇报最终结果。

### 给 Agent（驱动循环）

```
1. 加载 skill → 读 protocol/schema.json + templates/workflow_template.json
2. 根据用户需求生成 workflow.json
3. 循环:
   a. 调用: node engine/loop.js --workflow workflow.json --step
   b. 解析输出 JSON:
      - NEED_SKILL → 读 skills/<ref>/SKILL.md，思考，产出 output
                    → 调用: node engine/loop.js --step --output '<json>'
      - DONE       → 回到 3a
      - LOOP_BACK  → 回到 3a（引擎已把指针移回）
      - FINISHED   → 结束，向用户汇报
      - FAILED     → 向用户汇报失败
      - TERMINATED → 向用户汇报终止原因
```

---

## 设计决策记录

本节记录设计过程中（通过 `/grill-me` 访谈）做出的关键决策。

| # | 决策 | 理由 |
|---|---|---|
| 1 | `phase` = 大阶段，`name` = 具体任务 | 分离"在哪个阶段"和"做什么任务"。回环目标是某个阶段里的 task，不只是阶段。 |
| 2 | 无 `canskip` 字段 | 本版所有 task 必须执行。将来加 `canskip` 是非破坏性新增。 |
| 3 | `input`/`output` 是 JSON Schema，可选 | 结构化契约支持校验。可选是因为子 skill 可自声明。 |
| 4 | `status` 只有 `success` / `fail` | 无中间状态。控制流更简单。 |
| 5 | 回环触发条件 = `passed: false` | `passed` 是 verdict task 的业务产出，不是通用字段。回环配置通过 `trigger_field` 引用它。 |
| 6 | 回环目标 = `code` task | 验证失败意味着要重新实现，不只是重测。 |
| 7 | `max_iterations: 3` | 有界重试。防止无限循环。 |
| 8 | history 追加，永不覆盖 | 每次尝试都保留供调试。`attempt` 序号递增。 |
| 9 | 串行执行 + `depends_on` | v1 不并行。`depends_on` 声明显式顺序。 |
| 10 | 大阶段失败 = 工作流终止 | task 失败（status=fail）时，工作流以 `terminate_reason` 终止。 |
| 11 | code↔review 小回环暂缓 | 协议支持（加一条 loop 即可），但 v1 不配置。 |
| 12 | 零代码扩展 | 新增 task/phase/loop = 只改 JSON。引擎读声明，绝不硬编码。 |
| 13 | handler 类型：`skill` + `script` | `skill` = Agent 执行的 prompt。`script` = bash 执行。将来可扩展新类型。 |
| 14 | `passed` 放在 output 外壳 `{ data, passed? }` 里 | 统一 output 形状。`data` 永远有；`passed` 可选，仅判定类 task 填。 |
| 15 | `id` 改名 `name`，不带 phase 前缀 | `name + phase` 联合标识 task。减少冗余。 |
| 16 | 去掉 `label` | `name` 本身已语义化。协议里不存中文展示字段。 |
| 17 | 时间戳只在 Task 层（方案 A） | `started_at`（首次）+ `finished_at`（末次）= task 总耗时。不追踪单次 attempt 耗时（回环上限才 3）。 |
| 18 | skill + script 以单步模式协作 | 引擎每次 `--step` 只跑一个 task。skill 执行委托 Agent。引擎绝不直接调大模型。 |
| 19 | 子 skill 是内部资源 | harness 不识别。由 Agent 用 `read` 加载，不走 `skill()`。 |
| 20 | `handler.ref` 用相对路径 | 相对于 skill 根目录。如 `skills/requirement_clarification`。 |
| 21 | 子 skill 自包含 | 每个 SKILL.md 声明自己的 input/output schema。workflow.json 可省略 schema，信任子 skill。 |

---

## 许可

本 skill 是 verification-workflow-v1 原型的一部分。
