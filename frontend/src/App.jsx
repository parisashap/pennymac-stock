import { useEffect, useState } from "react";
import {
  AreaChart, Area, Line,
  XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine,
} from "recharts";
import "./App.css";

const API_BASE = "https://8chu3gpiq3.execute-api.us-west-1.amazonaws.com/prod";

const COMPANY_NAMES = {
  AAPL: "Apple Inc.",
  AMZN: "Amazon.com Inc.",
  GOOGL: "Alphabet Inc.",
  MSFT: "Microsoft Corp.",
  NVDA: "NVIDIA Corp.",
  TSLA: "Tesla Inc.",
};

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function fmtDate(isoDate) {
  const [, m, d] = isoDate.split("-");
  return `${MONTHS[parseInt(m, 10) - 1]} ${parseInt(d, 10)}`;
}
const RANGES = [
  { label: "3M", days: 63 },
  { label: "1Y", days: 365 },
];

const TOP_SERIES_COLOR = "#10b981";
const SPY_SERIES_COLOR = "#2563eb";

function buildMonthLabels(data) {
  const seen = new Set(), labels = new Set();
  data.forEach(({ date }) => {
    const m = date.slice(5, 7);
    if (!seen.has(m)) { seen.add(m); labels.add(date); }
  });
  return labels;
}

function fmtMonth(v, labels) {
  if (!labels.has(v)) return "";
  return MONTHS[parseInt(v.slice(5, 7), 10) - 1];
}

// ── Shared components ────────────────────────────────

function InfoTooltip({ text }) {
  return (
    <span className="info-tooltip-wrap">
      <span className="info-icon">?</span>
      <span className="info-tooltip-box">{text}</span>
    </span>
  );
}

function ChangeBadge({ value }) {
  if (value == null) return <span className="dim">—</span>;
  const up = value >= 0;
  return (
    <span className={`badge ${up ? "up" : "down"}`}>
      {up ? "▲" : "▼"} {Math.abs(value).toFixed(2)}%
    </span>
  );
}


function RangeBar({ current, low, high }) {
  if (!current || !low || !high || high === low) return null;
  const pct = Math.min(100, Math.max(0, ((current - low) / (high - low)) * 100));
  return (
    <div className="range-bar-wrap">
      <span className="range-label">${low.toFixed(0)}</span>
      <div className="range-track">
        <div className="range-fill" style={{ width: `${pct}%` }} />
        <div className="range-dot" style={{ left: `${pct}%` }} />
      </div>
      <span className="range-label">${high.toFixed(0)}</span>
    </div>
  );
}

function MiniRangeBar({ current, low, high }) {
  if (!current || !low || !high || high === low) return <span className="dim">—</span>;
  const pct = Math.min(100, Math.max(0, ((current - low) / (high - low)) * 100));
  return (
    <div className="mini-range-wrap">
      <span className="mini-range-lbl">${low.toFixed(0)}</span>
      <div className="mini-range-track">
        <div className="mini-range-fill" style={{ width: `${pct}%` }} />
        <div className="mini-range-dot" style={{ left: `${pct}%` }} />
      </div>
      <span className="mini-range-lbl">${high.toFixed(0)}</span>
    </div>
  );
}

// ── Chart tooltips ───────────────────────────────────

const PriceTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tooltip">
      <p className="chart-tooltip-date">{label}</p>
      <p className="chart-tooltip-price">${payload[0].value.toFixed(2)}</p>
    </div>
  );
};

const CombinedTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  const top = payload.find((p) => p.dataKey === "topClose");
  const spy = payload.find((p) => p.dataKey === "spyClose");
  return (
    <div className="chart-tooltip">
      <p className="chart-tooltip-date">{label}</p>
      {top && <p className="chart-tooltip-price">Top Stock: ${top.value.toFixed(2)}</p>}
      {spy && <p className="chart-tooltip-price">S&amp;P 500: ${spy.value.toFixed(2)}</p>}
    </div>
  );
};

// ── Price chart (absolute price) ─────────────────────

function PriceChart({ history, range, positiveFill }) {
  const days = RANGES.find((r) => r.label === range)?.days ?? 365;
  const visible = history.slice(-days);
  if (!visible.length) return null;
  const monthLabels = buildMonthLabels(visible);
  const firstClose = visible[0].close;
  const lastClose = visible[visible.length - 1].close;
  const overallUp = lastClose >= firstClose;
  const minClose = Math.min(...visible.map((d) => d.close));
  const maxClose = Math.max(...visible.map((d) => d.close));
  const yPad = (maxClose - minClose) * 0.1;

  return (
    <ResponsiveContainer width="100%" height={240} key={`top-${range}`}>
      <AreaChart data={visible} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="priceGrad" x1="0" y1="0" x2="0" y2="1">
            <stop
              offset="5%"
              stopColor={positiveFill ? "#16a34a" : "#ef4444"}
              stopOpacity={0.18}
            />
            <stop
              offset="95%"
              stopColor={positiveFill ? "#16a34a" : "#ef4444"}
              stopOpacity={0}
            />
          </linearGradient>
        </defs>
        <XAxis
          dataKey="date" tickLine={false} axisLine={{ stroke: "#e2e8f0" }} interval={0}
          tick={{ fill: "#94a3b8", fontSize: 10 }}
          tickFormatter={(v) => fmtMonth(v, monthLabels)}
        />
        <YAxis
          domain={[minClose - yPad, maxClose + yPad]}
          tickLine={false} axisLine={{ stroke: "#e2e8f0" }}
          tick={{ fill: "#94a3b8", fontSize: 10 }}
          tickFormatter={(v) => v >= 1000 ? `$${(v / 1000).toFixed(1)}K` : `$${v.toFixed(0)}`}
          width={55}
        />
        <Tooltip content={<PriceTooltip />} />
        <ReferenceLine y={firstClose} stroke="#e2e8f0" strokeDasharray="4 4" />
        <Area
          type="monotone" dataKey="close"
          stroke={TOP_SERIES_COLOR} strokeWidth={2}
          fill="url(#priceGrad)" dot={false}
          activeDot={{ r: 4, fill: TOP_SERIES_COLOR }}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

// ── S&P 500 chart (standalone, below winner) ─────────

function SpyChart({ spyHistory, range }) {
  const days = RANGES.find((r) => r.label === range)?.days ?? 365;
  const visible = spyHistory.slice(-days);
  if (!visible.length) return null;

  const monthLabels = buildMonthLabels(visible);
  const firstClose = visible[0].close;
  const lastClose = visible[visible.length - 1].close;
  const overallUp = lastClose >= firstClose;
  const minClose = Math.min(...visible.map((d) => d.close));
  const maxClose = Math.max(...visible.map((d) => d.close));
  const yPad = (maxClose - minClose) * 0.1;
  const pctChange = ((lastClose - firstClose) / firstClose) * 100;

  return (
    <div className="comp-chart-wrap" key={`spy-${range}`}>
      <div className="comp-summary">
        <span className="chart-title">S&amp;P 500 (SPY)</span>
        <span className="comp-vs"> · </span>
        <span style={{ color: overallUp ? "#059669" : "#dc2626", fontWeight: 700, fontSize: "0.85rem" }}>
          {pctChange >= 0 ? "+" : ""}{pctChange.toFixed(1)}%
        </span>
        <span className="comp-period"> · {range}</span>
      </div>

      <ResponsiveContainer width="100%" height={180}>
        <AreaChart data={visible} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="spyGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={SPY_SERIES_COLOR} stopOpacity={0.15} />
              <stop offset="95%" stopColor={SPY_SERIES_COLOR} stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis
            dataKey="date" tickLine={false} axisLine={{ stroke: "#e2e8f0" }} interval={0}
            tick={{ fill: "#94a3b8", fontSize: 10 }}
            tickFormatter={(v) => fmtMonth(v, monthLabels)}
          />
          <YAxis
            domain={[minClose - yPad, maxClose + yPad]}
            tickLine={false} axisLine={{ stroke: "#e2e8f0" }}
            tick={{ fill: "#94a3b8", fontSize: 10 }}
            tickFormatter={(v) => v >= 1000 ? `$${(v / 1000).toFixed(1)}K` : `$${v.toFixed(0)}`}
            width={55}
          />
          <Tooltip content={<PriceTooltip />} />
          <ReferenceLine y={firstClose} stroke="#e2e8f0" strokeDasharray="4 4" />
          <Area
            type="monotone" dataKey="close"
            stroke={SPY_SERIES_COLOR} strokeWidth={2}
            fill="url(#spyGrad)" dot={false}
            activeDot={{ r: 4, fill: SPY_SERIES_COLOR }}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

// ── Combined chart (top stock + market) ─────────────

function CombinedChart({ history, spyHistory, range, positiveFill }) {
  const days = RANGES.find((r) => r.label === range)?.days ?? 365;
  const topVisible = history.slice(-days);
  const spyVisible = spyHistory.slice(-days);
  if (!topVisible.length || !spyVisible.length) return null;

  const topByDate = new Map(topVisible.map((d) => [d.date, d.close]));
  const spyByDate = new Map(spyVisible.map((d) => [d.date, d.close]));
  const data = topVisible
    .filter((d) => spyByDate.has(d.date))
    .map((d) => ({
      date: d.date,
      topClose: d.close,
      spyClose: spyByDate.get(d.date),
    }));

  if (!data.length) return null;

  const monthLabels = buildMonthLabels(data);
  const topMin = Math.min(...data.map((d) => d.topClose));
  const topMax = Math.max(...data.map((d) => d.topClose));
  const spyMin = Math.min(...data.map((d) => d.spyClose));
  const spyMax = Math.max(...data.map((d) => d.spyClose));
  const topPad = (topMax - topMin) * 0.1;
  const spyPad = (spyMax - spyMin) * 0.1;

  return (
    <ResponsiveContainer width="100%" height={260} key={`both-${range}`}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="topGrad" x1="0" y1="0" x2="0" y2="1">
            <stop
              offset="5%"
              stopColor={positiveFill ? "#16a34a" : "#ef4444"}
              stopOpacity={0.18}
            />
            <stop
              offset="95%"
              stopColor={positiveFill ? "#16a34a" : "#ef4444"}
              stopOpacity={0}
            />
          </linearGradient>
        </defs>
        <XAxis
          dataKey="date" tickLine={false} axisLine={{ stroke: "#e2e8f0" }} interval={0}
          tick={{ fill: "#94a3b8", fontSize: 10 }}
          tickFormatter={(v) => fmtMonth(v, monthLabels)}
        />
        <YAxis
          yAxisId="left"
          domain={[topMin - topPad, topMax + topPad]}
          tickLine={false} axisLine={{ stroke: "#e2e8f0" }}
          tick={{ fill: "#94a3b8", fontSize: 10 }}
          tickFormatter={(v) => v >= 1000 ? `$${(v / 1000).toFixed(1)}K` : `$${v.toFixed(0)}`}
          width={55}
        />
        <YAxis
          yAxisId="right"
          orientation="right"
          domain={[spyMin - spyPad, spyMax + spyPad]}
          tickLine={false} axisLine={false}
          tick={false}
          tickFormatter={(v) => v >= 1000 ? `$${(v / 1000).toFixed(1)}K` : `$${v.toFixed(0)}`}
          width={55}
        />
        <Tooltip content={<CombinedTooltip />} />
        <Area
          yAxisId="left"
          type="monotone" dataKey="topClose"
          stroke={TOP_SERIES_COLOR} strokeWidth={2}
          fill="url(#topGrad)" dot={false}
          activeDot={{ r: 4, fill: TOP_SERIES_COLOR }}
          isAnimationActive={false}
        />
        <Line
          yAxisId="right"
          type="monotone" dataKey="spyClose"
          stroke={SPY_SERIES_COLOR} strokeWidth={2}
          dot={false}
          activeDot={{ r: 3, fill: SPY_SERIES_COLOR }}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

// ── Chart panel (top stock + market view toggle) ─────

function TopChartsPanel({ ticker }) {
  const [range, setRange] = useState("1Y");
  const [showTop, setShowTop] = useState(true);
  const [showSpy, setShowSpy] = useState(true);
  const [history, setHistory] = useState(null);
  const [spyHistory, setSpyHistory] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!ticker) return;
    setLoading(true);
    const fetchHistory = (symbol) =>
      fetch(`${API_BASE}/history?ticker=${symbol}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .catch(() => []);

    Promise.all([fetchHistory(ticker), fetchHistory("SPY")])
      .then(([h, s]) => {
        setHistory(h);
        setSpyHistory(s);
        setLoading(false);
      })
      .catch(() => {
        setHistory([]);
        setSpyHistory([]);
        setLoading(false);
      });
  }, [ticker]);

  if (loading) return <div className="chart-loading">Loading chart...</div>;
  const spyAvailable = spyHistory?.length > 0;
  if (!history?.length && !spyAvailable) return null;

  const days = RANGES.find((r) => r.label === range)?.days ?? 365;
  const topVisible = history.slice(-days);
  const spyVisible = spyHistory?.slice(-days) ?? [];
  const topChange = topVisible.length > 1
    ? ((topVisible[topVisible.length - 1].close - topVisible[0].close) / topVisible[0].close) * 100
    : null;
  const spyChange = spyVisible.length > 1
    ? ((spyVisible[spyVisible.length - 1].close - spyVisible[0].close) / spyVisible[0].close) * 100
    : null;
  const diff = topChange != null && spyChange != null ? topChange - spyChange : null;
  const insight = diff != null
    ? `${ticker} ${diff >= 0 ? "outperformed" : "underperformed"} the S&P 500 by ${Math.abs(diff).toFixed(1)}% over ${range}.`
    : null;

  return (
    <section className="dashboard-section top-charts-section">
      <div className="section-header">
        <h2 className="section-title section-title-hero">Top Stock vs S&amp;P 500</h2>
        <p className="section-description">
          Compare the top moving stock with the S&amp;P 500 over the selected time period.
        </p>
        {insight && <p className="chart-insight">{insight}</p>}
      </div>
      <div className="chart-card">
        <div className="chart-header">
          <div className="range-tabs">
            {RANGES.map((r) => (
              <button
                key={r.label}
                className={`range-tab${range === r.label ? " active" : ""}`}
                onClick={() => setRange(r.label)}
              >
                {r.label}
              </button>
            ))}
          </div>
          <div className="view-checks">
            <label className="view-check">
              <input
                type="checkbox"
                checked={showTop}
                onChange={(e) => setShowTop(e.target.checked)}
              />
              <span>Top Stock</span>
            </label>
            <label className="view-check">
              <input
                type="checkbox"
                checked={showSpy}
                onChange={(e) => setShowSpy(e.target.checked)}
              />
              <span>S&amp;P 500</span>
            </label>
          </div>
        </div>
        <div className="line-legend">
          {showTop && (
            <span className="line-legend-item">
              <span className="line-swatch top" />
              Top Stock
              {topChange != null && (
                <span className={`perf-value ${topChange >= 0 ? "up" : "down"}`}>
                  {topChange >= 0 ? "+" : ""}{topChange.toFixed(1)}%
                </span>
              )}
            </span>
          )}
          {showSpy && (
            <span className="line-legend-item">
              <span className="line-swatch spy" />
              S&amp;P 500
              {spyChange != null && (
                <span className={`perf-value ${spyChange >= 0 ? "up" : "down"}`}>
                  {spyChange >= 0 ? "+" : ""}{spyChange.toFixed(1)}%
                </span>
              )}
            </span>
          )}
        </div>

        {showTop && showSpy && spyAvailable && (
          <CombinedChart
            history={history}
            spyHistory={spyHistory}
            range={range}
            positiveFill={topChange != null ? topChange >= 0 : true}
          />
        )}

        {showTop && (!showSpy || !spyAvailable) && (
          <PriceChart
            ticker={ticker}
            history={history}
            range={range}
            positiveFill={topChange != null ? topChange >= 0 : true}
          />
        )}

        {showSpy && spyAvailable && !showTop && (
          <SpyChart spyHistory={spyHistory} range={range} />
        )}

        {showSpy && !spyAvailable && (
          <div className="chart-loading">No S&amp;P 500 data available.</div>
        )}

        {!showTop && !showSpy && (
          <div className="chart-loading">Nothing to show! Please select at least one series.</div>
        )}
      </div>
    </section>
  );
}

// ── Winner card ──────────────────────────────────────

function WinnerCard({ mover }) {
  const vsMarket = mover.sp500_pct_change != null
    ? mover.percent_change - mover.sp500_pct_change
    : null;
  const outperform = vsMarket != null ? vsMarket > 0 : mover.percent_change >= 0;

  return (
    <div className={`winner-card ${outperform ? "outperform" : "underperform"}`}>
      <div className="winner-header">
        <div className="winner-identity">
          <div className="winner-ticker-block">
            <span className="winner-ticker">{mover.ticker}</span>
            <span className="winner-company">{COMPANY_NAMES[mover.ticker] ?? mover.ticker}</span>
          </div>
          <span className="winner-date">{fmtDate(mover.date)}</span>
        </div>
        <ChangeBadge value={mover.percent_change} />
      </div>

      <div className="winner-price">${mover.close_price?.toFixed(2)}</div>

      <div className="winner-stat-row">
        <div className="winner-stat-card">
          <div className="winner-stat-label">
            VS S&amp;P 500
            <InfoTooltip text="Shows how the stock performed compared to the overall market today." />
          </div>
          <div className="winner-stat-value">
            {vsMarket != null ? <ChangeBadge value={vsMarket} /> : <span className="dim">—</span>}
          </div>
        </div>

        <div className="winner-stat-card">
          <div className="winner-stat-label">
            BETA
            <InfoTooltip text="Measures how volatile the stock is compared to the market. 1.0 means it moves with the market, above 1 means more volatile." />
          </div>
          <div className="winner-stat-value">
            {mover.beta != null
              ? <span className="beta-stat">{mover.beta.toFixed(2)}</span>
              : <span className="dim">—</span>}
          </div>
        </div>

        <div className="winner-stat-card">
          <div className="winner-stat-label">
            52-Week Range
            <InfoTooltip text="Shows where the current price sits between the lowest and highest price over the past year." />
          </div>
          <div className="winner-stat-value range-stat-value">
            {mover.week52_low && mover.week52_high
              ? <span className="range-stat">${mover.week52_low.toFixed(0)} – ${mover.week52_high.toFixed(0)}</span>
              : <span className="dim">—</span>}
          </div>
        </div>
      </div>

      <div className="winner-body">
        <RangeBar
          current={mover.close_price}
          low={mover.week52_low}
          high={mover.week52_high}
        />
      </div>
    </div>
  );
}

// ── App ──────────────────────────────────────────────

export default function App() {
  const [movers, setMovers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch(`${API_BASE}/movers`)
      .then((res) => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json(); })
      .then((data) => { setMovers(data); setLoading(false); })
      .catch((err) => { setError(err.message); setLoading(false); });
  }, []);

  const latest = movers[0];

  return (
    <div className="container">
      <header>
        <div className="header-top">
          <div>
            <h1>Daily Top Mover</h1>
            <p className="subtitle">Tracks the strongest daily movers from your watchlist.</p>
            <p className="watchlist-label">Watchlist: NVDA, MSFT, AMZN, AAPL, TSLA, GOOGL</p>
          </div>
        </div>
      </header>

      {loading && <p className="status">Loading market data...</p>}
      {error && <p className="status error">Error: {error}</p>}

      {!loading && !error && latest && (
        <div className="page-layout">
          <TopChartsPanel ticker={latest.ticker} />

          <div className="bottom-grid">
            <section className="dashboard-section">
              <div className="section-header">
                <h2 className="section-title">Today&apos;s Top Mover</h2>
              </div>
              <WinnerCard mover={latest} />
              <div className="edu-section">
                <div className="edu-header">
                  <h3 className="edu-title">Continue Your Investing Journey</h3>
                  <p className="edu-subtitle">Start with the basics.</p>
                </div>
                <div className="edu-list">
                  <a className="edu-item" href="https://www.schwab.com/learn/story/investing-basics" target="_blank" rel="noreferrer">
                    Charles Schwab — Investing Basics
                  </a>
                  <a className="edu-item" href="https://www.investor.gov/introduction-investing" target="_blank" rel="noreferrer">
                    Investor.gov — Introduction to Investing
                  </a>
                  <a className="edu-item" href="https://www.investopedia.com/articles/investing/052216/4-benefits-holding-stocks-long-term.asp" target="_blank" rel="noreferrer">
                    Investopedia — Advantages of Long-Term Stock Investment
                  </a>
                </div>
              </div>
            </section>

            <section className="dashboard-section">
              <div className="section-header">
                <h2 className="section-title">Top Movers (Last 7 Trading Days)</h2>
                <p className="section-description">
                  Daily top-performing stocks from the watchlist with market comparison and volatility indicators.
                </p>
              </div>
              <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Ticker</th>
                  <th>Close</th>
                  <th>Change</th>
                  <th>
                    vs S&amp;P 500
                  </th>
                  <th>
                    Beta
                  </th>
                  <th>
                    52-Week Range
                  </th>
                </tr>
              </thead>
              <tbody>
                {movers.map((m) => {
                  const rel = m.sp500_pct_change != null
                    ? m.percent_change - m.sp500_pct_change
                    : null;
                  return (
                    <tr key={m.date} className="table-row">
                      <td className="date-cell">{fmtDate(m.date)}</td>
                      <td className="ticker">{m.ticker}</td>
                      <td>${m.close_price?.toFixed(2)}</td>
                      <td><ChangeBadge value={m.percent_change} /></td>
                      <td><ChangeBadge value={rel} /></td>
                      <td>
                        {m.beta != null
                          ? <span className="beta-inline">β {m.beta.toFixed(2)}</span>
                          : <span className="dim">—</span>}
                      </td>
                      <td>
                        <MiniRangeBar
                          current={m.close_price}
                          low={m.week52_low}
                          high={m.week52_high}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              </table>
            </section>
          </div>
        </div>
      )}
    </div>
  );
}
