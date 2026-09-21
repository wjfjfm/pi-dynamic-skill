# Dynamic-skill 重构审计

## 实现边界

统一路径：连续队列 + 宿主有效上下文 → 状态协调 → 缺失描述差分。

- read/write/edit 按完整工具批次的最终成功结果即时结算，同批去重、跨批晋升。
- 只有 read 在原生结果 details 保存直接子描述快照。根不入队；实际访问/手选进入 LRU，发现不算访问。
- active/pending/discovery 互斥，共用路径级描述去重。取消不删除历史、不发取消消息。
- pending 的已展示预告和代次独立于访问消费边界；普通批次不逐出。
- 删除文件索引生成、回写、原子 rename、冲突重试及旧延迟结算引擎。现有技能文件一律不改。
- Queues / All 共用只读校验。隐藏目录忽略；仅 `skills/<slug>/SKILL.md` 是子节点，其他位置是普通资源；候选坏节点局部诊断。重叠根按路径去重，所有注册根不可选择。

## 模型输入变化（待用户核对）

| 变化 | 范围 |
| --- | --- |
| **新增 `### Discovered skills`** | 成功 read 父技能后，仅补直接子技能中尚未可见的 description，使用 Pi 原生 XML；无额外指导语 |
| 原有 active 描述提前 | 从 compact/reload/backtrack 结算改为完整工具批次结束后；已有描述不重复 |
| pending 预告沿用 | 已有 description 时只提示名称/路径，不再复制描述；发现不冒充预告 |
| 根模板更新 | 移除旧索引维护指令，说明动态发现、批次结算；只影响新建模板，未改现有根 |

未增加模型轮次、工具、系统提示前缀修改、context-hook 注入或历史消息改写。read 正文与原有 renderer details 保留；新增快照只在 details，不进入工具正文。write/edit 不再触发索引维护及相关工具正文警告。保留原有 ON 标记及空 active 标题行为。

## 最小持久化

沿用两种内部 entry：`dynamic-skill:access-state` 和 `dynamic-skill:manual-selection`，以及已有原生描述 custom message。不另建日志或外部队列文件。

access-state 保存连续队列、单一消费 cursor、pending 代次/已展示状态及最近周期。discovery 仅保存路径、来源 entry；接纳时描述已可见才加布尔标记，防止旧描述被收起后误补。描述本身引用工具结果快照。无实际变化不落盘，旧 eviction-notice 只读迁移、不再新增。

恢复按会话全部记录的最新队列，不按目标历史分支恢复。正常磁盘会话 fork 从 `previousSessionFile` 继承当前队列，待资源注册后按真实上下文补差分。**无源会话文件、且宿主销毁扩展实例的纯内存旧点 fork，无法取得未复制的最新状态**；不为此引入全局状态服务。常规 tree、磁盘 fork、reload/resume 均走统一协调。

发送中断时，尚未交付的 discovery 可重试；已交付后被收起则删除，不重放旧 read。没有把扩展保存/发送宣称为宿主原子事务。

## 必需的原生宿主修复

修改 `../pi-native-backtrack/packages/coding-agent/src/core/agent-session.ts`：原生 `sendMessage({ triggerTurn: false })` 原先在 turn_end 已保存消息，却未传给运行中循环的下一请求。现在只向下一轮传递本次追加的 custom-message 差分；发生 backtrack 时沿用原生完整刷新。新循环清空临时差分，不复活 retry 丢弃的历史，不强行续跑 terminate 批次。

这不是 dynamic-skill 私有协议，无技能类型判断、加载顺序要求或新 API。**普通批次即时交付依赖部署该宿主修复**。配套本地部署已完成，见 [部署验收](deployment-acceptance.md)；未对外发布宿主。

`../pi-backtrack/test/native-runtime.integration.mjs` 同步两类旧断言：无队列变化的 compact/backtrack 不应为了证明“结算过”而强制写快照。

## 验证入口

```bash
npm run typecheck
npm test
npm run test:native  # 默认使用 ../pi-native-backtrack；可设置 PI_NATIVE_SOURCE
cd ../pi-backtrack
PI_DYNAMIC_SKILL_EXTENSION=/absolute/path/pi-dynamic-skill/src/index.ts npm test
```

验收结果：本模块 typecheck 通过，默认测试 69/69、原生集成 16/16；backtrack 默认测试 22/22、原生组合 121/121；宿主 `agent-session-backtrack.test.ts` 与 `agent-session-retry.test.ts` 22/22。三仓库 `git diff --check` 通过。宿主 Biome 未能运行：当前系统 glibc 低于其二进制要求，不能将其视为检查通过。全部测试使用隔离目录，不修改真实技能树。

自动化覆盖完整批次、后置结果覆盖、顺序/并行、同批 backtrack、下一请求正文顺序、terminate 不额外续跑、描述去重、发送/保存中断、旧来源不复活、只读树、磁盘旧点 fork、三队列键盘选择/窄屏。后续已完成新安装制品和真实 CLI PTY 自动验收，见 [部署验收](deployment-acceptance.md)；非人工目视验收。用户授权后已备份并迁移真实技能树的两处旧索引，根说明同步新模板；详见部署验收记录。未 push。
