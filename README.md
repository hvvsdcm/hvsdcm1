# hvsdcm

Static learning site served by GitHub Pages, with account synchronization and administration provided by a Cloudflare Worker backed by D1.

## Applications

| Path | Purpose | Browser entrypoint | Persistent key |
| --- | --- | --- | --- |
| `/` | Home, drawer and account login | `assets/js/home.js` | account token/user keys |
| `/WordMaster/` | 2,000-word meaning quiz with personal error-rate/recent sorting | `WordMaster/assets/js/app.js` | `wordmaster2000.quiz.v1` |
| `/smstudy/` | Social studies concepts and 78 sortable KICE questions | `smstudy/assets/js/app.js` | `samun2027.study.v1` |
| `/plstudy/` | Politics and Law concepts and 90 five-choice review questions | `plstudy/assets/js/app.js` | `politicslaw2027.study.v1` |
| `/gichul/` | Login-only KICE past-paper filtering, viewing and client-side PDF merge | `gichul/app.js` | filter settings |
| `/behavior-lab/` | Human-owner-only Bitget behavior dashboard and bounded real-time adaptive $100 paper-session status | `behavior-lab/assets/js/app.js` | account token |
| `/admin/` | User, activity, device/IP and shared-answer administration | `admin/assets/js/admin.js` | session-only admin token |
| `/usage/` | Owner-only competition candidates and approval queue | `usage/assets/js/competition.js` | account token |
| Worker | JSON API, D1 access, authenticated R2 learning/PDF proxy and owner-only Behavior Lab boundaries | `worker/src/index.js` | D1 tables and R2 objects |

There is no front-end bundle step. HTML loads checked-in CSS and JavaScript directly, while learning content is fetched after login from authenticated Worker routes. The checked-in `_learning/` source is excluded by the default Jekyll Pages build and is converted into private R2 payloads before release.

## Local verification

Requires Node.js 20 or newer. The normal test suite does not load the optional real-PDF extractor, so it can run before the root development dependency is installed.

```bash
npm test
```

The command checks every JavaScript file, local HTML asset references, the WordMaster 50 × 40 data shape, all 17 social-studies subunits and 98 questions, all 18 Politics and Law subunits and 90 questions, shared study sorting behavior, then runs Worker utility and routing tests.

## Protected learning content

WordMaster, social-studies, and Politics and Law source data lives under `_learning/`, which GitHub Pages omits while Jekyll is enabled. Public loader files contain no content. Build and verify the 81 private R2 objects (3 JSON visibility switches plus 78 WebP files) before deploying the Worker or Pages change:

```bash
node scripts/learning/build-payloads.mjs
node scripts/learning/upload-r2.mjs --bucket hvsdcm-gichul
```

The uploader sends images first and the three JSON payloads last. Worker routes `/api/learning/wordmaster`, `/api/learning/smstudy`, `/api/learning/plstudy`, and `/api/learning/smstudy/image/:name` require a valid user session and disable caching.

For a static preview:

```bash
python3 -m http.server 4173
```

Worker development remains inside `worker/`:

```bash
cd worker
npm install
npm run db:init
npm run dev
```

Behavior Lab is intentionally narrower than a proxy. Its static shell remains covered until `GET /api/behavior-lab/paper` confirms a bearer session for the one normalized `BEHAVIOR_OWNER_USERNAME`; unauthenticated reads return 401 and every other valid account receives 404. The owner browser reads only the Worker-backed paper and live-report endpoints. It does not call an exchange directly, does not fall back to a fixture that looks live, and exposes no order-entry surface. The current paper source is the separately operated public-data runner; inactive or malformed reports render as an explicit empty/error state rather than as live data.

The paper read API remains rollout-compatible with the fixed single-session row and the immutable `abc-paper-experiment-v1` row. A reserved source accepts schema `multi-paper-experiment-v2` with exact experiment id `multi-paper-20260831-v2`, six independent 100 USDT arm chains, one shared public-feed chain, exact strategy/policy hashes, and the lower 1.5% risk / 3× leverage facts. The current report mode is `until-stopped`: only the exact owner can POST one idempotent stop request, and only the dedicated report bearer can poll it. Owner GET prefers a valid `starting` or `active` v2 snapshot and falls back to v1 only when no active v2 snapshot exists. Completed experiments and the completed legacy card stay hidden.

Both experiment schemas use the same dedicated ingest bearer but different D1 sources and monotonic rows, so a v1 retry cannot replace or downgrade v2. The v2 normalizer rejects unknown fields, cross-schema/id/hash drift, malformed/private/credential-shaped data, impossible position/trade economics, incoherent arm/top-level states, non-monotonic chain references, oversized arrays, and reports over 282,000 bytes. The maximal semantically valid six-arm boundary fixture is 244,430 bytes, leaving 37,570 bytes of headroom; tests reject an exact one-byte body overflow plus the 65th curve point and 21st decision. The UI renders six responsive cards with accessible time-scaled equity/PnL curves (up to 64 immutable-chain-derived points), immutable entry-policy and risk facts, position, trades, decisions with gate reasons, logs, metrics, and chain references without adding any exchange submission surface.

The fixed paper session reports to `POST /api/behavior-lab/paper/report` with the dedicated `BEHAVIOR_PAPER_REPORT_TOKEN`. The Worker accepts only the exact simulation session/deadline, a 100-USDT seed and finite bounded metrics. Legacy payloads advance only with a newer paper sequence. The six-arm runner polls `GET /api/behavior-lab/paper/control` with that same dedicated bearer; the browser can only write `POST /api/behavior-lab/paper/stop` after exact-owner authentication. Once v2 is stored it cannot be replaced by a legacy downgrade. The owner page polls every five seconds but reconciles existing cards in place, so a background request neither dims the experiment nor replaces stable card nodes. It exposes no exchange credential, private channel or order action. Set the report secret before deployment:

```bash
cd worker
npx wrangler secret put BEHAVIOR_PAPER_REPORT_TOKEN
npm run deploy
```

## KICE past-paper data

The KICE list pages are the only collection source; there is no hand-maintained post seed. The collector covers academic years 2020-2027 for Korean, mathematics, English, Social and Culture, and the Politics and Law lineage (including its former `법과 정치` name). Source PDFs, their current list-derived `fileSeq` inventory, and the generated manifest stay in ignored `gichul-src/`. A repeated crawl skips a cached file only when its PDF signature is valid and its inventory `fileSeq` still matches; an official attachment replacement is downloaded atomically.

```bash
node scripts/gichul/fetch-kice.mjs
npm install
node scripts/gichul/build-manifest.mjs
node scripts/gichul/readiness.mjs
node scripts/gichul/upload-r2.mjs --bucket hvsdcm-gichul
```

Only the orchestrator should run the networked collection and upload commands. In its default production mode, `build-manifest.mjs` refuses missing question/answer or track coverage, PDFs absent from the current crawl inventory, and inventory entries whose PDFs are absent. It uses `pdfjs-dist` to count pages and detect the 2022+ Korean and mathematics selection-section headers. If a real PDF needs correction, add that final manifest ID to `scripts/gichul/overrides.json` under `sections`, with exactly `common` and `selection` as inclusive one-based page ranges. Invalid, unused, out-of-document, inconsistent-common, or overlapping ranges stop the build. `--allow-partial` exists only for isolated fixtures and diagnostics, never publication.

The R2 uploader includes `manifest.json` and every referenced PDF. It records content hashes in `gichul-src/.r2-upload-state.json`, so a repeat run uploads only locally new or changed objects. Changed PDFs are uploaded first and `manifest.json` is published last; the checkpoint advances only after every upload succeeds. Deleting an object directly from R2 requires removing that local checkpoint before restoring it.

Apply D1 migrations before deploying Worker code. Migration `0004_session_ip_address.sql` enables exact IP display for requests made after deployment. The historical usage/harness migrations and their D1 rows remain intact, but their ingest/read routes and UI were archived on 2026-09-04; see [`docs/archive/2026-09-04-usage/`](docs/archive/2026-09-04-usage/README.md). Older sessions may only have a one-way IP fingerprint.

## Archived features

- 2026-09-04: Codex/Claude usage snapshots and harness task/event UI, routes, scripts, tests, and snapshot were preserved under [`docs/archive/2026-09-04-usage/`](docs/archive/2026-09-04-usage/README.md). D1 schema and rows were not deleted; Behavior Lab and the competition surface remain active.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for request and synchronization flows, and [`CONTRIBUTING.md`](CONTRIBUTING.md) before modifying data or D1 migrations.
