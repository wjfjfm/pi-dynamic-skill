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

包接口已支持创建 skill 文件，并使用 Pi 原生解析器重新加载目录元数据。导入包不会注册工具或改变上下文。自动上下文注入与替换尚未实现，独立扩展入口仍为框架。

## 包接口

```ts
import { createSkill, reloadSkills } from "pi-dynamic-skill";

const skill = await createSkill(sessionSkillsDirectory, {
  name: "backtrack-20260917-153042-123",
  description: "排查重试行为时查阅。",
  content: "已排除数据库问题，重试行为仍待验证。",
});
const { skills, diagnostics } = reloadSkills(sessionSkillsDirectory);
```

调用方提供存储目录，并决定何时重新加载和注入返回的元数据。`createSkill` 遇到同名 skill 时抛出 `SkillExistsError`；已有文件可以通过普通文件工具更新，下次 reload 会重新读取。通过返回的 `filePath` 读取完整内容。无需增加模型 Tool，也无需扩展间事件总线。

作为 Git 依赖安装时，`prepare` 会构建 JavaScript 和 TypeScript 类型声明。

## 开发

```sh
npm ci
npm run typecheck
npm test
```

在 Pi 中加载本地框架：

```sh
pi -e ./src/index.ts
```

开发依赖固定为 Pi SDK 0.85.1。
