# pi-dynamic-skill

为 Pi 提供 KV-Cache 友好的 skill 动态装载。

[English](README.md) · **简体中文**

## 原理

- **追加装载**：只向上下文追加缺失的 skill 描述，不改写已有上下文，利于复用 KV Cache。
- **树状组织**：以多层技能树组织和维护 skill。
- **自动发现**：读取 skill 时自动发现其直接子 skill，逐层按需展开。
- **LRU 留存**：维护最近使用的 skill，不常使用的逐出队列，不删除文件。

使用 `/dynamic-skill` 浏览和选择技能。可独立使用，也可配合 [pi-backtrack](https://github.com/wjfjfm/pi-backtrack)，在收起上下文前保存有用知识。

## 安装

```sh
pi install git:github.com/wjfjfm/pi-dynamic-skill
```

知识保存在 `~/.pi/dynamic-skill/`，与扩展分离。

批次后即时注入需要配套 Pi 宿主修复，见[运行要求](docs/refactor-audit.md#必需的原生宿主修复)。
