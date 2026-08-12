import {
  MAX_V1_SUBMISSION_ID_LENGTH,
  V1_SUBMISSION_STATUSES,
} from "@/lib/api/v1-contract";

export type V1SubmissionStatus = (typeof V1_SUBMISSION_STATUSES)[number];

type Failure = { status: number; code: string; message: string };

function invalid(message: string): { ok: false; error: Failure } {
  return { ok: false, error: { status: 400, code: "INVALID_QUERY", message } };
}

/**
 * Parse the additions that belong only to `/api/v1/submissions`.
 *
 * A `status` value can only narrow the existing event-scoped offset browse
 * read; it does not expose a new projection or a sync capability.
 */
export function parseV1SubmissionQuery(searchParams: URLSearchParams):
  | { ok: true; value: V1SubmissionStatus | null }
  | { ok: false; error: Failure } {
  const statusRaw = searchParams.get("status");
  if (statusRaw === null) return { ok: true, value: null };
  const status = V1_SUBMISSION_STATUSES.find((value) => value === statusRaw);
  return status
    ? { ok: true, value: status }
    : invalid(`Query parameter 'status' must be one of: ${V1_SUBMISSION_STATUSES.join(", ")}.`);
}

/** Bound a path id before it becomes a database predicate. */
export function parseV1SubmissionId(value: string):
  | { ok: true; value: string }
  | { ok: false; error: Failure } {
  return value.length > 0 && value.length <= MAX_V1_SUBMISSION_ID_LENGTH
    ? { ok: true, value }
    : invalid("Path parameter 'submissionId' is invalid.");
}
