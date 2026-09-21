# pi-dynamic-skill

KV-cache-friendly dynamic skill loading for Pi.

**English** · [简体中文](README.zh-CN.md)

## How it works

- **Append-only loading**: append only missing skill descriptions without rewriting existing context, preserving KV cache reuse.
- **Tree organization**: organize and maintain skills in a multi-level tree.
- **Automatic discovery**: reading a skill reveals its direct children, expanding the tree on demand.
- **LRU retention**: keep recently used skills available; evict infrequently used skills from the queue, not from disk.

Use `/dynamic-skill` to browse and select skills. Works independently, or alongside [pi-backtrack](https://github.com/wjfjfm/pi-backtrack) to preserve useful knowledge before folding context.

## Install

```sh
pi install git:github.com/wjfjfm/pi-dynamic-skill
```

Knowledge is stored in `~/.pi/dynamic-skill/`, separate from the extension.

Immediate post-batch delivery requires the companion Pi host fix; see [runtime requirements](docs/refactor-audit.md#必需的原生宿主修复).
