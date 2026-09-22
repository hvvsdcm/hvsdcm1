# Study workspace redesign

## Scope and reference

The September 2026 study redesign applies only to `/gichul/`, `/WordMaster/`, and `/smstudy/`. The user's request makes Toss's task-focused mobile interface the reference for these surfaces. The historical Apple-style prescription in `DESIGN.md` remains relevant to other surfaces, not a reason to undo this explicit product direction.

Public reference pages reviewed on 2026-09-22:

- TDS overview: https://tossmini-docs.toss.im/tds-mobile/
- ListRow: https://tossmini-docs.toss.im/tds-mobile/components/ListRow/list-row-overview/
- FixedBottomCTA: https://tossmini-docs.toss.im/tds-mobile/components/BottomCTA/fixed-bottom-cta/
- BottomSheet: https://tossmini-docs.toss.im/tds-mobile/components/bottom-sheet/
- Typography: https://tossmini-docs.toss.im/tds-mobile/foundation/typography/

The implementation translates the reference's clear task hierarchy, readable rows, reachable primary actions and temporary filter sheets into the existing no-build application. It does not include Toss's proprietary art or fonts and does not claim to be an exact copy or official TDS integration.

## Preserved behavior

| Surface | Preserved |
| --- | --- |
| WordMaster | All 2,000 words; daily goals; automatic recall grading and visible answer feedback from PR #19; overdue-first scheduling; resume queue; DAY-range tests; wrong-answer search and retest; accepted answers; backups and account synchronization |
| Social and Culture | All 17 subunits and 98 questions; protected original question images; concept navigation, diagrams, comparisons, recall prompts and completion; quiz selection and ordering; grading, explanations, mistake notes and reasons; review modes; backups, restore and print |
| Past papers | Manifest-derived subjects, years, rounds and tracks; complete-paper and selection-only modes; optional answers; bulk selection; opening a paper; client-side PDF merging and extraction; unsupported-section disabling; failed-download handling and selection pruning |
| Other applications | Landing/login, administrator password reset, Politics and Law, owner-only surfaces and all Worker routes |

No learning-content files, persistence keys, account code, Worker modules, WordMaster scheduler or current WordMaster grading controller are changed by the completion patch. The landing HTML, home controller, home styles and logo bytes remain unchanged. Shared stylesheet additions are scoped to `html.study-app` / `.study-toss` and do not activate on the landing page.

## Layout and interaction ownership

`assets/js/study-shell.js` restores the saved palette in the document head before the learning shell paints. A missing explicit preference follows the operating system. An explicit choice persists under the existing `hvsdcm.study.theme.v1` key, overrides later system changes, and synchronizes across tabs. No theme preference is sent to the server.

All three applications expose the same top-level navigation and a labeled theme control. On narrow phones the header has two rows, so links are not hidden. Local study navigation becomes equal-width tabs rather than an offscreen horizontal menu. Phone/tablet layouts use the available content width without stretching desktop sidebars into narrow columns.

At 860 CSS pixels or narrower, the original past-paper filter node moves into a native dialog. The original event listeners remain attached; no duplicate filter state is created. Escape, close and outside-backdrop actions dismiss it, and focus returns to the trigger. Expanding the viewport closes the sheet, releases its scroll lock, and moves that same node back to the desktop rail. The main download action is fixed near the bottom on small screens with content padding and safe-area space.

Social-studies quiz setup precedes the unit list in the narrow layout and sits beside it on wide screens. A floating action mirrors the original quiz button only when there is a selection and the original button has scrolled out of view. It invokes the original action, never an independent session. Review options remain available in the expandable quick-review section. Checkbox rerenders return keyboard focus to the selected checkbox.

## Themes, motion and accessibility

Color tokens remain centralized in `assets/css/system.css`. Light and dark study palettes define readable secondary text and distinct success/error states. Button and text contrast is checked on rendered browser colors, not merely on a screenshot's appearance. Theme and route controls have at least 44-by-44 CSS-pixel targets, and input text is at least 16 pixels to avoid unwanted phone zoom.

The surface stylesheet no longer animates all main children on every rerender. A short content transition runs on a changed view or word; repeated polling of the same view does not restart it. The sheet animates independently of sticky/fixed actions. The operating system's reduced-motion preference suppresses transitions and animations. Print media restores a paper palette even when the saved screen preference is dark and hides navigation, dialogs and fixed actions.

## Regression evidence

`node scripts/study-ui.e2e.mjs` now loads the full existing vocabulary and social-studies sources into a local, mocked authenticated API. It requires the actual start/download controls and explicitly rejects a data-error shell. This replaces the previous social-studies check that could pass by finding only an empty `#app` element.

Coverage includes both themes at 320, 390, 768, 1024 and 1440 pixels; page overflow; touch-target geometry and pointer obstruction; foreground/background contrast; stored theme behavior; actual concept completion, quiz grading, protected image loading and JSON export; sheet focus and viewport rotation; synthetic full-paper-plus-answer PDF merging and two-page selection extraction; disabled unsupported selections; malformed-content and anonymous-access boundaries. Later additions cover printing, reduced motion, cross-application/cross-tab theme behavior and failed downloads without partial files.

The PDF fixtures are generated blank documents. The browser uses the same vendored library as the real application to produce and reopen them, so the test checks actual output page counts without redistributing examination PDFs. Tests do not reset real accounts or mutate production learning records.

Run `npm test` and `git diff --check` before publication. Set `STUDY_UI_ARTIFACT_DIR` to a directory outside the repository to capture viewport screenshots. The generated `docs/_snapshots/` now includes the study body classes and theme attribute, so its CSS actually reflects the current application rather than a theme-inactive shell.
