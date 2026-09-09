# Multica 项目梳理

> 调研日期：2026-09-09
> 
> 目标仓库：[multica-ai/multica](https://github.com/multica-ai/multica)

## 一句话结论

Multica 是一个开源、可自托管的“人类 + AI 编码 Agent 团队协作平台”。它不提供底层模型，而是把 Claude Code、OpenAI Codex、Cursor Agent、Copilot CLI、Kimi、Qwen 等本机 Agent CLI 统一注册成团队成员，通过 issue、评论、项目、运行记录和审批流来分派、跟踪和复查工作。

## 它解决什么问题

项目针对多个 Agent 分散在不同终端、上下文丢失、进度不可见、结果难以交接的问题。核心思路是把“需求意图、讨论、执行过程、产物和最终 diff”绑定在同一个工作项上，让 Agent 像同事一样被指派任务、汇报进度、提出阻塞并把结果交回人工审核。

## 工作链路

1. 人或外部事件创建/触发 issue。
2. 选择一个 Agent 或 squad 作为负责人。
3. Multica 创建 run 并排队。
4. 连接的 runtime 上的 daemon 领取 run，在本机启动对应的 Agent CLI。
5. Agent 在本地代码目录执行命令、修改文件、运行测试。
6. 进度、工具调用、错误和结果回写到 issue 时间线与 execution log。
7. 结果进入 review，是否合入由人决定。

Agent 是可复用的身份和配置，不是持续运行的进程；runtime 负责机器和 CLI，run 负责记录一次具体执行。

## 主要能力

- 多 Agent/多模型统一接入：README 列出 26 种 Agent CLI。
- Issue、项目、评论、聊天、@提及和 squad 协作。
- Autopilot：按 cron 或 webhook 做日报、依赖检查、审计等重复工作。
- 执行日志、Token 用量、重试/超时、收件箱和 review gate。
- GitHub、GitLab、Gitea、Forgejo 等 Git 主机，以及 Slack、飞书、钉钉、企业微信、Telegram 等聊天入口。
- Web、Electron 桌面端和 Expo/React Native iOS 客户端。
- Docker Compose 或 Helm 自托管，支持工作区、角色和 Agent 访问控制。

## 技术架构

| 层 | 技术 |
|---|---|
| Web | Next.js 16 App Router |
| Desktop | Electron，共享 Web UI 包 |
| Mobile | Expo / React Native（iOS） |
| Backend | Go，Chi、sqlc、gorilla/websocket |
| Database | PostgreSQL 17，pgcrypto + pg_trgm |
| 执行层 | 本机 agent daemon，启动外部 Agent CLI |
| 组织方式 | pnpm workspace + Turborepo |

## 最重要的安全判断

Multica 默认不提供完整的文件系统沙箱。daemon 启动的 Agent 通常拥有运行 daemon 的操作系统用户的权限，可能读取该用户可访问的文件、凭据并访问网络。因此它更像“远程调度和审计平台”，不是安全隔离平台。

官方建议把 daemon 放在专用 Unix 用户、容器或虚拟机中，并只提供必要的仓库和凭据；生产部署不能把个人 SSH key、云凭据和无关目录暴露给 Agent。

## 适用场景

- 小型研发团队同时运行多个编码 Agent，想统一派单和看进度。
- 希望把 Agent 工作沉淀为可复用 skill/runbook。
- 需要在本机或内网执行代码，但在 Web 端统一管理任务。
- 想把定时检查、依赖升级、报告生成等重复工作交给 Agent。
- 对数据驻留、自托管、Git/聊天系统集成有要求的团队。

## 不适合直接当成什么

- 它不是模型训练框架，也不是模型推理服务。
- 它不是单纯的 IDE 插件；重点在团队级任务编排、状态流转和审计。
- 它不是天然安全的沙箱执行器；需要自行设计 daemon 的机器和账号隔离。
- 它不能替代人工验收：项目明确把最终 review/发布决策留给人。

## 项目成熟度的初步判断

仓库具有完整的 Web、桌面、移动端、Go 服务端、CLI/daemon、Docker/Helm 部署和文档体系，且 GitHub 页面显示约 49.3k stars、5,204 commits；从工程范围看已经不是概念 Demo。另一方面，根目录版本仍为 `0.2.0`，README 说明主分支大多数工作日都会更新，因此如果用于生产，需要锁定发布版本、单独验证升级和迁移，并重点评估权限、凭据和运行隔离。

## 依据

- [项目 README](https://github.com/multica-ai/multica/blob/main/README.md)
- [How Multica works](https://multica.ai/docs/how-multica-works)
- [Agents](https://multica.ai/docs/agents)
- [Autopilots](https://multica.ai/docs/autopilots)
- [Security model](https://multica.ai/docs/security-model)
- [Self-hosting guide](https://github.com/multica-ai/multica/blob/main/SELF_HOSTING.md)
- [VISION.md](https://github.com/multica-ai/multica/blob/main/VISION.md)
- [package.json](https://github.com/multica-ai/multica/blob/main/package.json)
