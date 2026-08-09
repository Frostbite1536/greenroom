# Reimbursement claim and cost evidence

## Claim status

This is the evidence structure for the competition's reimbursable token-cost
claim (up to $500, subject to the organizer's terms). It is deliberately not an
invoice and does not invent a claim total. The final requested amount must be
the applicable paid subscription cost supported by private billing evidence,
not an API-equivalent telemetry estimate.

## Private subscription proof to attach at submission

Attach these items to the reimbursement submission, rather than committing them
to this public repository:

1. The account holder's OpenAI subscription invoice or receipt for the billing
   period that covers the Greenroom work, showing plan, date, and paid amount.
2. Any separate Anthropic subscription invoice, usage export, or other provider
   receipt that the account holder asks to include in the claim.
3. A short statement identifying the requested amount and the relevant billing
   period, capped by the organizer's reimbursement limit.

Do not attach API keys, full payment details, account identifiers, or raw
provider credentials. The repository intentionally contains no invoice amount
or customer billing data.

## Telemetry context — estimates, not charges

The OpenAI/Codex telemetry snapshot was captured by the orchestrator at
2026-08-08 10:26:48 CT. It applies published API rates to recorded token
categories to make usage transparent. These figures are **API-equivalent
estimates**, not an actual provider bill and not the reimbursement amount.

| Session | Model | Recorded tokens | API-equivalent estimate |
| --- | --- | ---: | ---: |
| Orchestrator | GPT-5.6 Sol, xhigh | 88,022,819 | $59.11 |
| Backend | GPT-5.6 Terra, high | 26,522,809 | $7.49 |
| Frontend | GPT-5.6 Terra, high | 21,798,384 | $6.94 |
| Ops | GPT-5.6 Terra, high | 22,052,986 | $6.77 |
| **Snapshot total** |  | **158,396,998** | **$80.31** |

The source is the archived `TOKEN-COSTS-CODEX.md` telemetry export maintained
with the sprint coordination records. The snapshot excludes 29,641,324 tokens
from an unpriced `codex-auto-review` process, and the orchestrator was still
active when it was captured. Consequently, **do not treat $80.31 as a final
total, invoice, or reimbursement request**.

Separate Claude/pi work is not combined into the table: its per-session
telemetry and subscription evidence are incomplete and must be refreshed from
the account holder's records. This prevents an unsupported cross-provider total
or double count.

## Freeze checklist

Before submitting the reimbursement request:

- refresh the Codex telemetry snapshot and record its capture time;
- replace any incomplete Claude/pi telemetry with a dated account export or
  state that it is excluded;
- attach the private subscription invoice(s) and calculate the requested amount
  from those paid charges, never from the estimate table alone;
- confirm the resulting request is within the organizer's cap; and
- keep the final evidence bundle private while leaving this methodology public.
