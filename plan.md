# pi-dynamic-skill 重构计划

状态：代码重构已实施；验证、上下文注入变化与宿主依赖见 [重构审计](docs/refactor-audit.md)。已完成配套本地部署及真实 CLI PTY 自动验收，见 [部署验收](docs/deployment-acceptance.md)。真实技能树已备份并迁移旧索引、更新根说明；终端验收采用真实 PTY 自动化，非人工目视。

调研基线：dynamic-skill `06d0d64`、backtrack `c335ad9`。dynamic-skill typecheck 与 57 项默认测试通过，backtrack 原生集成 121 项通过；这些不代表新功能已经通过验证。

## 1. 第一原则

> **有效上下文里已有某个 skill 的 description，就不再写一遍。**

以规范绝对路径识别技能，以正在运行的宿主提供的有效上下文判断描述是否存在。active、pending、discovery 共用这一判断，不各建一套装载账本。

- 队列变化不是重新注入描述的理由。
- 取消选择不能抹去已经注入的描述，也不发送取消消息。
- 描述被 backtrack/compact 移除后，才按当前留存资格决定是否补回。
- 不改历史描述、read 结果或系统提示前缀；摘要提到技能不算装载事实。

只区分三件事：

| 问题 | 依据 |
| --- | --- |
| 描述是否已经可见？ | 宿主有效原生消息中的技能路径 |
| 技能是否应继续留存？ | 队列状态与人工选择 |
| 这次访问是否已经处理？ | 最终工具结果与消费边界 |

## 2. 队列是留存策略，不是三套消息系统

同一路径最多属于一个队列：

| 队列 | 资格与行为 |
| --- | --- |
| active | 已实际访问或人工选入，参与 LRU；描述缺失时可补回 |
| pending | LRU 溢出候选；遵守预告与逐出规则，实际重访可救回 |
| discovery | 仅由父技能 read 发现；不占容量、不影响 LRU；描述被收起后不自动补回 |

典型过程：

```text
read A → A 进入 LRU；发现直接子技能 B，补充 B 的描述
read B → B 从 discovery 转入 LRU；描述仍在，不重复输出
取消 B → 改变留存意图；现有描述原样保留
重选 B → 恢复留存资格；描述仍在，仍不重复输出
```

发现 active/pending 技能不算访问，不晋升、不救回 pending；若其描述缺失，可共用同一链路补齐。

discovery 按首次接纳顺序排列，无独立容量或 LRU。退出 active/pending 后，不凭旧发现消息自动退回 discovery；新的父 read 才能再次触发发现。

根 `dynamic-skill/SKILL.md` 是 Pi 原生注册的固定入口，不进入任何队列、不占 LRU。read 根仍发现直接子技能；所有后代，包括第一层子技能，都按普通规则处理。

## 3. 访问与发现

### 完整工具批次后统一处理

成功 read/write/edit 都在**完整批次结束后即时结算**，不等 compact/reload/backtrack。

- read 成功即算访问，分页、只读一行、正常截断均可。
- write/edit 同样算访问，但不触发子技能发现。
- 以最终成功结果和 call/result 配对为准，不在暂定的 tool_result hook 中提交队列。
- 同批同路径只晋升一次，按最终历史中的最后成功访问排序；跨批分别晋升。
- 保留现有二分递进 LRU 算法、合法性校验及描述保护：溢出项的描述仍保留时，允许 active 超容量。
- 失败操作、树外文件、辅助文件不入队；根豁免。

### 只有 read 发现直接子技能

read hook 在结果 details 中合并直接子技能的描述快照，不改变正文和工具原有字段。完整批次后只消费最终成功且仍有效的发现来源，合并一次描述增量。

不递归展开、不读取子正文、不新增 tool、不覆盖 read、不调用额外模型。手选父技能只选父技能，不发现下一层。

后续扩展将结果改错或覆盖发现元数据时，保守跳过；不凭当前磁盘重建旧快照。read/write 同批的目录快照不保证反映写后状态。

## 4. 统一描述增量

所有入口共用：

```text
连续的当前队列 + 本次事件 + 实际有效上下文 → 更新当前状态
更新后本次需要提供的技能描述 − 有效上下文已有的技能描述 = 本次追加
```

使用 Pi 原生技能 XML，尊重 `disable-model-invocation`。描述由 discovery 提供过，后来进入 active/pending 时也能去重。

分组标题只解释新增描述的来源，不要求每次队列变化都发消息；`New active skills` 不是第四个队列。没有新增描述或必要预告时不发空更新。

逐出预告是状态提示，不是另一份描述。必要时只提示名称/路径，不重复 description；发现消息不算逐出预告。

取消仅保存人工留存意图，现有描述不变。不为取消设计额外消息、上下文删除或独立生效时机。

## 5. pending 周期保持独立

即时处理访问，不等于每批都执行逐出。

- 普通批次更新访问、容量和队列，不使已预告 pending 自动过期。
- pending 仍在成功 compact/reload/backtrack 时，按实际展示预告及此后是否重访处理。
- 新溢出项有自己的预告机会；失败/取消的上下文变化不推进逐出周期。
- 实际访问可救回，发现或描述去重不算重访。
- 逐出只影响留存资格，不删除文件或历史描述。

预告现在绑定 pending 代次，实际展示事实保存在队列快照中；旧 ACCESS_STATE entry ID 预告仅读取迁移。访问消费与预告到期是两个边界，普通批次不会丢掉预告事实。

## 6. 原生宿主边界与最小状态

宿主负责有效上下文、完整批次、原子 backtrack 提交和下一轮刷新。dynamic-skill 通过公共生命周期处理自身状态，使用原生 custom message 追加描述。

- 使用运行宿主的 `buildSessionContext()`，不借扩展所带旧 SDK reducer 解释原生 backtrack。
- context hook 只观察实际展示，不补消息、不修复上下文数组。
- 不恢复 overlay/project、context owner、私有事件或扩展间服务发现。
- 不让 backtrack 调用或理解技能队列逻辑，不依赖加载顺序。
- 预期顺序：全部工具结果 → 技能增量 → checkpoint（若启用），以真实宿主测试证明。

### 遵循 Pi 原生持久化范式

- 先复用已有 session entry、工具结果 details 与原生 custom message；不为每个概念新增一种 entry。
- 描述使用原生 custom message；内部状态使用不进入模型上下文的 custom entry。不可将队列快照作为提示消息注入。
- 队列是当前会话的状态，不是历史分支的投影；不因 /tree 或 /fork 回放、回滚或切换队列。
- 能从原生记录可靠恢复的事实不重复保存；但不能用目标历史分支重放来替代当前会话状态。
- 队列、消费边界和预告状态可以有不同语义，不意味着必须各建一套记录系统。具体字段先核对 Pi API 和现有实现，再由恢复测试证明必要性。
- 仅在实际变化时落盘，不为无变化的 hook 写快照；不复制历史、建立第二份上下文 view、自定义日志、外部队列文件或私有事件框架。

描述已装载与否由有效原生消息判断，不再建 available registry。

发现来源也必须只消费一次，包括零候选或描述全已可见的 read。队列优先引用来源快照，避免复制描述；消费记录不得成为无限增长的全局 ID 集合。

约束：

- discovery 更新不能顺便推进未处理访问的边界。
- 先计算完整状态变化，失败时不能先删一半队列；无变化不重复写状态。
- session_backtrack 与 turn_end 共用消费判断，不能对同批重复晋升或重复排队消息。
- raw 分支可证明已发生访问，但不能用来重放已折叠发现。
- 扩展持久化不属于宿主 backtrack 原子事务；发送/保存中断后的恢复需要测试。

## 7. 上下文变化的一致处理

核心是通用的状态协调，而不是为每个事件实现一套恢复机制：延续当前队列，读取真实有效上下文，维护留存资格，再追加必要差分。backtrack 使用这条共同路径，不设专属队列恢复协议。

讨论 tree/fork 是为 backtrack 提供一致性参照、检验实现是否通用，不是增加重点功能或独立实现阶段。生命周期 hook 只是触发入口；只有确实不同的业务规则（如 pending 到期周期）才需要显式区分，不能复制状态维护与描述注入逻辑。

| 场景 | 行为 |
| --- | --- |
| reload/resume | 恢复留存资格与有效描述；不把旧 read 当新发现，不重复晋升 |
| backtrack/compact | 按有效描述保留 discovery；被收起的 discovery 不自动重建；按 LRU 资格补缺失描述 |
| backtrack 0 | 同样遵循有效上下文与留存资格，不特殊清空仍保留的描述 |
| tree/fork | 延续当前队列，不恢复目标历史的旧队列；依据实际有效上下文维护当前状态，再统一计算描述及预告差分 |
| 重复通知 | 幂等，不重复消费或注入 |
| 中断恢复 | 真正未处理的成功访问可补结算一次，不能重新晋升所有历史访问 |

必须防止三个已知反例：

1. 用“旧发现块减 active/pending”推导 discovery，会复活人工移除的技能。
2. 为保存 discovery 写 ACCESS_STATE，会吞掉边界之前未结算的访问。
3. 发现消息被压缩、旧 read 仍在尾部时，重新扫描旧 read 会错误复活发现。

## 8. 技能树与 UI

### 只读技能树

从 `tree.ts` 拆出共享节点校验与直接子节点枚举；All 视图递归组合，read 只枚举一层。

删除运行时生成目录、父文件回写、临时 rename、冲突重试和生成标记完整性约束。旧生成块暂时视为普通正文。

保留路径、slug/name、frontmatter、祖先、文件类型及树内 symlink 校验。明确隐藏目录、错误位置、重叠根的归属与诊断；坏子节点局部跳过。原生目录加载器会递归，不能直接用它冒充一层扫描。

不自动追踪 rename；新路径是新身份。旧描述不随磁盘修改重写，缺失后重新加载才使用新描述。

### Queues / All

保留两个 Tab，Queues 展示 active/pending/discovery。

- active 默认勾选，pending/discovery 默认未选；明确勾选表示人工加入 active。
- 根不可选；Esc 或未修改直接 Enter 不写状态。
- 浏览只读，不触发发现、结算或文件修改。
- TUI/non-TUI 都展示三队列，保留搜索、滚动、窄屏及中文输入支持。

## 9. 实施与验收

按以下顺序，每步单独验证：

1. 真实宿主小测试：批次后注入、两种加载顺序、同批 backtrack 时序。
2. read/write/edit 即时访问结算，拆开访问消费与 pending 周期。
3. 纯化技能树，接入 read 发现及统一描述差分。
4. discovery 恢复与三队列 UI，删除旧回写代码，更新模板。
5. 全量测试、真实 TUI 验收，再按授权处理本地旧索引。

重点测试：

- 同批去重、跨批晋升、最终失败不算、根豁免、超容量保护。
- discovery → active、取消/重选、active → pending 均不重复已有描述。
- pending 预告跨普通批次保留，不提前逐出、不重复描述。
- 顺序/并行工具、同批父子 read、write/edit 不发现、后置 hook 改错。
- 默认回退/保留尾部、compact 成功/失败、reload/resume、重复通知与中断。
- tree/fork 延续队列而不回滚或重放历史访问；依据真实可见上下文维护状态，统一产生 new active/discovery/pending 差分，不重复已有描述。
- 旧 read 仍在但描述被收起不重放；队列移除不复活 discovery。
- read/菜单/reload/compact/backtrack 不修改已有技能文件。
- 原生 XML、details 不进入模型正文、实际下一轮请求顺序正确。
- 多根/同名/重叠根、隐藏目录、坏祖先、symlink、路径规范化。

规模边界：不按 active capacity 静默截断 discovery；大量直接子节点需压测，若要限制另行明确产品语义。远程 read 不假定等价于本地文件；`/skill:` 原生展开不经过 read hook，不解析用户文本伪造访问。

## 10. 范围与验证入口

保留 createSkill/reloadSkills 公共 API、独立技能目录、根注册及缺失模板初始化。README 人工维护；依赖升级、通用迁移框架不在本次范围。

旧状态 discovery 默认空，不从旧 read 生成发现快照。旧访问边界接续必须测试，不吞访问、不重复晋升。

开发完成后，按用户授权备份本地技能树、一次性清理明确旧索引、更新根说明；保留自定义正文，畸形区块人工审阅，确认改动范围可恢复，再 reload/新会话验收。历史 session 不改写；安装、提交、push 分别授权。

```bash
# pi-dynamic-skill
npm run typecheck
npm test

# pi-backtrack
PI_DYNAMIC_SKILL_EXTENSION=../pi-dynamic-skill/src/index.ts npm test
```

原生组合测试使用独立 `npm run test:native` 入口（需要配套宿主源码），默认 npm test 保持独立可运行。所有测试使用隔离目录，不操作真实 ~/.pi 技能树。

调研依据：本仓库 src/ 与 test/；pi-backtrack 的 docs/design.md、docs/native-context-injection-audit.md 及原生集成测试；配套宿主 native-backtrack.md、agent-session.ts。原生生命周期保证以运行宿主为准，不以已发布 SDK 0.85.1 推断。
