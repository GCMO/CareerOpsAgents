# Mode: ranker — Auto-evaluate queued offers (P1)

Takes jobs in `data/workflow.yml` with `state: discovered`, evaluates A–G, updates tracker and workflow. Does **not** package CVs/CLs, fill forms, or submit.

Policy: `config/profile.yml` → `automation` + `modes/_profile.md`.

## Commands (Node)

```bash
node workflow-runner.mjs sync-discovered   # pipeline shortlists → workflow.yml
node workflow-runner.mjs queue [--limit N] # top-K → batch/ranker-queue.json + batch/batch-input.tsv
node workflow-runner.mjs status
node workflow-runner.mjs mark --id ID --state evaluated|skipped --score X.X --report reports/...
```

Default `top_k`: `automation.ranker.top_k` in profile (default **10**). Sweden before remote; FE/React boost; hard-skip .NET/Java/BI/embedded-only titles.

## Agent workflow

1. Run `node workflow-runner.mjs sync-discovered`
2. Run `node workflow-runner.mjs queue` (or `--limit N`)
3. Read `batch/ranker-queue.json`
4. **For each job** (in order):
   a. Playwright: navigate URL → snapshot JD (WebFetch fallback; mark Verification unconfirmed if needed)
   b. Apply deal-breakers from `_profile.md` — if hard skip → `mark --state skipped --notes "..."` and continue
   c. Full A–G evaluation per `modes/oferta.md` using `cv.md` + `_profile.md`
   d. Save report: `reports/{num}-{company-slug}-{YYYY-MM-DD}.md`
   e. Write tracker TSV to `batch/tracker-additions/` then `node merge-tracker.mjs`
   f. `node workflow-runner.mjs mark --id {id} --state evaluated --score {score} --report {path}`
      - Runner auto-downgrades to `skipped` if score &lt; `auto_skip_below` (4.0)
      - Notes `eligible for package` if score ≥ 4.5 (Packager is **P2** — do not generate PDFs here)
5. After queue: `node workflow-runner.mjs status` and print summary table:

| # | Company | Role | Score | State | Report |
|---|---------|------|-------|-------|--------|

6. **Stop.** No Packager, Form Agent, or Submit.

## Caps

- Process only the queued `top_k` jobs per run (quality over quantity)
- Never click Apply/Submit
- Prefer Sweden hybrid/remote-eligible roles per location policy

## Monday Automation (Ranker)

Suggested schedule: **Monday 05:00 UTC** (after Scout at 04:00 UTC).

1. Checkout repo
2. `node workflow-runner.mjs sync-discovered`
3. `node workflow-runner.mjs queue`
4. Evaluate each job in `batch/ranker-queue.json` as above
5. Persist via **draft PR** (never push directly to main)
6. Reply with counts: evaluated / skipped / eligible-for-package (≥4.5) + links to reports
7. Stop
