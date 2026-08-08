"use client";

import { useState } from "react";
import { FileUp, Plus, X } from "lucide-react";
import { describeImportError, describeImportSummary, IMPORT_TARGETS } from "@/lib/operations/status";
import styles from "./operations.module.css";

type Mapping = { sourceField: string; targetField: string; fallback?: string };
type Result = { tone: "good" | "bad"; headline: string; advice?: string };

const MAX_UPLOAD_BYTES = 5_000_000;

/**
 * Mapped CSV import for proposals (`POST /api/integrations/import`).
 *
 * The file is read in the browser and posted as text, so the operator sees the
 * detected column names before committing. Mapping rows are pre-filled from the
 * header row when a column name matches a known target, which is the difference
 * between "fill in eight dropdowns" and "check these look right".
 */
export function ImportPanel({
  eventId,
  forms,
}: {
  eventId: string;
  forms: { id: string; name: string; slug: string }[];
}) {
  const [fileName, setFileName] = useState<string | null>(null);
  const [payload, setPayload] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [mappings, setMappings] = useState<Mapping[]>([]);
  const [formConfigId, setFormConfigId] = useState(forms[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  async function onFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    setResult(null);
    if (!file) return;
    if (file.size > MAX_UPLOAD_BYTES) {
      setResult({ tone: "bad", headline: "That file is too large.", advice: "Split it into files under 5 MB and import them one at a time." });
      return;
    }
    const text = await file.text();
    const firstLine = text.split(/\r?\n/)[0] ?? "";
    const detected = firstLine.split(",").map((header) => header.trim().replace(/^"|"$/g, "")).filter(Boolean);
    setFileName(file.name);
    setPayload(text);
    setHeaders(detected);
    // Pre-fill the obvious matches; the operator only corrects the rest.
    setMappings(
      IMPORT_TARGETS.filter((target) => target.value !== "formConfigId")
        .map((target) => {
          const match = detected.find((header) => header.toLowerCase().replace(/[^a-z]/g, "") === target.value.toLowerCase().replace(/[^a-z]/g, ""));
          return match ? { sourceField: match, targetField: target.value } : null;
        })
        .filter((mapping): mapping is Mapping => mapping !== null),
    );
  }

  function update(index: number, patch: Partial<Mapping>) {
    setMappings((current) => current.map((mapping, i) => (i === index ? { ...mapping, ...patch } : mapping)));
  }

  async function submit() {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/integrations/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          eventId,
          format: "csv",
          entity: "abstracts",
          payload,
          // The form is chosen once, not per row, so it rides along as a fallback.
          mappings: [...mappings, { sourceField: "__form", targetField: "formConfigId", fallback: formConfigId }],
        }),
      });
      const body = await res.json();
      if (!body?.ok) {
        const described = describeImportError(body?.error?.message ?? "The import did not run.");
        setResult({
          tone: "bad",
          headline: described.row ? `Row ${described.row} stopped the import: ${described.text}` : described.text,
          advice: "Nothing was imported. Fix that row in your spreadsheet and upload it again.",
        });
        return;
      }
      setResult({
        tone: "good",
        headline: describeImportSummary(body.data.summary),
        advice: "Imported proposals appear in Abstracts as submitted.",
      });
    } catch {
      setResult({ tone: "bad", headline: "We couldn't reach the server. Check your connection and try again." });
    } finally {
      setBusy(false);
    }
  }

  const missingRequired = IMPORT_TARGETS.filter(
    (target) => target.required && target.value !== "formConfigId" && !mappings.some((mapping) => mapping.targetField === target.value),
  );
  const canSubmit = payload !== "" && formConfigId !== "" && missingRequired.length === 0 && !busy;

  return (
    <section className={styles.panel} aria-labelledby="ops-import">
      <div className={styles.panelHead}>
        <h2 id="ops-import">Import proposals from a spreadsheet</h2>
        <p>Bring proposals in from another system. Save your spreadsheet as CSV first.</p>
      </div>

      {forms.length === 0 ? (
        <p className={styles.empty}>Create a CFP form before importing proposals.</p>
      ) : (
        <>
          <div className={styles.field}>
            <label className="field-label" htmlFor="ops-import-form">Add these proposals to</label>
            <select className="text-input" id="ops-import-form" value={formConfigId} onChange={(e) => setFormConfigId(e.target.value)}>
              {forms.map((form) => (
                <option key={form.id} value={form.id}>{form.name}</option>
              ))}
            </select>
          </div>

          <div className={styles.field}>
            <label className="field-label" htmlFor="ops-import-file">CSV file</label>
            <input className="text-input" id="ops-import-file" type="file" accept=".csv,text/csv" onChange={onFile} />
            {fileName ? <p className={styles.hintText}>{fileName} · {headers.length} columns found</p> : null}
          </div>

          {headers.length > 0 ? (
            <div className={styles.field}>
              <span className="field-label">Match your columns</span>
              <p className={styles.hintText}>We filled in the ones we recognised. Check them, then add any that are missing.</p>
              {mappings.map((mapping, index) => (
                <div className={styles.mappingRow} key={`${mapping.targetField}-${index}`}>
                  <div>
                    <label className="field-label" htmlFor={`src-${index}`}>Column in your file</label>
                    <select className="text-input" id={`src-${index}`} value={mapping.sourceField} onChange={(e) => update(index, { sourceField: e.target.value })}>
                      {headers.map((header) => (
                        <option key={header} value={header}>{header}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="field-label" htmlFor={`tgt-${index}`}>Becomes</label>
                    <select className="text-input" id={`tgt-${index}`} value={mapping.targetField} onChange={(e) => update(index, { targetField: e.target.value })}>
                      {IMPORT_TARGETS.filter((target) => target.value !== "formConfigId").map((target) => (
                        <option key={target.value} value={target.value}>{target.label}{target.required ? " (required)" : ""}</option>
                      ))}
                    </select>
                  </div>
                  <button
                    className="icon-button" type="button" aria-label={`Remove mapping for ${mapping.targetField}`}
                    onClick={() => setMappings((current) => current.filter((_, i) => i !== index))}
                  >
                    <X size={15} aria-hidden="true" />
                  </button>
                </div>
              ))}
              <div className={styles.actions}>
                <button
                  className="ghost-button" type="button"
                  onClick={() => setMappings((current) => [...current, { sourceField: headers[0] ?? "", targetField: "abstract" }])}
                >
                  <Plus size={15} aria-hidden="true" /> Add a column
                </button>
              </div>
              {missingRequired.length > 0 ? (
                <p className={styles.hintText}>
                  Still needed: {missingRequired.map((target) => target.label).join(", ")}.
                </p>
              ) : null}
            </div>
          ) : null}

          <div className={styles.actions}>
            <button className="primary-button" type="button" onClick={submit} disabled={!canSubmit}>
              <FileUp size={15} aria-hidden="true" /> {busy ? "Importing…" : "Import proposals"}
            </button>
          </div>
        </>
      )}

      {result ? (
        <div className={`${styles.result} ${result.tone === "good" ? styles.resultGood : styles.resultBad}`} role="status">
          <span className={styles.resultHead}>{result.headline}</span>
          {result.advice ? <p className={styles.resultAdvice}>{result.advice}</p> : null}
        </div>
      ) : null}
    </section>
  );
}
