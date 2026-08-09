export const CFP_DRAFT_RECOVERY_VERSION = 1;
const STORAGE_PREFIX = "greenroom.cfp.draft.v1";

export type DraftRecoveryMetadata = {
  version: typeof CFP_DRAFT_RECOVERY_VERSION;
  formConfigId: string;
  abstractId: string;
  capability: string;
  draftRevision: number;
};

export type DraftRecoveryLink = Pick<DraftRecoveryMetadata, "abstractId" | "capability">;

export type DraftRecoveryStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isDraftRecoveryMetadata(value: unknown, formConfigId: string): value is DraftRecoveryMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === CFP_DRAFT_RECOVERY_VERSION
    && record.formConfigId === formConfigId
    && isNonEmptyString(record.abstractId)
    && isNonEmptyString(record.capability)
    && typeof record.draftRevision === "number"
    && Number.isSafeInteger(record.draftRevision)
    && record.draftRevision >= 1
  );
}

/** Versioned and form-scoped so one public CFP never resumes another's draft. */
export function draftRecoveryStorageKey(formConfigId: string): string {
  return `${STORAGE_PREFIX}:${formConfigId}`;
}

/**
 * Recovery storage deliberately contains only the opaque recovery metadata.
 * Browser storage can throw (disabled/quota/privacy mode), so all access is
 * best-effort and a failed read never blocks ordinary public submission.
 */
export function readDraftRecovery(
  storage: DraftRecoveryStorage | null | undefined,
  formConfigId: string,
): DraftRecoveryMetadata | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(draftRecoveryStorageKey(formConfigId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isDraftRecoveryMetadata(parsed, formConfigId) ? parsed : null;
  } catch (error) {
    // Never log the form-scoped key or metadata: browser storage errors can be
    // diagnosed with this bounded operation label and the original error only.
    console.error("CFP draft recovery storage read failed", error);
    return null;
  }
}

export function writeDraftRecovery(
  storage: DraftRecoveryStorage | null | undefined,
  metadata: DraftRecoveryMetadata,
): boolean {
  if (!storage || !isDraftRecoveryMetadata(metadata, metadata.formConfigId)) return false;
  try {
    // Construct the persisted record explicitly: never add speaker or answer
    // values here, even if the component's draft state grows in the future.
    storage.setItem(draftRecoveryStorageKey(metadata.formConfigId), JSON.stringify({
      version: CFP_DRAFT_RECOVERY_VERSION,
      formConfigId: metadata.formConfigId,
      abstractId: metadata.abstractId,
      capability: metadata.capability,
      draftRevision: metadata.draftRevision,
    }));
    return true;
  } catch (error) {
    console.error("CFP draft recovery storage write failed", error);
    return false;
  }
}

export function clearDraftRecovery(
  storage: DraftRecoveryStorage | null | undefined,
  formConfigId: string,
): void {
  if (!storage) return;
  try {
    storage.removeItem(draftRecoveryStorageKey(formConfigId));
  } catch (error) {
    console.error("CFP draft recovery storage clear failed", error);
  }
}

/** Canonical fragment form; capabilities never enter a query string. */
export function draftRecoveryHash(link: DraftRecoveryLink): string {
  return `#draft=${encodeURIComponent(link.abstractId)}&cap=${encodeURIComponent(link.capability)}`;
}

/** Any draft/cap fragment is sensitive, even if it is malformed or duplicated. */
export function hasDraftRecoveryHash(hash: string): boolean {
  if (!hash.startsWith("#")) return false;
  const params = new URLSearchParams(hash.slice(1));
  return params.has("draft") || params.has("cap");
}

/** Reject partial, duplicated, or unrelated fragments rather than guessing. */
export function parseDraftRecoveryHash(hash: string): DraftRecoveryLink | null {
  if (!hasDraftRecoveryHash(hash)) return null;
  const params = new URLSearchParams(hash.slice(1));
  if (
    params.size !== 2
    || params.getAll("draft").length !== 1
    || params.getAll("cap").length !== 1
  ) {
    return null;
  }
  const abstractId = params.get("draft");
  const capability = params.get("cap");
  return isNonEmptyString(abstractId) && isNonEmptyString(capability)
    ? { abstractId, capability }
    : null;
}

/** The safe replacement target always removes the capability-bearing fragment. */
export function withoutDraftRecoveryHash(pathname: string, search: string): string {
  return `${pathname}${search}`;
}

/** A later edit must always win over a delayed recovery response. */
export function shouldApplyRecoveredDraft(
  editVersionAtRequest: number,
  currentEditVersion: number,
): boolean {
  return editVersionAtRequest === currentEditVersion;
}
