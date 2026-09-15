# Project Cybersyn for DeepSeek Harness

本目录包含可选的 DeepSeek Harness 监督插件，以及 v3 新增的独立文件运行器 runtime/。下面的插件说明只描述 DSH 适配。它把 L3/L4 拆解、证据门、偏差诊断、J-workspace、人类提示词治理，以及子代理审计流水线投影为可回放状态；它不读取、伪造或显示模型隐藏推理。

> 目标宿主版本：DeepSeek Harness `0.1.1-rc.2`（developer preview）。插件会在不兼容版本上明确拒绝加载，避免静默错配。

## 先说清楚：它是什么，不是什么

DSH 插件是 T2 监督适配。独立 T3 由 runtime/cli.mjs 提供，说明见 ../references/harness-mode.md。插件自身的职责：

- 插件负责组装只读审计 PromptPacket、记录 Harness 已发生的生命周期事实、计算退化信号并显示结果；
- DeepSeek Harness 的 `subagent` / `workflow` 能力负责真正创建、并行、取消和回收子代理；
- 纯 Skill 负责语义判断、复杂度路由和证据纪律；插件缺席时仍可独立工作；
- `unmeasured` 不等于健康，`completed` 也不等于有效；没有外部质量基线时，不做效果未退化的声明；
- J-workspace 是外部的有限容量协调面，不是模型内部 J-space、激活、意识或 chain-of-thought 接口。

## 能力总览

| 控制面 | 能力 | 关键约束 |
| --- | --- | --- |
| `cybersyn_start` | 创建与当前 Harness task/session 绑定的 L1-L4 控制图 | 按实际依赖拆解，不按级别强制深度/任务数 |
| `cybersyn_task_update` | 登记证据、A/B/C/D 多标签偏差和状态跃迁 | `verified` 必须有当前、逐声明通过的证据 |
| `cybersyn_workspace_update` | 维护有限容量 J-workspace | 只保存可报告协调事实，不保存隐藏推理 |
| `cybersyn_model_update` | 维护 L4 竞争结构模型 | 模型需带预测和证伪条件 |
| `cybersyn_audit_plan` | 按风险选择审计角色并组装只读 PromptPacket | 只组装，返回 `subagents started: 0` |
| `cybersyn_audit_update` | 投影 Harness 子代理/工作流的运行事实 | 只接受合法状态跃迁，最多一次重试 |
| `cybersyn_inspect` | 读取当前状态、审计健康和交付门 | session 所有权隔离 |
| `Cybersyn` 会话页签 | 显示 DAG、子任务提示词、证据、偏差、J-workspace、L4 模型和审计流水线 | 修改通道仅限 loopback 人类界面 |

提示词修改是一次控制器重配置：它新建版本、记录操作者和原因、使目标任务及所有后代证据失效；若影响范围内存在运行中任务，则拒绝修改。

## 原 Skill 的只读审计结论

以下保留初期只读检查背景；v3 已修订根 Skill 并统一内嵌入口。结论不是“原设计没有子代理功能”，而是需要区分三件事：

1. **组装规则已经显式存在。** 原 Skill 的 `validation_prompt_assembler.py` 会选择 `goal-spec`、`measurement`、`integration-regression`、`environment` 视角，移除 `expected_answer`、`primary_diagnosis`、`proposed_fix`、`peer_outputs`，生成带只读权限和 `Finding[]` 输出约束的 PromptPacket。
2. **实际启动被有意留给宿主。** 原实现明确写出 assembler 永不启动子代理，Host 决定启动方式与并行度。这与 DeepSeek Harness 的能力边界一致，不是缺陷。
3. **退化思想存在，但运行态呈现不足。** 原资料已有静止/发散、环境漂移、覆盖缺口、单视角回退、成本不足和“多代理无稳定净收益就退回单审计”的规则；但独立插件此前没有显示 `planned → dispatched → running → completed/failed`，也没有把覆盖、失败、预算和质量下降变成可判定状态。本版本补的是这一层。

原 Skill 的静态评估观察不能证明真实效果；其评估运行器聚合观察值，但不自动形成子代理质量回归门。因此本插件同样把“尚无外部基线”显示为 `effectiveness: unmeasured`。

## 子代理组装流水线

```text
Cybersyn task + current prompt revision + A/B/C/D risk
                         │
                         ▼
              risk-selected audit roles
          B measurement        D integration-regression
          goal conflict goal-spec    C environment
                         │ L2≤1 / L3≤2 / L4≤3
                         ▼
              read-only PromptPacket[]
       ┌─────────────────┼──────────────────┐
       │ authority       │ excluded context │ Finding[] schema
       │ read-only       │ answer/diagnosis │ evidenceRef required
       └─────────────────┴──────────────────┘
                         │
                 plugin dispatches 0 agents
                         │
                         ▼
       DeepSeek Harness subagent / workflow runtime
       start ── running ── end(completed|failed|cancelled)
                         │
                         ▼
          cybersyn_audit_update fact projection
                         │
                         ▼
       visualization + degradation checks + optional gate
```

默认风险路由是确定性的：B 选测量视角，D 选集成回归，C 选环境，A 的执行偏差也先复核测量；目标/验收冲突由独立的 `goalConflict` 信号选择目标规格视角。调用者也可显式指定角色。超过层级预算会直接失败，不会静默丢弃显式请求。L1 的审计预算为零。

### PromptPacket 的隔离契约

每个包均显示：

- 固定 `authority: read-only`；
- 目标 task、当前有效提示词及其 revision；
- acceptance、constraints、artifact/evidence references；
- 角色目标和失败判据；
- 明确排除的答案、主诊断、拟议修复和同伴输出；
- 最多 1–20 个带 `evidenceRef` 的 Finding；没有证据支持的问题时返回空数组。

工具参数只接受引用和外部事实，不接受上述敏感上下文字段。这是输入结构上的隔离，不依赖“请忽略某字段”的软提示。

### 生命周期和重试

| 状态 | 含义 | 允许的下一步 |
| --- | --- | --- |
| `planned` | PromptPacket 已组装，尚未由 Harness 启动 | dispatched / running / completed / failed / cancelled |
| `dispatched` | Harness 已接受启动请求 | running / completed / failed / cancelled |
| `running` | 子代理正在执行 | completed / failed / cancelled |
| `completed` | Harness 已给出完整终态 | 终态，不可改写 |
| `failed` / `cancelled` | 本次尝试未完成 | 仅可再启动一次；第二次后终止 |

每次更新要求稳定的 `harnessRunId`。同一次尝试中 run id 不得变化；生命周期历史保留每个投影事实。插件没有“自动重试”副作用，只允许宿主显式登记一次重试。

### 退化检测

退化器分开报告 `operationalStatus` 与 `effectivenessStatus`：

| 检查 | 检测对象 | 何时为 `unmeasured` | 何时退化 |
| --- | --- | --- | --- |
| `context_independence` | 审计是否拥有独立上下文 | 不适用 | 串行/共享上下文回退无法提供独立第二视角 |
| `prompt_freshness` | PromptPacket 是否仍对应当前 task prompt revision | 不适用 | 人类修改提示词后旧包变 stale |
| `role_completion` | 计划角色的完成覆盖率 | 流水线未终止 | 覆盖率低于阈值 |
| `run_failure_ratio` | 所有终态尝试的失败/取消率 | 流水线未终止 | 高于阈值；重试失败也计入 |
| `evidence_grounding` | Finding 是否绑定证据引用 | 流水线未终止 | 出现无证据引用的 Finding |
| `token_budget` | 包括失败尝试的累计 token | 未配置或终态指标缺失 | 超过配置阈值 |
| `duration_budget` | 包括失败尝试的累计耗时 | 未配置或终态指标缺失 | 超过配置阈值 |
| `quality_regression` | 外部评分相对基线的下降 | 未提供基线或终态评分不完整 | 平均分下降超过 `maximumQualityDrop` |

只有显式设置 `requiredForGate` 的流水线才进入交付门。若还设置 `qualityRegressionRequired`，则必须提供质量基线，而且 effectiveness 必须为 `non-degraded`；“没测”不会通过。

`qualityScore` 是外部评估器提供的观察值。插件不会自己用 Finding 数量冒充质量，也不会把更多 Finding 自动解释为更好。

## 可视化运行呈现

会话页签包含四个相互关联但不混淆的视图：

1. L1–L4 task DAG：显示深度、依赖、状态和 prompt revision；
2. 人类子任务控制面：并列显示 generated baseline 与 effective prompt，可修订和回滚；
3. 子代理审计面：显示组装、Harness dispatch、运行、终态、attempt、run id 和 Finding 数；
4. 退化面：逐项显示 `pass / fail / unmeasured / not-applicable`，同时显示 operational 与 effectiveness 总状态。

图形只呈现持久化事实。若没有审计流水线，界面会写“未计划审计”，不会显示虚假的 PASS。

## 两种独立入口

### 纯 Skill

复制 `skill/project-cybersyn` 到目标 Skill 目录即可。Skill 不要求插件或工具存在：

- 有 `cybersyn_*` 工具时，使用持久状态和可视化控制面；
- 工具缺席时，使用相同字段维护文本证据账本；
- Host 没有子代理时，主代理可串行检查审计视角，但必须显式记录 `contextIndependent: false`，不得把它描述成独立审计。

### Harness 插件

构建并打包：

```sh
pnpm install
pnpm run check
pnpm pack
```

把生成的 npm 包加入 Harness 插件配置。`cordis.patch.yml` 提供默认插入项；发布和远程上传不属于本仓库的自动测试，需由使用者明确提供目标地址。

持久状态默认写入宿主工作目录下 `.dsh/cybersyn/events.jsonl`，也可通过 `stateFile` 指定：

```yaml
workspaceCapacity: 6
maxPromptChars: 24000
l4MinimumModels: 3
registerBundledSkill: true
```

## 体系结构

```text
pure Skill ─ semantic protocol ──> model
                                      │ seven constrained tools
                                      ▼
                              deterministic reducer
                 ┌────────────┬───────┼────────┬──────────────┐
                 │            │       │        │              │
              task DAG  evidence gate J-workspace audit projection
                 │            │       │        │              │
                 └────────────┴ append-only JSONL ┴────────────┘
                                      │
                    loopback RPC + session/revision checks
                                      │
                                      ▼
                         visual human control console

DeepSeek Harness workflow/subagent ─ lifecycle facts ─> audit projection
          (execution owner)                          (observer/controller)
```

插件使用自有 append-only JSONL 事件，不增加自定义 Harness Session event；因此不会改变 Harness 会话日志不变量。恢复时只修复可证明为未写完的最后一条 JSON，内部损坏会明确失败。

## 现成项目对照与复用决定

检索只采用官方仓库/文档作为技术依据：

| 项目 | 已显式提供 | 本项目决定 |
| --- | --- | --- |
| [DeepSeek Harness workflow](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/workflow.md) 与 [subagent](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/subagent.md) | 成对 start/end 事件、member 序号、终态、取消/回收、持久记录、中断证据、能力不支持时 fail-loud | **直接对接其语义，不复制执行引擎。** 插件保存 PromptPacket 与 run-id 投影 |
| [LangGraph](https://github.com/langchain-ai/langgraph) | 持久状态、故障恢复、human-in-the-loop、执行路径可视化 | 借鉴“状态可恢复、运行事实可检查”；不引入其 runtime 依赖 |
| [Microsoft Agent Framework](https://github.com/microsoft/agent-framework) | 顺序/并发/handoff/group workflow、checkpoint、事件流、OpenTelemetry、DevUI | 借鉴 executor start/end 与 checkpoint 观察模型；不建立第二套 workflow runtime |
| [OpenAI Agents SDK](https://github.com/openai/openai-agents-python) | handoff、agent-as-tool、guardrail、trace/span 与敏感数据开关 | 借鉴独立 trace、输入过滤和 guardrail 边界；不绑定其模型或云 tracing |
| [Promptfoo](https://github.com/promptfoo/promptfoo) | 断言、命名指标、阈值、失败退出码、重试错误 | 借鉴“显式阈值才能形成回归门”；本地实现少量领域指标，不引入完整 eval 框架 |

AutoGen 也被检查过，但其官方仓库已标明 maintenance mode，并建议新项目使用 Microsoft Agent Framework，因此没有作为新依赖或主要架构基线。

## 第一性原理与 Steelman

可直接控制的是事件、权限、状态跃迁、证据版本、提示词版本和人类决定；不可直接控制的是模型隐藏激活、真实世界因果关系和“审计员是否真的聪明”。因此本项目：

- 把原 Skill steelman 为证据优先、分层自治、结构性怀疑和人类元系统权威，而不是把语言模型硬套成线性控制对象；
- 用离散事件监督器约束可观察行为，不声称连续系统稳定性、增益裕度或 Lyapunov 证明；
- 把 J-space 理论转译成外部有限容量 J-workspace，只保留可报告、可广播、可移除的协调事实；
- 把“多代理更好”当成待检验假设，通过基线和阈值保留否证路径。

更完整推导见 `docs/construction.md`；理论与工程来源映射见 `docs/references.md`；纯 Skill 的运行协议见 `skill/project-cybersyn/references/runtime-protocol.md` 和 `audit-pipeline.md`。

## 验证

`pnpm run check` 依次执行：

1. 严格 TypeScript 类型检查；
2. 单元、负向、状态机、持久化、session 隔离和可视化测试；
3. host/client 双入口构建；
4. 软件发布、制造质量、科学复现三个跨域构造性例证；
5. npm 打包后，从 tarball 加载插件、注册七个工具与 Skill，并执行 start、audit plan 和 inspect。

测试覆盖了无基线时 `unmeasured`、健康流水线、共享上下文退化、token 超限、质量基线下降、stale PromptPacket、一次重试上限和 JSONL 回放。

这些测试证明实现不变量和当前 pinned Harness 版本的打包兼容性；不等同于真实现场效果研究。运行结果见 `reports/verification.md` 和 `reports/cross-domain-evidence.json`。

## 安全与发布边界

- 状态按 Harness session 隔离，写操作使用乐观并发 revision；
- 浏览器修改接口仅向 loopback UI 开放；
- 审计 PromptPacket 固定只读，工具不接受主答案/主诊断/拟议修复/同伴输出；
- 外部子代理失败保留为覆盖缺口，不静默转换成成功；
- 本项目不会自动上传、发布、创建远程仓库或修改原 Skill；远程地址由使用者在测试完成后另行提供。


## v3 运行器

运行器复用 src/core.ts 导出的领域控制器，仅以 pi-ai 作为单次模型后端。运行步骤、文件派发、预算和恢复由 Cybersyn 持有。npm/DSH 插件包与 Skill 的 with-harness 包是不同发行目标；运行器通过根 tools/build_package.py 随 Skill 分发。模型可见 DSH 工具返回 stateJson（含任务、证据和完整审计包），assurance 标识为 T2-reported-evidence。默认审计一个视角，显式 requestedRoles 可在预算内增加。
