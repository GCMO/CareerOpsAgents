# Cursor Automation — career-ops Monday Ranker

**Name:** career-ops Monday ranker  
**Trigger:** Every Monday 05:00 UTC (`0 5 * * 1`) — after Scout at 04:00 UTC  
**Repo:** GCMO/CareerOpsAgents · branch `main`  
**Scope:** Evaluate top_k discovered jobs only. No package / form / submit.

---

## Instructions (copy into Automation)

You are running the **career-ops Monday Ranker** on repo `GCMO/CareerOpsAgents` (branch `main`).

### Goal
Evaluate the top queue of discovered FE/FS roles. Update reports, tracker, and workflow states. Stop after a summary.

### Do
1. Follow `modes/ranker.md` and `modes/oferta.md` (A–G). Read `cv.md`, `modes/_profile.md`, `config/profile.yml`.
2. `node workflow-runner.mjs sync-discovered`
3. `node workflow-runner.mjs queue` (uses `automation.ranker.top_k`, default 10)
4. Read `batch/ranker-queue.json`
5. For each job in order:
   - Fetch JD (Playwright preferred; WebFetch fallback — mark verification if needed)
   - Apply deal-breakers → `mark --state skipped` if hard skip
   - Else full A–G → save `reports/{num}-{slug}-{date}.md`
   - Write tracker TSV → `node merge-tracker.mjs`
   - `node workflow-runner.mjs mark --id {id} --state evaluated --score {score} --report {path}`
6. `node workflow-runner.mjs status`
7. Persist via **draft PR** against `main` (never push directly to `main`)
8. Reply with: evaluated / skipped / eligible-for-package (≥4.5) + report links + draft PR link

### Do not
- Run Packager / Form Agent / Submitter
- Click Apply/Submit
- Evaluate more than `top_k` unless the user overrode `--limit`

### Policy reference
`modes/ranker.md` · `modes/orchestrate.md` · `config/profile.yml` → `automation.ranker`
