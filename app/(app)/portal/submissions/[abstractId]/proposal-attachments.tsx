"use client";

import { useCallback, useEffect, useState } from "react";
import { FileStack, Lock, Paperclip, X } from "lucide-react";
import { FileUploadField } from "@/components/file-upload-field";
import {
  MAX_ATTACHMENTS_PER_ABSTRACT,
  formatAttachmentSize,
  type AttachmentView,
} from "@/lib/uploads/abstract-attachment";
import { storedFilePath } from "@/lib/uploads/stored-file";
import styles from "../../portal.module.css";

/**
 * Supporting documents on one proposal, from the speaker's side.
 *
 * Two steps, deliberately: the file is stored by the EXISTING upload route
 * (`FileUploadField` → `POST /api/files?kind=supporting-document`, which does
 * the sniffing, the 5 MiB cap, the rate buckets and the dedupe), and then this
 * island links the returned id to the proposal. Nothing about the upload
 * pipeline was forked to make that work.
 *
 * The server is authoritative for every rule here. `editable` and each row's
 * `canOpen`/`canRemove` are computed server-side by the same functions the API
 * refuses with, so this component never decides who may do what — it only
 * renders the answer. A control that is hidden here is still refused there.
 */
export function ProposalAttachments({ abstractId }: { abstractId: string }) {
  const [attachments, setAttachments] = useState<AttachmentView[] | null>(null);
  const [editable, setEditable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [attaching, setAttaching] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/cfp/submissions/${abstractId}/attachments`);
      const body = await res.json();
      if (!body?.ok) {
        setError(body?.error?.message ?? "Could not load your supporting documents.");
        return;
      }
      setAttachments(body.data.attachments as AttachmentView[]);
      setEditable(Boolean(body.data.editable));
      setError(null);
    } catch (caught) {
      console.warn(
        "Supporting document list failed",
        caught instanceof Error ? caught.name : "unknown",
      );
      setError("Network error while loading your supporting documents.");
    }
  }, [abstractId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (cancelled) return;
      await load();
    })();
    return () => { cancelled = true; };
  }, [load]);

  async function attach(storedFileId: string, filename: string) {
    setAttaching(true);
    setError(null);
    try {
      const res = await fetch(`/api/cfp/submissions/${abstractId}/attachments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storedFileId, filename }),
      });
      const body = await res.json();
      if (!body?.ok) {
        setError(body?.error?.message ?? "Could not attach that document.");
        return;
      }
      // Re-read rather than splice the response in: the list is short, and a
      // refetch is the only version of it that also reflects a co-speaker's
      // concurrent attach.
      await load();
    } catch (caught) {
      console.warn(
        "Supporting document attach failed",
        caught instanceof Error ? caught.name : "unknown",
      );
      setError("Network error while attaching that document.");
    } finally {
      setAttaching(false);
    }
  }

  async function remove(attachmentId: string) {
    setBusyId(attachmentId);
    setError(null);
    try {
      const res = await fetch(`/api/cfp/submissions/${abstractId}/attachments/${attachmentId}`, {
        method: "DELETE",
      });
      const body = await res.json();
      if (!body?.ok) {
        setError(body?.error?.message ?? "Could not remove that document.");
        return;
      }
      await load();
    } catch (caught) {
      console.warn(
        "Supporting document removal failed",
        caught instanceof Error ? caught.name : "unknown",
      );
      setError("Network error while removing that document.");
    } finally {
      setBusyId(null);
    }
  }

  if (attachments === null) {
    return (
      <div className={styles.field}>
        <span className="field-label">Supporting documents</span>
        <p className={styles.empty} role="status">Loading your supporting documents…</p>
      </div>
    );
  }

  const atLimit = attachments.length >= MAX_ATTACHMENTS_PER_ABSTRACT;

  return (
    <div className={styles.field}>
      <span className="field-label">Supporting documents</span>
      <p className="hint">
        Anything that helps the program team read your proposal — a draft paper, a demo script, a
        letter of support. PDF, up to {MAX_ATTACHMENTS_PER_ABSTRACT} per proposal. Only you and the
        organizers of this event can open what you upload.
      </p>

      {attachments.length === 0 ? (
        <p className={styles.empty}>No supporting documents yet.</p>
      ) : (
        <ul className={styles.taskList}>
          {attachments.map((attachment) => (
            <li className={styles.sessionItem} key={attachment.id}>
              <div className={styles.sessionTitle}>
                <FileStack size={14} aria-hidden="true" />{" "}
                {attachment.canOpen ? (
                  <a href={storedFilePath(attachment.storedFileId)}>{attachment.filename}</a>
                ) : (
                  attachment.filename
                )}
              </div>
              <p className={styles.sessionMeta}>
                {formatAttachmentSize(attachment.size)} · added by {attachment.uploadedByName}
              </p>
              {/* Honest rather than convenient: a co-speaker may see that a
                  document exists on the shared proposal, but the bytes stay
                  private to whoever uploaded them and this event's organizers.
                  Rendering a link that answers 404 would be the alternative. */}
              {attachment.canOpen ? null : (
                <p className={styles.sessionMeta}>
                  <Lock size={12} aria-hidden="true" /> Only {attachment.uploadedByName} and the
                  organizers can open this.
                </p>
              )}
              {attachment.canRemove ? (
                <button
                  className="icon-button"
                  type="button"
                  disabled={busyId !== null || attaching}
                  onClick={() => void remove(attachment.id)}
                  aria-label={`Remove ${attachment.filename}`}
                >
                  <X size={15} aria-hidden="true" />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {editable && !atLimit ? (
        <FileUploadField
          kind="SUPPORTING_DOCUMENT"
          label="Add a supporting document"
          hint="PDF."
          pairsWithUrlField={false}
          disabled={attaching || busyId !== null}
          onUploaded={(_url, stored) => {
            if (stored) void attach(stored.id, stored.filename);
          }}
        />
      ) : null}

      {editable && atLimit ? (
        <p className="hint">
          <Paperclip size={13} aria-hidden="true" /> This proposal already has the maximum of{" "}
          {MAX_ATTACHMENTS_PER_ABSTRACT} supporting documents. Remove one to add another.
        </p>
      ) : null}

      {editable ? null : (
        <p className="hint">
          <Lock size={13} aria-hidden="true" /> This proposal can no longer be edited, so its
          supporting documents are fixed.
        </p>
      )}

      {attaching ? <p className="hint" role="status">Attaching…</p> : null}
      {error ? <p className={styles.saveError} role="alert">{error}</p> : null}
    </div>
  );
}
