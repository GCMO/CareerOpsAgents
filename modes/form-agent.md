# Mode: form-agent — Fill application forms to form_ready (P3)

Fills ATS application forms using packaged CV/CL + report answers. **HARD STOP before Apply / Submit / Send.**

Policy: `config/profile.yml` → `automation.submit_policy: human_approve_only`.

Extends interactive `modes/apply.md` (question detection + answer generation) with workflow state + browser fill + review pack.

## Prerequisites

Job must be `state: packaged` with:
- `artifacts.cv_pdf`
- `artifacts.cl_pdf`
- report path + apply URL

## Node helpers

```bash
node workflow-runner.mjs form-queue                 # packaged jobs awaiting form fill
node workflow-runner.mjs form-queue --ids id1,id2
node workflow-runner.mjs form-queue --nums 008,009
node workflow-runner.mjs form-ready --id ID \
  --answers batch/form/{num}-{slug}-answers.json \
  --screenshot batch/form/{num}-{slug}-form.png
node workflow-runner.mjs status
```

## Artifact paths

```
batch/form/{num}-{company-slug}-answers.json
batch/form/{num}-{company-slug}-form.png          # filled-form screenshot
batch/form/{num}-{company-slug}-review.md         # human review checklist
```

### answers.json schema

```json
{
  "id": "workflow-job-id",
  "report_num": "008",
  "company": "...",
  "role": "...",
  "url": "https://...",
  "cv_pdf": "output/008-…-cv.pdf",
  "cl_pdf": "output/008-…-cl.pdf",
  "fields": [
    { "label": "Why this role?", "type": "text", "value": "..." },
    { "label": "Salary expectation", "type": "text", "value": "60000 SEK/month" },
    { "label": "Work authorization", "type": "select", "value": "EU citizen / Sweden" },
    { "label": "Resume", "type": "upload", "value": "output/008-…-cv.pdf" },
    { "label": "Cover letter", "type": "upload", "value": "output/008-…-cl.pdf" }
  ],
  "blocked_submit": true,
  "notes": ["captcha not present", "login wall: none"]
}
```

## Agent workflow

1. `node workflow-runner.mjs form-queue` (or user: `form 142` / `form packaged`)
2. For each job:
   a. Load report, `cv.md`, profile, CL PDF path, CV PDF path
   b. Browser: navigate to apply URL (Playwright / cursor browser)
   c. Snapshot all visible fields (scroll until complete) — reuse `modes/apply.md` Pasos 1–5 for answer generation
   d. **Fill** text, textareas, selects, checkboxes; **upload** CV/CL when upload fields exist
   e. Save `answers.json` + filled-form **screenshot** + short `review.md`
   f. **HARD STOP** — never click controls whose label/name/aria matches:

| Block patterns (case-insensitive) |
|-----------------------------------|
| `submit` · `apply` · `send application` · `send` · `finish application` · `complete application` |
| Swedish: `skicka` · `ansök` · `skicka ansökan` · `skicka in` |

   g. If only a single primary CTA exists and it is Submit — **do not click**; leave form filled and stop
   h. `node workflow-runner.mjs form-ready --id {id} --answers {path} --screenshot {path}`
3. Notify user:

```
Form ready: #{num} {company} — {role}
CV: {cv_pdf}
CL: {cl_pdf}
Answers: {answers.json}
Screenshot: {screenshot}
Reply: approve submit #{num}   ← only then may Submitter click Apply
```

## Chat commands

| Command | Action |
|---------|--------|
| `form 142` / `form packaged` | Run Form Agent on those / all packaged |
| `approve submit #142` | Hand off to Submitter (P4) — **not** Form Agent |

## Blockers → stop and report

- Login / SSO wall
- CAPTCHA / Cloudflare
- File input that cannot be automated
- Multi-step wizard where next step is indistinguishable from submit

Set notes on the job; leave state as `packaged` (or `form_ready` only if fill is complete and screenshot saved). Prefer staying `packaged` if fill incomplete.

## Ethical caps

- One form at a time unless user lists multiple nums
- Never mass-submit
- Never click Apply/Submit/Send in this mode
