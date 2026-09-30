# Public-extension runtime

Targets unmodified Pi **0.99.1**, Node **≥22.19.0**. No host patch is required. Source development and release packaging use the primary checkout on `main`.

## Installation

Dynamic-skill works alone. When combined, load **backtrack before dynamic-skill** so descriptions are reconciled against retained context. Do not install duplicate copies. Preserve unrelated settings:

```json
{
  "packages": [
    "git:github.com/wjfjfm/pi-backtrack",
    "git:github.com/wjfjfm/pi-dynamic-skill"
  ]
}
```

Local packages use the same order. Extension-only updates support `/reload`; **host upgrades require restarting Pi**. Back up settings and sessions before upgrading. Keep the dedicated skill directory and configuration; do not move it into Pi's recursive skills directory.

## Context and state

- Pi's `buildSessionProjection()` is the source of message provenance, including native context replacements and omissions. System/tool declarations are not conversation anchors.
- Descriptions are injected request-locally through `context`. Immutable description records retain positions without storing full context snapshots. Missing or ambiguous anchors are not guessed.
- Successful read/write/edit and manual selections maintain active/pending/discovery queues. Read discovery reuses saved child-description snapshots, not a new filesystem scan during replay.
- Direct accesses replay transcript tool results. Nested accesses use `tool_result.parentToolCallId` and a minimal session custom entry containing the successful access and optional discovery snapshot. Native `nestedCalls` is a bounded audit trail, not a reliable access journal. Failed accesses are not recorded; successful nested accesses remain valid even if their outer tool subsequently fails.
- Compact/reload settlement waits for retained context. Native compaction/context-edit identity and request-local missing-source identity deduplicate settlement. Ordinary appends and system/loadout changes do not consume pending grace.
- Internal IDs and delivery records are not extra model instructions. Descriptions count as shown during context construction, not as a transactional guarantee of provider delivery.
- Reversing extension order is unsupported: reconciliation would see anchors that a later backtrack removes. Real-SDK tests cover this constraint. Indistinguishable synthetic rewrites by arbitrary third-party extensions cannot provide reliable provenance.

Queues remain session-local. Current session records restore directly; the obsolete eviction-notice migration has been removed. Native-backtrack/legacy-view sessions require a new session with an explicit handoff, not JSONL rewriting.

## Verification

```sh
npm ci
npm run typecheck
npm test
npm pack --pack-destination /absolute/path/artifacts
```

Tests include native projection, nested discovery, lifecycle, navigation, persistence failures and recovery. Companion integration runs from backtrack with `PI_DYNAMIC_SKILL_EXTENSION` pointing to this extension. Providers are local/scripted, not live network models.

`scripts/audit-injection.mjs` is an optional historical differential audit requiring an explicitly supplied baseline. It is not a release dependency or old-host runtime adapter. Historical deployment records are retained as dated evidence, not current installation instructions.
