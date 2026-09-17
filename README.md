# pi-dynamic-skill

[English](README.md) | [简体中文](README.zh-CN.md)

Dynamic skill loading and replacement for [Pi](https://github.com/earendil-works/pi).

`pi-dynamic-skill` is a Pi extension being developed to let agents load skills and replace their active representations during a running session. Skills use `SKILL.md` files: names, descriptions, and paths make knowledge discoverable, while full content is available on demand.

## Design

- **Dynamic loading:** make skills available during a session without restarting Pi.
- **Dynamic replacement:** update which skill content is active in context while retaining saved files for later access.
- **File-backed skills:** store full content in `SKILL.md` files and use ordinary file reading to retrieve it.
- **Independent loading:** skill discovery and loading do not depend on the application that produced the files.

Agents can author and update skill files with ordinary file tools. Applications can also use the package API. The current API accepts a directory from the caller; naming conventions, content generation, and storage scope belong to the caller. Directory configuration and automatic loading policy remain to be designed.

## Status

The package API creates file-backed skills and reloads directory metadata using Pi’s native skill parser. Importing the package does not register tools or change context. Automatic context injection and replacement are not implemented yet; the standalone extension entry remains a scaffold.

## Package API

```ts
import { createSkill, reloadSkills } from "pi-dynamic-skill";

const skill = await createSkill(skillsDirectory, {
  name: "review-typescript",
  description: "Use when reviewing TypeScript changes.",
  content: "Check public types, error handling, and relevant tests.",
});
const { skills, diagnostics } = reloadSkills(skillsDirectory);
```

The caller supplies the directory and decides when to reload and inject the returned metadata. `createSkill` refuses duplicate names with `SkillExistsError`; existing files can be updated with ordinary file tools and rediscovered on the next reload. Reading the returned `filePath` retrieves the full content. No additional model tool or extension event bus is required.

Git dependency installation builds the JavaScript and TypeScript declarations through `prepare`.

## Development

```sh
npm ci
npm run typecheck
npm test
```

Load the local scaffold in Pi:

```sh
pi -e ./src/index.ts
```

The development dependency pins Pi SDK 0.85.1.
