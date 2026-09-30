# Public-extension runtime

Targets unmodified Pi 0.85.1 and Node ≥22.19.0. No companion host fix is required. Local artifacts were deployed on 2026-09-30 under `~/.local/share/pi-public-extension/20260930-093527/`; its deployment record and rollback script are preserved there. The public-API implementation is now maintained on `main`; the temporary `refactor/public-extension` worktree has been consolidated into the primary checkout.

An extension-only artifact refresh was deployed later the same day at `~/.local/share/pi-public-extension/20260930-165207-checkpoints/`, alongside backtrack's v3 checkpoint storage. Dynamic-skill runtime semantics and the public host are unchanged; see that release's `DEPLOYMENT.md` for current paths and rollback.

Dynamic-skill works alone. When used with backtrack, load **backtrack before dynamic-skill**, so descriptions are reconciled against the retained request rather than raw history. Do not load two copies of either extension.

This is a pipeline constraint, not an automatic ordering mechanism. Reversing the hooks lets skill reconciliation see raw anchors that the later fold removes: a discovered-only skill can then remain visible instead of expiring. Backtrack preserves unrelated request-local additions, so the failure is not simply deletion of all skill descriptions. Real-SDK tests cover both orders.

For package-based installation, keep the existing package entries in this order in Pi settings (preserve any other settings):

```json
{
  "packages": [
    "git:github.com/wjfjfm/pi-backtrack",
    "git:github.com/wjfjfm/pi-dynamic-skill"
  ]
}
```

Local package paths follow the same order. Then run `/reload`.

## Context and state

- Successful tool accesses and manual selections maintain continuous active/pending/discovery queues. Read discovery uses the saved child-description snapshot, not a new filesystem scan during replay.
- Descriptions are added in the public `context` hook. Immutable description records restore stable positions; raw anchors also verify their public source entry ID.
- A missing or ambiguous anchor is not guessed. A non-replayable delivery record prevents an old read from rediscovering a description that has already disappeared. Active skills remain eligible for rebuilding; a new read may legitimately discover a child again.
- Compact/reload settlement waits for the next actual retained request. Ordinary request growth does not advance pending eviction.
- Backtrack settlement is inferred from a changed, nonempty set of raw entries absent from the request. Its hash prevents repeated settlement for the same projection. This supports backtrack's folding path, not general shrink/growth classification for arbitrary context transformations; there is no tree-specific handling.
- Internal source IDs and delivery records are not extra model instructions. Descriptions, ON marker and active/pending/discovery formatting are unchanged.
- Descriptions count as shown when constructing context; this is not a transactional guarantee of provider delivery. Arbitrary third-party rewriting into indistinguishable synthetic messages is not supported provenance.

## Verification

```sh
npm ci
npm run typecheck
npm test
npm pack --pack-destination /absolute/path/artifacts
```

An optional differential audit compares public LLM-converted message roles, content and order against an explicitly supplied pre-refactor runtime:

```sh
node scripts/audit-injection.mjs /absolute/path/to/baseline/dist/runtime.js
```

It covers initial requests, read/write/edit, manual selection, next-user growth, reload, compact and runtime recreation. It is a development audit, not a dependency required for installation. The obsolete native-host runner and integration fixtures have been removed; their baseline remains in the original worktree/Git history. Public lifecycle and navigation tests are retained.

Keep the existing dedicated skill directory and configuration; do not copy it into Pi's ordinary recursive skill directory. Queue state remains session-local. When moving away from the modified backtrack host, use a new session and an explicit task handoff rather than rewriting old session history. See the companion backtrack deployment document for rollback and old-session constraints.
