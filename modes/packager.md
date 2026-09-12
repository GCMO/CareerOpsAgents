# Mode: packager — CV + Cover Letter PDFs (P2)

Builds application packs for evaluated (or override) jobs. Writes PDFs under `output/`. Does **not** fill forms or submit.

Policy: `config/profile.yml` → `automation.cover_letter` + `modes/_profile.md` CL quality gate.

## Artifact paths

```
output/{num}-{company-slug}-cv.pdf
output/{num}-{company-slug}-cl.pdf
```

Optional intermediates:
```
batch/package/{num}-{company-slug}-cl.json
output/{num}-{company-slug}-cl.html
```

## Node helpers

```bash
node workflow-runner.mjs package-queue              # eligible ≥4.5 + optional --ids / --nums
node workflow-runner.mjs package-queue --override 142,155   # include 4.0–4.4 band
node render-cl.mjs batch/package/{num}-…-cl.json output/{num}-…-cl.pdf
node workflow-runner.mjs package-done --id ID --cv PATH --cl PATH
node workflow-runner.mjs status
```

## When to package

| Score | Action |
|-------|--------|
| ≥ 4.5 | Auto-eligible (`package_queued` / package-queue) |
| 4.0–4.4 | Only if user says `package {num…}` / `--override` |
| &lt; 4.0 | Do not package |

## Agent workflow

1. Resolve targets: user `package 142 155` **or** `node workflow-runner.mjs package-queue`
2. For each job, load: report, JD (from report URL), `cv.md`, `modes/_profile.md`, `config/profile.yml`
3. **CV PDF**
   - Follow `modes/pdf.md` (keyword injection from truth only)
   - Prefer GOCV visual language (see `output/gocv-waitwhile.html` layout: teal header, monospace body) when producing HTML; otherwise `templates/cv-template.html`
   - Write `output/{num}-{company-slug}-cv.pdf` via `node generate-pdf.mjs … --format=a4`
4. **Cover letter PDF**
   - Write JSON for `render-cl.mjs` using CL26 skeleton:
     - Object / Date / Att.
     - Opening
     - **Am I a good fit?**
     - **What will I bring?** (bullets)
     - Closing + contact
   - **Quality gate — all four required in body + `gate` phrases:**
     1. Employer-specific **JD requirements**
     2. **Product** (what they build / sell)
     3. **Stack** (mapped to React/Next.js/TS/Node proof)
     4. **Location policy** (Stockholm hybrid / remote worldwide rules)
   - Company name must appear in the letter body (reject rename-only templates)
   - `gate` arrays must list concrete phrases that appear in the letter
   - Run: `node render-cl.mjs {json} output/{num}-{company-slug}-cl.pdf`
   - Exit code 2 → regenerate (do not mark packaged)
5. `node workflow-runner.mjs package-done --id {id} --cv {cv.pdf} --cl {cl.pdf}`
6. Notify user with paths + score + “next: `/career-ops apply` or wait for P3 Form Agent. Submit only after `approve submit #{num}`.”

## Chat commands

- `package 142 155` — package those report nums (override OK for 4.0–4.4)
- `package eligible` — all ≥4.5 evaluated jobs not yet packaged

## Hard stops

- Never Apply/Submit
- Never invent metrics — only `cv.md` / `article-digest.md`
- Never ship a CL that would still read as valid if the company name were swapped
