"use client";

import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { MonthDay } from "@/lib/dashboard";
import { fmt, pct, shortDate } from "@/lib/format";

interface Props {
  month: MonthDay[];
  today: string;
  decimals: number;
  target: string;
}

interface Point {
  date: string;
  day: number;
  actual: number | null;
  predicted: number | null;
  band: [number, number] | null;
  lastMonth: number | null;
  raw: MonthDay;
}

export default function MonthChart({ month, today, decimals, target }: Props) {
  const data: Point[] = month.map((d) => ({
    date: d.date,
    day: Number(d.date.slice(8)),
    actual: d.actual,
    predicted: d.predicted,
    band: d.kind !== "past" && d.lower80 !== null && d.upper80 !== null ? [d.lower80, d.upper80] : null,
    lastMonth: d.lastMonth,
    raw: d,
  }));

  const values = data.flatMap((p) => [p.actual, p.predicted, p.lastMonth, ...(p.band ?? [])]).filter(
    (v): v is number => v !== null,
  );
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = (max - min) * 0.12 || max * 0.001;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-ink-2 mb-3" aria-label="Legend">
        <LegendItem color="var(--series-1)" label="Actual (Wise)" />
        <LegendItem color="var(--series-2)" label="Predicted" dashed />
        <span className="inline-flex items-center gap-2">
          <span className="inline-block h-3 w-5 rounded-sm" style={{ background: "var(--band)" }} />
          80% range
        </span>
        <LegendItem color="var(--series-3)" label="Same day last month" thin />
        {month.some((d) => d.events.length > 0) && <LegendItem color="var(--text-3)" label="Policy event" dotted />}
      </div>
      <div className="h-[300px] sm:h-[340px] -ml-2">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="var(--grid)" vertical={false} />
            <XAxis
              dataKey="day"
              tickLine={false}
              axisLine={{ stroke: "var(--border)" }}
              tick={{ fill: "var(--text-3)", fontSize: 11 }}
              interval="preserveStartEnd"
              minTickGap={14}
            />
            <YAxis
              domain={[min - pad, max + pad]}
              tickLine={false}
              axisLine={false}
              width={decimals > 3 ? 62 : 56}
              tick={{ fill: "var(--text-3)", fontSize: 11 }}
              tickFormatter={(v: number) => fmt(v, decimals > 3 ? 4 : 1)}
            />
            <Tooltip
              cursor={{ stroke: "var(--text-3)", strokeDasharray: "3 3" }}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const p = (payload[0].payload as Point).raw;
                return (
                  <div className="card px-3 py-2 text-xs shadow-lg min-w-[180px]">
                    <div className="font-medium text-ink mb-1">
                      {shortDate(p.date)} {p.kind === "today" ? "· today" : ""}
                    </div>
                    {p.actual !== null && (
                      <Row label={p.provisional ? "Live (Wise)" : "Actual"} value={`${fmt(p.actual, decimals)} ${target}`} />
                    )}
                    {p.predicted !== null && <Row label="Predicted" value={fmt(p.predicted, decimals)} />}
                    {p.kind !== "past" && p.lower80 !== null && (
                      <Row label="80% range" value={`${fmt(p.lower80, decimals)} – ${fmt(p.upper80, decimals)}`} />
                    )}
                    {p.delta !== null && (
                      <Row
                        label={p.delta > 0 ? "Too high by" : p.delta < 0 ? "Too low by" : "Miss"}
                        value={`${fmt(Math.abs(p.delta), decimals)} (${pct(Math.abs(p.pctError!), 3, false)})`}
                      />
                    )}
                    {p.lastMonth !== null && <Row label="Last month" value={fmt(p.lastMonth, decimals)} />}
                    {p.events.length > 0 && <Row label="Policy event" value={p.events.join(", ")} />}
                  </div>
                );
              }}
            />
            <Area
              dataKey="band"
              stroke="none"
              fill="var(--band)"
              isAnimationActive={false}
              connectNulls={false}
              activeDot={false}
            />
            <Line
              dataKey="lastMonth"
              stroke="var(--series-3)"
              strokeWidth={1.5}
              strokeOpacity={0.75}
              dot={false}
              activeDot={false}
              isAnimationActive={false}
            />
            <Line
              dataKey="predicted"
              stroke="var(--series-2)"
              strokeWidth={2}
              strokeDasharray="5 4"
              dot={false}
              activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--surface)" }}
              isAnimationActive={false}
            />
            <Line
              dataKey="actual"
              stroke="var(--series-1)"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4.5, strokeWidth: 2, stroke: "var(--surface)" }}
              isAnimationActive={false}
            />
            {month
              .filter((d) => d.events.length > 0)
              .map((d) => (
                <ReferenceLine
                  key={d.date}
                  x={Number(d.date.slice(8))}
                  stroke="var(--text-3)"
                  strokeDasharray="1 3"
                  strokeOpacity={0.8}
                  label={{ value: d.events.join("·"), position: "insideBottomLeft", fill: "var(--text-3)", fontSize: 10 }}
                />
              ))}
            <ReferenceLine
              x={Number(today.slice(8))}
              stroke="var(--text-3)"
              strokeDasharray="2 3"
              label={{ value: "Today", position: "insideTopRight", fill: "var(--text-3)", fontSize: 11 }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 py-0.5">
      <span className="text-ink-3">{label}</span>
      <span className="num text-ink">{value}</span>
    </div>
  );
}

function LegendItem({
  color,
  label,
  dashed,
  thin,
  dotted,
}: {
  color: string;
  label: string;
  dashed?: boolean;
  thin?: boolean;
  dotted?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-2">
      <svg width="20" height="8" aria-hidden>
        <line
          x1="1"
          y1="4"
          x2="19"
          y2="4"
          stroke={color}
          strokeWidth={thin ? 1.5 : 2}
          strokeDasharray={dashed ? "5 3" : dotted ? "1 3" : undefined}
          strokeLinecap="round"
        />
      </svg>
      {label}
    </span>
  );
}
