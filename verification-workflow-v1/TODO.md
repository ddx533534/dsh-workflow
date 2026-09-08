# TODO — 优化点清单

基于当前架构（引擎独占状态 + 声明式协议 + 单步执行 + 大模型无状态调用），待优化的点。

---

## 已完成

### ✅ 1. 回溯用 expired 标记代替清除 history

**原问题**：回溯时清除 target_task 之后所有 task 的 history。code 审批拒绝 → 回 tech_design → code 的 rejected 记录丢了。跟"保留历史"的决策矛盾。

**实现**：不清除 history，给下游每个 task 的最后一个 Attempt 加 `expired: true` 标记。`findNextTask` 和 `advance` 通过 `isTaskDone` helper 统一判断——最后一个 attempt 是 expired 的 task 视为"需重跑"，但历史记录完整保留。

```json
{
  "attempt": 1,
  "status": "success",
  "expired": true,
  "expired_reason": "backtrack_from:code→tech_design"
}
```

改动点：`isTaskDone` helper、`findNextTask`、`advance`、`checkLoops`、`checkRequestBacktrack`、schema.json `Attempt` 加 `expired`/`expired_reason` 字段。

---

### ✅ 2. 增量执行（崩溃恢复不白跑）

**原问题**：崩溃重启后可能重跑已经成功的 task。

**实现**：配合 #1 的 `isTaskDone` helper，崩溃恢复时自动跳过 success 且非 expired 的 task，只重跑 expired 或未跑的。`findNextTask` 本来就有这个判断，#1 把 expired 纳入同一判断后，崩溃恢复天然工作，无需额外机制。暂停-恢复走同一路径。

---

当前无待办项。
