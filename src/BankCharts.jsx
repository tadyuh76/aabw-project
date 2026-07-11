"use client";

import { useMemo } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

const ACCENT = "#DB676D";
const CHART_COLORS = [ACCENT, "#f0b4b7", "#aa8c8f", "#77585b", "#d9d4d5"];
const TACTIC_KEYS = ["IMPERSONATION", "PHISHING", "QR RELAY", "ADVANCE FEE"];
const TACTIC_COLORS = {
  IMPERSONATION: "#DB676D",
  PHISHING: "#f0b4b7",
  "QR RELAY": "#a87579",
  "ADVANCE FEE": "#7f6669",
};

const tooltipStyle = {
  background: "#171415",
  border: "1px solid rgba(255,255,255,.14)",
  borderRadius: 12,
  color: "#f5f3f0",
  fontSize: 11,
};

function buildTrend(days) {
  const count = days === 7 ? 7 : days === 90 ? 18 : 14;
  const step = days === 90 ? 5 : days === 30 ? 2 : 1;
  return Array.from({ length: count }, (_, index) => {
    const distance = (count - 1 - index) * step;
    const date = new Date(2026, 6, 11 - distance);
    return {
      label: date.toLocaleDateString("en-US", { day: "2-digit", month: "short" }),
      IMPERSONATION: 5 + ((index * 5 + 3) % 13),
      PHISHING: 3 + ((index * 7 + 2) % 11),
      "QR RELAY": 4 + ((index * 4 + 5) % 9),
      "ADVANCE FEE": 2 + ((index * 3 + 1) % 7),
    };
  });
}

function ChartCard({ title, note, meta, className = "", children }) {
  return (
    <section className={`analytics-card ${className}`}>
      <header>
        <div><span>{title}</span><small>{note}</small></div>
        {meta && <strong>{meta}</strong>}
      </header>
      <div className="analytics-chart-body">{children}</div>
    </section>
  );
}

export function BankCharts({ campaigns, timeRange, onBankSelect, onTacticSelect }) {
  const trendData = useMemo(() => buildTrend(Number(timeRange)), [timeRange]);
  const bankData = useMemo(() => {
    const totals = new Map();
    campaigns.forEach((campaign) => {
      campaign.banks.forEach((bank) => {
        const current = totals.get(bank) || { name: bank, reports: 0, exposure: 0 };
        current.reports += Math.round(campaign.reports / campaign.banks.length);
        current.exposure += Math.round(campaign.exposureValue / campaign.banks.length);
        totals.set(bank, current);
      });
    });
    return [...totals.values()].sort((a, b) => b.exposure - a.exposure).slice(0, 6);
  }, [campaigns]);
  const tacticData = useMemo(() => {
    const totals = new Map();
    campaigns.forEach((campaign) => {
      campaign.tactics.forEach((tactic) => {
        totals.set(tactic, (totals.get(tactic) || 0) + Math.round(campaign.reports / campaign.tactics.length));
      });
    });
    return [...totals.entries()]
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);
  }, [campaigns]);
  const statusData = useMemo(() => {
    const buckets = { ACTIVE: 0, REVIEW: 0, ACTIONED: 0, CONTAINED: 0 };
    campaigns.forEach((campaign) => {
      if (campaign.status === "CONTAINED") buckets.CONTAINED += 1;
      else if (campaign.status === "NEEDS REVIEW") buckets.REVIEW += 1;
      else if (campaign.status === "MONITORING") buckets.ACTIONED += 1;
      else buckets.ACTIVE += 1;
    });
    return Object.entries(buckets).map(([name, value]) => ({ name, value }));
  }, [campaigns]);

  const totalTacticReports = tacticData.reduce((sum, item) => sum + item.value, 0);

  return (
    <div className="analytics-grid">
      <ChartCard
        className="trend-card"
        title="SCAM ACTIVITY TREND"
        note="Customer reports by scam tactic"
        meta={`LAST ${timeRange} DAYS`}
      >
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={trendData} margin={{ top: 10, right: 12, left: -18, bottom: 0 }}>
            <CartesianGrid stroke="rgba(255,255,255,.07)" vertical={false} />
            <XAxis dataKey="label" stroke="#8f8a8c" fontSize={11} tickLine={false} axisLine={false} minTickGap={20} />
            <YAxis stroke="#8f8a8c" fontSize={11} tickLine={false} axisLine={false} />
            <Tooltip contentStyle={tooltipStyle} cursor={{ stroke: "rgba(219,103,109,.3)" }} />
            <Legend wrapperStyle={{ fontSize: 11, paddingTop: 8 }} />
            {TACTIC_KEYS.map((key) => (
              <Area key={key} type="monotone" dataKey={key} stackId="1" stroke={TACTIC_COLORS[key]} fill={TACTIC_COLORS[key]} fillOpacity={key === "IMPERSONATION" ? .48 : .28} />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard title="EXPOSURE BY BANK" note="Estimated exposure in VND millions" meta="CLICK TO FILTER">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={bankData} layout="vertical" margin={{ top: 6, right: 18, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="rgba(255,255,255,.07)" horizontal={false} />
            <XAxis type="number" stroke="#8f8a8c" fontSize={11} tickLine={false} axisLine={false} />
            <YAxis type="category" dataKey="name" stroke="#bbb6b8" fontSize={11} width={108} tickLine={false} axisLine={false} />
            <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "rgba(219,103,109,.05)" }} formatter={(value) => [`₫${value}M`, "Exposure"]} />
            <Bar dataKey="exposure" fill={ACCENT} radius={[0, 6, 6, 0]} onClick={(row) => onBankSelect?.(row.name)} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard title="REPORTS BY SCAM TACTIC" note="How scammers are approaching customers" meta={`${totalTacticReports} REPORTS`}>
        <div className="donut-chart-wrap">
          <ResponsiveContainer width="58%" height="100%">
            <PieChart>
              <Tooltip contentStyle={tooltipStyle} />
              <Pie data={tacticData} dataKey="value" nameKey="name" innerRadius="58%" outerRadius="85%" paddingAngle={2} onClick={(row) => onTacticSelect?.(row.name)}>
                {tacticData.map((entry, index) => <Cell key={entry.name} fill={CHART_COLORS[index % CHART_COLORS.length]} />)}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
          <div className="chart-legend-list">
            {tacticData.map((entry, index) => (
              <button key={entry.name} onClick={() => onTacticSelect?.(entry.name)}>
                <i style={{ background: CHART_COLORS[index % CHART_COLORS.length] }} />
                <span>{entry.name}</span><strong>{entry.value}</strong>
              </button>
            ))}
          </div>
        </div>
      </ChartCard>

      <ChartCard title="CAMPAIGN STATUS" note="Current operational state" meta="ALL ACTIVE CASES">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={statusData} margin={{ top: 10, right: 10, left: -22, bottom: 0 }}>
            <CartesianGrid stroke="rgba(255,255,255,.07)" vertical={false} />
            <XAxis dataKey="name" stroke="#8f8a8c" fontSize={10} tickLine={false} axisLine={false} />
            <YAxis allowDecimals={false} stroke="#8f8a8c" fontSize={11} tickLine={false} axisLine={false} />
            <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "rgba(219,103,109,.05)" }} />
            <Bar dataKey="value" radius={[7, 7, 0, 0]}>
              {statusData.map((entry, index) => <Cell key={entry.name} fill={CHART_COLORS[index % CHART_COLORS.length]} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>
    </div>
  );
}
