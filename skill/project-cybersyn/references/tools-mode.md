# T2：按缺口使用工具

先确认当前任务需要哪项补足。强基座默认继续 T1，不必为了流程创建状态文件。

| 缺口 | 工具 |
| --- | --- |
| 忘记目标、轮次和未完成项 | `tools/cybersyn_state.py` |
| 漏验收、混淆候选与证据 | `tools/checklist_compare.py`、`tools/convergence_check.py` |
| 无法决定需要什么支撑 | `tools/control_contract.py`；仅使用已观察缺口，不会启动任何东西 |
| 确需独立复核 | `tools/validation_prompt_assembler.py`；只组包，不创建子代理 |

从 Skill 根目录运行，需 Python 3.10+，工具仅使用标准库。示例见 `tools/README.md`。
T2 工具检查契约，不能强制宿主所有行为；来源文本不等于已经执行。

状态 v3 保存 `goal_revision`。初始目标可以读取旧格式的新反馈；目标修改后，passed 项必须显式匹配新 revision。
旧 v2 状态读取时迁移为 v3，旧证据保留为 legacy，待重新核对；显式 `migrate` 保存前备份旧文件。
`apply-audit reset-rt` 失效旧证据，保留已用轮次；`restructure` 不增加 Nmax。
必要环境/假设以 `conditions` 记录 id、required、status 和 evidence。未复核为 unknown，不能凭关键词推断 confirmed。

执行测试需要已有宿主授权和可信命令来源。`--execute-tests --authorize-test-execution --trusted-command-source` 是宿主声明，不是模型可自行授予的权限。
工具不提供 OS 沙箱；不要把 shell=False 或命令白名单描述成隔离。

可选：把 `CYBERSYN_STATE` 指向此任务独立状态文件。不要让不同任务共用账本。
