/**
 * The human rendering of the v1 API contract.
 *
 * Everything on this page is derived from `OPENAPI_DOCUMENT` at render time —
 * the endpoint list, the parameter bounds, the ordering guarantees, the error
 * table, and the response examples. Nothing here restates the API in prose that
 * could quietly fall out of date, which is the whole point of pairing the page
 * with `lib/api/openapi.test.ts`.
 *
 * Server-rendered with no client JavaScript and no external spec renderer.
 * Swagger UI, Redoc and friends are dependencies, and this repository keeps its
 * runtime dependency count at five. A contract this small reads better as a
 * plain document anyway.
 */
import type { Metadata } from "next";
import Link from "next/link";
import {
  API_KEY_PLACEHOLDER,
  CURL_EXAMPLES,
  INTEGRATION_SURFACES,
  OPENAPI_DOCUMENT,
  V1_OPENAPI_PATH,
} from "@/lib/api/openapi";
import {
  endpointViews,
  inlineCodeSegments,
  listEndpointViews,
  paragraphsOf,
  securitySchemeViews,
  type EndpointView,
} from "@/lib/api/openapi-view";
import { PublicChrome } from "@/components/public-chrome";

export const metadata: Metadata = {
  title: "Greenroom read-only API",
  description:
    "The contract for Greenroom's read-only v1 API: authentication, pagination bounds, response shapes, error codes, and ordering guarantees.",
};

/** A paragraph with the document's `backtick code` spans rendered as code. */
function Prose({ text }: { text: string }) {
  return (
    <p className="api-prose">
      {inlineCodeSegments(text).map((segment, index) =>
        segment.code ? <code key={index}>{segment.text}</code> : <span key={index}>{segment.text}</span>,
      )}
    </p>
  );
}

function anchorFor(path: string): string {
  return `endpoint-${path.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "")}`;
}

function Endpoint({ view }: { view: EndpointView }) {
  const anchor = anchorFor(view.path);
  return (
    <section className="api-endpoint" aria-labelledby={anchor}>
      <h3 className="api-endpoint-title" id={anchor}>
        <span className="api-method">{view.method}</span>
        <code>{view.path}</code>
      </h3>
      <p className="api-endpoint-summary">{view.summary}</p>

      <p className="api-auth-line">
        {view.security.length > 0 ? (
          <>Requires an API key ({view.security.join(" or ")}).</>
        ) : (
          <>No API key required.</>
        )}
      </p>

      {view.paragraphs.map((paragraph, index) => (
        <Prose key={index} text={paragraph} />
      ))}

      {view.parameters.length > 0 ? (
        <>
          <h4 className="api-subheading">Query parameters</h4>
          <div className="api-table-scroll">
            <table className="api-table">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Required</th>
                  <th scope="col">Accepts</th>
                  <th scope="col">Notes</th>
                </tr>
              </thead>
              <tbody>
                {view.parameters.map((parameter) => (
                  <tr key={parameter.name}>
                    <th scope="row"><code>{parameter.name}</code></th>
                    <td>{parameter.required ? "Yes" : "No"}</td>
                    <td>{parameter.constraint}</td>
                    <td>
                      {inlineCodeSegments(parameter.description).map((segment, index) =>
                        segment.code ? <code key={index}>{segment.text}</code> : <span key={index}>{segment.text}</span>,
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {view.ordering.length > 0 ? (
        <p className="api-note">
          Ordering: {view.ordering.map((field, index) => (
            <span key={field}>
              {index > 0 ? ", then " : ""}
              <code>{field}</code>
            </span>
          ))}{" "}
          ascending. The trailing <code>id</code> is a tiebreaker, so paging with{" "}
          <code>offset</code> cannot repeat or skip a row.
        </p>
      ) : null}

      {view.responseExample ? (
        <>
          <h4 className="api-subheading">Response (200)</h4>
          <pre className="api-code"><code>{view.responseExample}</code></pre>
        </>
      ) : null}

      {view.errors.length > 0 ? (
        <>
          <h4 className="api-subheading">Failures</h4>
          <div className="api-table-scroll">
            <table className="api-table">
              <thead>
                <tr>
                  <th scope="col">Status</th>
                  <th scope="col">Code</th>
                  <th scope="col">When</th>
                </tr>
              </thead>
              <tbody>
                {view.errors.map((error) => (
                  <tr key={error.status}>
                    <th scope="row">{error.status}</th>
                    <td><code>{error.code}</code></td>
                    <td>
                      {inlineCodeSegments(error.description).map((segment, index) =>
                        segment.code ? <code key={index}>{segment.text}</code> : <span key={index}>{segment.text}</span>,
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </section>
  );
}

export default function ApiDocsPage() {
  const { info } = OPENAPI_DOCUMENT;
  const lists = listEndpointViews();
  const meta = endpointViews().filter((view) => view.path === V1_OPENAPI_PATH);

  return (
    <PublicChrome active="api">
      <article className="api-docs">
        <header className="api-docs-head">
          <p className="eyebrow">OpenAPI {OPENAPI_DOCUMENT.openapi} · {info.version}</p>
          <h1>{info.title}</h1>
          <p className="api-lede">{info.summary}</p>
          <p className="api-note">
            The machine-readable document is at{" "}
            <Link href={V1_OPENAPI_PATH}><code>{V1_OPENAPI_PATH}</code></Link> and needs no key.
            This page renders that same document — they cannot disagree.
          </p>
        </header>

        <section aria-labelledby="api-overview">
          <h2 className="api-heading" id="api-overview">Overview</h2>
          {paragraphsOf(info.description).map((paragraph, index) => (
            <Prose key={index} text={paragraph} />
          ))}
        </section>

        <section aria-labelledby="api-authentication">
          <h2 className="api-heading" id="api-authentication">Authentication</h2>
          <ul className="api-list">
            {securitySchemeViews().map((scheme) => (
              <li key={scheme.name}>
                <code>{scheme.header}</code>
                {scheme.paragraphs.map((paragraph, index) => (
                  <Prose key={index} text={paragraph} />
                ))}
              </li>
            ))}
          </ul>
          <p className="api-warning">
            <strong>The key is never published here.</strong> <code>GREENROOM_API_KEY</code> is
            deployment-wide rather than event-scoped, so every example below uses the placeholder{" "}
            <code>{API_KEY_PLACEHOLDER}</code>. Ask the operator of the deployment for a real one;
            pasting the placeholder gets you a <code>401</code>.
          </p>
          {CURL_EXAMPLES.map((example) => (
            <div key={example.title}>
              <h4 className="api-subheading">{example.title}</h4>
              <pre className="api-code"><code>{example.lines.join("\n")}</code></pre>
            </div>
          ))}
        </section>

        <section aria-labelledby="api-surfaces">
          <h2 className="api-heading" id="api-surfaces">Which surface answers your question</h2>
          <p className="api-prose">
            Most integration questions are already answered by a page that needs no key. The
            key-gated API is for the ones that are not.
          </p>
          <div className="api-table-scroll">
            <table className="api-table">
              <thead>
                <tr>
                  <th scope="col">You want to</th>
                  <th scope="col">Use</th>
                  <th scope="col">Key</th>
                  <th scope="col">Notes</th>
                </tr>
              </thead>
              <tbody>
                {INTEGRATION_SURFACES.map((surface) => (
                  <tr key={surface.route}>
                    <th scope="row">{surface.need}</th>
                    <td><code>{surface.route}</code></td>
                    <td>{surface.keyed ? "Required" : "None"}</td>
                    <td>{surface.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section aria-labelledby="api-endpoints">
          <h2 className="api-heading" id="api-endpoints">Endpoints</h2>
          {lists.map((view) => (
            <Endpoint key={view.path} view={view} />
          ))}
          {meta.map((view) => (
            <Endpoint key={view.path} view={view} />
          ))}
        </section>
      </article>
    </PublicChrome>
  );
}
