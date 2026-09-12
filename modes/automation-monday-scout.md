# Cursor Automation — career-ops Monday Scout

**Name:** career-ops Monday scan  
**Trigger:** Every Monday 04:00 UTC (`0 4 * * 1`)  
**Repo:** GCMO/CareerOpsAgents · branch `main`  
**Scope:** Scout only — discover + shortlist + sync queue. No evaluate / package / form / submit.

Paste the block below into the Automation instructions (or re-open via agent with this file as the prompt source).

---

## Instructions (copy into Automation)

You are running the **career-ops Monday Scout** on repo `GCMO/CareerOpsAgents` (branch `main`).

### Goal
Discover new jobs, refresh FE/FS shortlists, sync the workflow queue. Stop after a count digest.

### Do
1. From repo root: `npm install` only if needed for `js-yaml` / scripts; prefer existing `node_modules`.
2. Run: `node scan.mjs`
3. From the scan’s **new offers** (+ lines in the console / newly appended `- [ ]` rows in `data/pipeline.md`), build two markdown tables and **prepend** them under `## Pendientes` (mark with `⭐ latest`; remove that star from older shortlist headings):
   - `### Sweden — FullStack & Frontend (scan YYYY-MM-DD) ⭐ latest`
   - `### Remote — FullStack & Frontend (scan YYYY-MM-DD)`
4. Shortlist filters (align with `config/profile.yml` + `modes/_profile.md`):
   - Include: frontend / full-stack / React / Next.js / TypeScript / webbutvecklare FE-ish titles
   - Exclude hard deal-breakers: Java-only, .NET/C#-only, BI-only, embedded-only (unless modern JS/React also present)
   - Sweden: Stockholm / Sweden cities / arbetsförmedlingen / `.se` careers
   - Remote: remote / EMEA / EU / worldwide — **skip clear US-work-auth-only** postings
5. Run: `node workflow-runner.mjs sync-discovered`  
   (shortlist tables only — do **not** pass `--include-checkboxes` unless the user asked)
6. Run: `node workflow-runner.mjs queue --limit 10` so Ranker has a ready queue (do not evaluate yet)
7. Persist changes via a **draft pull request** against `main` — never push directly to `main`
8. Reply with counts only:
   - companies scanned / jobs found / new URLs
   - Sweden FE-FS shortlist size / remote FE-FS shortlist size
   - workflow `discovered` count / hard-skipped count
   - top 5–10 links from the new Sweden shortlist
   - link to the draft PR

### Do not
- Evaluate offers (no A–G reports)
- Generate CV/CL PDFs
- Fill application forms
- Click Apply / Submit / Send
- Approve submissions

### Policy reference
`modes/orchestrate.md` → Monday Automation (Scout only) · `config/profile.yml` → `automation`
