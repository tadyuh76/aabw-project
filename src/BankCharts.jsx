"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

const ACCENT = "#DB676D";
const CHART_COLORS = [ACCENT, "#f0b4b7", "#aa8c8f", "#77585b", "#d9d4d5"];

const tooltipStyle = {
  background: "#171415",
  border: "1px solid rgba(255,255,255,.14)",
  borderRadius: 12,
  color: "#f5f3f0",
  fontSize: 11,
};

function ChartCard({ title, note, meta, children }) {
  return (
    <section className="analytics-card">
      <header>
        <div><span>{title}</span><small>{note}</small></div>
        {meta && <strong>{meta}</strong>}
      </header>
      <div className="analytics-chart-body">{children}</div>
    </section>
  );
}

function AnalyticsState({ status }) {
  return (
    <div className="analytics-grid">
      <section className="analytics-card analytics-state-card">
        <span>{status === "loading" ? "SYNCING LIVE ANALYTICS" : "LIVE ANALYTICS UNAVAILABLE"}</span>
        <strong>{status === "loading" ? "Loading the current Supabase snapshot…" : "No mock chart has been substituted."}</strong>
      </section>
    </div>
  );
}

export function BankCharts({ analytics }) {
  if (analytics.status !== "live") {
    return <AnalyticsState status={analytics.status} />;
  }

  const categoryData = analytics.categories.map((row) => ({
    name: row.label,
    value: row.count,
  }));
  const severityData = analytics.severities.map((row) => ({
    name: `L${row.level}`,
    value: row.count,
    level: row.level,
  }));

  return (
    <div className="analytics-grid">
      <ChartCard
        title="EVIDENCE BY CLASSIFICATION"
        note="Documents in the current analytics snapshot"
        meta={`${analytics.snapshot.documentsAnalyzed.toLocaleString("en-US")} SOURCES`}
      >
        <div className="donut-chart-wrap">
          <ResponsiveContainer width="58%" height="100%">
            <PieChart>
              <Tooltip contentStyle={tooltipStyle} formatter={(value) => [value, "Documents"]} />
              <Pie data={categoryData} dataKey="value" nameKey="name" innerRadius="58%" outerRadius="85%" paddingAngle={2}>
                {categoryData.map((entry, index) => <Cell key={entry.name} fill={CHART_COLORS[index % CHART_COLORS.length]} />)}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
          <div className="chart-legend-list" aria-label="Evidence classification totals">
            {categoryData.map((entry, index) => (
              <div className="chart-legend-row" key={entry.name}>
                <i style={{ background: CHART_COLORS[index % CHART_COLORS.length] }} />
                <span>{entry.name}</span><strong>{entry.value.toLocaleString("en-US")}</strong>
              </div>
            ))}
          </div>
        </div>
      </ChartCard>

      <ChartCard
        title="EVIDENCE BY SEVERITY"
        note="Classified documents by severity level"
        meta={`LEVEL ${analytics.snapshot.maximumSeverity} MAX`}
      >
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={severityData} margin={{ top: 14, right: 18, left: -10, bottom: 0 }}>
            <CartesianGrid stroke="rgba(255,255,255,.07)" vertical={false} />
            <XAxis dataKey="name" stroke="#8f8a8c" fontSize={11} tickLine={false} axisLine={false} />
            <YAxis allowDecimals={false} stroke="#8f8a8c" fontSize={11} tickLine={false} axisLine={false} />
            <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "rgba(219,103,109,.05)" }} formatter={(value) => [value, "Documents"]} />
            <Bar dataKey="value" radius={[7, 7, 0, 0]}>
              {severityData.map((entry) => (
                <Cell
                  key={entry.name}
                  fill={entry.level >= 4 ? ACCENT : CHART_COLORS[Math.min(entry.level, CHART_COLORS.length - 1)]}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>
    </div>
  );
}
