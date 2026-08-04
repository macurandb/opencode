# Real desktop renderer profile

## Scope

- Revision: `60e23fee161982d572fafbf6cc0df63ac8ac87cc`
- Runtime: production Electron preview from the current `dev` build
- Data: the live `opencode.db` used by Beta, queried read-only for targets active in the preceding 24 hours
- Contents are never written to reports. Reports contain rank labels, counts, sizes, durations, and source locations only.
- The database is shared by channels, so rows cannot be attributed exclusively to the Beta executable.

The final attributed run covered 26 active sessions: 7 roots and 19 child/subagent sessions. The selected root-session targets were:

| Rank | Serialized bytes in window | Messages | Parts | User turns |
| --- | ---: | ---: | ---: | ---: |
| p50 | 13,211 | 6 | 14 | 3 |
| p95/max | 7,665,253 | 421 | 1,883 | 51 |

The p95 and maximum were the same root session. The harness intentionally runs it twice, so those rows are warm/cold repetitions rather than independent samples.

## Confirmed main-thread work

### 1. Response parsing and synchronous continuation

The largest consistently attributed script entry starts at `Response.text.then` in `packages/sdk/js/src/v2/gen/client/client.gen.ts:171-172`. The client reads the complete body as text and calls synchronous `JSON.parse` on the renderer. The LoAF duration also includes the promise microtasks that synchronously ingest the parsed result and update the UI.

- Large-session navigation: 139-391 ms attributed to this entry point, including 38-88 ms forced style/layout.
- History pagination: 388 ms attributed, including 64 ms forced style/layout.
- Home: two response continuations took 77 ms and 61 ms, including 22 ms forced style/layout.

This is the first boundary to split or move off-thread. The measurement does not imply that all attributed time is `JSON.parse`; it includes downstream work in the same promise checkpoint.

### 2. Timeline measurement and scroll reconciliation

History loading was the heaviest repeatable workflow.

| Metric | Clean-run range |
| --- | ---: |
| Long tasks | 6-9 |
| Total long-task time | 763-1,097 ms |
| Worst long task | 138-309 ms |
| Workflow time | 4.7-5.3 s |

The attributed run found:

- TanStack Virtual `ResizeObserver`: 173 ms, including 42 ms forced layout.
- TanStack Virtual scroll handler: 160 ms.
- `ScrollView` scroll handler at `packages/ui/src/components/scroll-view.tsx:173-202`: 65 ms, including 64 ms forced layout.
- The timeline's virtualizer and resize anchoring are configured at `packages/app/src/pages/session/timeline/message-timeline.tsx:413-486`.

The next optimization target is the response-to-projection-to-measurement pipeline, especially reducing synchronous DOM reads and repeated resize/scroll reactions while prepending history.

### 3. Renderer-side Shiki WASM startup

A small-session navigation loaded `@shikijs/engine-oniguruma` in the renderer and spent 58-62 ms evaluating its WASM module. Session Markdown parsing/highlighting and Pierre highlighting have workers, but renderer-side Shiki/Pierre initialization is still reachable. The bundled path is created by `getSharedHighlighter(... preferredHighlighter: "shiki-wasm")` and should be audited separately from worker execution.

### 4. Home startup and geometry

Across clean runs, Home produced 3-4 long tasks, 277-394 ms total, with a 127-172 ms maximum.

Attribution showed:

- Main module evaluation: 137 ms.
- Two response continuations: 77 ms and 61 ms.
- 22 ms forced style/layout.
- CPU samples in `ScrollView.updateThumb` and `home-scroll-controller.ts:56-69` (`getComputedStyle`, every header's `offsetTop`, and `scrollTop`).

### 5. Review opening

The current real workspace review was not a major hotspot. Clean runs ranged from zero to two long tasks, with a 0-106 ms maximum. The attributed run had a 35 ms delegated click handler and 11 ms forced style/layout. This corpus had one diff viewer and does not validate large-review behavior.

## Markdown renderer conclusion

No current real text part exceeded 19,466 characters in the initial corpus audit. In the desktop traces:

- Marked, KaTeX, and Shiki parsing did not appear as renderer CPU hotspots because they run in the Markdown worker.
- Markdown worker response handling appeared as a 43 ms entry in one run.
- Renderer `postMessage`, `innerHTML`, HTML parsing, sanitization-related DOM parsing, and token DOM updates appeared in low-single-digit samples and accumulated tens of milliseconds, but none was independently responsible for the observed long tasks.
- Checksumming did not appear above the 1 ms CPU reporting threshold.

For this real 24-hour corpus, Markdown's remaining renderer stages are secondary to response ingestion and timeline layout. This does not establish safety for an exceptional multi-megabyte text part.

## Reviewed but not measured

The source audit also found scale-sensitive renderer paths that this real workflow did not exercise enough to assign runtime numbers:

- Terminal buffer serialization/restoration over up to 10,000 rows.
- In-file search text-node scans, DOM `Range` creation, and match geometry.
- Large file/diff preprocessing and virtualized file DOM work.
- Command-palette filtering and unvirtualized result rendering.
- Draft recursive serialization and blob hashing.
- Generic persisted-state parse/merge/stringify.
- Large review trees and large diff switching.

No synthetic data was introduced merely to force these paths. They remain candidates for a future profile when corresponding real data exists.

## Reproduce

From `packages/app`:

```powershell
$env:OPENCODE_PROFILE_DIAGNOSTICS = "0"
$env:OPENCODE_PROFILE_OUTPUT = "C:\tmp\opencode\markdown-profile-results\run"
bun run e2e/performance/real-desktop-profile.ts
```

The script builds and launches Electron, points it at the shared real database, enables Electron 42's `AlwaysLogLOAFURL` feature for custom-protocol script attribution, profiles the workflows, and terminates the complete process tree in `finally`.

For Chrome traces and a 1 ms CPU sampler:

```powershell
$env:OPENCODE_PROFILE_DIAGNOSTICS = "1"
$env:OPENCODE_PROFILE_OUTPUT = "C:\tmp\opencode\markdown-profile-results\diagnostic"
bun run e2e/performance/real-desktop-profile.ts
```

Diagnostic timing is perturbed by tracing and sampling. Use clean runs for blocking-time numbers and diagnostic runs only for attribution.

Useful outputs from this audit:

- `C:\tmp\opencode\markdown-profile-results\loaf-positions\renderer-profile.json`
- `C:\tmp\opencode\markdown-profile-results\diagnostic\renderer-profile.json`
- `C:\tmp\opencode\markdown-profile-results\diagnostic\traces`

## LoAF attribution

Electron custom protocols normally produce an empty `PerformanceLongAnimationFrameTiming.scripts` array. Electron 42 supports custom-protocol attribution behind `--enable-features=AlwaysLogLOAFURL`; the harness enables it through an environment-guarded `app.commandLine.appendSwitch` and verifies it with an 80 ms calibration callback.

References:

- https://developer.chrome.com/docs/web-platform/long-animation-frames
- https://www.electronjs.org/docs/latest/api/command-line-switches#chromium-features-relevant-to-electron-apps
- https://github.com/electron/electron/pull/49706
