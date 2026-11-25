# 统一训练任务编排

`training-orchestrator.js` 是一个无副作用的 CommonJS 决策层。它只返回工作流决策，不读取文件、不调用工具，也不创建交付物。

## 优先级

1. 红旗或即时安全信号：固定路由到 `safety_routing`；它覆盖显式报告、图片分享和训练计划。
2. 显式 `taskType` / `task_type`：安全检查通过后使用支持的任务类型。训记连接和写回还需核对用户原话，否定、转述和功能询问不产生工具请求。后续独立表达的明确意图按最后决定处理。
3. 用户指令中的训练、数据或分享意图：识别计划、今日训练、复盘、训练系统、训记分析和分享输出。
4. 其余输入：`knowledge_question`。

## 决策契约

`buildWorkflowDecision(input)` 始终返回：

```js
{
  task_type,
  safety, // clear | clarify | stop
  connection, // connector | configure | manual_import, for xunji_connect
  data_source, // status and next read or analysis action, for xunji_analysis
  writeback, // preview prerequisite, for xunji_writeback
  interaction_mode,
  required_fields,
  missing_fields,
  information_state, // ready | ask | assume
  artifact_mode,
  artifacts,
  index, // multi-asset delivery index, otherwise null
  paths, // non-overwriting candidate paths; index path is first when present
  reason_codes
}
```

`interaction_mode`、`artifacts`、`index` 与 `paths` 直接来自 `planOutputAssets`，它以最终 `task_type` 和原始用户指令规划交付物。对话、Markdown 和 dashboard 的显式命令仍然有效；只有安全路由不可被覆盖。`artifact_mode` 也只按最终计划推导：空资产为 `none`，dashboard 为 `dashboard`，含索引或多个资产为 `multi_asset_bundle`，单个 Markdown 为 `single_markdown`，单图片为 `single_image`。

## 信息状态

| 任务 | 必要信息 | 缺失时行为 |
| --- | --- | --- |
| `knowledge_question`、`safety_routing` | 无 | `ready`；安全任务先给出即时分流 |
| `training_plan`、`training_system` | 目标、经验、每周天数、器械、伤病/医疗约束 | `ask`，仅列会改变安全或方案结构的字段 |
| `training_review` | `records` | `ask` |
| `xunji_analysis` | 已核对记录或已就绪连接器和明确日期范围 | 连接可读时返回 `read_pending`，缺日期时只问范围，需导入时才问记录 |
| `today_workout` | 无强制结构字段 | 缺少执行上下文时 `assume`，并记录安全执行假设 |
| `share_output` | `source_assets` | `ask` |

训练计划和系统会从已给出的 `profile`、`currentState` 和 `records` 合并检查，已提供的信息不会重复提问。简单知识问题不产生画像缺口或文件资产。

## 连接与恢复

`xunji_connect` 先返回能力判断。连接就绪时只验证一个用户指定的日期，缺日期先问。`xunji_writeback` 返回准备预览所欠的记录或预览后确认的下一步，决策中的 `confirmed` 始终为 `false`。写回交由连接器核对预览和用户授权。`resume_training` 需要接续摘要。

`xunji_analysis` 以 `data_source` 为准。已核对的导入优先，明确采用导出且不连接时保持手动导入。就绪连接器可按 `start_date` 和 `end_date` 读取，或解析明确的绝对日期、最近 N 天/周。相对范围含端点，截止日使用 `reference_date` 或 `Asia/Shanghai` 的当天。宿主读完把结果作为 `connector_result` 传回，分别处理 `read_complete`、`empty`、`partial`、`read_failed`。只在实际读取成功的日期范围内解释零记录，部分失败注明受影响日期。凭据失效且存在安全入口时走 `configure_credentials`。
