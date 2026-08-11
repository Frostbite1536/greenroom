"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { BookOpen, ExternalLink, Plus, Trash2 } from "lucide-react";
import { apiDelete, apiPatch, apiPost, firstFieldErrors } from "@/lib/api-client";
import { EmptyState, Pill } from "@/components/ui";
import {
  RESOURCE_TEMPLATES,
  applyResourceTemplate,
  isResourceAssistantTemplateKey,
  isResourceTemplateKey,
  resourceHtmlNeedsReplacementConfirmation,
  resourceTemplateNeedsConfirmation,
} from "@/lib/resources/resource-templates";
import type { ResourceDraftSuggestion } from "@/lib/assistant/resource-draft";
import {
  RESOURCE_SLUG_MAX_LENGTH,
  RESOURCE_SLUG_PATTERN,
  portalResourceHref,
  prepareResourceHtml,
  resourceSlugFromTitle,
  type ResourceView,
} from "@/lib/services/resource-wiki";

/**
 * Resource / wiki authoring for organizers (buyer requirement 8).
 *
 * The server is the only authority: every action posts to
 * `/api/admin/resources` and a success refreshes the RSC payload rather than
 * patching a local list, so what is on screen is always what is stored. A
 * refusal — a taken slug, a body that was entirely script — leaves the row
 * exactly as it was.
 *
 * The editor is a native `<dialog>` opened with `showModal()`, the precedent
 * `NewFormDialog` and the abstract drawer already set: focus trap, Escape and
 * focus restoration are the platform's rather than hand-rolled.
 */
type ResourceDraft = {
  title: string;
  slug: string;
  slugTouched: boolean;
  summary: string;
  htmlContent: string;
  published: boolean;
};

const EMPTY_DRAFT: ResourceDraft = {
  title: "",
  slug: "",
  slugTouched: false,
  summary: "",
  htmlContent: "",
  published: false,
};

function draftFromResource(resource: ResourceView): ResourceDraft {
  return {
    title: resource.title,
    // An existing page already has an address people may have linked to, so it
    // is never re-derived from the title behind the organizer's back.
    slug: resource.slug,
    slugTouched: true,
    summary: resource.summary ?? "",
    htmlContent: resource.htmlContent,
    published: resource.published,
  };
}

function effectiveSlug(draft: ResourceDraft): string {
  return draft.slugTouched ? draft.slug.trim().toLowerCase() : resourceSlugFromTitle(draft.title);
}

export function ResourceManager({
  eventId,
  resources,
}: {
  /**
   * The active event, as the page read it. The create contract carries an event
   * id, and the route checks it against the session before discarding it — the
   * row is written with the server's own `ctx.eventId`, never this value.
   */
  eventId: string;
  resources: ResourceView[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState<{ id: string | null; draft: ResourceDraft } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);

  const anyBusy = busy !== null || pending;

  function refresh() {
    startTransition(() => router.refresh());
  }

  function openCreate() {
    setErrors({});
    setNotice(null);
    setEditing({ id: null, draft: EMPTY_DRAFT });
  }

  function openEdit(resource: ResourceView) {
    setErrors({});
    setNotice(null);
    setEditing({ id: resource.id, draft: draftFromResource(resource) });
  }

  /** Client-side shape checks only. Every one of these is re-decided server-side. */
  function localErrors(draft: ResourceDraft, slug: string, id: string | null): Record<string, string> {
    const next: Record<string, string> = {};
    if (draft.title.trim() === "") next.title = "Give the page a title.";
    if (slug === "") next.slug = "A web address is required.";
    else if (!RESOURCE_SLUG_PATTERN.test(slug)) next.slug = "Use lowercase letters, numbers and single dashes.";
    else if (slug.length > RESOURCE_SLUG_MAX_LENGTH) next.slug = `Use ${RESOURCE_SLUG_MAX_LENGTH} characters or fewer.`;
    else if (resources.some((resource) => resource.slug === slug && resource.id !== id)) {
      next.slug = "Another resource page already uses this web address.";
    }
    if (draft.htmlContent.trim() === "") next.htmlContent = "Write the page content.";
    return next;
  }

  async function save() {
    if (!editing) return;
    const { id, draft } = editing;
    const slug = effectiveSlug(draft);
    const next = localErrors(draft, slug, id);
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    setBusy(id ?? "new");
    setNotice(null);
    const body = {
      slug,
      title: draft.title.trim(),
      // Always sent, including as an empty summary on create and as null on
      // edit, so clearing it is a real instruction rather than an omission the
      // server would read as "leave it alone".
      summary: draft.summary.trim(),
      htmlContent: draft.htmlContent,
      published: draft.published,
    };
    const res = id === null
      ? await apiPost<{ resource: ResourceView }>("/api/admin/resources", { eventId, ...body })
      : await apiPatch<{ resource: ResourceView }>("/api/admin/resources", {
          id,
          ...body,
          summary: body.summary === "" ? null : body.summary,
        });
    setBusy(null);

    if (!res.ok) {
      const fields = firstFieldErrors(res.error.fieldErrors);
      setErrors(Object.keys(fields).length > 0 ? fields : { _root: res.error.message });
      return;
    }
    setEditing(null);
    setNotice(
      `${id === null ? "Created" : "Saved"} “${res.data.resource.title}”. ` +
        (res.data.resource.published
          ? "Speakers can see it in the portal now."
          : "It stays a draft until you publish it."),
    );
    refresh();
  }

  async function togglePublished(resource: ResourceView) {
    setBusy(`publish:${resource.id}`);
    setErrors({});
    setNotice(null);
    const res = await apiPatch<{ resource: ResourceView }>("/api/admin/resources", {
      id: resource.id,
      published: !resource.published,
    });
    setBusy(null);
    if (!res.ok) {
      setErrors({ _root: res.error.message });
      return;
    }
    setNotice(
      res.data.resource.published
        ? `Published “${res.data.resource.title}” — it is live in the speaker portal.`
        : `Unpublished “${res.data.resource.title}” — speakers no longer see it.`,
    );
    refresh();
  }

  async function remove(resource: ResourceView) {
    if (!window.confirm(`Delete “${resource.title}”? Its content and its portal address are removed for good.`)) return;
    setBusy(`delete:${resource.id}`);
    setErrors({});
    setNotice(null);
    const res = await apiDelete<{ resource: ResourceView }>(
      `/api/admin/resources?resourceId=${encodeURIComponent(resource.id)}`,
    );
    setBusy(null);
    if (!res.ok) {
      // Never drop the row locally: a refusal means it is still real event data.
      setErrors({ _root: res.error.message });
      return;
    }
    setNotice(`Deleted “${res.data.resource.title}”.`);
    refresh();
  }

  return (
    <>
      <div className="row wrap" style={{ justifyContent: "flex-end" }}>
        <button className="primary-button" type="button" disabled={anyBusy} onClick={openCreate}
          style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
          <Plus size={16} aria-hidden="true" /> New resource page
        </button>
      </div>

      {errors._root ? <p className="field-error" role="alert">{errors._root}</p> : null}
      {notice ? <p className="settings-notice" role="status" aria-live="polite">{notice}</p> : null}

      <div className="card">
        {resources.length === 0 ? (
          <EmptyState icon={<BookOpen size={22} aria-hidden="true" />} title="No resource pages yet">
            Use <strong>New resource page</strong> above to write the speaker handbook, a venue guide, or any
            other page speakers should find in their portal.
          </EmptyState>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <caption className="sr-only">Resource and wiki pages with their portal address and publish state</caption>
              <thead>
                <tr>
                  <th scope="col">Page</th>
                  <th scope="col">Portal address</th>
                  <th scope="col">State</th>
                  <th scope="col"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {resources.map((resource) => (
                  <tr key={resource.id}>
                    <td>
                      <div className="cell-title">{resource.title}</div>
                      {resource.summary ? <div className="cell-sub">{resource.summary}</div> : null}
                    </td>
                    <td>
                      {resource.published ? (
                        <a
                          className="ghost-button"
                          href={portalResourceHref(resource.slug)}
                          style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
                        >
                          /portal/resources/{resource.slug}
                          <ExternalLink size={14} aria-hidden="true" />
                        </a>
                      ) : (
                        <span className="muted">/portal/resources/{resource.slug}</span>
                      )}
                    </td>
                    <td>
                      {resource.published
                        ? <Pill tone="good">Published</Pill>
                        : <Pill tone="neutral">Draft</Pill>}
                    </td>
                    <td>
                      <div className="row wrap settings-row-actions">
                        <button
                          className="ghost-button"
                          type="button"
                          disabled={anyBusy}
                          onClick={() => void togglePublished(resource)}
                        >
                          {busy === `publish:${resource.id}`
                            ? "Working…"
                            : resource.published ? "Unpublish" : "Publish"}
                        </button>
                        <button className="ghost-button" type="button" disabled={anyBusy} onClick={() => openEdit(resource)}>
                          Edit
                        </button>
                        <button
                          className="ghost-button danger-button"
                          type="button"
                          disabled={anyBusy}
                          onClick={() => void remove(resource)}
                        >
                          <Trash2 size={15} aria-hidden="true" />{" "}
                          {busy === `delete:${resource.id}` ? "Working…" : "Delete"}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <ResourceDialog
        key={editing ? `resource:${editing.id ?? "new"}` : "resource:closed"}
        editing={editing}
        errors={errors}
        submitting={busy !== null}
        onChange={(draft) => setEditing((current) => (current ? { ...current, draft } : current))}
        onClose={() => {
          setEditing(null);
          setErrors({});
        }}
        onSubmit={() => {
          save().catch((error) => {
            console.warn("Resource save failed", error);
            setBusy(null);
            setErrors({ _root: "Could not save the page. Check your connection and try again." });
          });
        }}
      />
    </>
  );
}

function ResourceDialog({
  editing,
  errors,
  submitting,
  onChange,
  onClose,
  onSubmit,
}: {
  editing: { id: string | null; draft: ResourceDraft } | null;
  errors: Record<string, string>;
  submitting: boolean;
  onChange: (draft: ResourceDraft) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const htmlTabRef = useRef<HTMLButtonElement>(null);
  const previewTabRef = useRef<HTMLButtonElement>(null);
  const ids = useId();
  const open = editing !== null;
  const [activeContentTab, setActiveContentTab] = useState<"html" | "preview">("html");
  const [selectedTemplate, setSelectedTemplate] = useState("");
  const [assistantNotes, setAssistantNotes] = useState("");
  const [assistantSuggestion, setAssistantSuggestion] = useState<ResourceDraftSuggestion | null>(null);
  const [assistantError, setAssistantError] = useState<string | null>(null);
  const [assistantStatus, setAssistantStatus] = useState<string | null>(null);
  const [assistantBusy, setAssistantBusy] = useState(false);
  const suggestionRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      // showModal() gives us the focus trap, Esc handling and inert background
      // for free — no hand-rolled trap needed here.
      dialog.showModal();
      titleRef.current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  const draft = editing?.draft ?? EMPTY_DRAFT;
  const slug = effectiveSlug(draft);
  const selectedTemplateDetails = RESOURCE_TEMPLATES.find((template) => template.key === selectedTemplate);
  const previewDecision = draft.htmlContent.trim() === "" ? null : prepareResourceHtml(draft.htmlContent);
  const suggestionPreview = assistantSuggestion === null ? null : prepareResourceHtml(assistantSuggestion.html);

  function selectContentTab(tab: "html" | "preview") {
    setActiveContentTab(tab);
    if (tab === "html") htmlTabRef.current?.focus();
    else previewTabRef.current?.focus();
  }

  function handleTabKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    if (event.key === "Home") selectContentTab("html");
    else if (event.key === "End") selectContentTab("preview");
    else selectContentTab(activeContentTab === "html" ? "preview" : "html");
  }

  function handleTemplateChange(event: React.ChangeEvent<HTMLSelectElement>) {
    if (!isResourceTemplateKey(event.target.value)) return;
    const key = event.target.value;
    if (
      resourceTemplateNeedsConfirmation(draft.htmlContent, key) &&
      !window.confirm("Apply this template and replace the HTML currently in this editor? Page details and publish state stay unchanged.")
    ) {
      event.target.value = selectedTemplate;
      return;
    }
    onChange(applyResourceTemplate(draft, key));
    setSelectedTemplate(key);
    setActiveContentTab("html");
  }

  async function generateAssistantDraft() {
    if (!editing || editing.id !== null) return;
    if (!isResourceAssistantTemplateKey(selectedTemplate)) {
      setAssistantError("Choose one of the four guided templates before generating a draft.");
      return;
    }
    if (draft.title.trim() === "") {
      setAssistantError("Add a page title before generating a draft.");
      return;
    }
    if (assistantNotes.trim() === "") {
      setAssistantError("Add the facts and notes the draft may use.");
      return;
    }

    setAssistantBusy(true);
    setAssistantError(null);
    setAssistantStatus(null);
    const response = await apiPost<{ suggestion: ResourceDraftSuggestion }>("/api/assistant/resource-draft", {
      templateKey: selectedTemplate,
      title: draft.title.trim(),
      ...(draft.summary.trim() === "" ? {} : { summary: draft.summary.trim() }),
      notes: assistantNotes.trim(),
    });
    setAssistantBusy(false);
    if (!response.ok) {
      // Keep both the editor and any prior suggestion byte-for-byte intact: a
      // failed retry cannot become an accidental destructive action.
      setAssistantError(response.error.message);
      return;
    }
    setAssistantSuggestion(response.data.suggestion);
    setAssistantStatus("Draft suggestion ready. Review it before using it.");
    requestAnimationFrame(() => suggestionRef.current?.focus());
  }

  function useAssistantDraft() {
    if (!assistantSuggestion) return;
    if (
      resourceHtmlNeedsReplacementConfirmation(draft.htmlContent) &&
      !window.confirm("Use this draft and replace the HTML currently in this editor? Page details and publish state stay unchanged.")
    ) {
      return;
    }
    onChange({ ...draft, htmlContent: assistantSuggestion.html });
    setAssistantStatus("Draft applied to the HTML editor. Review and edit it before saving.");
    setActiveContentTab("html");
    requestAnimationFrame(() => htmlTabRef.current?.focus());
  }

  return (
    <dialog
      ref={dialogRef}
      className="app-dialog resource-dialog"
      aria-labelledby={`${ids}-title`}
      onClose={onClose}
      onCancel={(event) => {
        if (submitting) event.preventDefault();
      }}
      onMouseDown={(event) => {
        if (event.target === dialogRef.current && !submitting) onClose();
      }}
    >
      <form
        method="dialog"
        onSubmit={(event) => {
          event.preventDefault();
          if (assistantBusy) return;
          onSubmit();
        }}
      >
        <h2 id={`${ids}-title`}>{editing?.id === null ? "New resource page" : "Edit resource page"}</h2>
        <p className="hint">
          Resource and wiki pages appear in the speaker portal. Only published pages are visible to speakers.
        </p>

        {errors._root ? (
          <p className="conflict-banner" role="alert" style={{ marginTop: 14 }}>{errors._root}</p>
        ) : null}

        <label className="stack" style={{ marginTop: 16 }} htmlFor={`${ids}-page-title`}>
          <span className="field-label">Page title</span>
          <input
            id={`${ids}-page-title`}
            ref={titleRef}
            className="text-input"
            value={draft.title}
            maxLength={180}
            autoComplete="off"
            aria-invalid={!!errors.title}
            placeholder="Speaker Handbook"
            disabled={assistantBusy}
            onChange={(event) => onChange({ ...draft, title: event.target.value })}
          />
          {errors.title ? <span className="field-error">{errors.title}</span> : null}
        </label>

        <label className="stack" style={{ marginTop: 14 }} htmlFor={`${ids}-slug`}>
          <span className="field-label">Portal address</span>
          <input
            id={`${ids}-slug`}
            className="text-input"
            value={slug}
            maxLength={RESOURCE_SLUG_MAX_LENGTH}
            autoComplete="off"
            aria-invalid={!!errors.slug}
            aria-describedby={`${ids}-slug-hint`}
            disabled={assistantBusy}
            onChange={(event) => onChange({ ...draft, slug: event.target.value, slugTouched: true })}
          />
          <span className="hint" id={`${ids}-slug-hint`}>
            {portalResourceHref(slug || "your-page")} — derived from the title until you edit it, and unique within this event.
          </span>
          {errors.slug ? <span className="field-error">{errors.slug}</span> : null}
        </label>

        <label className="stack" style={{ marginTop: 14 }} htmlFor={`${ids}-summary`}>
          <span className="field-label">Summary <span className="muted">(optional)</span></span>
          <input
            id={`${ids}-summary`}
            className="text-input"
            value={draft.summary}
            maxLength={500}
            autoComplete="off"
            aria-invalid={!!errors.summary}
            placeholder="Everything you need before you present."
            disabled={assistantBusy}
            onChange={(event) => onChange({ ...draft, summary: event.target.value })}
          />
          <span className="hint">One line shown beside the page link in the portal.</span>
          {errors.summary ? <span className="field-error">{errors.summary}</span> : null}
        </label>

        <label className="stack" style={{ marginTop: 14 }} htmlFor={`${ids}-template`}>
          <span className="field-label">Start from a template <span className="muted">(optional)</span></span>
          <select
            id={`${ids}-template`}
            className="text-input"
            value={selectedTemplate}
            disabled={assistantBusy}
            onChange={handleTemplateChange}
          >
            <option value="">Choose a template</option>
            {RESOURCE_TEMPLATES.map((template) => (
              <option key={template.key} value={template.key}>{template.label}</option>
            ))}
          </select>
          <span className="hint">
            {selectedTemplateDetails?.description ?? "Templates change only the HTML below."}{" "}
            Existing content is never replaced without confirmation.
          </span>
        </label>

        {editing?.id === null ? (
          <section className="resource-assistant" aria-labelledby={`${ids}-assistant-title`}>
            <div className="stack">
              <h3 id={`${ids}-assistant-title`}>Turn my notes into a resource page</h3>
              <p className="hint">
                Optional AI help for a new page. Only the selected template structure, page title, optional summary,
                and notes below are sent to the configured provider. Greenroom does not send event records, save the
                suggestion, or publish it for you.
              </p>
            </div>

            <label className="stack" htmlFor={`${ids}-assistant-notes`}>
              <span className="field-label">Facts and notes</span>
              <textarea
                id={`${ids}-assistant-notes`}
                className="text-input"
                rows={5}
                maxLength={8000}
                value={assistantNotes}
                disabled={assistantBusy}
                placeholder="Paste only the facts this page may use. Leave unknown details out so the draft marks them as [Add …]."
                onChange={(event) => setAssistantNotes(event.target.value)}
              />
              <span className="hint">{assistantNotes.length.toLocaleString("en-US")} / 8,000 characters</span>
            </label>

            <div className="row wrap resource-assistant-actions">
              <button
                className="ghost-button"
                type="button"
                disabled={assistantBusy}
                aria-describedby={`${ids}-assistant-provider-note`}
                onClick={() => {
                  void generateAssistantDraft();
                }}
              >
                {assistantBusy ? "Generating…" : assistantSuggestion ? "Try again" : "Generate suggestion"}
              </button>
              <span className="hint" id={`${ids}-assistant-provider-note`}>
                Templates, preview, manual HTML, save, and publish still work when AI is unavailable.
              </span>
            </div>

            {assistantError ? <p className="field-error" role="alert">{assistantError}</p> : null}
            {assistantStatus ? <p className="settings-notice" role="status" aria-live="polite">{assistantStatus}</p> : null}

            {suggestionPreview?.allowed ? (
              <div
                className="resource-assistant-suggestion"
                ref={suggestionRef}
                tabIndex={-1}
                aria-labelledby={`${ids}-assistant-suggestion-title`}
              >
                <div className="row wrap resource-assistant-suggestion-heading">
                  <div>
                    <h4 id={`${ids}-assistant-suggestion-title`}>Generated suggestion</h4>
                    <p className="hint">Sanitized and separate from the HTML editor until you choose to use it.</p>
                  </div>
                  <button className="primary-button" type="button" disabled={assistantBusy} onClick={useAssistantDraft}>
                    Use this draft
                  </button>
                </div>
                <div className="prose resource-preview" dangerouslySetInnerHTML={{ __html: suggestionPreview.html }} />
                {assistantSuggestion && assistantSuggestion.placeholders.length > 0 ? (
                  <p className="hint">
                    Check these visible placeholders: {assistantSuggestion.placeholders.join(" · ")}
                  </p>
                ) : null}
              </div>
            ) : null}
          </section>
        ) : null}

        <div className="stack" style={{ marginTop: 14 }}>
          <div className="row" role="tablist" aria-label="Resource page content">
            <button
              id={`${ids}-html-tab`}
              ref={htmlTabRef}
              className={activeContentTab === "html" ? "primary-button" : "ghost-button"}
              type="button"
              role="tab"
              aria-selected={activeContentTab === "html"}
              aria-controls={`${ids}-html-panel`}
              tabIndex={activeContentTab === "html" ? 0 : -1}
              onClick={() => selectContentTab("html")}
              onKeyDown={handleTabKeyDown}
            >
              HTML
            </button>
            <button
              id={`${ids}-preview-tab`}
              ref={previewTabRef}
              className={activeContentTab === "preview" ? "primary-button" : "ghost-button"}
              type="button"
              role="tab"
              aria-selected={activeContentTab === "preview"}
              aria-controls={`${ids}-preview-panel`}
              tabIndex={activeContentTab === "preview" ? 0 : -1}
              onClick={() => selectContentTab("preview")}
              onKeyDown={handleTabKeyDown}
            >
              Preview
            </button>
          </div>

          <div
            id={`${ids}-html-panel`}
            role="tabpanel"
            aria-labelledby={`${ids}-html-tab`}
            hidden={activeContentTab !== "html"}
          >
            <label className="stack" htmlFor={`${ids}-html`}>
              <span className="field-label">Page content (HTML)</span>
              <textarea
                id={`${ids}-html`}
                className="text-input"
                rows={12}
                value={draft.htmlContent}
                aria-invalid={!!errors.htmlContent}
                aria-describedby={`${ids}-html-hint`}
                placeholder="<h2>Welcome, speakers!</h2><p>This handbook covers arrival, A/V and stage logistics.</p>"
                onChange={(event) => onChange({ ...draft, htmlContent: event.target.value })}
              />
              {/* An honest label, because the sanitizer is strict: an organizer who
                  pastes an embed needs to know it will not survive, before they
                  publish a page that silently lost half its content. */}
              <span className="hint" id={`${ids}-html-hint`}>
                HTML is supported and sanitized before it is saved. Headings, paragraphs, lists, tables, quotes, code and
                links are kept; scripts, styles, iframes and other embeds are removed, and links open in a new tab.
              </span>
            </label>
          </div>

          <div
            id={`${ids}-preview-panel`}
            role="tabpanel"
            aria-labelledby={`${ids}-preview-tab`}
            hidden={activeContentTab !== "preview"}
          >
            <p className="field-label">Sanitized preview</p>
            <div
              className="prose resource-preview"
              style={{ minHeight: 180, marginTop: 8, padding: 16, border: "1px solid var(--line)", borderRadius: 10 }}
            >
              {previewDecision === null ? (
                <p className="muted" role="status">Nothing to preview yet.</p>
              ) : previewDecision.allowed ? (
                <div dangerouslySetInnerHTML={{ __html: previewDecision.html }} />
              ) : (
                <p className="muted" role="status">{previewDecision.message}</p>
              )}
            </div>
            <p className="hint" style={{ marginTop: 8 }}>
              This preview uses the same sanitizer as saved resource pages. Disallowed markup is removed before rendering.
            </p>
          </div>
          {errors.htmlContent ? <span className="field-error">{errors.htmlContent}</span> : null}
        </div>

        <label className="row" style={{ marginTop: 16 }} htmlFor={`${ids}-published`}>
          <input
            id={`${ids}-published`}
            type="checkbox"
            checked={draft.published}
            onChange={(event) => onChange({ ...draft, published: event.target.checked })}
          />
          <span className="field-label">Published — speakers can open this page in their portal</span>
        </label>

        <div className="row wrap" style={{ justifyContent: "flex-end", marginTop: 22 }}>
          <button className="ghost-button" type="button" onClick={onClose} disabled={submitting}>Cancel</button>
          <button className="primary-button" type="submit" disabled={submitting || assistantBusy}>
            {submitting ? "Saving…" : editing?.id === null ? "Create page" : "Save page"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
