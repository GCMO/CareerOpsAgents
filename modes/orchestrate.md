# Mode: orchestrate — Agent workflow (Scout → Ranker → Packager → Form → HITL Submit)

Coordinates career-ops agents end-to-end. Policy source of truth: `config/profile.yml` → `automation` and `modes/_profile.md` → Agent orchestration.

## Locked policy (do not override in chat)

| Decision | Value |
|----------|-------|
| Submit | **human_approve_only** — never click Apply/Submit without `approve submit #{num}` |
| Scan | Monday 05:00 Europe/Stockholm (Cursor Automation + manual `/career-ops scan`) |
| Surfaces | Chat + Cursor Automations |
| CL output | PDF → `output/{num}-{company-slug}-cl.pdf` |
| Score gates | &lt;4.0 skip · 4.0–4.4 package only on override · ≥4.5 auto-package |

## State machine

Read/write `data/workflow.yml`. Canonical states:

| State | Meaning | Next |
|-------|---------|------|
| `discovered` | In pipeline from Scout | Ranker |
| `evaluated` | Report + score exist | Packager if ≥ gate; else `skipped` |
| `skipped` | Low fit / deal-breaker | Stop |
| `packaged` | CV + CL PDFs in `output/` | Form Agent |
| `form_ready` | Form filled or answers ready; **stopped before Submit** | Wait for human |
| `approved` | User said `approve submit #{num}` | Submitter |
| `submitted` | Confirmation captured | Tracker |
| `follow_up_due` | Cadence fired | Draft follow-up only |

## Chat commands

| Command | Action |
|---------|--------|
| `package {num...}` | Packager for listed report nums (override allowed for 4.0–4.4) |
| `package eligible` | Packager for all evaluated ≥4.5 |
| `approve submit #{num}` | Set `approved` → Submitter may click Apply/Submit |
| `/career-ops scan` | Scout (manual) |
| `/career-ops pipeline` | Ranker on pending URLs (legacy inbox) |
| `/career-ops ranker` | Ranker on workflow queue (P1) |
| `/career-ops packager` | CV + CL PDFs (P2) |
| `/career-ops form` / `form-agent` | Fill form → form_ready (P3); never submit |
| `/career-ops submitter` | Click Submit **only** if approved (P4) |
| `/career-ops apply` | Form Agent (fill → stop) |

## Agent roles

### 1. Scout
1. Run `node scan.mjs`
2. Append new URLs to `data/pipeline.md`
3. Build Sweden + remote FE/FS shortlists at top of pipeline
4. For each new relevant URL, upsert `data/workflow.yml` entry: `state: discovered`
5. **Do not** evaluate, package, apply, or submit

### 2. Ranker
1. Process `- [ ]` items in `data/pipeline.md` (or nums listed by user)
2. Playwright JD → A–G evaluation → report → tracker TSV → `node merge-tracker.mjs`
3. Apply deal-breakers from `_profile.md` / `profile.yml`
4. Set workflow state: `evaluated` or `skipped`
5. If score ≥ `auto_package_at_or_above` (4.5) → queue Packager
6. If score &lt; `auto_skip_below` (4.0) → `skipped` (recommend against apply)

### 3. Packager (CV + Cover Letter)
Follow `modes/packager.md`. Queue via `node workflow-runner.mjs package-queue`. Render CL with `node render-cl.mjs` (enforces JD requirements + product + stack + location_policy gate). Mark with `package-done`.
### 4. Form Agent
Follow `modes/form-agent.md`. Queue via `node workflow-runner.mjs form-queue`. Fill fields + upload CV/CL. **HARD STOP** before Apply/Submit/Send. Mark `form-ready` with answers JSON + screenshot.

### 5. Submitter (HITL only)
Follow `modes/submitter.md`. Requires `approve submit #{num}` → `approve` → `submit-queue` → click once → `submit-done`. Updates tracker to Applied.

### 6. Tracker
1. Merge TSVs; normalize statuses
2. On follow-up due → draft only; never auto-send

## Monday Automation (Scout only)

When triggered by schedule (04:00 UTC):
1. Checkout this repo
2. `node scan.mjs`
3. Update `data/pipeline.md` shortlists
4. `node workflow-runner.mjs sync-discovered`
5. Reply with counts: fetched / new / Sweden FE-FS / remote FE-FS + top links
6. Stop — Ranker is a separate run (05:00 UTC)

## Monday Automation (Ranker — P1)

When triggered by schedule (05:00 UTC) or chat `/career-ops ranker`:
1. Follow `modes/ranker.md`
2. `sync-discovered` → `queue` → evaluate top_k → mark states
3. Draft PR with reports + workflow.yml + tracker merges
4. Stop — no Packager / Form / Submit

## Ethical caps

- Never mass-apply; quality over quantity
- Never submit without human approval (`approve submit #N`)
- Strongly discourage applying when score &lt; 4.0
- Ranker processes at most `automation.ranker.top_k` (default 10) per run
- Submitter processes only `approved` jobs from `submit-queue`
