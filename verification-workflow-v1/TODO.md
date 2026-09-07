# TODO — 优化点清单

基于当前架构（引擎独占状态 + 声明式协议 + 单步执行 + 大模型无状态调用），待优化的点。

---

## 优先级：高（实际跑过时已暴露的问题）

### 1. gatherInput 按需提取字段

**问题**：当前 `gatherInput` 把前序 task 的全部产出一股脑塞给当前 task。tech_design 产出几千字的方案全文，code task 全部进上下文。task 链变长后 input 膨胀，最终爆上下文。

**方案**：task 声明 `input_mapping`，引擎按需提取指定字段，不传全部。

```json
{
  "name": "code",
  "input_mapping": {
    "tech_design": ["key_components", "tech_risks"],
    "test_case_design": ["test_cases"]
  }
}
```

**改动**：`gatherInput` 加字段过滤逻辑。不改核心原理。

---

### 2. 回溯用 stale 标记代替清除 history

**问题**：回溯时清除 target_task 之后所有 task 的 history。code 审批拒绝 → 回 tech_design → code 的 rejected 记录丢了。跟"保留历史"的决策矛盾。

**方案**：不清除 history，给最后一个 Attempt 加 `stale: true` 标记。`findNextTask` 和 `advance` 跳过 stale 的 Attempt，但记录完整保留。

```json
{
  "attempt": 1,
  "status": "fail",
  "approval_status": "rejected",
  "stale": true,
  "stale_reason": "backtrack_from:code→tech_design"
}
```

**改动**：`findNextTask`、`advance`、`checkLoops` 加 stale 检查。改动量小。

---

### 3. artifacts_dir 路径解析修复

**问题**：引擎按 `workflow.json` 所在目录解析相对路径。如果 `workflow.json` 不在项目根目录，文件写到错误位置（实际跑时遇到过——文件写到了 `.verification-workflow/` 子目录里）。

**方案**：Workflow 加 `project_root` 字段，所有路径解析基于 `project_root` 而不是 `workflowDir`。

```json
{
  "project_root": ".."
}
```

**改动**：`processOutput`、`gatherInput`、`writeArtifact` 的路径基准改用 `project_root`。

---

## 优先级：中

### 4. task 产出反馈机制（request_backtrack）

**问题**：大模型完全被动——收 input、产 output，不能说"需求有矛盾，建议回头改需求"。灵活性短板。

**方案**：task 产出里允许带可选的 `request_backtrack` 字段。引擎在 `checkLoops` 之后检查，有则临时 jump_to 到目标 task（走同一套 jump_to 逻辑）。大模型只是"请求"，引擎决定要不要执行（校验目标合法性、设上限防无限回溯）。

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

**改动**：引擎加一个 `request_backtrack` 检查分支。不改核心架构。

---

### 5. verdict 区分 blocker_type，环境问题早止损

**问题**：`failed_count > 0 → passed: false → 回环`。但环境问题导致的失败，回环 3 次都是同样的失败，白跑。

**方案**：verdict 产出加 `blocker_type` 字段（`code_issue` / `environment_issue`）。引擎看到 `environment_issue` 时不回环，直接终止。

```json
{
  "data": {
    "verdict": "1 of 4 failed: full_apk_build",
    "blocker_type": "environment_issue",
    "reason": "rustc version insufficient, code cannot fix this"
  },
  "passed": false
}
```

**注意**：跟"不豁免失败"不矛盾——passed 还是 false，只是引擎决定不值得回环重试。

**改动**：`checkLoops` 加 blocker_type 检查分支。

---

### 6. 完整 JSON Schema 校验

**问题**：当前 `validateAgainstSchema` 只检查 `required` 字段有没有。大模型产出少字段、类型不对，引擎不报错，下游 task 拿到残缺 input 才出问题。

**方案**：引入 `ajv` 做完整 JSON Schema 校验。产出不通过就拒绝、报错给 Agent 重试。

**改动**：换一个校验函数。改动量小。

---

## 优先级：低

### 7. 大文件产出走文件而非命令行参数

**状态：已解决**。引擎加 `--output-file <path>` 参数，子 Agent 把产出写到文件，主 Agent 只传文件路径给引擎。`--output`（inline JSON）仍兼容小产出。见 CLI 文档。

---

### 8. 增量执行（崩溃恢复不白跑）

**问题**：崩溃重启后可能重跑已经成功的 task。

**方案**：配合优化 2（stale 标记），崩溃恢复时跳过 success 且非 stale 的 task，只重跑 stale 或未跑的。

**改动**：`findNextTask` 逻辑调整。跟优化 2 一起做最自然。

---

## 建议实施顺序

先做 1、2、3（高优先级，实际暴露的问题），再做 4、5、6（中优先级，提升灵活性和健壮性），最后做 7、8（低优先级，边界情况）。
