# Change Proposal: sampling-config-unify

## 元信息

- **日期**: 2026-08-10
- **类型**: MODIFY（新行为：采样参数统一配置）
- **状态**: pending
- **影响 spec**: alysia-architecture（§3 Provider 抽象，新增 sampling 配置节）

## 动机（为什么做）

temperature / top_p / presence_penalty / frequency_penalty / max_tokens 散落各处：
vision/bridge.ts 硬编码（0.1/200）、index.ts llmService 闭包 fetch 直调无参数、
主 chat 走 DeepSeek 服务端默认、life/proactive 各回调无参数。调一处不知还剩几处；
不同场景需不同值且无配置入口。

## 需求（做什么）

1. 一处入口、按场景分槽：`sampling` 配置节，7 槽位
   （chat / vision.describe / life.generateEvent / life.generateSummary /
   proactive.personalize / profile.extract / session.summary）
2. 硬编码默认作 floor（无 config 也能起），config 覆盖不报错
3. 全部现有硬编码/缺失采样参数迁移到读配置，不留原地
4. config.yml 统一放 sampling 节（用户已拍板，与 persona/memory_config 语义聚成"她的嗓子"）
5. ProviderRequest 增加 sampling 字段，openai.ts 透传进 body

## 设计决策

- **落点**: `packages/core/src/provider/sampling.ts`（SamplingConfig 类型 + DEFAULT_SAMPLING）
  + `AlysiaCoreOptions.sampling`（与 DEFAULT 深合并）+ config.yml `sampling:` 节
- **主 chat 槽**: config.yml sampling.chat（用户拍板，不进 DB memory_config）
- **透传**: `ProviderRequest.sampling?: Partial<SamplingSlot>` → openai.ts body
- **主 chat**: runner.run 增 sampling 参数，llm-agent 从 ctx.sampling.chat 传
- **vision**: VisionBridge 构造注入 sampling.vision.describe（bootstrap 读 config）
- **life/proactive**: bootstrap 回调各传自己的槽
- **记忆系统**: llmService.complete 增可选 sampling 参数；MemoryManager 构造时
  给 ProfileExtractor/SessionEndProcessor/PersonaAdapter/CronProcessor 分别包
  绑定槽位的闭包（slotify）
- **死代码**: memory/services/OpenAILLMService.ts（无调用方）确认后删除，
  避免"统一了还有漏网"

## 对账方向确认

- [x] 新增配置行为，不冲突现有 spec（alysia-architecture §3 无采样参数契约）

## 测试计划

- grep 全仓 temperature/top_p/presence_penalty/frequency_penalty：
  除 sampling.ts 定义处外无散落硬编码
- 改 sampling.life.generateEvent.temperature → 仅 life 事件生成行为变
- 无 sampling 配置时项目正常启动（走默认 floor）
- 单元测试：DEFAULT_SAMPLING 与 config 深合并、openai.ts body 组装含采样参数
