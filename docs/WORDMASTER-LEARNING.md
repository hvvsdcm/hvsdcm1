# Daily learning and administrator password reset

## WordMaster learning flow

`/WordMaster/` opens on today's learning, not the exam-configuration form. The existing DAY selector, Korean-meaning grading, accepted aliases, filtered wrong-answer notebook, backup and restoration remain available.

- The daily goal defaults to 20 distinct words and can be changed from 5 to 200. Presets are 10, 20, 30 and 50. New words can be restricted to a DAY range.
- Automatic daily sessions prioritize overdue reviews, then fill the remaining goal with unseen words. A normal batch is at most 20 words; after the goal is met, an optional extra batch has at most 10. Reviews are not limited by the new-word DAY range.
- The dedicated review screen includes only currently due cards, lists the next review time, and paginates the schedule in groups of 30.
- Daily progress counts each word once per Korean calendar day, even when an incorrect answer is repeated. Attempts and accuracy still record every attempt. Seven-day activity and the consecutive-study-day count reflect actual saved activity, not assumed completion.
- Sessions save their queue, answered state and position. Refreshing offers an explicit resume button; continuing an already answered card does not grade it again.

## Independent scheduling algorithm

The interface references the public learning flow described by Epop, particularly automatic review around forgetting. Neither Epop's code, character art, wording nor a proprietary formula is copied. This implementation does **not** claim to reproduce Malhaeboka's private algorithm or to estimate scientifically calibrated recall probabilities.

The isolated, deterministic scheduler is `WordMaster/assets/js/scheduler.js`. Each card stores its due time, interval, ease, repetitions and lapses. The defaults are product heuristics, informed by public spaced-repetition principles:

| Answer | First qualified success | Second qualified success | Later qualified successes |
| --- | --- | --- | --- |
| Hard | 12 hours | 1 day | Previous interval × 1.2, rounded up |
| Good | 1 day | 3 days | Previous interval × current ease, rounded up |
| Easy | 3 days | 7 days | Previous interval × current ease × 1.3, rounded up |

Ease begins at 2.5, is bounded to 1.3–3.0, decreases by 0.15 for hard and increases by 0.15 for easy. A wrong answer decreases ease by 0.2, resets repetitions, and schedules another review in 10 minutes. Intervals are capped at 365 days. These intervals intentionally differ from the original SM-2 algorithm.

A correct answer before the existing due time is practice, not new evidence for increasing the interval. Incorrect words appear once more within an automatic session, after up to three intervening questions; this bounded retry does not expand the future interval when answered immediately. If a user accepts a valid alternative answer, the just-recorded score, daily accuracy, review schedule and false retry are repaired from the pre-answer snapshot.

## Persistence and migration

The existing `wordmaster2000.quiz.v1` key and `wordmaster` API app name remain unchanged. Scheduling data is an additive `learning` object. Existing score and alias data is retained. Previously attempted words without scheduling records are due immediately for one recall check; old accuracy is not treated as proof of a long interval.

All day boundaries use Asia/Seoul's UTC+9 offset. Storage retains at most 366 daily aggregates and distinct-word lists for today and yesterday. Unknown card IDs and out-of-range scheduling values are normalized. The controller waits for authenticated account hydration as well as the private vocabulary payload before initializing, so a fast vocabulary response cannot overwrite a slower remote progress response.

## Administrator password reset

The administrator's user list includes **비밀번호 초기화**. A dialog requires the new password twice, with the existing site policy of 6–128 characters. It does not reveal the previous password or persist plaintext in browser storage. Cancelling makes no change.

`POST /api/admin/users/:id/password` requires an authenticated admin session. The API accepts `password`; the administrator dialog requires matching confirmation before sending it. Responses receive `Cache-Control: private, no-store`. Unknown users return 404 only behind the admin gate.

A fresh random salt and the existing PBKDF2 password-hash format are used. Password replacement, expiry of that user's active sessions, and a credential-free audit event are a single D1 batch transaction. Successive administrator resets are transactional; only the last completed password remains current. Other users' sessions, administrator sessions, progress, aliases and history are left intact. The reset does not create a new login session.

User-session creation checks that the password hash verified during login is still current at insertion time, preventing a login racing the reset from issuing a session with an outdated password. A fresh login must use the new password. This is administrator-assisted reset, not an unauthenticated email recovery flow; the site has no verified email recovery channel.

## Verification

- `node --test scripts/wordmaster-scheduler.test.mjs worker/password-reset.test.mjs`
- `node scripts/wordmaster-ui.e2e.mjs`
- `npm test`
- `git diff --check`

The new browser suite uses synthetic vocabulary and mocked account responses. Security tests use in-memory SQLite and actual hashing, routing and session validation. No real user's password is changed by these tests. Set `WORDMASTER_E2E_ARTIFACT_DIR` outside the repository to collect UI screenshots.

## Public references

- Epop product overview: https://epop.ai/ko
- Original SuperMemo 2 algorithm: https://super-memory.com/english/ol/sm2.htm
- OWASP Forgot Password Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html

Reviewed on 2026-09-21. The specific scheduling choices above are this project's own, not claims about Epop's internal implementation.

### Sync durability and payload limits

Progress writes are serialized to avoid out-of-order completion. For WordMaster, an ownership marker accompanies the existing cache key; a cache known to belong to a different account is not reused. After hydration, a newer timestamped local record belonging to the same account is retained and uploaded, including when the previous page was reloaded before the debounce fired. The server bounds WordMaster progress to 1,200,000 UTF-8 bytes to accommodate the additional schedules and daily history; other apps retain an 800,000-byte bound. Multi-device simultaneous edits still use whole-document synchronization rather than a conflict-free per-answer merge.

The administrator reset UI/API from PR #16 is preserved during integration. Additional SQLite and browser tests exercise that existing contract rather than introducing a duplicate reset endpoint.
