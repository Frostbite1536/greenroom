type PagePlaceholderProps = {
  eyebrow: string;
  title: string;
  description: string;
  metrics: Array<{ label: string; value: string }>;
  nextSteps: string[];
};

export function PagePlaceholder({ eyebrow, title, description, metrics, nextSteps }: PagePlaceholderProps) {
  return (
    <section className="page-stack">
      <header className="page-header">
        <div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{description}</p></div>
        <button className="primary-button" type="button">Create new</button>
      </header>
      <div className="metric-grid">
        {metrics.map((metric) => <div className="metric" key={metric.label}><span>{metric.label}</span><strong>{metric.value}</strong></div>)}
      </div>
      <section className="work-panel">
        <div className="panel-heading"><div><h2>Foundation ready</h2><p>This route is reserved for its owning worker.</p></div><span className="status-badge">Contract locked</span></div>
        <ol className="next-list">{nextSteps.map((step, index) => <li key={step}><span>{index + 1}</span><p>{step}</p></li>)}</ol>
      </section>
    </section>
  );
}
