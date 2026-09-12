# Mode: submitter — HITL Apply/Submit only (P4)

Clicks Apply/Submit **only** after explicit human approval. Never runs on `form_ready` alone.

Policy: `config/profile.yml` → `automation.submit_policy: human_approve_only`.

## Prerequisites

| State | Meaning |
|-------|---------|
| `form_ready` | Form filled; awaiting human review |
| `approved` | Human ran `approve submit #{num}` |
| `submitted` | Confirmation captured; tracker → Applied |

## Node helpers

```bash
# Human (or agent on explicit chat command):
node workflow-runner.mjs approve --num 142
node workflow-runner.mjs approve --id JOB_ID

# Agent after approval:
node workflow-runner.mjs submit-queue
node workflow-runner.mjs submit-done --id ID \
  --confirmation-url "https://..." \
  --screenshot batch/form/{num}-{slug}-submitted.png \
  [--notes "confirmation page text"]

# Optional revoke before click:
node workflow-runner.mjs revoke-approve --num 142
```

## Chat commands

| Command | Action |
|---------|--------|
| `approve submit #142` | `approve --num 142` → state `approved` |
| `revoke approve #142` | back to `form_ready` |
| `/career-ops submitter` | Process `submit-queue` (approved only) |

## Agent workflow

1. Confirm trigger is explicit approval (`approve submit #N` or jobs already `approved`)
2. `node workflow-runner.mjs submit-queue` — **empty queue = stop** (do not invent approvals)
3. For each approved job:
   a. Open the same apply URL / form session (Playwright)
   b. Verify filled fields still present; re-upload CV/CL if the ATS cleared them
   c. Click the Apply/Submit/Send/Skicka/Ansök control **once**
   d. Wait for confirmation page or success toast
   e. Capture confirmation URL + screenshot
   f. `node workflow-runner.mjs submit-done --id … --confirmation-url … --screenshot …`
4. Runner sets `submitted` and updates `data/applications.md` status → **Applied** when a matching report row exists
5. Notify user with confirmation link + screenshot path
6. Suggest `/career-ops followup` or `contacto` — do not send outreach automatically

## Blockers → do not force submit

- CAPTCHA / Cloudflare / MFA
- Login expired
- Form validation errors
- Confirmation page never appears after click

Revert or leave as `approved`, report blocker, ask user to finish manually. If partially broken, `revoke-approve` → `form_ready`.

## Hard rules

- **No approval → no click.** `submit-queue` ignores `form_ready` / `packaged` / `evaluated`
- One submission per job unless user re-approves after a failed attempt
- Never batch-approve; each `approve submit #N` is per report number
- Quality: if score &lt; 4.0, refuse approve/submit and warn
