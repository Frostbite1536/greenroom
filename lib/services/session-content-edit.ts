import type { Prisma } from "@prisma/client";
import type { SessionUpdateInput } from "@/types/api";

/**
 * What `PATCH /api/agenda/sessions` writes, decided in one testable place.
 *
 * The route used to carry its whole write in the literal
 * `data: { contentStatus: input.contentStatus }`, which a source test could pin
 * exactly. A sparse patch cannot be a literal, so the projection moves here and
 * is asserted against behaviour instead: the keys this returns are the only
 * columns the route can write, and a body that names nothing returns `{}` (the
 * contract refuses that body before it gets here — see `sessionUpdateSchema`).
 *
 * Absent means untouched. `undefined` is therefore never written: Prisma treats
 * an `undefined` value as "no change", but relying on that would make the
 * response projection and the `updatedAt` bump depend on a driver detail rather
 * than on a decision, so the keys simply are not added.
 *
 * `Prisma.SessionUncheckedUpdateInput` rather than the checked shape because
 * `categoryId` is written as a scalar. The id is authorized against this event
 * in the route's transaction (404 `CATEGORY_NOT_FOUND`) — this function only
 * decides which columns move, never whose rows they may point at.
 */
export function sessionUpdateData(input: SessionUpdateInput): Prisma.SessionUncheckedUpdateInput {
  const data: Prisma.SessionUncheckedUpdateInput = {};
  if (input.contentStatus !== undefined) data.contentStatus = input.contentStatus;
  if (input.title !== undefined) data.title = input.title;
  // A blank textarea is a cleared field, not a talk whose summary is the empty
  // string: `Session.description` is nullable and "absent" is the state the
  // public programme and every export already know how to render.
  if (input.description !== undefined) data.description = blankToNull(input.description);
  if (input.format !== undefined) data.format = blankToNull(input.format);
  if (input.durationMinutes !== undefined) data.durationMinutes = input.durationMinutes;
  if (input.categoryId !== undefined) data.categoryId = input.categoryId;
  return data;
}

/** The contract already trims; this is only about "" meaning "no value". */
function blankToNull(value: string | null): string | null {
  return value === null || value.trim() === "" ? null : value;
}
