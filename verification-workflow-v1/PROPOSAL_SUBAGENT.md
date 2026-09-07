# 技术方案：子 Agent 执行器 + 主 Agent 编排

> 状态：已实施（分支 `feat/executor-subagent`）
> 关联代码：`engine/loop.js`、`protocol/schema.json`、`templates/workflow_template.json`、`README.md`、`SKILL.md`

---

## 1. 问题

当前所有 task 由顶层 Agent 自己扮演：收到 `NEED_SKILL` → read SKILL.md → 思考 → 产出 → `--output` 喂回引擎。一次完整流程（含回环）可能执行 12+ 个 task，所有交互全堆在主 Agent 同一个上下文里，最终爆上下文。

## 2. 核心设计

### 2.1 解耦 task 和 executor

- **task** = 工作流里的一个步骤（code、code_review、run_test、verdict）
- **agent** = 一个有状态、可复用的执行角色（planner、coder、verifier）
- **executor** = task 声明它由谁执行（主 Agent 自己 / 某个子 Agent）

### 2.2 两种 id

复用机制涉及两种 id，必须分清：

| 类型 | 例子 | 谁管 | 何时产生 |
|------|------|------|---------|
| **声明名** (declared_name) | `"planner"` | 写在 workflow.json 的 `executor` 字段里，引擎输出 `NEED_SKILL` 时带这个 | 生成 workflow.json 时 |
| **真实 id** (real_agent_id) | `"a3f7b2c1-..."` | 主 Agent 的 `agent_id_map` 里存，调 `subagent`/`send_message` 时用这个 | `subagent` 创建时 harness 返回 |

**引擎只管声明名**：从 `executor` 字段读声明名，在 `context.known_agents` 里记录见过哪些，输出 `reuse: true/false`。不存真实 id。

**主 Agent 管真实 id**：调 `subagent` 时拿到 harness 返回的真实 id，存在 `agent_id_map`（声明名 → 真实 id）。下次复用时从映射表查真实 id，调 `send_message`。

### 2.3 引擎侧逻辑（已实现）

- `executeHandler`：解析 `executor` 字段，维护 `known_agents` 列表，返回 `executor: { mode, agent_id, reuse }`
- `NEED_SKILL` 输出带 `executor` 字段
- `loadWorkflow` 初始化 `known_agents`
- `status()` 输出 `known_agents`

**引擎代码不用再改。**

### 2.4 主 Agent 侧逻辑（文档指导，不改引擎）

主 Agent 维护 `agent_id_map`（声明名 → 真实 id）：

```
收到 NEED_SKILL + executor:
  declared_name = executor.agent_id

  if declared_name not in agent_id_map:        # 新建
    result = subagent(
      prompt = read(handler.ref + "/SKILL.md"),
      input  = NEED_SKILL.input,
      description = declared_name
    )
    agent_id_map[declared_name] = result.agent_id
    output = result.output

  else:                                         # 复用
    real_id = agent_id_map[declared_name]
    output = send_message(
      agent_id = real_id,
      message  = 构建任务消息(input, handler.ref)
    )

  --output '<output JSON>'  # 直传，不加工
```

**主 Agent 以 `agent_id_map` 为真相**，引擎输出的 `reuse` 只是参考。映射表里有就复用，没有就新建。

### 2.5 子 Agent 生命周期

子 Agent 跑完一轮后**不会消失**——进入 idle 状态，Session 持久化，带着上下文等着。`send_message` 发新任务时，新消息追加到同一个 Session，上下文连续。回环重跑同一个 task 时，同一个子 Agent 带着上下文继续工作。

### 2.6 主 Agent 的定位

> **纯流程调度器 + 用户接口。不碰仓库、不做执行、不收集业务数据。**

主 Agent 不做的事：
- **不探查仓库**：不 read 代码、不 grep、不 bash——所有业务数据收集由子 Agent 在自己上下文里完成
- **不判断产出**：收子 Agent 产出后直传 `--output` 喂回引擎，不判断、不加工
- **不思考业务**：不理解技术方案、不写代码、不跑测试——全交给子 Agent

主 Agent 只做的事：
- 把用户需求翻译成 workflow.json 声明（套模板，填 run_name，不探查仓库）
- 驱动 `--step` 循环、起/复用子 Agent
- 审批问用户、最终结果报用户

主 Agent 上下文里只有：用户需求（一句话）+ workflow.json 声明 + 引擎输出消息（含精简摘要）+ `--output` 喂回的 JSON + `agent_id_map` + 和用户的对话。**没有任何仓库内容、代码、业务数据。**

## 3. 默认 executor 分配

| 阶段 | task | executor |
|------|------|----------|
| plan | requirement_clarification | `subagent:planner` |
| plan | tech_design | `subagent:planner` |
| plan | test_case_design | `subagent:planner` |
| code | code | `subagent:coder` |
| code | code_review | `subagent:coder` |
| verify | run_test | `subagent:verifier` |
| verify | verdict | `subagent:verifier` |

3 个子 Agent，各自独立上下文，跨 task 复用。回环时上下文连续。

## 4. 完整执行流程示例

```
用户: "/verification-workflow 给登录加 JWT"

主 Agent:
  1. 生成 workflow.json（含 executor 字段）
  2. agent_id_map = {}

  3. --step → NEED_SKILL(task=requirement_clarification, executor={agent_id:"planner", reuse:false})
     agent_id_map 里没有 "planner" → subagent(prompt=skills/req/SKILL.md, ...)
     harness 返回 "a3f7..." → agent_id_map["planner"] = "a3f7..."
     收产出 → --output

  4. --step → NEED_SKILL(task=tech_design, executor={agent_id:"planner", reuse:true})
     agent_id_map 里有 "planner" → send_message("a3f7...", "做 tech_design")
     子 Agent 带着上一轮上下文继续 → 收产出 → --output

  5. --step → NEED_SKILL(task=test_case_design, executor={agent_id:"planner", reuse:true})
     同上复用 planner

  6. --step → NEED_SKILL(task=code, executor={agent_id:"coder", reuse:false})
     agent_id_map 里没有 "coder" → subagent(prompt=skills/code/SKILL.md, ...)
     harness 返回 "b8e2..." → agent_id_map["coder"] = "b8e2..."
     收产出 → --output

  7. --step → NEED_SKILL(task=code_review, executor={agent_id:"coder", reuse:true})
     复用 coder → send_message("b8e2...")

  8. --step → NEED_SKILL(task=run_test, executor={agent_id:"verifier", reuse:false})
     新建 verifier → agent_id_map["verifier"] = "c5d1..."

  9. --step → NEED_SKILL(task=verdict, executor={agent_id:"verifier", reuse:true})
     复用 verifier

  10. --step → LOOP_BACK (verdict 失败, 回到 code)

  11. --step → NEED_SKILL(task=code, executor={agent_id:"coder", reuse:true})
      复用 coder → send_message("b8e2...", "回环重跑，上轮问题=...")
      coder 记得第 1 轮改了什么，带着上下文继续修

  12. ... 继续直到 FINISHED
```

## 5. 改动范围

| 文件 | 改动 | 状态 |
|------|------|------|
| `engine/loop.js` | `executeHandler` 加 executor 逻辑；`NEED_SKILL` 带 executor + saveWorkflow；`loadWorkflow` 初始化 known_agents；`status()` 输出 known_agents | ✅ 已完成 |
| `protocol/schema.json` | Task 加 `executor` 字段；Context 加 `known_agents` 字段 | ✅ 已完成 |
| `templates/workflow_template.json` | 7 个 task 加 executor；context 加 known_agents | ✅ 已完成 |
| `README.md` | Agent 驱动循环（含 agent_id_map 伪码）；执行器机制（两种 id、生命周期、定位） | ✅ 已完成 |
| `SKILL.md` | 使用指南更新（agent_id_map 管理、两种 id 说明） | ✅ 已完成 |

**不改**：产物目录逻辑、产出处理、input 收集、回环/审批/backtrack/推进逻辑、持久化逻辑、子 skill SKILL.md。

## 6. 端到端验证结果

- 首次遇到 `subagent:planner` → `executor.reuse: false`，`known_agents` 写入 `["planner"]` ✓
- 同声明名的第二个 task → `executor.reuse: true` ✓
- 不同声明名（coder）→ `reuse: false`，`known_agents` 变成 `["planner", "coder"]` ✓
- 无 executor 字段的 task（旧行为）→ `NEED_SKILL` 不带 executor 字段，兼容 ✓
