"use client";

import type { FormFieldModel } from "@/lib/fixtures";
import type { AnswerValue } from "@/lib/form-logic";

export function FieldControl({
  field,
  value,
  onChange,
  error,
  idPrefix = "f",
}: {
  field: FormFieldModel;
  value: AnswerValue;
  onChange: (v: AnswerValue) => void;
  error?: string | null;
  idPrefix?: string;
}) {
  const id = `${idPrefix}-${field.key}`;
  const describedBy = [field.helpText ? `${id}-help` : null, error ? `${id}-err` : null]
    .filter(Boolean)
    .join(" ") || undefined;

  return (
    <div className="cfp-field">
      {field.type !== "CHECKBOX" && (
        <label className="field-label" htmlFor={id}>
          {field.label} {field.required ? <span className="req" aria-hidden="true">*</span> : null}
        </label>
      )}
      {field.helpText ? (
        <p className="hint" id={`${id}-help`}>{field.helpText}</p>
      ) : null}

      {(() => {
        switch (field.type) {
          case "LONG_TEXT":
            return (
              <textarea
                id={id}
                className="text-input"
                value={typeof value === "string" ? value : ""}
                onChange={(e) => onChange(e.target.value)}
                aria-invalid={!!error}
                aria-describedby={describedBy}
                required={field.required}
              />
            );
          case "NUMBER":
            return (
              <input
                id={id}
                type="number"
                className="text-input"
                value={value === undefined || value === null ? "" : String(value)}
                onChange={(e) => onChange(e.target.value)}
                aria-invalid={!!error}
                aria-describedby={describedBy}
                required={field.required}
              />
            );
          case "URL":
            return (
              <input
                id={id}
                type="url"
                inputMode="url"
                placeholder="https://"
                className="text-input"
                value={typeof value === "string" ? value : ""}
                onChange={(e) => onChange(e.target.value)}
                aria-invalid={!!error}
                aria-describedby={describedBy}
                required={field.required}
              />
            );
          case "SELECT":
            return (
              <select
                id={id}
                className="select-input"
                value={typeof value === "string" ? value : ""}
                onChange={(e) => onChange(e.target.value)}
                aria-invalid={!!error}
                aria-describedby={describedBy}
                required={field.required}
              >
                <option value="">Select…</option>
                {field.options?.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            );
          case "MULTI_SELECT": {
            const arr = Array.isArray(value) ? value : [];
            return (
              <div className="stack" role="group" aria-label={field.label} aria-describedby={describedBy}>
                {field.options?.map((o) => (
                  <label key={o.value} className="row" style={{ gap: 8 }}>
                    <input
                      type="checkbox"
                      checked={arr.includes(o.value)}
                      onChange={(e) =>
                        onChange(e.target.checked ? [...arr, o.value] : arr.filter((v) => v !== o.value))
                      }
                    />
                    <span>{o.label}</span>
                  </label>
                ))}
              </div>
            );
          }
          case "CHECKBOX":
            return (
              <label className="row" style={{ gap: 10, alignItems: "flex-start" }}>
                <input
                  id={id}
                  type="checkbox"
                  checked={value === true}
                  onChange={(e) => onChange(e.target.checked)}
                  aria-invalid={!!error}
                  aria-describedby={describedBy}
                  style={{ marginTop: 3 }}
                />
                <span className="field-label" style={{ fontWeight: 500 }}>
                  {field.label} {field.required ? <span className="req" aria-hidden="true">*</span> : null}
                </span>
              </label>
            );
          default:
            return (
              <input
                id={id}
                type="text"
                className="text-input"
                value={typeof value === "string" ? value : ""}
                onChange={(e) => onChange(e.target.value)}
                aria-invalid={!!error}
                aria-describedby={describedBy}
                required={field.required}
              />
            );
        }
      })()}

      {error ? <p className="field-error" id={`${id}-err`}>{error}</p> : null}
    </div>
  );
}
