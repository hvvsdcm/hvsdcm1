# Architecture

## Deployment boundaries

The front end is static and requires no bundler. GitHub Pages serves the repository root through the custom domain in `CNAME`. The API is a separate Cloudflare Worker whose D1 binding and allowed browser origin are configured in `worker/wrangler.toml`.

## Browser flow

1. The home page logs a user in through `POST /api/login` and stores `hvsdcm.token` plus `hvsdcm.user` in localStorage.
2. A learning page loads `/account.js` with `data-app` and `data-key` attributes.
3. `account.js` requires the account token, fetches remote progress and shared accepted answers, then hydrates the app-specific localStorage record.
4. The public content loader uses the same bearer session to fetch private R2 content through `/api/learning/*`; the app controller renders that content plus the local record.
5. Each app saves its local record and explicitly schedules a debounced 350 ms synchronization to `PUT /api/progress/:app`. Custom aliases are also sent to `/api/answers/accept`. A synchronization whose stored payload is byte-identical to the current row does not update the row and does not append an activity entry, so the admin event counts reflect real changes rather than debounce ticks.
6. The past-paper screen fetches its R2-resident manifest and PDFs only through bearer-authenticated Worker routes. Selection extraction and merging remain in the browser; neither the static Pages deployment nor logged-out HTML contains the exam list.
7. The Behavior Lab static shell is noindexed and covered until `GET /api/behavior-lab/paper` authenticates the bearer session as the exact, separately configured `BEHAVIOR_OWNER_USERNAME`. The paper report POST routes strict paper contracts to independent reserved rows. The exact owner may place one idempotent stop record; the browser cannot read the ingest-only control endpoint, and the runner cannot write the owner stop endpoint. No path exposes a secret value, private exchange route, balance, or submission action.
8. The owner-only competition view at `/usage/` places immutable approval requests before scan and candidate details. Candidates persist verified fee and participation-mode facts; only free work requiring no attendance or online-only participation can become active, and the redacted portfolio is capped at ten. Each request binds a redacted review summary and exact approval wording to an action SHA-256. The former usage/harness screen and Worker routes are archived; their historical D1 schema and rows remain untouched.

The local record is a fast browser cache, while D1 is the cross-device source of truth. The one-time session marker `hvsdcm.loaded.<app>` prevents repeated reloads during hydration.

## Front-end ownership

- `assets/`: home-only presentation and behavior.
- `assets/js/study-utils.js`: the single implementation of shared study helpers — HTML escaping, search normalization, stable metric sorting, Fisher–Yates shuffling, answer-shape matching and the toast timer — used by WordMaster, social studies, Politics and Law and the past-paper screen. `scripts/validate.mjs` fails if a page reintroduces a private copy of a toast timer.
- `admin/assets/`: admin-only presentation and behavior.
- `account.js`: shared authentication and synchronization adapter.
- `_learning/wordmaster/words.js`: Jekyll-hidden vocabulary source used by validation and the R2 payload builder.
- `WordMaster/assets/js/words.js`: public authenticated-content loader; contains no vocabulary rows.
- `WordMaster/assets/js/app.js`: WordMaster state, grading, personal error-rate metrics and rendering.
- `_learning/smstudy/`: Jekyll-hidden concept, question, explanation and 78-image source used by validation and the R2 payload builder.
- `smstudy/assets/js/data.js`: public authenticated-content loader; the companion data filenames remain empty compatibility stubs for script-order stability.
- `smstudy/assets/js/app.js`: social-studies state, source error-rate sorting, grading and rendering.
- `plstudy/assets/js/data.js`: public authenticated-content loader for Politics and Law.
- `plstudy/assets/js/app.js`: Politics and Law concept search, quizzes, local progress and account-sync scheduling under `politicslaw2027.study.v1`.
- `gichul/`: login-gated past-paper filtering, viewing, extraction and client-side merge UI. The data list itself is not checked into this directory. The screen loads `account.js` in gate-only mode (`data-app`, no `data-key` — there is no study progress to sync), then the vendored icon set, then `gichul/app.js`; filter options, labels and results are all derived from the manifest that `GET /api/gichul/manifest` returns after authentication. The 526 KB vendored pdf-lib bundle is not a first-paint asset: `gichul/app.js` fetches it through `loadPdfLib()` only when a merge or extraction starts, overlapping that download with the authenticated PDF fetch, and reports a load failure through the existing merge-error banner instead of merging partially.
- `behavior-lab/`: owner-gated classic-script dashboard. `assets/js/app.js` reads the existing account bearer, keeps the shell covered until exact-owner verification, and renders separate market and active paper-experiment tabs. The paper tab refreshes every five seconds without applying a loading opacity or rebuilding stable arm-card nodes, hides completed experiments and the legacy single-session surface, prefers the six-arm v2 shape while retaining strict v1 fallback rendering, and shows each arm's accessible time-scaled bounded equity curve plus immutable policy/risk facts, position, trades, gate decisions, logs, metrics, chain reference, and exact-owner stop control. `assets/js/core.js` owns the deterministic walk-forward and inert manual draft calculations.
- `assets/vendor/pdf-lib/`: pinned pdf-lib UMD bundle plus its MIT text, used for in-browser merging and selection-section extraction. `scripts/validate.mjs` locks the bundle bytes with a sha256 so it cannot be swapped silently.

## Worker ownership

- `worker/src/index.js`: CORS, top-level exception boundary and Worker entrypoint.
- `worker/src/router.js`: endpoint matching and domain handlers.
- `worker/src/lib.js`: HTTP, hashing, token, authentication and activity helpers.
- `worker/migrations/`: append-only D1 schema history.
- R2 binding `GICHUL`: generated past-paper manifest/PDFs plus WordMaster and social-studies payloads/images. All are private behind Worker session checks rather than static Pages assets.

The KICE ingestion pipeline is owned by `scripts/gichul/`. `fetch-kice.mjs` derives attachments and a current `fileSeq` inventory from the official list filters for academic years 2020-2027, refreshing an existing PDF when that sequence changes. `build-manifest.mjs` derives deterministic metadata and page sections from only the inventoried filesystem and rejects incomplete question/answer or track coverage. `upload-r2.mjs` uploads content-hash changes through the locally installed Wrangler CLI, placing changed PDFs before the manifest visibility switch and advancing its checkpoint only after success. `gichul-src/`, the crawl inventory, and the upload checkpoint are ignored. The checked-in `overrides.json` is only an exact `common`/`selection` correction layer keyed by final manifest ID; it is not a second source list.

Sessions store SHA-256 token hashes rather than raw tokens. User passwords use PBKDF2-SHA-256 with per-user salts and 100,000 iterations. Admin authentication uses the `ADMIN_PASSWORD` Worker secret and receives a role-scoped session. Each authenticated request refreshes the session's Cloudflare client IP, IP fingerprint and user-agent only when one of them changed, and rewrites `last_seen_at` at most once every 60 seconds (`SESSION_TOUCH_INTERVAL_MS`), which is well inside the 90-day admin history window; a debounced 350 ms learning save therefore costs one D1 statement instead of two per request. Exact IP and user-agent fields are returned only by admin routes. Logout expires a session instead of deleting its audit row, and the admin session query prunes records after 90 days.

The historical usage and harness migrations remain in `worker/migrations/`, and their D1 tables and rows are intentionally preserved. Their Worker routes and collectors are no longer part of the active product. Behavior Lab remains active and may continue to read its own reserved reports from the existing storage model. The archived source, contracts, and restoration notes live under `docs/archive/2026-09-04-usage/`.

## API surface

| Method and path | Role | Purpose |
| --- | --- | --- |
| `POST /api/login` | public | User login |
| `POST /api/admin/login` | public | Admin login |
| `GET /api/behavior-lab/paper` | behavior owner | Active six-arm experiment when valid, otherwise immutable three-arm fallback, alongside the fixed-session compatibility shape |
| `GET /api/behavior-lab/live` | behavior owner | Latest validated dual-model live-trading report, or an explicit not-connected state |
| `POST /api/behavior-lab/paper/report` | paper report token | Strictly route fixed-session, three-arm v1, or six-arm v2 reports into separate monotonic reserved rows |
| `GET /api/behavior-lab/paper/control?experiment_id=...` | paper report token | Read the one-way stop state for the exact six-arm runner |
| `POST /api/behavior-lab/paper/stop` | behavior owner | Idempotently request that the active until-stopped six-arm experiment close |
| `GET /api/me` | user | Current user |
| `POST /api/logout` | token | Delete current session |
| `GET/PUT /api/progress/:app` | user | Read or replace app progress |
| `GET /api/answers/:app` | user | Read shared accepted answers |
| `POST /api/answers/accept` | user | Add a shared accepted answer |
| `GET/POST /api/admin/users` | admin | List or create users |
| `DELETE /api/admin/users/:id` | admin | Delete a user and related data |
| `POST /api/admin/users/:id/password` | admin | Atomically replace the salted password hash, expire target sessions, and record a secret-free audit event; preserve learning data |
| `GET /api/admin/stats` | admin | Aggregate activity |
| `GET /api/admin/sessions` | admin | Recent device, IP and session activity |
| `GET /api/admin/answers` | admin | Review accepted answers |
| `GET /api/competitions` | owner user | Read the latest competition scan, applications and immutable approval requests |
| `POST /api/competitions/report` | competition ingest token | Append one strict redacted scan, application and approval-request snapshot |
| `POST /api/competitions/approvals/:requestId/decision` | owner user | Store one action-bound web approval or hold decision for the latest request |
| `GET /api/gichul/manifest` | user | Read the R2 past-paper manifest with caching disabled |
| `GET /api/gichul/pdf/:id` | user | Stream a manifest-mapped R2 PDF with caching disabled |
| `GET /api/learning/wordmaster` | user | Read the private WordMaster payload with caching disabled |
| `GET /api/learning/smstudy` | user | Read the private social-studies payload with caching disabled |
| `GET /api/learning/smstudy/image/:name` | user | Stream one allowlisted-name private WebP with caching disabled |

## Regression boundaries

`scripts/validate.mjs` treats stable IDs, counts, source coverage, image presence, HTML asset paths, and the KICE/R2 backend wiring as contracts. `worker/test.mjs` covers pure security helpers plus response/CORS behavior that can run without a live D1 database or R2 bucket, including the permanent 404 contract for the archived usage/harness routes. `worker/paper-report.test.mjs` additionally runs the adaptive monotonic-upsert SQL against in-memory SQLite. `worker/abc-paper-experiment.test.mjs` preserves the immutable v1 row, while `worker/multi-paper-experiment.test.mjs` covers the separate six-arm source, exact hashes/policies, monotonicity, active-v2 preference, maximal payload measurement, and overflow rejection. Behavior experiment rows still reuse the retained `usage_snapshots` table, so no D1 migration is required. Script tests inject PDF text extraction, so real-PDF section accuracy remains a deployment gate. A real D1 migration or query change should additionally be exercised with `wrangler dev --local`; the past-paper feature additionally requires an authenticated live R2/CORS check after upload.
