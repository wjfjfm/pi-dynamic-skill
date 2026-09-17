# pi-dynamic-skill

[English](README.md) | [简体中文](README.zh-CN.md)

为 [Pi](https://github.com/earendil-works/pi) 提供 skill 的动态装载与动态替换。

`pi-dynamic-skill` 是一个开发中的 Pi 扩展，让 Agent 在会话运行期间装载 skill，并替换其在活动上下文中的呈现。Skill 使用 `SKILL.md` 文件：名称、描述和路径用于发现知识，完整内容按需读取。

## 设计

- **动态装载：** 无需重启 Pi，即可在会话中提供新的 skill。
- **动态替换：** 更新上下文中当前展开的 skill 内容，同时保留已保存的文件供后续访问。
- **文件存储：** 完整知识保存在 `SKILL.md` 文件中，通过普通文件读取获取。
- **会话范围：** 会话知识与全局可用的 skill 分开管理。

知识生成由调用方负责。例如，[pi-backtrack](https://github.com/wjfjfm/pi-backtrack) 可以在折叠执行过程时生成知识，再使用 `pi-dynamic-skill` 管理其可用状态。回退和总结仍由调用方负责。

## 当前状态

目前仅包含扩展框架。动态装载、动态替换、持久化和集成 API 尚未实现。加载扩展目前不会注册工具或改变上下文。

## 开发

```sh
npm ci
npm run typecheck
```

在 Pi 中加载本地框架：

```sh
pi -e ./src/index.ts
```

开发依赖固定为 Pi SDK 0.85.1。
