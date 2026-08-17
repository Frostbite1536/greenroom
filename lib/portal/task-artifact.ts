/**
 * A task deliverable's address, with no database and no request in it.
 *
 * `SpeakerTask.artifactUrl` has always held one string, and it still holds one
 * string: either an absolute link the speaker pasted, or this app's own
 * `/api/files/<id>` path for a file they uploaded. That choice — one column
 * filled two ways rather than a second column — is the same one the profile's
 * `headshotUrl`/`slideDeckUrl` already made, and it is what lets every existing
 * reader of `artifactUrl` keep working untouched.
 *
 * Two decisions live here because both are pure and both would otherwise be
 * duplicated between a client island and a server route:
 *
 *   1. Which key a save sends. A relative `/api/files/<id>` cannot go through
 *      `artifactUrl`, because the shared contract validates that key with
 *      `z.string().url()` (`types/api.ts`, Architect-owned) and a path is not a
 *      URL. So an uploaded file travels as `artifactFileId` and the SERVER
 *      writes the path, after verifying the row is the caller's own. The client
 *      never gets to name the string that lands in the column.
 *
 *   2. Whether a stored value may become an `href`. Nothing rendered
 *      `artifactUrl` before this change, so this is the first surface to do it
 *      — and `z.string().url()` accepts `javascript:alert(1)`, which the repo
 *      documents as GRA2-07 and re-filters at each renderer rather than at the
 *      schema. This follows that established shape (`safePublicImageUrl` in
 *      `lib/public-speakers.ts`): a stored-file path, or an http(s) URL, or not
 *      a link at all.
 */
import { isHttpUrl } from "@/lib/form-logic";
import { isStoredFilePath, storedFileIdFromPath } from "@/lib/uploads/stored-file";

/**
 * What a save should send for the one artifact field the speaker edited.
 *
 * The portal keeps ONE text input. Uploading fills it with the served path,
 * exactly as the profile form's uploader fills the field beside it; pasting a
 * link fills it with a link. This function reads whichever the field now holds
 * and picks the key that can carry it.
 *
 * An empty field returns `{}` — no key at all. That is not a way to CLEAR the
 * artifact, and deliberately does not pretend to be one: the task route writes
 * `artifactUrl: artifactUrl ?? undefined`, so an omitted key has always
 * preserved the stored value and there has never been a clear. Sending `""`
 * instead would fail the contract's `.url()` and surface as a 422 on an
 * otherwise valid save, which is worse than the honest no-op.
 */
export type TaskArtifactSubmission =
  | { artifactFileId: string }
  | { artifactUrl: string }
  | Record<string, never>;

export function taskArtifactSubmission(value: string | null | undefined): TaskArtifactSubmission {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return {};
  const fileId = storedFileIdFromPath(trimmed);
  if (fileId) return { artifactFileId: fileId };
  return { artifactUrl: trimmed };
}

/**
 * The `href` a stored artifact may be rendered with, or null when it may not be
 * a link at all.
 *
 * Null is a rendering instruction, not an error: the caller shows the raw string
 * as text instead. A speaker who pasted something odd should still be able to
 * see what they pasted, and an organizer should still be able to read it — what
 * neither should get is a clickable non-http scheme on the app's own page.
 */
export function taskArtifactHref(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (isStoredFilePath(trimmed)) return trimmed;
  return isHttpUrl(trimmed) ? trimmed : null;
}

/** True when this artifact is a file held by this app rather than a link away. */
export function isUploadedTaskArtifact(value: string | null | undefined): boolean {
  return isStoredFilePath(typeof value === "string" ? value.trim() : value);
}

/**
 * How an artifact is described in a list — to the speaker who handed it over
 * and to the organizer chasing it. An uploaded file and a pasted link are not
 * the same kind of thing and are not labelled as though they were.
 */
export function taskArtifactLabel(value: string | null | undefined): string {
  return isUploadedTaskArtifact(value) ? "Uploaded file" : "Link";
}
