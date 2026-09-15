# T3：外部执行支撑

仅在持续执行不稳定或任务明确需要运行时能力时启用。T3 为模型缩小每步动作与上下文，不要求模型阅读整个实现。

发行包包含 `harness/cli.mjs`，需 Node 22.19+（推荐 24）；复用 Python 工具时需 Python 3.10+。
真实模型后端使用固定版本 pi-ai，先在 `harness/` 运行 `npm ci --ignore-scripts`。
无网络的自检后端无需安装 pi-ai，不产生模型费用；测试结果明确标为 fixture。

运行入口：

```text
node harness/cli.mjs run --task task.json --workspace WORKSPACE --state STATE_DIRECTORY --backend backend.json
node harness/cli.mjs inspect --state STATE_DIRECTORY
node harness/cli.mjs resume --state STATE_DIRECTORY
node harness/cli.mjs cancel --state STATE_DIRECTORY
```

工作目录与可信状态目录必须互不包含。模型只能读写明确列出的项目文件，不能修改任务配置、验收器、预算和事件库。
初版执行器提供有限文件操作与确定性文件/JSON 验收；不提供任意 shell 或任意代码执行，更不模拟未运行的测试。
超出已支持验证范围的任务明确受阻，可以在具备真实隔离的宿主中使用其原有工具。

每步仅发送目标、验收摘要、有效证据、最近结果和允许动作。原始日志保留，重建上下文不改变事实。
完成由 runtime 对当前文件重新验收决定，模型 finish 只是请求。目标与产物版本变化使旧证据失效。
中断后恢复不清零预算；结果不确定的写入先按记录的内容哈希核对，不能确认时保持 indeterminate。
读取、格式失败和提供方重试都有总上限。取消请求在下一动作之前生效，模型请求遵守取消信号。

DSH 插件是可选监督适配，保留图、审计包、prompt 修订与回放。未接入真实执行前拦截和可信生命周期时，只声明 T2 监督能力；不把安装插件或出现工具名当作 T3 激活。
强基座无需加载本页或启动 runner；后续证据表明较轻模式足够时，在任务边界撤除额外支撑。

## 可运行示例与参数

从完整安装包根目录运行离线示例；WORKSPACE 与 STATE_DIRECTORY 使用两个不同目录：

```text
node harness/cli.mjs run --task harness/examples/report-task.json --backend harness/examples/report-fixture.json --workspace WORKSPACE --state STATE_DIRECTORY
```

真实模型配置样例是 harness/examples/pi-backend.json。将所选 provider/model 和显式环境变量配好后替换 --backend 即可；fixture 响应不参与真实效果统计。

--limits 接受 JSON 文件，可设 maxSteps、maxToolCalls、maxTokens、maxOutputTokens、maxContextBytes、maxMs、callTimeoutMs、maxRepairs、maxNoProgress。全部是正整数，未知参数拒绝；不能靠 resume 清零。maxMs 是从创建起计算的墙钟总时间，暂停期间仍计时。此版没有美元费用预算，令牌缺少实际用量时保留保守估算。

run/resume 的 --stop-after N 在动作边界暂停。needs_input 只有收到真实补充输入才继续：resume --state STATE_DIRECTORY --input "用户补充内容"。revise --state STATE_DIRECTORY --task NEW_TASK_JSON --expected-revision N 在暂停或终止边界修订目标，清空当前证据并保留预算；不能扩大文件权限。cancel 终止本次运行，需要新预算时新建一次明确授权的运行。

事件日志包括发送给模型的上下文、原始回复、动作准备与观测快照。原始内容可能包含任务文件数据，应保存在用户控制的状态目录。哈希链用于检测损坏，不是抵御管理员修改的签名。inspect 对当前产物重新核对；accepted 旧状态下的文件后来被修改时 accepted 返回 false。

配套 pi-ai API 已做本地导入与目录兼容核对；未使用真实模型密钥时，取消/超时自检仅能证明本地 fixture 路径，不能证明每个提供方的网络行为。当前实测不构成“弱基座已被补成强基座”的证据。
