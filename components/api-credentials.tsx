"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Ban, Check, Copy, KeyRound, Plus } from "lucide-react";
import { apiDelete, apiPost, firstFieldErrors } from "@/lib/api-client";
// The PURE contract module, never `lib/services/api-credential` itself: that
// one imports `node:crypto` and has no business in a client bundle.
import { MAX_API_CREDENTIAL_LABEL_LENGTH } from "@/lib/services/api-credential-contract";
import type { ApiResponse } from "@/types/api";
import { EmptyState, Pill } from "@/components/ui";

/**
 * The event's API-access panel: issue, list, and revoke per-event keys for the
 * read-only v1 API (docs/ROADMAP.md, "Scoped credentials").
 *
 * Three deliberate choices about the secret:
 *
 * 1. The issued token lives in component state for the life of one dialog and
 *    nowhere else. It is never written to storage, never put in a URL, never
 *    passed to `console`, and never sent back to the server. Closing the dialog
 *    drops it, which is exactly what "shown once" has to mean.
 * 2. The panel loads its own list rather than riding the page's RSC payload.
 *    That keeps `EventSettingsView` — and therefore every render of this page —
 *    free of credential metadata, and lets the fetch be `no-store`.
 * 3. Revocation addresses the credential by `id`. The token is never a route
 *    parameter, so no credential material can reach an access log or a
 *    `Referer` header.
 */

type Credential = {
  id: string;
  label: string;
  tokenPrefix: string;
  createdAt: string;
  revokedAt: string | null;
  createdBy: string | null;
};

type CredentialList = {
  credentials: Credential[];
  truncated: boolean;
  activeLimit: number;
};

type IssuedCredential = { credential: Credential; token: string };

const ENDPOINT = "/api/admin/api-keys";

function formatDate(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? "—"
    : parsed.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function ApiCredentials() {
  const ids = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const labelRef = useRef<HTMLInputElement>(null);
  const tokenField = useRef<HTMLInputElement>(null);

  const [list, setList] = useState<CredentialList | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [issued, setIssued] = useState<IssuedCredential | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "manual">("idle");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const res = await fetch(ENDPOINT, { cache: "no-store", headers: { Accept: "application/json" } });
      const body = (await res.json()) as ApiResponse<CredentialList>;
      if (!body.ok) {
        setListError(body.error.message);
        return;
      }
      setListError(null);
      setList(body.data);
    } catch (error) {
      // Only the error's name: nothing from this panel's payload is ever an
      // argument to a log call.
      console.warn("API key list failed", error instanceof Error ? error.name : "unknown");
      setListError("Could not load this event's API keys. Reload the page to try again.");
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      // showModal() gives the focus trap, Esc handling and inert background for
      // free — the same precedent as the new-event dialog.
      dialog.showModal();
      labelRef.current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  function closeDialog() {
    setOpen(false);
    setLabel("");
    setCreateError(null);
    setCreating(false);
    setCopyState("idle");
    // The only copy of the token the browser held. Closing is what makes
    // "shown only once" true rather than merely advertised.
    setIssued(null);
  }

  async function create() {
    const trimmed = label.trim();
    if (!trimmed) {
      setCreateError("Give the key a name.");
      return;
    }
    setCreating(true);
    setCreateError(null);
    const res = await apiPost<IssuedCredential>(ENDPOINT, { label: trimmed });
    setCreating(false);
    if (!res.ok) {
      const fields = firstFieldErrors(res.error.fieldErrors);
      setCreateError(fields.label ?? res.error.message);
      return;
    }
    setIssued(res.data);
    setCopyState("idle");
    void reload();
  }

  /** Success is claimed only after the clipboard write actually resolves. */
  async function copyToken(value: string) {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(value);
      setCopyState("copied");
    } catch (error) {
      console.warn("API key copy failed", error instanceof Error ? error.name : "unknown");
      setCopyState("manual");
      tokenField.current?.focus();
      tokenField.current?.select();
    }
  }

  async function revoke(credential: Credential) {
    if (
      !window.confirm(
        `Revoke “${credential.label}”? Anything using this key stops working immediately, and the key cannot be restored.`,
      )
    ) {
      return;
    }
    setBusy(credential.id);
    setRowError(null);
    setNotice(null);
    const res = await apiDelete<{ credential: Credential }>(
      `${ENDPOINT}?id=${encodeURIComponent(credential.id)}`,
    );
    setBusy(null);
    if (!res.ok) {
      setRowError(res.error.message);
      return;
    }
    setNotice(`Revoked ${res.data.credential.label}.`);
    void reload();
  }

  const credentials = list?.credentials ?? [];
  const activeCount = credentials.filter((credential) => credential.revokedAt === null).length;
  const atLimit = list !== null && activeCount >= list.activeLimit;

  return (
    <div className="settings-grid">
      <section className="card settings-card" aria-labelledby="api-access-heading">
        <div className="settings-heading">
          <div className="settings-icon"><KeyRound size={18} aria-hidden="true" /></div>
          <div>
            <h2 id="api-access-heading">API access</h2>
            <p>
              Keys let another system read this event&rsquo;s proposals, speakers and published
              schedule through the read-only API. A key reaches this event and no other, and you can
              revoke one at any time.
            </p>
          </div>
        </div>

        <div className="row wrap">
          <button
            className="primary-button"
            type="button"
            disabled={atLimit}
            style={{ display: "inline-flex", alignItems: "center", gap: 7 }}
            onClick={() => {
              setIssued(null);
              setCreateError(null);
              setLabel("");
              setOpen(true);
            }}
          >
            <Plus size={16} aria-hidden="true" /> New API key
          </button>
          {atLimit ? (
            <span className="hint">
              This event has its maximum of {list?.activeLimit} active keys. Revoke one to create another.
            </span>
          ) : null}
        </div>

        {listError ? <p className="field-error" role="alert">{listError}</p> : null}
        {rowError ? <p className="field-error" role="alert">{rowError}</p> : null}
        {notice ? <p className="settings-notice" role="status" aria-live="polite">{notice}</p> : null}
        {list?.truncated ? (
          <p className="hint">
            Showing the {credentials.length} most recent keys. Older revoked keys are not listed.
          </p>
        ) : null}

        {list === null ? (
          <p className="hint">Loading this event&rsquo;s API keys…</p>
        ) : credentials.length === 0 ? (
          <EmptyState icon={<KeyRound size={22} aria-hidden="true" />} title="No API keys yet">
            Create one when another system needs to read this event&rsquo;s program.
          </EmptyState>
        ) : (
          <div className="table-scroll settings-table-scroll">
            <table className="data-table">
              <caption className="sr-only">API keys issued for this event</caption>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Key</th>
                  <th scope="col">Created</th>
                  <th scope="col">Status</th>
                  <th scope="col"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {credentials.map((credential) => (
                  <tr key={credential.id}>
                    <td>{credential.label}</td>
                    {/* The stored display prefix, never the key itself: the rest
                        of the value does not exist on the server to show. */}
                    <td><span className="api-credential-prefix">{credential.tokenPrefix}…</span></td>
                    <td>
                      {formatDate(credential.createdAt)}
                      {credential.createdBy ? <span className="muted"> · {credential.createdBy}</span> : null}
                    </td>
                    <td>
                      {credential.revokedAt === null ? (
                        <Pill tone="good">Active</Pill>
                      ) : (
                        <Pill tone="neutral">Revoked {formatDate(credential.revokedAt)}</Pill>
                      )}
                    </td>
                    <td>
                      <div className="row settings-row-actions">
                        {credential.revokedAt === null ? (
                          <button
                            className="ghost-button danger-button"
                            type="button"
                            disabled={busy === credential.id}
                            onClick={() => void revoke(credential)}
                          >
                            <Ban size={14} aria-hidden="true" />
                            {busy === credential.id ? "Revoking…" : "Revoke"}
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <dialog
        ref={dialogRef}
        className="app-dialog api-credential-dialog"
        aria-labelledby={`${ids}-title`}
        onClose={closeDialog}
        onCancel={closeDialog}
        onMouseDown={(event) => {
          if (event.target === dialogRef.current) closeDialog();
        }}
      >
        {issued ? (
          <div>
            <h2 id={`${ids}-title`}>API key created</h2>
            <div className="api-credential-reveal">
              <label className="stack" htmlFor={`${ids}-token`}>
                <span className="field-label">{issued.credential.label}</span>
                <input
                  ref={tokenField}
                  id={`${ids}-token`}
                  className="text-input"
                  readOnly
                  spellCheck={false}
                  value={issued.token}
                  onFocus={(event) => event.currentTarget.select()}
                />
              </label>
              <div className="row wrap">
                <button className="link-button" type="button" onClick={() => void copyToken(issued.token)}>
                  {copyState === "copied" ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
                  {copyState === "copied" ? "Key copied" : "Copy key"}
                </button>
                <span className="hint" role="status" aria-live="polite">
                  {copyState === "manual"
                    ? "Clipboard blocked by the browser — the key is selected, press Ctrl/Cmd + C."
                    : copyState === "copied"
                      ? "Paste it into the system that needs it now."
                      : ""}
                </span>
              </div>
              <p className="hint">
                <strong>This key is shown only once.</strong> It is stored here only as a one-way
                hash, so nobody — including you — can read it again after you close this dialog.
                Copy it now; if you lose it, revoke this key and create another.
              </p>
            </div>
            <div className="row wrap" style={{ justifyContent: "flex-end", marginTop: 22 }}>
              <button className="primary-button" type="button" onClick={closeDialog}>
                I have copied it
              </button>
            </div>
          </div>
        ) : (
          <form
            method="dialog"
            onSubmit={(event) => {
              event.preventDefault();
              create().catch((error) => {
                console.warn("API key creation failed", error instanceof Error ? error.name : "unknown");
                setCreating(false);
                setCreateError("Could not create the key. Check your connection and try again.");
              });
            }}
          >
            <h2 id={`${ids}-title`}>New API key</h2>
            <p className="hint">
              Name it after the system that will use it, so you know what you are switching off when
              you revoke it. The key is shown once, immediately after you create it.
            </p>

            {createError ? (
              <p className="conflict-banner" role="alert" style={{ marginTop: 14 }}>{createError}</p>
            ) : null}

            <label className="stack" style={{ marginTop: 16 }} htmlFor={`${ids}-label`}>
              <span className="field-label">Key name</span>
              <input
                ref={labelRef}
                id={`${ids}-label`}
                className="text-input"
                value={label}
                maxLength={MAX_API_CREDENTIAL_LABEL_LENGTH}
                autoComplete="off"
                aria-invalid={!!createError}
                placeholder="Website schedule mirror"
                onChange={(event) => setLabel(event.target.value)}
              />
            </label>

            <div className="row wrap" style={{ justifyContent: "flex-end", marginTop: 22 }}>
              <button className="ghost-button" type="button" onClick={closeDialog} disabled={creating}>
                Cancel
              </button>
              <button className="primary-button" type="submit" disabled={creating}>
                {creating ? "Creating…" : "Create key"}
              </button>
            </div>
          </form>
        )}
      </dialog>
    </div>
  );
}
