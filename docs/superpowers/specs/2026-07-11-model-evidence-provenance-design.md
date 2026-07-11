# Claude Code 模型证据与来源语义修复设计

## 文档状态

- 状态：已批准，待实施
- 日期：2026-07-11
- 范围：`cc-plugin-codex` 的模型元数据采集、持久化、展示、兼容迁移与回归测试
- 不包含：Provider 配置修改、模型自动选择、Provider 后台查询、任务执行逻辑重构
- 关联文档：
  - `docs/superpowers/specs/2026-07-10-provider-agnostic-model-and-runtime-liveness.md`
  - `docs/superpowers/specs/2026-07-10-cc-plugin-adversarial-hardening.md`
- 优先级：P1 正确性缺陷。任务实际执行不受影响，但当前 UI 会把用量聚合 key 错报为执行模型。

本设计取代上述 Provider-agnostic Spec 中“`observedModel` 来自 Claude Code result metadata，因此代表运行时观察模型”的语义。模型透传、继承 Provider 配置和无默认任务超时等其他决策保持不变。

## 一、问题与已确认根因

当前 watchdog 在 Claude CLI 完成后解析 `--output-format json` 的最终结果，并执行：

```js
const observedModel = Object.keys(parsed.modelUsage)[0];
```

随后 companion 将该值写入 `job.observedModel`，并在 `cc_delegate`、`cc_check`、`cc_list_models`、任务列表和 review 输出中展示为 `Model` 或 `Observed Model`。

这条链路隐含了一个未经证明的等式：

```text
modelUsage 的第一个 key = Provider 实际执行模型
```

真实运行已经反证该等式：

- 委派请求没有传入 `model`，所以 `requestedModel = null`，Claude Code 继承本地 Provider 配置。
- Claude Code 会话 JSONL 中，本次任务的全部 assistant 记录均为 `message.model = "mimo-v2.5-pro"`。
- Provider 后台也显示实际请求使用 `mimo-v2.5-pro`。
- Claude 最终 JSON 的 `modelUsage` 聚合 key 被插件读成 `mimo-v2.5`。
- 插件最终错误展示 `Model: mimo-v2.5`。

因此根因不是模型路由错误，而是字段语义错误：`modelUsage` 是用量/计费聚合维度，可能使用基础模型族、别名、归一化名称或 Provider 自定义 bucket；它不是执行模型的权威字段，而且可能包含多个 key。当前实现还错误地只取第一个 key，丢失其余信息。

## 二、第一性原理

插件能诚实回答的不是“后台物理上究竟运行了哪个模型”，而是“每个系统边界分别报告了什么”。模型信息必须按证据来源分层，不能把不同来源合并成一个 `model` 字符串。

四条不可破坏的原则：

1. **请求意图不等于执行结果。** `--model mimo-v2.5-pro` 只证明插件请求了该标识，不证明 Provider 最终没有重写、fallback 或路由。
2. **用量维度不等于执行结果。** `modelUsage` 的 key 只能称为 usage key，不能称为 observed/executed model。
3. **会话记录是强证据，但不是绝对真相。** JSONL `message.model` 是 Claude Code 对每条 assistant 消息记录的执行模型，是插件本地可获得的最强证据；展示时必须注明来源，不得宣称为 Provider 物理基础设施的绝对事实。
4. **未知优于推断。** 证据缺失、格式变化、文件不可读或解析超限时，显示 `unavailable`，任务仍正常完成；不得从别名、配置文件、usage key 或历史任务猜测执行模型。

## 三、对抗性审查结论

### 3.1 被否决的方案

#### 只把 `observedModel` 改名

优点是改动小，但仍无法解释“后台显示 Pro、插件只显示基础模型”的真实问题，也无法展示 Claude Code 已经记录的 `message.model`。只改文案不足以满足可观察性需求。

#### 读取 `settings.json` 生成 `configuredModel`

该字段被否决。配置可能使用 alias、环境变量、Provider 映射、命令行 override、项目级设置和运行时 fallback。读取配置只能得到部分意图，不能证明最终路由；同时会扩大读取 secret-bearing 配置的隐私面。插件不得解析或持久化 Provider 配置。

#### 用 JSONL 模型覆盖 usage key

该方案也被否决。两者表达不同事实，都应保留。覆盖会继续隐藏 Provider 聚合命名与执行记录之间的差异，并使计费排障失去证据。

#### 继续只保留一个模型字符串

一次 Claude Code 任务可能由主会话和 subagent 使用多个模型。单字符串数据模型从结构上无法准确表达多模型执行，不能用“取第一个”“取最后一个”或“优先主模型”掩盖。

### 3.2 必须防御的失败模式

- Claude Code 升级后 JSONL 路径或字段格式变化。
- 主会话文件存在，但尚未完成 flush、包含部分损坏行或超大内容。
- 多条流式快照复用相同 `message.id`，导致把记录数误报为模型调用次数。
- subagent 使用与主会话不同的模型。
- `modelUsage` 同时包含多个 key，且对象插入顺序没有业务语义。
- 历史 v3 job 的 `observedModel` 已经是错误语义，迁移时不能把它冒充成 executed model。
- 恶意或异常模型标识包含换行、Markdown 表格分隔符、控制字符或超长文本。
- `session_id` 被利用进行路径穿越，或 transcript 路径通过 symlink 逃逸 Claude 配置目录。
- transcript 扫描阻塞 MCP server，拖慢任务最终返回。
- transcript 不可用导致一个本来成功的编码任务被标记失败。

## 四、目标与非目标

### 4.1 目标

- 精确区分模型请求、Claude Code 执行记录和 Provider/CLI usage key。
- 支持一次任务出现多个模型，并区分主会话与 subagent。
- 修复所有用户可见表面，不再显示含糊的 `Observed Model`。
- 对历史 job 做无损、诚实的兼容迁移。
- transcript 采集失败时安全降级，不改变任务成功状态。
- 不读取、打印或持久化 Provider URL、API key、token 或完整配置。
- 建立可复现本次 `mimo-v2.5` / `mimo-v2.5-pro` 差异的永久回归测试。

### 4.2 非目标

- 证明 Provider 物理基础设施实际加载的模型权重。
- 调用自定义 Provider 的管理、账单或日志 API。
- 枚举 Provider 可用模型。
- 根据任务复杂度自动选模型。
- 修改 Claude Code 的模型 alias、fallback 或配置。
- 将模型不一致自动判定为任务失败。
- 保存完整 Claude transcript 或将其内容返回给 Codex。

## 五、模型证据语义

### 5.1 证据层级

| 字段 | 含义 | 来源 | 能证明什么 | 不能证明什么 |
|---|---|---|---|---|
| `requestedModel` | 本次请求显式传给 `--model` 的值 | `cc_delegate.model` | 插件请求意图 | Provider 最终执行结果 |
| `requestMode` | `explicit` 或 `inherited` | 是否传入 `model` | 是否使用显式 override | 继承配置最终解析出的模型 |
| `executedModels` | Claude Code transcript 记录的模型集合 | JSONL `message.model` | Claude Code 对本次消息的执行记录 | Provider 物理后台的绝对事实 |
| `usageModelKeys` | 最终 JSON 用量对象的全部 key | `modelUsage` | CLI/Provider 返回的用量聚合维度 | 实际执行模型、优先级或调用顺序 |
| `modelEvidenceStatus` | 证据采集完整度 | collector | transcript 是否可用、是否部分解析 | 模型质量或任务质量 |

严禁新增没有稳定来源的 `configuredModel`、`actualModel`、`resolvedModel` 或继续使用语义含糊的 `observedModel`。

### 5.2 新状态结构

Job schema 升级到 v4。新 job 使用以下结构：

```json
{
  "version": 4,
  "requestedModel": null,
  "requestMode": "inherited",
  "modelEvidence": {
    "status": "complete",
    "executedModels": [
      {
        "id": "mimo-v2.5-pro",
        "source": "claude-transcript",
        "scopes": ["main"]
      }
    ],
    "usageModelKeys": ["mimo-v2.5"],
    "usageSource": "claude-result-modelUsage",
    "warnings": []
  }
}
```

约束：

- `requestMode` 只能为 `explicit` 或 `inherited`。
- `executedModels` 按首次出现顺序去重，最多 16 个。
- 每个 model id UTF-8 长度最多 256 bytes；超出时截断并增加 warning。
- `scopes` 只能包含 `main`、`subagent`；同一模型可同时出现在两个 scope。
- 不保存 transcript 行号、prompt、thinking、tool arguments、message content 或完整原始记录。
- 不把 transcript 快照数称为“调用次数”。JSONL 会对相同 `message.id` 写入多个快照，当前没有稳定依据将其换算为 API request count。
- `usageModelKeys` 保存全部 key，按最终 JSON 的原始顺序去重，最多 16 个；不得只取第一项。
- `status` 只能为：
  - `complete`：主 transcript 成功解析；subagent 目录存在时也完成有界解析。
  - `partial`：获得部分执行证据，但存在损坏行、超限、subagent 读取失败或截断。
  - `unavailable`：未找到或无法安全读取 transcript。
- warnings 只能保存预定义、无敏感内容的错误码，例如 `transcript-not-found`、`invalid-json-lines`、`size-limit`、`path-outside-config-root`、`scan-deadline`。

### 5.3 历史 v3 兼容

历史 `observedModel` 的真实来源是 `Object.keys(modelUsage)[0]`。迁移到 v4 时：

- 保留 `requestedModel`。
- 将非空 `observedModel` 映射到 `modelEvidence.usageModelKeys = [observedModel]`。
- 设置 `modelEvidence.status = "unavailable"`。
- 增加 warning：`legacy-observed-model-reclassified-as-usage-key`。
- `executedModels` 必须为空，不得从历史 usage key 反推。
- 迁移后删除或停止写入 `observedModel`，但 reader 在迁移期仍兼容该字段。
- 迁移使用现有原子 per-job 写入；不得重建或读取历史 transcript 来批量“修正”旧任务。

## 六、架构与数据流

```text
cc_delegate.model
  └─ requestedModel + requestMode

Claude CLI final JSON
  ├─ session_id ────────────────┐
  └─ modelUsage keys            │
       └─ usageModelKeys        │
                                ▼
Claude transcript collector ── executedModels
                                │
                                ▼
                     normalized modelEvidence
                                │
             ┌──────────────────┼──────────────────┐
             ▼                  ▼                  ▼
          job v4          result artifact      MCP display
```

### 6.1 Watchdog 边界

`watchdog.mjs` 只负责解析 Claude 最终 JSON 并返回原始语义明确的摘要：

```js
{
  sessionId,
  usageModelKeys,
  result,
  cost,
  duration,
  exitCode
}
```

要求：

- 删除 `observedModel` 和通用 `model` 输出。
- `modelUsage` 缺失或不是普通 object 时，返回空数组并产生受控 warning，不得失败。
- 只传递经过长度与数量限制的 key；不需要把完整 usage metrics 写入 job metadata。
- 不在 watchdog 中查 transcript。文件系统证据采集属于 companion finalization，避免 watchdog 获得额外的用户目录读取职责。

### 6.2 Transcript collector

新增独立模块，例如 `scripts/lib/model-evidence.mjs`，对外提供纯接口：

```js
collectModelEvidence({
  cwd,
  sessionId,
  usageModelKeys,
  claudeConfigDir,
  deadlineMs
})
```

解析规则：

1. `sessionId` 必须匹配受限 UUID/Claude session id 格式，只能作为精确文件名使用，拒绝 `/`、`\\`、`..`、NUL 和控制字符。
2. 配置根目录优先使用运行 Claude 时相同环境中的 `CLAUDE_CONFIG_DIR`；未设置时使用 `~/.claude`。不得读取 `settings.json`。
3. 只在 `<configRoot>/projects/` 下查找：枚举第一层 project 目录，并检查精确候选 `<project>/<sessionId>.jsonl`。不根据 cwd 猜测 Claude 的路径编码规则。
4. 找到主 transcript 后，仅检查其相邻的 `<project>/<sessionId>/subagents/*.jsonl`。不得全盘搜索任意 JSONL。
5. 对根目录、project 目录、主文件和 subagent 文件执行 `realpath` 边界检查；解析后的真实路径必须仍位于 `<configRoot>/projects`。拒绝逃逸边界的 symlink。
6. 使用异步流式逐行解析，不一次性读入内存。
7. 只接受 `type === "assistant"`、`message.role === "assistant"` 且 `message.model` 为非空字符串的记录。
8. 主文件最大读取 32 MiB；全部 subagent 合计最大 32 MiB；最多 100,000 行、256 个 subagent 文件、16 个唯一模型。
9. collector 总预算默认 1,000 ms。到达预算时返回已有证据和 `partial + scan-deadline`，不得阻塞任务完成。
10. Claude 子进程已经 close 后再采集。若主文件第一次未出现，可在总预算内重试两次，每次最多等待 100 ms；不得引入无界轮询。
11. 单行 JSON 损坏时跳过该行并记录 `invalid-json-lines`；不能因为一个坏行丢弃全部已获得证据。
12. collector 的任何异常只影响 `modelEvidence.status`，不能把成功任务改成 failed。

### 6.3 Companion finalization

`cc-companion.mjs` 在 Claude 成功退出并获得 `sessionId` 后：

1. 调用 collector。
2. 将 `requestedModel`、`requestMode`、`modelEvidence` 写入 result artifact 和 job v4 metadata。
3. 使用一个统一 formatter 生成 delegate/check/list/review 所需的模型摘要，避免五处独立拼字符串再次发生语义漂移。
4. formatter 对所有模型标识清除控制字符、转义 Markdown table pipe/backtick，并执行长度上限。
5. 模型证据 mismatch 只生成说明，不改变 job status。

## 七、用户可见输出

### 7.1 正常继承配置，证据不一致

```text
Model request: inherited from Claude Code configuration
Claude-recorded execution model: mimo-v2.5-pro
Provider usage key: mimo-v2.5
Note: execution labels and usage keys have different semantics and may differ.
```

### 7.2 显式 override

```text
Requested model: custom-provider/model-pro
Claude-recorded execution model: custom-provider/model-pro-v202607
Provider usage keys: model-pro, cache-tier-a
```

显式请求与 transcript 不同时，可以增加中性提示 `Claude Code recorded a different execution label than the requested identifier.`，不得自动声称 fallback、错误路由或 Provider 故障。

### 7.3 Transcript 不可用

```text
Model request: inherited from Claude Code configuration
Claude-recorded execution model: unavailable
Provider usage key: mimo-v2.5
Evidence note: Claude transcript was not available; the usage key is not treated as an execution model.
```

### 7.4 多模型任务

```text
Claude-recorded execution models:
- mimo-v2.5-pro (main, subagent)
- glm-5.1 (subagent)
Provider usage keys: mimo-v2.5, glm-5.1
```

### 7.5 需要统一更新的表面

- `cc_delegate` 完成结果
- `cc_check` 单 job 详情
- `cc_check all=true` 表格
- `cc_list_models` 最近任务摘要
- `cc_review` header
- job result artifact
- job metadata/schema migration
- `cc_setup` 中相关 schema/version 信息
- `README.md`、`PRD.md`、`CLAUDE.md`
- delegate/status/review/setup skills 中的模型术语

`cc_check all=true` 空间有限时，Model 列优先显示 `executedModels` 的主会话模型；若不存在则显示 `inherited` 或显式 requested 值，并加证据状态标记。usage key 不得静默替代 executed model。

## 八、错误处理与安全边界

- transcript collector 是 best-effort observability，不是任务成功前置条件。
- 不允许通过 shell、`find` 命令或字符串拼接执行路径搜索；使用 Node filesystem API。
- 不读取 Provider 配置、环境变量值、认证文件或 transcript message content。
- 日志只记录 warning code、找到的安全相对路径类别、耗时和模型数量；不记录完整 absolute home path 或 transcript 内容。
- model id 是不可信文本，进入 Markdown、JSON 和日志前必须规范化。
- `sessionId` 无效时直接返回 `unavailable + invalid-session-id`，不得尝试路径解析。
- collector 不得跟随逃逸 `<configRoot>/projects` 的 symlink。
- transcript 超限、超时或权限拒绝必须保留已解析结果，状态为 `partial` 或 `unavailable`。
- 不向 MCP 响应暴露 transcript 文件路径。
- 不新增对 Provider API 的网络请求。

## 九、测试策略

### 9.1 单元测试：watchdog/result normalization

- `modelUsage = { "mimo-v2.5": {} }` 输出 `usageModelKeys = ["mimo-v2.5"]`，没有 `model`/`observedModel`。
- 多 key 全部保留，不依赖第一项语义。
- 缺失、`null`、array、恶意超长 key 和控制字符得到受控结果。
- 现有 fake Claude fixtures 改用 usage 术语。

### 9.2 单元测试：transcript collector

所有测试使用临时 `CLAUDE_CONFIG_DIR`，禁止读取真实 `~/.claude`。

- 主 transcript 的 `message.model = mimo-v2.5-pro` 被收集为 main scope。
- 相同 `message.id` 的多个快照不会被描述为多次调用。
- 多模型按首次出现顺序去重。
- subagent 模型进入 subagent scope；与主会话相同的模型合并 scope。
- 不相关 session 文件不会被读入。
- 主文件不存在、权限拒绝、部分坏 JSONL、空文件、超大文件、超多行、超多 subagent、超时分别正确降级。
- session id 包含 `../`、斜线、反斜线、NUL 或控制字符时不发生目录访问。
- symlink 指向配置目录外时拒绝。
- model id 的换行、pipe、backtick、控制字符和超长内容被安全规范化。

### 9.3 Job v3 → v4 迁移测试

- v3 `observedModel: "mimo-v2.5"` 迁移为 usage key，不进入 executed models。
- v3 requested model 原样保留。
- 无 observedModel 的历史 job 仍可读。
- 迁移保持原子写、权限和其他 job 字段。
- 重复迁移幂等。

### 9.4 MCP 集成回归

必须包含能够复现本缺陷的固定 fixture：

```text
request model: omitted
Claude final modelUsage key: mimo-v2.5
Claude transcript message.model: mimo-v2.5-pro
```

断言：

- job `requestMode === inherited`。
- `executedModels === [{ id: "mimo-v2.5-pro", scopes: ["main"] }]`。
- `usageModelKeys === ["mimo-v2.5"]`。
- delegate/check/list/review 均不把 `mimo-v2.5` 标成 Model 或 Observed Model。
- 输出明确解释 execution model 与 usage key 可以不同。
- transcript 缺失时任务仍 completed，UI 不误报 usage key。
- 显式 arbitrary model override 仍按原值传入 CLI。

### 9.5 真实安装 smoke test

在完整 install verification 最后增加只读、低成本真实测试：

1. 在临时 Git workspace 中使用继承配置完成一个最小任务。
2. 不输出 Provider URL、环境变量值或 token。
3. 检查 job 中 `executedModels` 非空或明确 unavailable。
4. 如果本地 transcript 和 usage key 不同，确认二者被分栏展示。
5. 比对对应 Claude session JSONL 的唯一 `message.model` 集合与 job `executedModels`。
6. smoke test 只验证证据一致性，不硬编码 `mimo-v2.5-pro`，以兼容用户随时切换 Provider/model。

## 十、验收标准

- 代码中不存在把 `Object.keys(modelUsage)[0]` 命名为 `observedModel` 或通用 `model` 的路径。
- 新 job 不再写入 `observedModel`。
- 所有 `modelUsage` key 均以 usage 语义展示。
- transcript 可用时，显示 Claude Code 记录的一个或多个执行模型及 scope。
- transcript 不可用时，不推断执行模型，任务仍按真实执行结果完成。
- v3 历史数据不会被错误升级为 executed model。
- `cc_delegate`、`cc_check`、`cc_list_models`、`cc_review` 使用同一个 formatter 和一致术语。
- 不读取 `settings.json`，不访问 Provider API，不记录 transcript 内容。
- 模型证据采集满足尺寸、文件数、路径和 1 秒时间预算。
- 新增回归测试在旧实现上失败，在新实现上通过。
- 完整源码测试、`git diff --check`、plugin validation、source/cache diff、installed-cache tests 全部通过。
- 真实 smoke test 的 UI、job state 和 Claude transcript 三方证据一致。

## 十一、实施顺序

1. 新增 `model-evidence.mjs` 及纯单元测试，先固定证据结构、路径安全和降级行为。
2. 修改 watchdog，将第一 key 的 `model` 改为完整有界 `usageModelKeys`。
3. 在 companion finalization 接入 collector 和统一 formatter。
4. 升级 job schema v4，增加 v3 兼容迁移。
5. 更新所有 MCP 表面、artifact、review header 和 job list。
6. 更新 fake Claude、runner/MCP/state tests，加入本次真实差异 fixture。
7. 更新 README、PRD、CLAUDE 和相关 skills。
8. 运行源码验证。
9. 更新 cachebuster、重新安装插件，运行 installed-cache tests 和真实 smoke test。
10. 打开新 Codex task，确认实际展示不再把 usage key 当成执行模型。

## 十二、回滚策略

- 如果 transcript collector 在真实环境中出现性能或兼容问题，可以关闭 executed-model 采集，但必须继续保留 `usageModelKeys` 的正确命名；不得回退到 `Observed Model`。
- v4 reader 必须继续读取 v3 job，因此回滚应用代码不会要求删除 job 数据。
- 不做历史 transcript 回填，回滚不涉及用户会话文件修改。
- 任何回滚都不得重新引入 Provider 配置解析或第一 usage key 推断。

## 十三、实施 Agent 约束

- 当前工作区包含大量尚未提交的既有修改，必须在现有 diff 上增量工作。
- 禁止 `git reset --hard`、`git checkout --`、清理 untracked 文件或覆盖用户修改。
- 不 commit、不 push、不 publish，除非用户另行明确授权。
- 不修改真实 Claude settings、Provider、token 或历史 transcript。
- 不把真实 transcript fixture 复制进仓库；测试必须生成脱敏临时 JSONL。
- 完成后必须报告真实验证结果和未覆盖项，不能把 skip/warning 写成 pass。
