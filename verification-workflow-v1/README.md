# Verification Workflow v1

一个协议驱动的 **计划 → 编码 → 验证** 循环工作流，以 skill 形式打包。

---

## 基本原理：为什么流程能被保证

**引擎独占状态和转移条件，执行体不持有流程状态、不知道流程。**

这是整套设计的核心——保证流程执行的，不是执行体的"自觉"，而是引擎对状态和转移条件的独占控制。

### 三个原理

**原理 1：状态独占。** 引擎把所有流程状态锁在 `workflow.json` 里——当前在第几个 task、回环了几次、每个 task 的历史产出。执行体（大模型 / 子 Agent）每次被调用时只收到 input（前序 task 的产出路径），它不知道自己在第几轮、不知道接下来要跑什么。子 Agent 虽然有持久 Session（跨 task 复用时上下文保留），但**流程状态不在它手里**——它在哪个 task 被 call、拿到什么 input、产出存到哪，全由引擎决定。**执行体不持有流程状态 → 它无法自己决定"接下来干什么"。**

**原理 2：转移条件是代码。** "什么时候从 A 到 B"写死在引擎代码里（`findNextTask`、`checkLoops`、`advance`），不写在 prompt 里。执行体被调用时，它已经在引擎选定的 task 里了——它没有机会选择"我要跑哪个 task"。

**原理 3：单步执行。** 引擎每次 `--step` 只跑一个 task，跑完写盘退出。两次 `--step` 之间的流程状态完全由 `workflow.json` 持有。子 Agent 的持久 Session 是**业务上下文**的延续（同一个 planner 连续做 3 个 plan task 时记住前面想过的东西），不是**流程状态**的延续——它不知道引擎下一步会调谁。

### 结果

执行体唯一能做的事：**收到 input → 思考 → 产出 output**。除此之外的一切——选 task、传 input、存 output、判回环、计数、终止——全是引擎代码。

执行体可以产出烂代码、可以判错 verdict，但它**不能偏离流程**——因为流程不在它手里。

**剧本、导演、演员，三位一体。**

- **引擎是剧本**——它是静态的流程结构 + 状态记录，不主动、不调度、不和人对话。它只回答"下一步该拍哪场戏""这场戏过了没""要不要重拍第 N 场"。"什么时候从 A 到 B"写死在剧本里（`findNextTask`、`checkLoops`、`advance`），不靠谁的自觉。
- **主 Agent 是导演**——它读剧本（调 `--step`），理解当前该拍哪场戏，去叫演员（起 / 复用子 Agent），把材料（input）递给演员，收产出喂回剧本（`--output-file`），遇到审批门禁停下来问制片人（用户）。导演不懂业务（不碰仓库、不读代码），但掌管调度——没有导演喊人，演员不会自己上场。
- **子 Agent 是演员**——收到一场戏的剧本（SKILL.md）和道具（input），演完把结果交出去。同一个演员可以连演几场戏（复用），他记得前面演过什么，但不知道接下来导演会不会再喊他——流程不在他手里。

导演（主 Agent）自己不知道该拍什么——它不持有流程状态，全靠读剧本（调 `--step` 让引擎告诉自己下一步）。剧本（引擎）本身不主动推进——它只被导演查询和回写。两者分离，谁都不能独自把戏拍下去。

---

## 目录

- [基本原理](#基本原理为什么流程能被保证)
- [优缺点对比：vs 全权交给大模型](#优缺点对比vs-全权交给大模型)
- [设计目标](#设计目标)
- [目录结构](#目录结构)
- [硬规则](#硬规则rulesjson)
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

**本设计**：引擎独占流程状态，执行体（大模型 / 子 Agent）只管"收 input → 思考 → 产 output"。同阶段的多个 task 可复用同一个子 Agent 保持业务上下文，但流程状态始终在引擎手里。

**全权交给大模型**：大模型自己持有状态、自己决定流程、自己控制每一步。

交换的本质：用**灵活性**换**可控性**。

### 本设计的优点

- **流程不偏离**：引擎强制 task 顺序、回环、审批，执行体无法跳步或忘循环。
- **同阶段上下文连续**：同阶段的 task 复用同一个子 Agent，planner 做 3 个 plan task 时记住前面的思考，不重复读。
- **可审计**：workflow.json 每步有记录，产出有 artifact 文件。
- **可恢复**：崩溃了从 workflow.json 续跑——`findNextTask` 通过 `isTaskDone` 跳过 success 且非 expired 的 task，只重跑 expired 或未跑的。
- **可复现**：流程结构固定，同样的声明跑同样的流程。

### 本设计的缺点

- **流程是死的**：预定义的 loops 覆盖不了运行时发现的新问题（如 code 发现需求矛盾想回头改需求，但没声明这条回环）。已通过 `request_backtrack` 机制部分缓解——执行体可主动请求回头，引擎决定是否执行。
- **跨阶段上下文断裂**：同阶段内的 task（如 plan 阶段 3 个 task）通过子 Agent 复用实现了上下文连续，但跨阶段切换时（planner → coder → verifier）上下文不传递，每个阶段的子 Agent 不知道其他阶段想过什么。
- **简单任务过度工程**：改个 label 跑八个 task，开销远大于任务本身。
- **声明本身可能错**：workflow.json 的 depends_on、handler.ref、loops 写错了流程就乱。

### 适合场景

- **本设计适合**：流程已知、需要纪律保证、需要审计复现的研发流程。
- **全权交给大模型适合**：探索性任务、简单任务、高度动态的场景。

### 理想方向

不是二选一，而是**在引擎保持控制权的前提下，给执行体一条反馈通道**——`request_backtrack` 已实现：task 产出里带 `request_backtrack`，执行体可以"请求"回头，引擎决定要不要执行（校验目标合法性、per-task 计数上限）。既有纪律，又有灵活性。

---

## 设计目标

1. **协议驱动**：工作流由 JSON 声明描述，引擎读声明驱动执行，不硬编码 task 逻辑。
2. **循环感知**：验证失败自动回退到编码阶段，上限可配置。
3. **人工审批门禁**：指定 task 执行前必须人工审批，回环重跑时也要重新审批。
4. **零代码扩展**：新增 task/phase/loop 只改 JSON，引擎不变。
5. **历史保留**：每次执行（含回环重跑）都记录在案，永不覆盖。
6. **增量持久化**：每次 Attempt 后即写盘，支持崩溃恢复——`isTaskDone` 统一判断 task 是否需（重）跑，重启后自动跳过已完成且未过期的 task。

---

## 目录结构

```
verification-workflow-v1/
├── SKILL.md                    # 顶层 skill 入口（disable-model-invocation: true）
├── rules.json                  # 硬规则配置（主 Agent 启动时加载，子 Agent prompt 中带入）
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
        └── artifacts/              # 产出文件（子 Agent 直接写入，引擎只记路径）
            ├── requirement_clarification.json
            ├── tech_design.json
            ├── test_case_design.json
            ├── code_review.json
            ├── run_test.json
            └── verdict.json
```

- **run 目录名**：`run_<YYYYMMDDHHmmss>`，不绑 run_name，时间戳保证唯一。
- **project_root**：workflow.json 里的 `project_root` 字段（默认 `../..`），表示项目根相对 run 目录的路径。side-effect 模式（code task）写文件时基于此路径，写到真实仓库而非 run 目录。
- Agent 生成 workflow.json 时直接写到 `run_<时间戳>/.workflow.json`，引擎不搬家、不同步，全程只读写这一份。

### 两层 skill

| 层次 | 是什么 | harness 识别？ |
|---|---|---|
| 顶层 skill | 用户 `/verification-workflow` 触发。提供协议、引擎、模板、子 skill。 | 是 |
| 子 skill | 被 task handler 引用的 prompt 包。自包含 input/output schema。 | 否——子 Agent 自己 `read` 加载，主 Agent 不读 |

---

## 硬规则（rules.json）

`rules.json` 是主 Agent 和子 Agent 的硬约束清单。主 Agent 启动时加载，全程遵守。对于子 Agent，主 Agent 把 `target: "sub_agent"` 的规则拼进子 Agent 的 prompt 里。

这些规则是**声明式的**——引擎不解析它们，但主 Agent 必须遵守。违反规则等于 Agent 行为有 bug。

| ID | 约束对象 | 规则 | 强制来源 |
|---|---|---|---|
| R001 | 主 Agent | NEED_APPROVAL 必须人工决定，禁止自行批准（不管风险多低） | 引擎（不传 --approve 不推进）+ 文档 |
| R002 | 主 Agent | 不碰仓库（不 read/write/bash/grep） | 文档（SKILL.md） |
| R003 | 主 Agent | 不读子 skill 的 SKILL.md（把 ref 路径传给子 Agent） | 文档（SKILL.md） |
| R004 | 主 Agent | 不读/不处理子 Agent 产出内容，只传路径 | 文档 + 引擎（processOutput 只记路径） |
| R005 | 主 Agent | 不判断子 Agent 产出质量 | 文档（SKILL.md） |
| R008 | 主 Agent | 禁止自行终止 loop——verdict 返回 passed:false 时必须继续 --step，让引擎的 loop 机制决定回环还是耗尽 max_iterations。不能读失败原因后判断"环境问题，返工没用"就自己停 | 引擎（checkLoops + max_iterations）+ 文档 |
| R006 | 子 Agent | 测试结果如实报告，禁止替失败找理由 | 文档（run_test/verdict SKILL.md） |
| R007 | 子 Agent | 直接写 artifacts/ 或真实仓库，不写中间文件 | 文档 + 引擎（只记路径不重写） |

完整定义见 `rules.json`。新增规则只需往 `rules.rules` 数组加一条，无需改引擎。

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
    "file": "artifacts/tech_design_v1.json"
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

两种模式都可带 `passed`（可选布尔，仅 verdict task 有，驱动回环）和 `request_backtrack`（可选对象，执行体主动请求回头，见[request_backtrack](#request_backtrack)）。

审批相关字段（仅 `requires_approval` 的 task）：`approval_status`（null/approved/rejected）、`approved_by`、`approved_at`、`reject_reason`。

回溯标记字段（所有 task）：`expired`（boolean，回溯后下游 task 的最后 Attempt 被标记，`isTaskDone` 判定需重跑）、`expired_reason`（如 `backtrack_from:code→tech_design`）。

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
  "backtrack_counts": {},
  "backtrack_log": [],
  "known_agents": ["planner", "coder"],
  "terminated": false,
  "terminate_reason": null
}
```

---

## 执行模型

### 单步模式

引擎每次 `--step` 只跑一个 task，跑完写盘退出。Agent 通过反复调 `--step` 驱动循环。

这确保：引擎不直接调执行体、状态每步持久化、审批可自然暂停。

### 单步流程

```
Agent: node engine/loop.js --step [--approve | --reject "理由" | --output-file '<path>' --agent-id '<id>']
  │
  引擎读 workflow.json → 找到 current_task → 首次执行时创建 artifacts_dir
  │
  ├─ requires_approval 且未审批 → 输出 NEED_APPROVAL，退出
  │    Agent 必须停下问用户（禁止自行判断风险等级自动批准）
  │    用户同意: --approve / 用户拒绝: --reject "理由"
  │
  ├─ skill 执行体 → 输出 NEED_SKILL（带 ref 路径 + executor 信息），退出
  │    Agent 看 executor 字段：
  │      无 executor（= self）→ Agent 自己读 SKILL.md → 思考 → 产出
  │      有 executor → Agent 调 subagent/send_message，把 ref 路径传给子 Agent
  │        → 子 Agent 自己读 SKILL.md → 思考 → 直接写 artifacts/<task>.json
  │        → Agent 拿到文件路径 → 调 --output-file '<path>' --agent-id '<id>'
  │    引擎记录路径 → checkLoops → checkRequestBacktrack → 推进
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

两条 loop 共享 `checkLoops` 逻辑，各自独立计数。回溯时给 target_task 之后所有 task 的最后一个 Attempt 标 `expired: true`（不清除 history，记录完整保留，`findNextTask`/`advance` 自动跳过 expired 的 Attempt，重跑下游 task）。

### 审批门禁

`requires_approval: true` 的 task（默认只有 code）执行前暂停，输出 `NEED_APPROVAL`。用户同意才执行，拒绝则触发回环。回环重跑时重新审批。

**硬规则：主 Agent 必须停下问用户，禁止自行批准。** 不管变更看起来多简单、多低风险（改个 label、加个注释），都必须等用户明确说"同意"后才能传 `--approve`。主 Agent 不判断风险等级——风险判断是人的职责，不是 Agent 的。"低风险所以自动批准"是**违规行为**。

### request_backtrack

执行体在执行中发现前序 task 的产出有问题（如需求矛盾、方案不可行），可以在产出里带 `request_backtrack` 字段，**请求**引擎回头重跑前序 task。

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
- **jump_to 逻辑跟 loops 一致**：给目标之后所有 task 的最后一个 Attempt 标 `expired: true`，引擎自动重跑（history 不清除）。

两套回溯机制独立计数，互不干扰：

| 机制 | 计数器 | 键 | 上限 |
|---|---|---|---|
| 声明式 loops | `loop_counts` | `"trigger→target"` | 每条 loop 的 `max_iterations` |
| request_backtrack | `backtrack_counts` | `"发起 task name"` | `max_backtrack_per_task` |

引擎输出新增 `BACKTRACK`（触发）和 `BACKTRACK_IGNORED`（忽略/超限）。所有请求（含被忽略的）记录在 `context.backtrack_log` 供审计。

---

## 产出处理

引擎按产出内容自动判断模式，不需要声明字段：

**产出含 `changed_files` 数组 → 直接写仓库模式：**
- 子 Agent 自己用工具把代码文件写进真实仓库（write/edit/bash）
- 产出 JSON 里只有 `changed_files`（路径列表）+ `summary`，**不含文件内容**
- 引擎只记录路径列表到 Attempt，不碰文件内容
- 下一个 task 通过 `changed_files` 知道改了哪些文件，用 `read` 工具从真实仓库读
- 典型 task：code

**产出无 `changed_files` → artifact 模式：**
- 子 Agent 直接把产出写到 `artifacts/<task_name>.json`
- 主 Agent 把该路径传给 `--output-file`
- 引擎只记录路径到 Attempt（`output.file`），**不读内容、不解析、不重写**
- 下一个 task 的 input 收到 `{ file: "artifacts/xxx.json" }`（路径），子 Agent 自己 `read` 内容
- 典型 task：requirement_clarification, tech_design, test_case_design, code_review, run_test, verdict

**产物文件规范：每个 task 只有一个 artifact 文件**——由子 Agent 直接写入 `artifacts/<task_name>.json`，引擎不复制、不重写。主 Agent 不手动包装 `{data:...}`、不写中间文件。

```
artifacts/
├── requirement_clarification.json    ← 子 Agent 写的，引擎直接用这个路径
├── tech_design.json
├── test_case_design.json
├── code_review.json
├── run_test.json
└── verdict.json
```

回环重跑时，引擎自动归档上一次的产物：把 `artifacts/<task>.json` **复制**到 `artifacts/<task>_v<N>.json`（N 为版本号，对应 attempt 号），旧 Attempt 的 `output.file` 指向归档副本。子 Agent 无感（始终写同名文件 `artifacts/<task>.json`）。canonical 路径上保留最新产出，下游 task 能正常读取。

> ⚠️ **归档用 copy 不用 rename**。因为子 Agent 在引擎 `--step` 之前就把新产出写到 `artifacts/<task>.json`（覆盖了旧内容），引擎执行归档时该文件已经是新内容。如果用 rename 会把新内容移走，canonical 路径上文件丢失，下游 task 读不到产出。用 copy 则 canonical 路径保留新内容，归档副本也留一份。旧内容（上一轮的产出）被子 Agent 覆盖了，无法恢复——这是"子 Agent 先写、引擎后归档"架构的固有限制。

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
   - NEED_APPROVAL → **必须停下问用户，禁止自行批准**（不管风险多低）→ 用户同意: --approve / 用户拒绝: --reject "理由"
   - NEED_SKILL    → 看 executor 字段：
     - 无 executor（= self）→ 读 SKILL.md → 思考 → --output '<json>'
     - 有 executor            → 查 agent_id_map，决定新建还是复用（主 Agent 不读 SKILL.md）：
       declared_name = executor.agent_id          # 来自 workflow.json 的声明名
       artifact_path = run_dir + "/artifacts/" + task.name + ".json"
       task_prompt = "读 " + handler.ref + "/SKILL.md 并按其指引执行。输入：" + JSON.stringify(NEED_SKILL.input)
                    + " 你必须把产出直接写到: " + artifact_path
       if declared_name not in agent_id_map:       # 映射表里没有 → 新建（必须用 run_in_background=true）
         real_id = subagent(
           prompt = task_prompt,                    # 传路径给子 Agent，不自己读
           description = declared_name,
           run_in_background = true                  # 关键：后台运行，子 Agent 完成后保持 idle，可被 send_message 复用
         )                                           # subagent 立即返回 real_id，不阻塞
         agent_id_map[declared_name] = real_id       # 存真实 id
       else:                                        # 映射表里有 → 复用
         real_id = agent_id_map[declared_name]
         send_message(                               # send_message 只确认投递，不返回结果
           agent_id = real_id,
           message  = task_prompt                     # 同样传路径，不自己读
         )
       # 子 Agent 在后台工作，把产出直接写到 artifacts/<task_name>.json
       # 主 Agent 不 busy-poll、不 sleep——可做其他独立工作
       # 当 runtime 发来完成通知后，主 Agent 把 artifact_path 喂回引擎
       --output-file '<artifact_path>' --agent-id '<real_id>'
   - DONE          → 继续 --step
   - LOOP_BACK     → 继续 --step（声明式回环，引擎已移指针）
   - BACKTRACK     → 继续 --step（执行体请求回头，引擎已移指针）
   - BACKTRACK_IGNORED → 继续 --step（请求被忽略，正常推进）
   - FINISHED      → 向用户汇报
   - FAILED/TERMINATED → 向用户汇报原因
```

> **注意**：引擎输出的 `executor.reuse` 是参考值（基于 `context.known_agents` 判断），但主 Agent 以自己的 `agent_id_map` 为真相——映射表里有就复用，没有就新建。这样即使引擎状态被重置，主 Agent 仍能正确复用已活的子 Agent。

> **注意**：`subagent` 必须用 `run_in_background: true` 创建。前台子 Agent（`run_in_background: false`）执行完即终止，`send_message` 复用时会报 "subagent unavailable"。后台子 Agent 完成后进入 idle 状态，session 持久化，`send_message` 发新任务时上下文连续。`send_message` 只确认投递，不返回结果——结果通过 runtime 的异步完成通知到达。

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

子 Agent 用 `run_in_background: true` 创建后，跑完一轮**不会消失**——它进入 idle 状态，Session 持久化，带着之前的上下文等着。`send_message` 给它发新任务时，新消息追加到同一个 Session，上下文连续。回环重跑同一个 task 时，同一个子 Agent 继续——它记得上一轮做了什么。

> ⚠️ **必须用 `run_in_background: true`**。前台子 Agent（`run_in_background: false`）执行完即终止，无法被 `send_message` 复用——调用时会报 `Error: subagent "<name>" is unavailable`。这是子 Agent 复用失败的最常见原因。
>
> `send_message` 只确认消息投递，**不返回子 Agent 的产出**。子 Agent 在后台工作，完成后 runtime 会给主 Agent 发异步完成通知。主 Agent 收到通知后，读 artifact 文件路径，喂回引擎。在等待期间主 Agent 可以做其他独立工作，不要 busy-poll 或 sleep。

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

`--agent-id` 可选。主 Agent 调 `subagent`（`run_in_background: true`）拿到真实子 Agent id 后存入 `agent_id_map`，喂回产出时通过 `--agent-id` 传给引擎。引擎在 `DONE` 输出里带上这个 id，**用于日志验证复用**：连续两次 `DONE` 的 `agent_id` 相同 = 复用了同一个子 Agent。`--status` 输出里带 `duration_ms`（每步耗时），用于查看整个过程分阶段耗时。

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

每个子 skill 自包含 input/output schema + prompt。子 Agent 读取 SKILL.md 后按其指引执行，直接把产出写到 `artifacts/<task_name>.json`，引擎只记录路径——不读内容、不解析、不重写。

| 子 skill | 阶段 | 审批 | 产出模式 | passed | 说明 |
|---|---|---|---|---|---|
| requirement_clarification | plan | 否 | artifact | 否 | 澄清需求 |
| tech_design | plan | 否 | artifact | 否 | 设计技术方案 |
| test_case_design | plan | 否 | artifact | 否 | 设计测试用例 |
| code | code | **是** | **直接写仓库** | 否 | 子 Agent 用工具写文件到真实仓库，产出只声明 changed_files |
| code_review | code | 否 | artifact | 否 | 从真实仓库读文件来 review |
| run_test | verify | 否 | artifact | 否 | 执行测试，如实报告 pass/fail |
| verdict | verify | 否 | artifact | **是** | 基于 failed_count 判定 passed，驱动回环 |

### 各阶段输入输出详解

引擎的 `gatherInput` 根据 task 的 `depends_on` 列表，从前驱 task 的最近成功 Attempt 中收集 input。收集规则：
- 前驱是 artifact 模式 → 传 `{ file: "artifacts/xxx.json" }`（**路径，不读内容**），子 Agent 自己 `read` 文件
- 前驱是 side-effect 模式 → 传 `{ changed_files, summary }`（文件已在真实仓库，子 Agent 自己用工具读）
- 前驱无产出（`null`）→ 该依赖 key 值为 `null`

下面按流程顺序列出每个 task 的实际输入输出。

---

#### 1. requirement_clarification（plan 阶段，planner 子 Agent）

**输入**（引擎 `gatherInput` 产出）：
```json
{}
```
无 `depends_on`，input 为空对象。但主 Agent 在创建 workflow.json 时会把用户原始需求写入 context 或在 task prompt 里传递。子 Agent 通过 NEED_SKILL 的 input 字段拿到。

实际主 Agent 传给子 Agent 的 prompt 里包含：
```json
{
  "raw_requirement": "用户输入的原始需求文本"
}
```
这个 `raw_requirement` 不来自 `depends_on` 前驱，而是来自用户输入——主 Agent 在构建 workflow 时通过其他方式（如 context 自定义字段或 prompt 拼接）传递。

**输出**（子 Agent 写到 `artifacts/requirement_clarification.json`）：
```json
{
  "clarified_requirement": "澄清后的需求描述（string，必填）",
  "assumptions": ["假设1", "假设2"],
  "open_questions": ["需要用户确认的问题"]
}
```
引擎存到 Attempt：`output.file = "artifacts/requirement_clarification.json"`

---

#### 2. tech_design（plan 阶段，planner 子 Agent 复用）

**输入**（引擎 `gatherInput` 产出，`depends_on: ["requirement_clarification"]`）：
```json
{
  "requirement_clarification": {
    "file": "artifacts/requirement_clarification.json"
  }
}
```
子 Agent 拿到路径后自己 `read` 文件，拿到 `{ clarified_requirement, assumptions, open_questions }`。

**输出**（子 Agent 写到 `artifacts/tech_design.json`）：
```json
{
  "tech_design": "技术设计文档：架构、组件、数据流、关键决策（string，必填）",
  "key_components": ["模块1", "模块2"],
  "tech_risks": ["风险1", "风险2"]
}
```
引擎存到 Attempt：`output.file = "artifacts/tech_design.json"`

---

#### 3. test_case_design（plan 阶段，planner 子 Agent 复用）

**输入**（引擎 `gatherInput` 产出，`depends_on: ["tech_design"]`）：
```json
{
  "tech_design": {
    "file": "artifacts/tech_design.json"
  }
}
```
子 Agent 拿到路径后自己 `read`，拿到 `{ tech_design, key_components, tech_risks }`。

**输出**（子 Agent 写到 `artifacts/test_case_design.json`）：
```json
{
  "test_cases": [
    {
      "name": "测试用例名称（string，必填）",
      "description": "用例描述（string，必填）",
      "input": "测试输入（任意结构）",
      "expected": "预期结果（任意结构，必填）"
    }
  ],
  "coverage_notes": "覆盖说明：测了什么、没测什么"
}
```
引擎存到 Attempt：`output.file = "artifacts/test_case_design.json"`

---

#### 4. code（code 阶段，coder 子 Agent，**需审批**）

**输入**（引擎 `gatherInput` 产出，`depends_on: ["tech_design", "test_case_design"]`）：
```json
{
  "tech_design": {
    "file": "artifacts/tech_design.json"
  },
  "test_case_design": {
    "file": "artifacts/test_case_design.json"
  }
}
```
子 Agent 拿到两个路径，自己 `read` 文件内容。

**输出**（**直接写仓库模式**，子 Agent 自己用工具写文件到真实仓库，产出 JSON 里只有路径列表）：
```json
{
  "changed_files": ["src/main.py", "src/utils.py"],
  "summary": "实现了 XX 模块，处理了 YY 逻辑"
}
```
子 Agent 用自己的工具（write/edit/bash）把代码文件直接写到真实仓库。产出 JSON 里**不含文件内容**——只有路径列表和摘要。引擎只记录路径到 Attempt，不碰文件内容。不创建 artifact 文件（除非子 Agent 同时写了 `artifacts/code.json`）。

**审批**：`requires_approval: true`。引擎先输出 `NEED_APPROVAL`，主 Agent 问用户，用户批准后引擎才调 code skill。用户拒绝 → 触发回环到 tech_design。

---

#### 5. code_review（code 阶段，coder 子 Agent 复用）

**输入**（引擎 `gatherInput` 产出，`depends_on: ["code"]`）：
```json
{
  "code": {
    "changed_files": ["src/main.py", "src/utils.py"],
    "summary": "实现了 XX 模块，处理了 YY 逻辑"
  }
}
```
注意：这里传的是 `changed_files`（路径列表）和 `summary`，**不是文件内容**。子 Agent 拿到路径后自己用工具从真实仓库 `read` 文件内容来 review。

**输出**（子 Agent 写到 `artifacts/code_review.json`）：
```json
{
  "review_summary": "整体 review 结论（string）",
  "issues": [
    {
      "severity": "blocker | major | minor | nit",
      "file": "src/main.py",
      "description": "问题描述"
    }
  ]
}
```
引擎存到 Attempt：`output.file = "artifacts/code_review.json"`

---

#### 6. run_test（verify 阶段，verifier 子 Agent）

**输入**（引擎 `gatherInput` 产出，`depends_on: ["test_case_design"]`）：
```json
{
  "test_case_design": {
    "file": "artifacts/test_case_design.json"
  }
}
```
子 Agent 只拿测试用例，**不看实现代码**——这是黑盒测试。verifier 像 QA 一样：读测试用例 → 跑测试 → 报结果，不关心改了哪些文件。

**输出**（子 Agent 写到 `artifacts/run_test.json`）：
```json
{
  "results": [
    {
      "name": "测试用例名称（string，必填）",
      "passed": true,
      "actual": "实际结果（任意结构）",
      "error": "失败时的错误信息"
    }
  ],
  "summary": {
    "total": 5,
    "passed_count": 4,
    "failed_count": 1
  }
}
```
引擎存到 Attempt：`output.file = "artifacts/run_test.json"`

---

#### 7. verdict（verify 阶段，verifier 子 Agent 复用）

**输入**（引擎 `gatherInput` 产出，`depends_on: ["run_test"]`）：
```json
{
  "run_test": {
    "file": "artifacts/run_test.json"
  }
}
```
子 Agent 拿到路径后自己 `read`，拿到 `{ results, summary }`。

**输出**（子 Agent 写到 `artifacts/verdict.json`）：
```json
{
  "verdict": "PASS 或 FAIL 的文字结论（string，必填）",
  "failed_tests": ["失败的测试用例名称"],
  "reason": "判定理由（string，必填）",
  "passed": false
}
```
引擎存到 Attempt：`output.file = "artifacts/verdict.json"`，且 `output.passed = false`（**passed 留在 workflow.json，不进文件**，loop_controller 直接读）。

**回环驱动**：`output.passed == false` → 触发回环，`current_task` 跳回 `code`，最多 3 次。

---

### input 传递总结

| Task | depends_on | input 内容 | 传递方式 |
|---|---|---|---|
| requirement_clarification | [] | `{ raw_requirement }` 来自用户 | 主 Agent 拼 prompt |
| tech_design | [requirement_clarification] | `{ requirement_clarification: { file } }` | 路径 |
| test_case_design | [tech_design] | `{ tech_design: { file } }` | 路径 |
| code | [tech_design, test_case_design] | `{ tech_design: { file }, test_case_design: { file } }` | 路径 |
| code_review | [code] | `{ code: { changed_files, summary } }` | 内联值 |
| run_test | [test_case_design] | `{ test_case_design: { file } }` | 路径 |
| verdict | [run_test] | `{ run_test: { file } }` | 路径 |

> 所有 task 的 `depends_on` 与各 SKILL.md 声明的 required input 已对齐。如需子 Agent 获取更多前驱数据，修改 workflow.json 的 `depends_on` 加上前驱 task 名即可，引擎会自动收集。

### run_test 和 verdict 的判定规则

**run_test**：如实报告，禁止替失败找理由。任何原因的失败（断言不符、构建错误、环境缺失、超时）都标 `passed: false`，失败原因记在 `error` 字段。

**verdict**：`failed_count == 0` → `passed: true`；`failed_count > 0` → `passed: false`。不自行豁免失败——如果失败是环境问题导致 code 改不了，loop 会耗尽 max_iterations 后终止，这是正确结果。

---

## 设计决策记录

| # | 决策 | 理由 |
|---|---|---|
| 1 | 引擎独占状态和转移条件 | 执行体不持有流程状态 → 无法偏离流程 |
| 2 | 单步执行 | 两次 `--step` 之间流程状态靠 workflow.json 传递，子 Agent 的持久 Session 只延续业务上下文 |
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
| 14 | 回溯标 expired 而非清 history | 保留审计轨迹，`isTaskDone` 判定 expired 的 Attempt 需重跑 |
| 15 | 产出含 files → 引擎写真实仓库 | code task 直接写盘，不外置 artifact |
| 16 | side-effect 模式 output 只存 changed_files + summary | 文件已在仓库，不需 artifact 中转 |
| 17 | `passed` 留在 workflow.json | loop_controller 直接读，不用读文件 |
| 18 | run_test 如实报告，禁止替失败找理由 | 失败就是失败，环境问题也是失败 |
| 19 | verdict 基于 failed_count 判定，不豁免 | 环境问题导致回环耗尽 → 终止，是正确结果 |
| 20 | Agent 自己看仓库 | 引擎只管编排，信息收集由 Agent 用工具自主完成 |
| 21 | request_backtrack：执行体可请求回头 | 在引擎保持控制权前提下给执行体反馈通道，既有纪律又有灵活性 |
| 22 | checkLoops 优先于 checkRequestBacktrack | 声明式硬规则优先于执行体软请求 |
| 23 | request_backtrack 只允许往前序跳 | 防止执行体往前跳打乱流程 |
| 24 | per-task 计数（max_backtrack_per_task） | 每个 task 独立额度，互不干扰 |
| 25 | backtrack 超限不终止，正常推进 | 请求被拒绝不代表 task 失败 |
| 26 | 所有 backtrack 请求记录在 backtrack_log | 被忽略的也记录，供审计 |

---

## 许可

本 skill 是 verification-workflow-v1 原型的一部分。
