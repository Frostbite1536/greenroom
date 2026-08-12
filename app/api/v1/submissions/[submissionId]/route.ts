import { prisma } from "@/lib/prisma";
import {
  authorizeV1EventScope,
  authorizeV1Request,
  handleV1,
  parseV1EventQuery,
  v1Error,
  v1EventWhere,
  v1ItemResponse,
} from "@/lib/api/v1";
import { serializeV1Submission } from "@/lib/api/v1-serialize";
import { parseV1SubmissionId } from "@/lib/api/v1-submission-query";
import { v1SubmissionSelect } from "@/lib/api/v1-submission-select";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Params = { params: Promise<{ submissionId: string }> };

/** GET /api/v1/submissions/:submissionId?event=<slug|id> */
export const GET = handleV1(async (req: Request, { params }: Params): Promise<Response> => {
  const authorization = await authorizeV1Request(req.headers);
  if (!authorization.ok) return v1Error(authorization.error);

  const query = parseV1EventQuery(new URL(req.url).searchParams);
  if (!query.ok) return v1Error(query.error);
  const { submissionId } = await params;
  const parsedId = parseV1SubmissionId(submissionId);
  if (!parsedId.ok) return v1Error(parsedId.error);

  const selected = await prisma.event.findFirst({
    where: v1EventWhere(authorization.scope, query.value.event),
    select: { id: true, name: true, slug: true, timezone: true },
  });
  const scoped = authorizeV1EventScope(authorization.scope, selected);
  if (!scoped.ok) return v1Error(scoped.error);

  const submission = await prisma.abstract.findFirst({
    where: { id: parsedId.value, eventId: scoped.event.id },
    select: v1SubmissionSelect,
  });
  if (!submission) {
    return v1Error({ status: 404, code: "SUBMISSION_NOT_FOUND", message: "Submission not found." });
  }
  return v1ItemResponse(serializeV1Submission(submission), scoped.event);
});
