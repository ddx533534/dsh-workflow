# Verification Workflow v1

一个协议驱动的 **计划 → 编码 → 验证** 循环工作流，以 skill 形式打包。支持可配置的阶段与任务、人工审批门禁、验证失败自动回环、产出外置到独立文件、零代码扩展。

---

## 目录

- [设计目标](#设计目标)
- [架构总览](#架构总览)
- [目录结构](#目录结构)
- [协议规范](#协议规范)
- [执行模型](#执行模型)
- [审批门禁](#审批门禁)
- [回环机制](#回环机制)
- [产出外置](#产出外置)
- [可扩展性](#可扩展性)
- [引擎参考](#引擎参考)
- [子 Skill](#子-skill)
- [使用指南](#使用指南)
- [设计决策记录](#设计决策记录)

---

## 设计目标

1. **协议驱动**：整个工作流由一份 JSON 声明完整描述。引擎读声明、驱动执行——绝不硬编码任务逻辑。
2. **循环感知**：验证失败时自动回退到编码阶段，上限可配置。
3. **人工审批门禁**：指定 task（如 code）执行前必须人工审批，回环重跑时也要重新审批。
4. **零代码扩展**：新增任务或阶段只需改 JSON 声明，引擎逻辑不变。
5. **历史保留**：每次执行（含回环重跑）都记录在案，永不覆盖。
6. **产出外置**：每个 task 的产出写到独立文件，workflow.json 只存路径，避免大 JSON 糅杂。
7. **skill/script 混合执行体**：每个任务的执行体可以是子 skill（由 Agent 通过大模型执行）或外部脚本（由 bash 执行）。
8. **增量持久化**：每次 Attempt 后即写盘，支持崩溃恢复。

---

## 架构总览

设计是一个单 skill，内含三层概念结构：

```
Workflow（一次完整运行）
  └─ Phase（大阶段：plan | code | verify，可扩展）
       └─ Task（具体任务，串行执行，可挂审批门禁）
            └─ Attempt（单次执行记录，回环重跑时追加，产出外置到文件）
```

引擎与 Agent 以**单步循环**模式协作：

```
用户 (/verification-workflow <需求>)
  │
  ▼
Agent 加载 skill → 基于模板 + 用户需求生成 workflow.json（填 run_name）
  │
  ▼  （单步循环）
Agent 调用:  node engine/loop.js --workflow workflow.json --step
  │
  ├─ 审批门禁 task（requires_approval=true 且未审批）
  │    引擎输出 NEED_APPROVAL，退出
  │    Agent 问用户 → 同意则调 --step --approve；拒绝则调 --step --reject "<理由>"
  │
  ├─ script 执行体 → 引擎直接执行，产出写文件，写 Attempt，推进
  ├─ skill 执行体  → 引擎输出 NEED_SKILL，退出
  │      Agent 读 skills/<ref>/SKILL.md，按 prompt 思考，产出 output
  │      Agent 调: --step --output '<json>'
  │      引擎把产出写文件，写 Attempt，检查回环，推进
  │
  └─ 全部完成 → 引擎输出 FINISHED
```

**核心原则**：引擎决定*跑什么*、*要不要回环*、*要不要审批*。Agent 决定*怎么执行 skill*（通过大模型）。引擎绝不直接调大模型。

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
│   └── workflow_template.json            # 预填的声明模板，含 7 个默认任务 + 2 条回环
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

运行时，引擎会在 workflow.json 所在目录下创建产出目录：

```
<项目根>/
├── workflow.json                         # 工作流声明 + 运行时状态
└── .verification-workflow/
    └── <run_name>_<时间戳>/               # artifacts_dir
        └── artifacts/
            ├── requirement_clarification_attempt1.json
            ├── tech_design_attempt1.json
            ├── code_attempt1.json
            └── ...
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
  "run_name": "add_login_feature",
  "artifacts_dir": null,
  "phases":  [ Phase ],
  "tasks":   [ Task ],
  "loops":   [ Loop ],
  "context": Context
}
```

| 字段 | 说明 |
|---|---|
| `run_name` | **必填**。英文短名（`^[a-z][a-z0-9_]*$`），Agent 生成 workflow.json 时填。用于拼 artifacts_dir。 |
| `artifacts_dir` | 运行时。引擎首次执行时创建并填入。格式 `.verification-workflow/<run_name>_<时间戳>/artifacts`。 |
| `phases` / `tasks` / `loops` | 同前，分开数组。 |
| `context` | 运行时上下文。 |

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
  "requires_approval": true,
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
| `input` / `output` | 声明态，可选 | JSON Schema 契约。output 描述的是**产出文件内容**的结构（不再是 output 外壳）。 |
| `requires_approval` | 声明态，可选 | 默认 `false`。`true` = 执行前必须人工审批。回环重跑时重新审批。 |
| `started_at` / `finished_at` | 运行态 | 首次执行开始 + 末次执行结束。`finished_at - started_at` = 总耗时。 |
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

Attempt 的 `output` 有**两种模式**，由引擎根据产出结构自动判断：

**模式 1：artifact 模式（默认）**——产出外置到文件：

```json
{
  "attempt": 1,
  "status": "success",
  "output": {
    "file": ".verification-workflow/add_login_20250903T150000/artifacts/tech_design_attempt1.json",
    "passed": false
  }
}
```

**模式 2：side-effect 模式**——产出含 `files` 字段时，引擎自动写进真实仓库，output 只存路径列表：

```json
{
  "attempt": 1,
  "status": "success",
  "output": {
    "changed_files": ["src/auth/login.js", "src/auth/token.js"],
    "summary": "实现了登录和 token 验证"
  }
}
```

| 字段 | 模式 | 说明 |
|---|---|---|
| `output.file` | artifact | 产出文件路径。完整产出数据在此文件中。 |
| `output.changed_files` | side-effect | 被 code task 写进真实仓库的文件路径列表。 |
| `output.summary` | side-effect | code task 的实现摘要。 |
| `output.passed` | 两者皆有 | 可选布尔。仅 verdict 类 task 才有。留在 workflow.json 供 loop_controller 直接读。 |
| `attempt` | — | 序号，从 1 开始。回环重跑时递增。 |
| `status` | — | `"success"` 或 `"fail"`。审批拒绝也记为 `"fail"`。 |
| `approval_status` | — | 仅 `requires_approval` 的 task 才填。 |
| `approved_by` / `approved_at` | — | 审批人 / 审批时间。审计用。 |
| `reject_reason` | — | 拒绝理由。 |

**引擎如何判断走哪种模式**：

- 产出 `data` 里有 `files` 数组 → **side-effect 模式**：引擎把每个 file 的 content 写进真实仓库，output 只存 `changed_files` + `summary`。不创建 artifact 文件。
- 产出 `data` 里没有 `files` → **artifact 模式**：引擎把 data 外置到 artifact 文件，output 存 `file` 路径。

**为什么 code task 用 side-effect 模式**：

code task 的产出是"代码文件"——应该直接写进真实仓库，而不是存到 artifact 文件里再由人手动拷。写进真实仓库后：
- 下一个 task（code_review）通过 `changed_files` 知道改了哪些文件，用 `read` 工具从真实仓库读这些文件来 review。
- 不需要 artifact 文件做中转——文件已经在仓库里了。

**gatherInput 如何处理两种模式**：

- 前序 task 是 artifact 模式 → 读 artifact 文件内容作为 input。
- 前序 task 是 side-effect 模式 → 直接传 `changed_files` + `summary` 作为 input（不读文件内容，因为内容在真实仓库里，由后继 task 自己用工具读）。

### Loop（回环配置）

```json
{
  "trigger_type": "approval_rejected",
  "trigger_task": "code",
  "target_task": "tech_design",
  "max_iterations": 2
}
```

| 字段 | 说明 |
|---|---|
| `trigger_type` | `"output_field"`（默认）或 `"approval_rejected"`。区分两种触发方式。 |
| `trigger_task` | 检查哪个 task。 |
| `trigger_field` | 仅 `trigger_type=="output_field"` 时用。点号路径，如 `"output.passed"`。 |
| `trigger_when` | 仅 `trigger_type=="output_field"` 时用。字段值等于此值时触发。 |
| `target_task` | 回退到哪个 task。 |
| `max_iterations` | 上限。全局累计计数，不按回环轮次重置。超过则终止。 |

**两种触发类型的判定逻辑**：

| `trigger_type` | 判定方式 |
|---|---|
| `"output_field"` | 读 trigger_task 最后一次 Attempt 的 `output.passed`（或 trigger_field 指定字段），与 `trigger_when` 比较。 |
| `"approval_rejected"` | 检查 trigger_task 最后一次 Attempt 的 `approval_status == "rejected"`。 |

两种类型共用同一个 `checkLoops` 遍历逻辑，只是内部按 `trigger_type` 分支。

### Context（运行时上下文）

```json
{
  "current_phase": "code",
  "current_task": "code",
  "loop_counts": { "verdict→code": 1, "code→tech_design": 0 },
  "terminated": false,
  "terminate_reason": null
}
```

- `loop_counts`：键名格式 `"<trigger_task>→<target_task>"`。**每条 loop 独立计数**，互不干扰。
- `terminated` / `terminate_reason`：工作流结束时设置。

---

## 执行模型

### 单步模式

引擎**不会**在一个进程里跑完整个工作流。它**每次调用只跑一个 task**。Agent 通过反复调 `--step` 来驱动循环。

这个设计选择确保：
- 引擎绝不直接调大模型（skill 执行委托给 Agent）。
- 状态在每步后完整持久化到 `workflow.json`（崩溃恢复）。
- 审批门禁可以自然地"暂停"——引擎输出 `NEED_APPROVAL` 后退出，等用户决定。

### 单步流程

```
Agent: node engine/loop.js --step [--approve | --reject "<理由>" | --output '<json>']
  │
  引擎读 workflow.json，找到 current_task
  首次执行时创建 artifacts_dir
  │
  ├─ task.requires_approval == true 且 approval_status == null
  │    引擎创建 pending Attempt（approval_status=null）
  │    引擎输出: NEED_APPROVAL { task, attempt }
  │    引擎退出
  │
  │    Agent 问用户：
  │    ├─ 同意 → Agent 调: --step --approve
  │    │    引擎设 approval_status=approved → 继续执行 task
  │    └─ 拒绝 → Agent 调: --step --reject "<理由>"
  │         引擎设 approval_status=rejected, status=fail
  │         引擎检查 loops → approval_rejected 触发 → 回溯 tech_design
  │         引擎输出: LOOP_BACK
  │
  ├─ handler.type == "skill" 且无 --output
  │    引擎输出: NEED_SKILL { task, ref, input }
  │    引擎退出
  │    Agent 读 SKILL.md，思考，产出 output JSON
  │    Agent 调: --step --output '<json>'
  │    引擎把 output.data 写入 artifacts/<task>_attempt<N>.json
  │    引擎记 output.file = 路径, output.passed = output 里的 passed
  │    引擎检查 loops → 可能 LOOP_BACK
  │    引擎输出: DONE / LOOP_BACK
  │
  ├─ handler.type == "script"
  │    引擎执行脚本，产出写文件，检查 loops
  │    引擎输出: DONE / LOOP_BACK / FAILED
  │
  └─ 无更多 task → FINISHED
```

### 串行执行与数据流

Task 按声明顺序执行。`depends_on` 声明显式前置。

当一个 task 运行时，引擎从其 `depends_on` 前驱的**最近一次成功** Attempt 的 `output.file` 指向的文件中读取数据：

```
input = {
  "<前驱_task_name>": <读取前驱 artifact 文件的内容>,
  ...
}
```

产出外置后，数据流通过文件传递——workflow.json 里只存路径，实际数据在 artifact 文件中。

---

## 审批门禁

### 哪些 task 需要审批

只有 `requires_approval: true` 的 task。默认模板中只有 `code` task 开启。

### 审批流程

1. 引擎进入 code task，发现有 `requires_approval` 且当前 Attempt 的 `approval_status == null`。
2. 引擎创建一个 pending Attempt（只有 approval 字段，没有 status/output）。
3. 引擎输出 `NEED_APPROVAL { task, attempt }`，退出。
4. Agent 拿到指令，问用户："code task 要审批，同意吗？"
5. 用户决定：
   - **同意** → Agent 调 `--step --approve`。引擎设 `approval_status=approved`，然后继续执行 task（走 skill/script 分支）。
   - **拒绝** → Agent 调 `--step --reject "<理由>"`。引擎设 `approval_status=rejected`、`status=fail`、`reject_reason`，然后检查 loops。

### 回环重跑时重新审批

verdict fail → 回 code 时，code 是一个**新的 Attempt**（attempt 号递增），`approval_status` 从 `null` 开始，重新走审批流程。满足"每次进入 code 都要审批"。

### 审批拒绝的后果

审批拒绝触发 `trigger_type: "approval_rejected"` 的 loop，回退到 `tech_design`。计数 `loop_counts["code→tech_design"]` 递增。到 2 次终止。

---

## 回环机制

### 两条默认回环

模板声明了两条 loop，共享同一个 `checkLoops` 引擎逻辑：

```json
"loops": [
  {
    "trigger_type": "output_field",
    "trigger_task": "verdict",
    "trigger_field": "output.passed",
    "trigger_when": false,
    "target_task": "code",
    "max_iterations": 3
  },
  {
    "trigger_type": "approval_rejected",
    "trigger_task": "code",
    "target_task": "tech_design",
    "max_iterations": 2
  }
]
```

| 回环 | 触发条件 | 回退到 | 上限 | 含义 |
|---|---|---|---|---|
| verdict → code | verdict 的 `output.passed == false` | code task | 3 次 | 验证失败 → 重新编码 |
| code → tech_design | code 的 `approval_status == "rejected"` | tech_design task | 2 次 | 审批拒绝 → 回退改方案 |

### 计数独立性

- `loop_counts` 里 `"verdict→code"` 和 `"code→tech_design"` 是两个独立的键。
- 各自独立计数，互不干扰。
- verdict fail 3 次终止；code 拒绝 2 次终止。
- 全局累计，不按回环轮次重置。

### 两个回溯场景的完整时序

**场景 A：verdict fail → 回 code**
```
1. code 执行 → 产出写 code_attempt1.json → DONE
2. code_review → run_test → verdict 执行, passed=false
   → loop_controller 检查 loops[0]: trigger_type=output_field
   → output.passed == false → 触发, loop_counts["verdict→code"]=1
   → current_task 跳回 code → LOOP_BACK
3. 下次 --step → code 重新审批（新 Attempt）→ 产出写 code_attempt2.json
```

**场景 B：code 审批拒绝 → 回 tech_design**
```
1. plan 三步跑完
2. 引擎进 code, requires_approval=true → 输出 NEED_APPROVAL
3. 用户拒绝 → --step --reject "方案不够细"
   → code 的 Attempt: approval_status=rejected, status=fail
   → loop_controller 检查 loops[1]: trigger_type=approval_rejected
   → approval_status == "rejected" → 触发, loop_counts["code→tech_design"]=1
   → current_task 跳回 tech_design → LOOP_BACK
4. tech_design 重跑 → test_case_design → 又进 code → 又 NEED_APPROVAL
5. 用户再拒绝 → loop_counts["code→tech_design"]=2 → 超限 → TERMINATED
```

---

## 产出外置

### 目录结构

```
<项目根>/
└── .verification-workflow/
    └── <run_name>_<时间戳>/        ← artifacts_dir
        └── artifacts/
            ├── requirement_clarification_attempt1.json
            ├── tech_design_attempt1.json
            ├── test_case_design_attempt1.json
            ├── code_attempt1.json
            ├── code_review_attempt1.json
            ├── run_test_attempt1.json
            ├── verdict_attempt1.json
            ├── tech_design_attempt2.json     ← 审批拒绝后回溯重跑
            ├── code_attempt2.json            ← 回溯后第二次 code
            └── ...
```

### 文件命名

```
<task_name>_attempt<N>.json
```

- N = 该 task 的 Attempt 序号（从 1 开始）。
- 回环重跑时 N 递增，**不覆盖**。满足"保留历史"。

### 文件内容

文件内容 = 原 `output.data` 的完整内容。**不含 `passed`**（passed 留在 workflow.json）。

示例 `code_attempt1.json`：
```json
{
  "files": [
    { "path": "src/foo.js", "content": "..." }
  ],
  "summary": "Implemented X, Y, Z..."
}
```

示例 `verdict_attempt1.json`：
```json
{
  "verdict": "2 of 5 tests failed.",
  "failed_tests": ["test_edge_case_1", "test_error_handling"],
  "reason": "Edge case handling missing in module X."
}
```

### workflow.json 里只存路径或摘要

**artifact 模式**（plan 阶段 + verdict）：

```json
"output": {
  "file": ".verification-workflow/add_login_20250903T150000/artifacts/tech_design_attempt1.json"
}
```

**side-effect 模式**（code task）：

```json
"output": {
  "changed_files": ["src/auth/login.js", "src/auth/token.js"],
  "summary": "实现了登录和 token 验证"
}
```

- artifact 模式：完整产出数据在 artifact 文件里，workflow.json 只存路径。
- side-effect 模式：文件已写进真实仓库，workflow.json 只存改了哪些文件 + 摘要。
- `passed`：两种模式都可带，仅 verdict task 才有。loop_controller 直接读，不用读文件。

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
     "depends_on": ["<前驱>"],
     "requires_approval": false
   }
   ```
3. 把 task name 加到对应 phase 的 `tasks` 数组里。

**引擎代码不变。**

### 新增一条回环

往 `loops` 数组加一条。两种 trigger_type 都支持，引擎已内置两种判定分支。

### 新增一个审批门禁 task

在 task 声明里加 `"requires_approval": true`。引擎自动走审批流程。如需审批拒绝后回溯，在 `loops` 加一条 `trigger_type: "approval_rejected"` 的配置。

### 新增一个大阶段 / 新增一种 handler 类型

同前版——加 Phase 声明 / 在 `executeHandler` 加分支。

---

## 引擎参考

文件：[`engine/loop.js`](engine/loop.js)

### 五个合一的模块

| 模块 | 职责 |
|---|---|
| **loader** | 读取并校验 `workflow.json`。检查：版本、run_name 格式、phase 引用、task name 唯一性、depends_on 合法性、loop 引用 + trigger_type 合法性。 |
| **executor** | 分发 handler。`skill` → 返回 `NEED_SKILL` 指令。`script` → 通过 bash 执行。 |
| **engine** | 串行任务驱动。找下一个 task、从 depends_on 读 artifact 文件收集 input、调 executor、把产出写 artifact 文件、记 Attempt、推进。 |
| **loop_controller** | 每个 task 完成后检查所有 loops。按 `trigger_type` 分支：`output_field` 读产出字段；`approval_rejected` 检查审批状态。触发时计数、jump_to。 |
| **checkpointer** | 每次 Attempt 后保存 `workflow.json`（原子写）。 |

### CLI

```bash
# 查看状态（不执行）
node engine/loop.js --workflow <path> --status

# 执行一步
node engine/loop.js --workflow <path> --step

# 审批通过
node engine/loop.js --workflow <path> --step --approve

# 审批拒绝
node engine/loop.js --workflow <path> --step --reject "<理由>"

# 喂回 skill 产出
node engine/loop.js --workflow <path> --step --output '<json>'
```

### 输出协议

所有引擎输出都是 stdout 上一行 JSON：

| `type` | 何时 | 关键字段 |
|---|---|---|
| `NEED_APPROVAL` | 审批门禁 task 等待用户决定 | `task`, `attempt` |
| `NEED_SKILL` | skill 执行体等待 Agent 执行 | `task`, `ref`, `input` |
| `DONE` | task 完成 | `task`, `status`, `output`（artifact 模式含 `file`；side-effect 模式含 `changed_files`+`summary`） |
| `LOOP_BACK` | 回环触发，已跳回目标 | `from`, `to`, `iteration`, `max`, `reason?` |
| `FINISHED` | 所有 task 完成 | — |
| `FAILED` | script task 失败 | `task`, `file` |
| `TERMINATED` | 工作流终止 | `reason` |
| `STATUS` | 状态查询响应 | `current_task`, `artifacts_dir`, `task_progress[]`, `loop_counts` |
| `ERROR` | 错误 | `message` |

---

## 子 Skill

每个子 skill 位于 `skills/<name>/SKILL.md`，**自包含**：在 YAML frontmatter 里声明自己的 `input`/`output` JSON Schema，外加 prompt 正文。

**output schema 描述的是产出内容的结构**（不再是 output 外壳）。Agent 产出时返回内容本身，引擎负责包装成 `{ data: <内容> }` 并处理：

- 产出含 `files` 字段 → **side-effect 模式**：引擎写进真实仓库，output 存 changed_files + summary。
- 产出无 `files` → **artifact 模式**：引擎外置到 artifact 文件，output 存 file 路径。

| 子 skill | 大阶段 | requires_approval | output 模式 | output 有 passed？ | 说明 |
|---|---|---|---|---|---|
| `requirement_clarification` | plan | 否 | artifact | 否 | 将模糊需求澄清为结构化规格。 |
| `tech_design` | plan | 否 | artifact | 否 | 从澄清后的需求设计技术方案。 |
| `test_case_design` | plan | 否 | artifact | 否 | 从技术方案设计测试用例。 |
| `code` | code | **是** | **side-effect** | 否 | 产出 `files` → 引擎写进真实仓库。output 只存 changed_files + summary。执行前需人工审批。 |
| `code_review` | code | 否 | artifact | 否（有 `approved`） | 从真实仓库读 changed_files 指定的文件来 review。 |
| `run_test` | verify | 否 | artifact | 否 | 执行测试用例，收集结果。 |
| `verdict` | verify | 否 | artifact | **是** | 基于测试结果判定通过/失败。`passed: false` 触发回环。 |

只有 `verdict` 产出驱动回环的 `passed` 字段。这是有意为之：`passed` 是 verdict task 的**业务产出**，不是协议通用字段。

---

## 使用指南

### 给最终用户

```
/verification-workflow <你的需求>
```

Agent 会：
1. 根据你的需求生成 `workflow.json`（填 `run_name`）。
2. 逐步驱动 plan → code → verify 三个大阶段。
3. 进入 code task 前暂停，问你"是否同意开始编码？"。
4. 验证失败时自动回退到 code（最多 3 次）。
5. code 审批被拒时回退到 tech_design（最多 2 次）。
6. 汇报最终结果。

### 给 Agent（驱动循环）

```
1. 加载 skill → 读 protocol/schema.json + templates/workflow_template.json
2. 根据用户需求生成 workflow.json（填 run_name）
3. 循环:
   a. 调用: node engine/loop.js --workflow workflow.json --step
   b. 解析输出 JSON:
      - NEED_APPROVAL → 问用户是否同意
                       → 同意: --step --approve
                       → 拒绝: --step --reject "<理由>"
      - NEED_SKILL → 读 skills/<ref>/SKILL.md，思考，产出 output
                   → 调用: --step --output '<json>'
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
| 1 | `phase` = 大阶段，`name` = 具体任务 | 分离"在哪个阶段"和"做什么任务"。 |
| 2 | 无 `canskip` 字段 | 本版所有 task 必须执行。 |
| 3 | `input`/`output` 是 JSON Schema，可选 | 结构化契约支持校验。子 skill 可自声明。 |
| 4 | `status` 只有 `success` / `fail` | 无中间状态。 |
| 5 | 回环触发条件 = `passed: false` | `passed` 是 verdict task 的业务产出。 |
| 6 | verdict fail → 回 code，上限 3 | 验证失败要重新实现。 |
| 7 | `max_iterations: 3` | 有界重试。 |
| 8 | history 追加，永不覆盖 | 每次尝试都保留供调试。 |
| 9 | 串行执行 + `depends_on` | v1 不并行。 |
| 10 | 大阶段失败 = 工作流终止 | task 失败时终止。 |
| 11 | code↔review 小回环暂缓 | 协议支持，v1 不配置。 |
| 12 | 零代码扩展 | 新增 task/phase/loop = 只改 JSON。 |
| 13 | handler 类型：`skill` + `script` | 可扩展新类型。 |
| 14 | `passed` 放在 output 外壳 `{ file, passed? }` 里 | 产出外置后，passed 留 workflow.json 供 loop_controller 直接读。 |
| 15 | `id` 改名 `name`，不带 phase 前缀 | `name + phase` 联合标识。 |
| 16 | 去掉 `label` | `name` 本身已语义化。 |
| 17 | 时间戳只在 Task 层 | `started_at` + `finished_at` = 总耗时。 |
| 18 | skill + script 以单步模式协作 | 引擎每次 `--step` 只跑一个 task。引擎绝不直接调大模型。 |
| 19 | 子 skill 是内部资源 | 由 Agent 用 `read` 加载，不走 `skill()`。 |
| 20 | `handler.ref` 用相对路径 | 相对于 skill 根目录。 |
| 21 | 子 skill 自包含 | 每个 SKILL.md 声明自己的 input/output schema。 |
| 22 | Task 新增 `requires_approval` | code task 执行前必须人工审批。门禁在 task 级别。 |
| 23 | Attempt 新增审批字段 | 审计需要记录谁批的、何时批、拒绝理由。 |
| 24 | 审批拒绝时 `status` 记为 `"fail"` | 拒绝和执行失败在 status 上同构，靠 `approval_status` 区分。 |
| 25 | 回环重跑时重新审批 | 每次 code 执行前都走审批门禁。 |
| 26 | 审批拒绝走 `loops` 配置，`trigger_type: "approval_rejected"` | 复用 loop_controller，不搞第二套回溯引擎。 |
| 27 | code 审批拒绝 → 回 tech_design，上限 2 | 拒绝意味着方案要改。 |
| 28 | 拒绝计数全局累计 | 跨回环不重置，2 次拒绝就终止。 |
| 29 | `output` 改为 `{ file, passed? }` | 大产出外置到文件，workflow.json 只留路径。 |
| 30 | 产出文件命名 `<task>_attempt<N>.json` | 带 attempt 号防覆盖。 |
| 31 | `artifacts_dir` = `.verification-workflow/<run_name>_<时间>/artifacts/` | 按需求名+时间隔离不同运行。 |
| 32 | `run_name` 由 Agent 填，`artifacts_dir` 由引擎首次执行时创建 | 职责分离。 |
| 33 | `trigger_type` 字段区分两种触发 | 共用 checkLoops 逻辑。 |
| 34 | 两条 loop 共享一套引擎检查逻辑 | 不搞两套回溯机制，只是 `loops` 数组里有两条配置。 |
| 35 | 子 skill 的 output schema 描述产出文件内容 | 不再描述 output 外壳。Agent 返回内容，引擎负责包装。 |
| 36 | code task 产出含 `files` → 引擎自动写进真实仓库 | code task 不外置 artifact，直接写真实文件。引擎按产出结构判断，不按 task 名。 |
| 37 | side-effect 模式 output 只存 `changed_files` + `summary` | 文件已写进仓库，不需要 artifact 文件做中转。 |
| 38 | `gatherInput` 支持两种模式 | artifact 模式读文件内容；side-effect 模式直接传 changed_files + summary。 |
| 39 | code_review 从真实仓库读文件 | input 拿到 changed_files 路径列表，用 read 工具读真实文件来 review。 |
| 40 | Agent 自己看仓库，引擎不自动注入 | 引擎只管编排，信息收集由 Agent 用工具自主完成。 |

---

## 许可

本 skill 是 verification-workflow-v1 原型的一部分。
