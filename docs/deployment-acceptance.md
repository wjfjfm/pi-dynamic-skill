# 部署与验收记录

## 部署

- 新运行时：`~/.local/share/pi-native-backtrack/ee8e49f-dynamic-20260922-032206/runtime`
- `~/.npm-global/bin/pi` 已原子切换至新运行时，CLI 版本仍为 `0.85.1`（本地补丁版本由目录和 manifest 标识）。
- 宿主源码构建通过；新 coding-agent tarball 覆盖在旧运行时的独立副本中，未原地修改旧安装。
- dynamic-skill/backtrack 已由用户配置引用本地源码目录，无须另加 package 或修改 settings。
- 新目录保存 `deployment.json`、`SHA256SUMS`、`host.patch`、`dynamic-skill.patch` 及验收脚本/日志。旧运行时完整保留。

## 已完成的实际制品验证

不是仅重跑源码测试：

1. 新安装的原生 SessionManager、AgentSession backtrack API 与 Agent batch hook 验证通过。
2. 使用新运行时的打包 SDK、实际扩展和真实 read 工具，在隔离目录执行：
   `read 根 → discovery → read 子技能 → active → backtrack 0 → reload → compact`。
   下一请求描述始终只出现一份；队列不重复消费、技能文件不改写。模型流为本地模拟，共六次任务请求，摘要也在本地模拟，未访问模型服务。
3. 新 CLI 在真实 PTY 中完成 Queues/All 切换、搜索、勾选应用、取消草稿、取消留存。检查中文描述显示、队列结果及原文件不变；未发模型请求。
4. 切换入口后再次运行原生及 SDK 验收，通过；`pi list` 确认两个本地 package 路径。

脚本与日志位于发布目录：`runtime/verify-dynamic.mjs`、`verify-tui.py`、`acceptance-sdk.log`、`acceptance-tui.log`、`acceptance-tui.raw.log`。

## 生效与回滚

**宿主修复需要退出并重新启动 Pi。当前已运行的对话不会热替换宿主；单独 `/reload` 不足以更新宿主。**

回滚入口：

```bash
~/.local/share/pi-native-backtrack/ee8e49f-dynamic-20260922-032206/rollback.sh
```

此脚本只回滚宿主启动链接。扩展仍引用工作区源码；如需回滚扩展，须另行恢复对应源码，不能把宿主入口回滚视为整套重构回滚。

部署阶段未改真实技能树或历史 session；后续按用户授权完成以下迁移。未 push。

## 真实技能树迁移

- 完整备份：`~/.pi/agent/backups/dynamic-skill-refactor-20260922-035554/`。
- 8 个文件全部备份并逐一校验 SHA-256；迁移前后哈希和 `migration.patch` 留在备份目录。
- 仅修改 2 个文件：根 `SKILL.md` 更新为当前模板并移除旧索引；`pi-memory/SKILL.md` 仅移除完整、可确认的旧生成索引块，其余正文逐字保留。
- 另外 6 个文件未变；没有删除技能、改路径或重写历史知识。所有生成索引标记已清除，无畸形区块。
- 验证：真实技能树 7 个节点、根下 3 个直接子技能，校验无诊断；根内容与新模板一致。读取时的子技能自动发现也已在当前真实会话观察到。
- 回滚迁移时可从备份的 `dynamic-skill/` 恢复；应先核对迁移后是否已有新知识，不能无条件覆盖后续修改。
