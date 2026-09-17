# pi-dynamic-skill

[English](README.md) | [简体中文](README.zh-CN.md)

Dynamic skill loading and replacement for [Pi](https://github.com/earendil-works/pi).

`pi-dynamic-skill` is a Pi extension being developed to let agents load skills and replace their active representations during a running session. Skills use `SKILL.md` files: names, descriptions, and paths make knowledge discoverable, while full content is available on demand.

## Design

- **Dynamic loading:** make skills available during a session without restarting Pi.
- **Dynamic replacement:** update which skill content is active in context while retaining saved files for later access.
- **File-backed knowledge:** store full content in `SKILL.md` files and use ordinary file reading to retrieve it.
- **Session scope:** keep session knowledge separate from globally available skills.

Knowledge generation belongs to the caller. For example, [pi-backtrack](https://github.com/wjfjfm/pi-backtrack) can produce knowledge when folding an execution trace and use `pi-dynamic-skill` to manage its availability. Backtracking and summarization remain the caller's responsibility.

## Status

Initial extension scaffold only. Runtime loading, replacement, persistence, and the integration API are not implemented yet. Loading the extension currently registers no tools and changes no context.

## Development

```sh
npm ci
npm run typecheck
```

Load the local scaffold in Pi:

```sh
pi -e ./src/index.ts
```

The development dependency pins Pi SDK 0.85.1.
