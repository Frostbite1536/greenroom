"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";

export type EmbedSnippet = {
  key: string;
  title: string;
  description: string;
  url: string;
  snippet: string;
  /** Rendered as a warning when the embed currently has nothing to show. */
  emptyWarning?: string;
};

/**
 * Copy-to-clipboard is progressive: `navigator.clipboard` is unavailable on
 * insecure origins and in some embedded browsers, so we fall back to selecting
 * the snippet text and telling the user to copy manually rather than silently
 * failing.
 */
function useCopy() {
  const [copied, setCopied] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  async function copy(key: string, text: string, node?: HTMLInputElement | HTMLTextAreaElement | null) {
    if (timer.current) clearTimeout(timer.current);
    setFailed(null);
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(text);
      setCopied(key);
    } catch (error) {
      console.warn("Clipboard copy failed", error);
      node?.focus();
      node?.select();
      setCopied(null);
      setFailed(key);
    }
    timer.current = setTimeout(() => {
      setCopied(null);
      setFailed(null);
    }, 2400);
  }

  return { copied, failed, copy };
}

export function EmbedSnippets({ snippets }: { snippets: EmbedSnippet[] }) {
  const { copied, failed, copy } = useCopy();
  const areas = useRef<Record<string, HTMLTextAreaElement | null>>({});
  const urlInputs = useRef<Record<string, HTMLInputElement | null>>({});

  return (
    <div className="embed-snippet-list">
      {snippets.map((item) => {
        const isCopied = copied === item.key;
        const isFailed = failed === item.key;
        return (
          <section className="card embed-snippet" key={item.key} aria-labelledby={`embed-${item.key}-title`}>
            <div className="row wrap embed-snippet-head">
              <div style={{ minWidth: 0, flex: 1 }}>
                <h2 id={`embed-${item.key}-title`}>{item.title}</h2>
                <p className="hint">{item.description}</p>
              </div>
              <a className="ghost-button" href={item.url} target="_blank" rel="noreferrer">
                <ExternalLink size={15} aria-hidden="true" /> Preview
              </a>
            </div>

            {item.emptyWarning ? (
              <p className="embed-snippet-warning" role="status">{item.emptyWarning}</p>
            ) : null}

            <div className="stack embed-snippet-field">
              <span className="field-label" id={`embed-${item.key}-label`}>Public URL</span>
              <div className="row">
                <input
                  className="text-input"
                  readOnly
                  value={item.url}
                  aria-labelledby={`embed-${item.key}-label`}
                  ref={(node) => {
                    urlInputs.current[item.key] = node;
                  }}
                />
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => copy(`${item.key}-url`, item.url, urlInputs.current[item.key])}
                >
                  {copied === `${item.key}-url` ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
                  {copied === `${item.key}-url` ? "Copied" : "Copy URL"}
                </button>
              </div>
              {failed === `${item.key}-url` ? (
                <span className="hint" role="status" aria-live="polite">
                  Clipboard blocked by the browser — the URL is selected, press Ctrl/Cmd + C.
                </span>
              ) : null}
            </div>

            <div className="stack embed-snippet-field">
              <span className="field-label" id={`embed-${item.key}-code-label`}>Iframe snippet</span>
              <textarea
                className="text-input embed-snippet-code"
                readOnly
                rows={4}
                spellCheck={false}
                value={item.snippet}
                aria-labelledby={`embed-${item.key}-code-label`}
                ref={(node) => {
                  areas.current[item.key] = node;
                }}
              />
            </div>

            <div className="row wrap">
              <button
                type="button"
                className="primary-button"
                onClick={() => copy(item.key, item.snippet, areas.current[item.key])}
              >
                {isCopied ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
                {isCopied ? "Copied to clipboard" : "Copy embed code"}
              </button>
              <span className="hint" role="status" aria-live="polite">
                {isFailed
                  ? "Clipboard blocked by the browser — the snippet is selected, press Ctrl/Cmd + C."
                  : isCopied
                    ? "Paste it into any CMS HTML block."
                    : ""}
              </span>
            </div>
          </section>
        );
      })}
    </div>
  );
}
