# Verification Workflow v1

一个协议驱动的 **计划 → 编码 → 验证** 循环工作流，以 skill 形式打包。

---

## 基本原理：为什么流程能被保证

**引擎独占状态和转移条件，大模型不持有状态、不知道流程。**

这是整套设计的核心——保证流程执行的，不是大模型的"自觉"，而是引擎对状态和转移条件的独占控制。

### 三个原理

**原理 1：状态独占。** 引擎把所有流程状态锁在 `workflow.json` 里——当前在第几个 task、回环了几次、每个 task 的历史产出。大模型每次被调用时只收到 input（前序 task 的产出），它不知道自己在第几轮、不知道之前跑了什么、不知道接下来要跑什么。**大模型不持有状态 → 它无法自己决定"接下来干什么"。**

**原理 2：转移条件是代码。** "什么时候从 A 到 B"写死在引擎代码里（`findNextTask`、`checkLoops`、`advance`），不写在 prompt 里。大模型被调用时，它已经在引擎选定的 task 里了——它没有机会选择"我要跑哪个 task"。

**原理 3：单步执行。** 引擎每次 `--step` 只跑一个 task，跑完写盘退出。大模型在两次调用之间不存在——"上一步做了什么、下一步做什么"的记忆完全由 `workflow.json` 持有。

### 结果

大模型唯一能做的事：**收到 input → 思考 → 产出 output**。除此之外的一切——选 task、传 input、存 output、判回环、计数、终止——全是引擎代码。

大模型可以产出烂代码、可以判错 verdict，但它**不能偏离流程**——因为流程不在它手里。

**引擎是导演，大模型是演员。** 导演喊"这场戏你演 code，给你这些材料，演完把结果给我"。演员演完就下场，下一场演什么、谁来演，演员说了不算。

---

## 目录

- [基本原理](#基本原理为什么流程能被保证)
- [优缺点对比：vs 全权交给大模型](#优缺点对比vs-全权交给大模型)
- [设计目标](#设计目标)
- [目录结构](#目录结构)
- [协议规范](#协议规范)
- [执行模型](#执行模型)
- [回环与审批](#回环与审批)
- [产出处理](#产出处理)
- [可扩展性](#可扩展性)
- [使用指南](#使用指南)
- [设计决策记录](#设计决策记录)

---

## 优缺点对比：vs 全权交给大模型

### 核心区别

**本设计**：引擎独占状态和流程，大模型只管"收 input → 思考 → 产 output"。

**全权交给大模型**：大模型自己持有状态、自己决定流程、自己控制每一步。

交换的本质：用**灵活性**换**可控性**。

### 本设计的优点

- **流程不偏离**：引擎强制 task 顺序、回环、审批，大模型无法跳步或忘循环。
- **可审计**：workflow.json 每步有记录，产出有 artifact 文件。
- **可恢复**：崩溃了从 workflow.json 续跑，不丢进度。
- **可复现**：流程结构固定，同样的声明跑同样的流程。

### 本设计的缺点

- **流程是死的**：预定义的 loops 覆盖不了运行时发现的新问题（如 code 发现需求矛盾想回头改需求，但没声明这条回环，todo待解决）。
- **task 不能协作**：每个 task 独立单轮调用，不能回头问前序 task(todo待解决)。
- **上下文不连续**：每个 task 是独立调用，前一个的思考过程不传给后一个。
- **简单任务过度工程**：改个 label 跑八个 task，开销远大于任务本身。
- **声明本身可能错**：workflow.json 的 depends_on、handler.ref、loops 写错了流程就乱。

### 适合场景

- **本设计适合**：流程已知、需要纪律保证、需要审计复现的研发流程。
- **全权交给大模型适合**：探索性任务、简单任务、高度动态的场景。

### 理想方向

不是二选一，而是**在引擎保持控制权的前提下，给大模型一条反馈通道**——比如 task 产出里带 `request_backtrack`，大模型可以"请求"回头，引擎决定要不要执行。既有纪律，又有灵活性。（已记入 [TODO](TODO.md) 第 4 条）

---

## 设计目标

1. **协议驱动**：工作流由 JSON 声明描述，引擎读声明驱动执行，不硬编码 task 逻辑。
2. **循环感知**：验证失败自动回退到编码阶段，上限可配置。
3. **人工审批门禁**：指定 task 执行前必须人工审批，回环重跑时也要重新审批。
4. **零代码扩展**：新增 task/phase/loop 只改 JSON，引擎不变。
5. **历史保留**：每次执行（含回环重跑）都记录在案，永不覆盖。
6. **增量持久化**：每次 Attempt 后即写盘，支持崩溃恢复。

---

## 目录结构

```
verification-workflow-v1/
├── SKILL.md                    # 顶层 skill 入口（disable-model-invocation: true）
├── agents/openai.yaml          # Agent 接口配置
├── protocol/schema.json        # 工作流协议 JSON Schema
├── templates/
│   └── workflow_template.json  # 预填声明模板（7 个 task + 2 条回环）
├── engine/loop.js              # 单步循环引擎
└── skills/                     # 子 skill（被 handler 引用，harness 不识别）
    ├── requirement_clarification/SKILL.md
    ├── tech_design/SKILL.md
    ├── test_case_design/SKILL.md
    ├── code/SKILL.md
    ├── code_review/SKILL.md
    ├── run_test/SKILL.md
    └── verdict/SKILL.md
```

运行时产物：

```
<项目根>/
└── .verification-workflow/
    └── run_<时间戳>/              # 一次完整运行的根目录（Agent 生成 workflow.json 时创建）
        ├── .workflow.json          # 声明 + 运行时状态（唯一一份，引擎读写）
        └── artifacts/              # 产出文件（引擎首次 step 时创建）
            ├── requirement_clarification_attempt1.json
            ├── tech_design_attempt1.json
            ├── code_review_attempt1.json
            ├── run_test_attempt1.json
            └── verdict_attempt1.json
```

- **run 目录名**：`run_<YYYYMMDDHHmmss>`，不绑 run_name，时间戳保证唯一。
- **project_root**：workflow.json 里的 `project_root` 字段（默认 `../..`），表示项目根相对 run 目录的路径。side-effect 模式（code task）写文件时基于此路径，写到真实仓库而非 run 目录。
- Agent 生成 workflow.json 时直接写到 `run_<时间戳>/.workflow.json`，引擎不搬家、不同步，全程只读写这一份。

### 两层 skill

| 层次 | 是什么 | harness 识别？ |
|---|---|---|
| 顶层 skill | 用户 `/verification-workflow` 触发。提供协议、引擎、模板、子 skill。 | 是 |
| 子 skill | 被 task handler 引用的 prompt 包。自包含 input/output schema。 | 否——Agent 用 `read` 加载 |

---

## 协议规范

完整定义见 `protocol/schema.json`。

### Workflow

```json
{
  "version": "1.0",
  "run_name": "add_login_feature",
  "artifacts_dir": null,
  "project_root": "../..",
  "phases": [Phase],
  "tasks": [Task],
  "loops": [Loop],
  "context": Context
}
```

- `run_name`：英文短名，Agent 生成 workflow.json 时填，语义标识用途，不用于目录名。
- `artifacts_dir`：引擎首次执行时创建（`artifacts`，相对于 run 目录）。
- `project_root`：项目根相对 run 目录的路径（默认 `../..`）。side-effect 模式写文件基于此路径。
- `loops`：全局配置，可跨 phase。

### Phase

```json
{ "name": "plan", "tasks": ["requirement_clarification", "tech_design", "test_case_design"] }
```

`name` 不是固定枚举，可扩展（将来可加 `deploy`）。

### Task

```json
{
  "name": "code",
  "phase": "code",
  "handler": { "type": "skill", "ref": "skills/code" },
  "depends_on": ["test_case_design"],
  "requires_approval": true
}
```

| 字段 | 说明 |
|---|---|
| `name` | 全局唯一，与 `phase` 联合标识。 |
| `handler` | `{ type: "skill"\|"script", ref }`。ref 是相对路径。 |
| `executor` | 默认 `self`（主 Agent 自己执行）。`subagent:<agent_id>` = 起子 Agent 执行，同 agent_id 跨 task 复用。 |
| `depends_on` | 前置 task 列表，声明串行顺序。 |
| `requires_approval` | 默认 false。true = 执行前必须人工审批。 |
| `input`/`output` | JSON Schema 契约，可选。子 skill 可自声明。 |
| `started_at`/`finished_at` | 运行态。首次开始 + 末次结束。 |
| `history` | 运行态。Attempt 数组，回环追加不覆盖。 |

### Attempt

```json
{
  "attempt": 1,
  "status": "success",
  "output": {
    "file": "artifacts/tech_design_attempt1.json"
  }
}
```

`output` 有两种模式（引擎按产出结构自动判断，见[产出处理](#产出处理)）：

| 模式 | output 字段 | 何时 |
|---|---|---|
| artifact | `file` | 产出无 `files` 字段（默认） |
| side-effect | `changed_files`, `summary` | 产出含 `files` 字段（如 code task） |

**input 传文件路径，不传内容。** 引擎的 `gatherInput` 收集前序 task 的产出时，artifact 模式只传 `{ file: "artifacts/xxx.json" }`（路径），side-effect 模式传 `{ changed_files, summary }`。主 Agent 和子 Agent 拿到路径后自己 `read` 文件内容——主 Agent 上下文里没有业务数据。

**产出包装自动化。** 子 Agent 写到 `--output-file` 的 JSON 可以是裸格式（如 `{"clarified_requirement": "..."}`），无需手动包 `{data: ...}`。引擎读进来如果没有 `data` 字段，自动把整个对象包进 `data`。

两种模式都可带 `passed`（可选布尔，仅 verdict task 有，驱动回环）和 `request_backtrack`（可选对象，大模型主动请求回头，见[request_backtrack](#request_backtrack)）。

审批相关字段（仅 `requires_approval` 的 task）：`approval_status`（null/approved/rejected）、`approved_by`、`approved_at`、`reject_reason`。

### Loop

```json
{
  "trigger_type": "output_field",
  "trigger_task": "verdict",
  "trigger_field": "output.passed",
  "trigger_when": false,
  "target_task": "code",
  "max_iterations": 3
}
```

| trigger_type | 判定方式 |
|---|---|
| `output_field` | 读 trigger_task 最后 Attempt 的字段，与 trigger_when 比较 |
| `approval_rejected` | 检查 trigger_task 最后 Attempt 的 approval_status == "rejected" |

两种类型共用 `checkLoops` 逻辑。每条 loop 独立计数（`loop_counts["trigger→target"]`），全局累计不重置。

### Context

```json
{
  "current_task": "code",
  "loop_counts": { "verdict→code": 1 },
  "terminated": false,
  "terminate_reason": null
}
```

---

## 执行模型

### 单步模式

引擎每次 `--step` 只跑一个 task，跑完写盘退出。Agent 通过反复调 `--step` 驱动循环。

这确保：引擎不直接调大模型、状态每步持久化、审批可自然暂停。

### 单步流程

```
Agent: node engine/loop.js --step [--approve | --reject "理由" | --output '<json>']
  │
  引擎读 workflow.json → 找到 current_task → 首次执行时创建 artifacts_dir
  │
  ├─ requires_approval 且未审批 → 输出 NEED_APPROVAL，退出
  │    Agent 问用户 → 同意: --approve / 拒绝: --reject "理由"
  │
  ├─ skill 执行体 → 输出 NEED_SKILL，退出
  │    Agent 读 SKILL.md → 思考 → 产出 → 调 --output '<json>'
  │    引擎处理产出 → checkLoops → checkRequestBacktrack → 推进
  │
  ├─ script 执行体 → 引擎直接执行 → checkLoops → checkRequestBacktrack → 推进
  │
  └─ 无更多 task → FINISHED
```

### 数据流

引擎从 `depends_on` 前驱的最近成功 Attempt 收集 input：

- 前驱是 artifact 模式 → 传 `{ file: "artifacts/xxx.json" }`（**路径，不读内容**）。子 Agent 拿到路径后自己 `read` 文件。
- 前驱是 side-effect 模式 → 传 `{ changed_files, summary }`（文件已在真实仓库，子 Agent 自己用工具读）

主 Agent 上下文里只有文件路径和摘要，没有任何业务数据内容。

---

## 回环与审批

### 两条默认回环

| 回环 | 触发条件 | 回退到 | 上限 | 含义 |
|---|---|---|---|---|
| verdict → code | `output.passed == false` | code | 3 | 验证失败 → 重新编码 |
| code → tech_design | `approval_status == "rejected"` | tech_design | 2 | 审批拒绝 → 回退改方案 |

两条 loop 共享 `checkLoops` 逻辑，各自独立计数。回溯时清除 target_task 之后所有 task 的 history（强制重跑）。

### 审批门禁

`requires_approval: true` 的 task（默认只有 code）执行前暂停，输出 `NEED_APPROVAL`。用户同意才执行，拒绝则触发回环。回环重跑时重新审批。

### request_backtrack

大模型在执行中发现前序 task 的产出有问题（如需求矛盾、方案不可行），可以在产出里带 `request_backtrack` 字段，**请求**引擎回头重跑前序 task。

```json
{
  "files": [...],
  "summary": "...",
  "request_backtrack": {
    "to": "requirement_clarification",
    "reason": "需求第三条与技术方案冲突"
  }
}
```

引擎在 `checkLoops` 之后检查 `request_backtrack`（loops 优先）。规则：

- **只允许往回跳**：目标必须是当前 task 的前序。往前跳会被忽略。
- **per-task 计数**：每个 task 发起 backtrack 的次数独立计数，上限 `max_backtrack_per_task`（默认 3）。不管回到哪，同一个 task 最多发起 3 次。
- **超限不终止**：请求被忽略，工作流正常推进。但记录在 `backtrack_log` 里供审计。
- **jump_to 逻辑跟 loops 一致**：清除目标之后所有 task 的 history，强制重跑。

两套回溯机制独立计数，互不干扰：

| 机制 | 计数器 | 键 | 上限 |
|---|---|---|---|
| 声明式 loops | `loop_counts` | `"trigger→target"` | 每条 loop 的 `max_iterations` |
| request_backtrack | `backtrack_counts` | `"发起 task name"` | `max_backtrack_per_task` |

引擎输出新增 `BACKTRACK`（触发）和 `BACKTRACK_IGNORED`（忽略/超限）。所有请求（含被忽略的）记录在 `context.backtrack_log` 供审计。

---

## 产出处理

引擎按产出结构自动判断模式，不需要声明字段：

**产出含 `files` 数组 → side-effect 模式：**
- 引擎把每个 file 的 content 写进真实仓库（路径基准 `project_root`，即项目根）
- output 只存 `changed_files`（路径列表）+ `summary`
- 不创建 artifact 文件
- 下一个 task 通过 `changed_files` 知道改了哪些文件，用 `read` 工具从真实仓库读

**产出无 `files` → artifact 模式：**
- 引擎把产出数据外置到 `artifacts/<task>_attempt<N>.json`
- output 只存 `file` 路径
- 回环重跑时 N 递增，不覆盖
- 下一个 task 的 input 收到 `{ file: "artifacts/xxx.json" }`（路径），子 Agent 自己 `read` 内容

**产出格式自动包装：** 子 Agent 产出可以是裸 JSON（如 `{"clarified_requirement": "..."}`），引擎读进来如果没有 `data` 字段会自动包装成 `{ data: { clarified_requirement: "..." } }`。不需要主 Agent 手动包装。

`passed`（仅 verdict task）始终留在 workflow.json，两种模式都可带，loop_controller 直接读。

---

## 可扩展性

| 要做什么 | 怎么做 | 改引擎？ |
|---|---|---|
| 新增 task | 创建 `skills/<name>/SKILL.md` + workflow.json 加声明 | 否 |
| 新增回环 | loops 数组加一条 | 否 |
| 新增审批门禁 | task 加 `requires_approval: true` | 否 |
| 新增大阶段 | phases 数组加一条 | 否 |
| 新增 handler 类型 | `executeHandler` 加分支 | 是 |

---

## 使用指南

### 用户

```
/verification-workflow <你的需求>
```

Agent 生成 workflow.json → 逐步驱动 plan → code → verify → 验证失败回退 code（最多 3 次）→ code 审批拒绝回退 tech_design（最多 2 次）→ 汇报结果。

### Agent 驱动循环

**主 Agent 不碰仓库、不收集业务数据。** 它只拿到用户的一句话需求，直接套模板生成 workflow.json，不探查仓库结构、不读代码、不关心技术栈。所有业务理解、代码探查、数据收集都由子 Agent 在自己的上下文里完成。

```
1. 加载 skill → 生成 workflow.json（不探查仓库）：
   a. 生成时间戳 ts = YYYYMMDDHHmmss
   b. 创建 run 目录 .verification-workflow/run_<ts>/
   c. 基于 templates/workflow_template.json 套模板，只填 run_name（从用户需求提取英文短名）
   d. 写到 .verification-workflow/run_<ts>/.workflow.json

2. 初始化空映射表：agent_id_map = {}
   # 存 declared_name → harness 真实 agent_id 的映射
   # 例：{ "planner": "a3f7b2c1-...", "coder": "b8e2d4f3-..." }

3. 循环调 node engine/loop.js --workflow .verification-workflow/run_<ts>/.workflow.json --step，按输出类型处理:
   - NEED_APPROVAL → 问用户 → --approve 或 --reject "理由"
   - NEED_SKILL    → 看 executor 字段：
     - 无 executor（= self）→ 读 SKILL.md → 思考 → --output '<json>'
     - 有 executor            → 查 agent_id_map，决定新建还是复用（主 Agent 不读 SKILL.md）：
       declared_name = executor.agent_id          # 来自 workflow.json 的声明名
       task_prompt = "读 " + handler.ref + "/SKILL.md 并按其指引执行。输入：" + JSON.stringify(NEED_SKILL.input)
       if declared_name not in agent_id_map:       # 映射表里没有 → 新建
         result = subagent(
           prompt = task_prompt,                    # 传路径给子 Agent，不自己读
           description = declared_name
         )
         agent_id_map[declared_name] = result.agent_id    # 存真实 id
         output = result.output
       else:                                        # 映射表里有 → 复用
         real_id = agent_id_map[declared_name]
         output = send_message(
           agent_id = real_id,
           message  = task_prompt                   # 同样传路径，不自己读
         )
       # 子 Agent 把产出写到文件，主 Agent 只传文件路径（不碰产出内容）
       --output-file '<产出文件路径>' --agent-id '<real_id>'
   - DONE          → 继续 --step
   - LOOP_BACK     → 继续 --step（声明式回环，引擎已移指针）
   - BACKTRACK     → 继续 --step（大模型请求回头，引擎已移指针）
   - BACKTRACK_IGNORED → 继续 --step（请求被忽略，正常推进）
   - FINISHED      → 向用户汇报
   - FAILED/TERMINATED → 向用户汇报原因
```

> **注意**：引擎输出的 `executor.reuse` 是参考值（基于 `context.known_agents` 判断），但主 Agent 以自己的 `agent_id_map` 为真相——映射表里有就复用，没有就新建。这样即使引擎状态被重置，主 Agent 仍能正确复用已活的子 Agent。

### 执行器机制

每个 task 声明 `executor` 字段决定由谁执行：

| executor | 含义 | 场景 |
|---|---|---|
| `self` 或不填 | 主 Agent 自己执行 | 兼容旧行为 |
| `subagent:<name>` | 起名为 `<name>` 的子 Agent | 隔离上下文 |

#### 子 Agent 复用：声明名 vs 真实 id

复用机制涉及两种 id，必须分清：

| 类型 | 例子 | 谁管 | 何时产生 |
|------|------|------|---------|
| **声明名** (declared_name) | `"planner"` | 写在 workflow.json 的 `executor` 字段里，引擎输出 `NEED_SKILL` 时带这个 | 生成 workflow.json 时 |
| **真实 id** (real_agent_id) | `"a3f7b2c1-..."` | 主 Agent 的 `agent_id_map` 里存，调 `subagent`/`send_message` 时用这个 | `subagent` 创建时 harness 返回 |

**引擎只管声明名**：它从 `executor` 字段读声明名，在 `context.known_agents` 里记录见过哪些声明名，输出 `reuse: true/false`。引擎不持有也不存真实 id——那是 harness 运行时的引用，不该写进 workflow.json。

**主 Agent 管真实 id**：它调 `subagent` 时拿到 harness 返回的真实 id，存在自己的 `agent_id_map`（声明名 → 真实 id）。下次 `reuse: true` 时，从映射表查真实 id，调 `send_message` 复用子 Agent。

#### 子 Agent 生命周期

子 Agent 跑完一轮后**不会消失**——它进入 idle 状态，Session 持久化，带着之前的上下文等着。`send_message` 给它发新任务时，新消息追加到同一个 Session，上下文连续。回环重跑同一个 task 时，同一个子 Agent 继续——它记得上一轮做了什么。

#### 主 Agent 的定位

> **纯流程调度器 + 用户接口。不碰仓库、不做执行、不收集业务数据。**

主 Agent 不做的事：
- **不探查仓库**：不 read 代码、不 grep、不 bash——所有业务数据收集由子 Agent 在自己上下文里完成
- **不判断产出**：收子 Agent 产出后直传 `--output` 喂回引擎，不判断、不加工
- **不思考业务**：不理解技术方案、不写代码、不跑测试——全交给子 Agent

主 Agent 只做的事：
- 把用户需求翻译成 workflow.json 声明（套模板，填 run_name）
- 驱动 `--step` 循环、起/复用子 Agent
- 审批问用户、最终结果报用户

主 Agent 上下文里只有：用户需求（一句话）+ workflow.json 声明 + 引擎输出消息（含精简摘要）+ `--output` 喂回的 JSON + `agent_id_map` + 和用户的对话。**没有任何仓库内容、代码、业务数据。**

#### 默认 executor 分配

| 阶段 | task | executor |
|------|------|----------|
| plan | requirement_clarification, tech_design, test_case_design | `subagent:planner` |
| code | code, code_review | `subagent:coder` |
| verify | run_test, verdict | `subagent:verifier` |

3 个子 Agent，各自独立上下文，跨 task 复用。回环时同一个子 Agent 带着上下文继续工作。

### CLI

```bash
node engine/loop.js --workflow <path> --status          # 查状态
node engine/loop.js --workflow <path> --step            # 执行一步
node engine/loop.js --workflow <path> --step --approve  # 审批通过
node engine/loop.js --workflow <path> --step --reject "理由"  # 审批拒绝
node engine/loop.js --workflow <path> --step --output '<json>'                    # 喂回产出（小内容）
node engine/loop.js --workflow <path> --step --output-file '<path>'               # 喂回产出（大内容，从文件读）
node engine/loop.js --workflow <path> --step --output-file '<path>' --agent-id '<id>'  # 从文件读 + 真实 id
```

`--output` 和 `--output-file` 二选一：
- `--output '<json>'`：产出内容小（几行 JSON）时直接传，简单但受命令行长度限制
- `--output-file '<path>'`：产出内容大时，子 Agent 把产出写到文件，主 Agent 只传文件路径给引擎。**推荐统一用 `--output-file`**——主 Agent 上下文里只有文件路径，没有产出内容，上下文更干净

`--agent-id` 可选。主 Agent 调 `subagent` 或 `send_message` 后，harness 返回真实子 Agent id，主 Agent 喂回产出时通过 `--agent-id` 传给引擎。引擎在 `DONE` 输出里带上这个 id，**用于日志验证复用**：连续两次 `DONE` 的 `agent_id` 相同 = 复用了同一个子 Agent。`--status` 输出里带 `duration_ms`（每步耗时），用于查看整个过程分阶段耗时。

### 引擎输出

| type | 关键字段 |
|---|---|
| `NEED_APPROVAL` | task, attempt |
| `NEED_SKILL` | task, ref, input, executor? |
| `DONE` | task, status, output, agent_id? |
| `LOOP_BACK` | from, to, iteration, max |
| `BACKTRACK` | from, to, reason, iteration, max |
| `BACKTRACK_IGNORED` | from, reason |
| `FINISHED` | — |
| `FAILED` | task, output |
| `TERMINATED` | reason |
| `STATUS` | current_task, task_progress[{duration_ms}], loop_counts, known_agents |
| `ERROR` | message |

---

## 子 Skill

每个子 skill 自包含 input/output schema + prompt。output schema 描述产出内容结构，Agent 返回内容，引擎负责包装。

| 子 skill | 阶段 | 审批 | 产出模式 | passed | 说明 |
|---|---|---|---|---|---|
| requirement_clarification | plan | 否 | artifact | 否 | 澄清需求 |
| tech_design | plan | 否 | artifact | 否 | 设计技术方案 |
| test_case_design | plan | 否 | artifact | 否 | 设计测试用例 |
| code | code | **是** | **side-effect** | 否 | 产出 files → 引擎写进真实仓库 |
| code_review | code | 否 | artifact | 否 | 从真实仓库读文件来 review |
| run_test | verify | 否 | artifact | 否 | 执行测试，如实报告 pass/fail |
| verdict | verify | 否 | artifact | **是** | 基于 failed_count 判定 passed，驱动回环 |

### run_test 和 verdict 的判定规则

**run_test**：如实报告，禁止替失败找理由。任何原因的失败（断言不符、构建错误、环境缺失、超时）都标 `passed: false`，失败原因记在 `error` 字段。

**verdict**：`failed_count == 0` → `passed: true`；`failed_count > 0` → `passed: false`。不自行豁免失败——如果失败是环境问题导致 code 改不了，loop 会耗尽 max_iterations 后终止，这是正确结果。

---

## 设计决策记录

| # | 决策 | 理由 |
|---|---|---|
| 1 | 引擎独占状态和转移条件 | 大模型不持有状态 → 无法偏离流程 |
| 2 | 单步执行 | 大模型在两次调用间不存在，状态靠 workflow.json 传递 |
| 3 | 转移条件写死在代码里 | 不靠 prompt 控制"接下来干什么" |
| 4 | `phase` = 大阶段，`name` = 具体任务 | 分离阶段和任务 |
| 5 | `status` 只有 success/fail | 无中间状态 |
| 6 | history 追加不覆盖 | 保留每次尝试供调试 |
| 7 | 串行执行 + depends_on | v1 不并行 |
| 8 | 零代码扩展 | 新增 task/phase/loop 只改 JSON |
| 9 | handler 类型 skill + script | 可扩展 |
| 10 | 子 skill 自包含 | 各自声明 input/output schema |
| 11 | `requires_approval` 在 task 级别 | code 执行前人工审批，回环重跑也重新审批 |
| 12 | 审批拒绝走 loops 配置 | 复用 checkLoops，trigger_type=approval_rejected |
| 13 | 两条 loop 共享一套检查逻辑 | loops 数组里两条配置，引擎按 trigger_type 分支 |
| 14 | 回溯清除下游 history | 强制重跑，否则 advance 跳过已有 success 的 task |
| 15 | 产出含 files → 引擎写真实仓库 | code task 直接写盘，不外置 artifact |
| 16 | side-effect 模式 output 只存 changed_files + summary | 文件已在仓库，不需 artifact 中转 |
| 17 | `passed` 留在 workflow.json | loop_controller 直接读，不用读文件 |
| 18 | run_test 如实报告，禁止替失败找理由 | 失败就是失败，环境问题也是失败 |
| 19 | verdict 基于 failed_count 判定，不豁免 | 环境问题导致回环耗尽 → 终止，是正确结果 |
| 20 | Agent 自己看仓库 | 引擎只管编排，信息收集由 Agent 用工具自主完成 |
| 21 | request_backtrack：大模型可请求回头 | 在引擎保持控制权前提下给大模型反馈通道，既有纪律又有灵活性 |
| 22 | checkLoops 优先于 checkRequestBacktrack | 声明式硬规则优先于大模型软请求 |
| 23 | request_backtrack 只允许往前序跳 | 防止大模型往前跳打乱流程 |
| 24 | per-task 计数（max_backtrack_per_task） | 每个 task 独立额度，互不干扰 |
| 25 | backtrack 超限不终止，正常推进 | 请求被拒绝不代表 task 失败 |
| 26 | 所有 backtrack 请求记录在 backtrack_log | 被忽略的也记录，供审计 |

---

## 许可

本 skill 是 verification-workflow-v1 原型的一部分。
