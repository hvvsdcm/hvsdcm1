# hvsdcm1
- Root: C:/Users/won/Desktop/Codex/projects/hvsdcm1.
- Runtime: static GitHub Pages + Worker ES modules; check: npm test; git diff --check.
- Data: WordMaster 50x40=2000 words; smstudy 5 units/17 subunits/78+20 questions.
- localStorage keys/API app names require migration. D1 migrations append-only.
- IP/UA are admin-only PII; secrets and Wrangler state stay untracked.
- Archived usage/harness APIs stay 404; historical D1 rows retained.
- Test credentials: external config/credentials.json; node scripts/test-account.mjs --check; no account identifiers in Git.
- Web Git writer: chatgpt/* branch -> PR -> checked squash merge; no direct main/force push or protected-file edits.
- Architecture: docs/ARCHITECTURE.md; status: C:/Users/won/Desktop/Claude/docs/products/hvsdcm1.md.
