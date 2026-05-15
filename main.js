import React, { useEffect, useMemo, useState } from "https://esm.sh/react@19.0.0";
import { createRoot } from "https://esm.sh/react-dom@19.0.0/client";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "https://esm.sh/recharts@3.2.1?external=react,react-dom";
import { dummyMonthlyData } from "./data/dashboardSeed.js";

const h = React.createElement;

const currencyTHB = new Intl.NumberFormat("th-TH", {
  style: "currency",
  currency: "THB",
  maximumFractionDigits: 0,
});
const numberFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 });

function monthRange(startMonth, endMonth) {
  const out = [];
  const cursor = new Date(`${startMonth}-01T00:00:00Z`);
  const end = new Date(`${endMonth}-01T00:00:00Z`);
  while (cursor <= end) {
    out.push(cursor.toISOString().slice(0, 7));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return out;
}

function monthKey(dateText) {
  return dateText.slice(0, 7);
}

function parseMoney(value) {
  return Number(String(value || "").replace(/,/g, "").trim());
}

function normalizeThaiFund(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/\s+\(/g, "(");
}

function providerLabel(provider) {
  return provider === "finnomena" ? "Thai fund" : provider === "csv" ? "CSV" : "Yahoo";
}

function pickMonthlyRows(rows, months, timing) {
  const grouped = new Map();
  rows.forEach((row) => {
    const key = monthKey(row.date);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  });
  const picks = new Map();
  months.forEach((month) => {
    const candidates = grouped.get(month) || [];
    if (candidates.length) picks.set(month, timing === "last" ? candidates.at(-1) : candidates[0]);
  });
  return picks;
}

function latestRowAtOrBefore(rows, endMonth) {
  const end = `${endMonth}-31`;
  return rows.filter((row) => row.date <= end).at(-1) || rows.at(-1);
}

function parseCsv(text, fallbackName) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) throw new Error(`${fallbackName}: CSV needs a header and one price row.`);
  const header = lines[0].split(",").map((cell) => cell.trim().toLowerCase());
  const dateIndex = header.findIndex((h2) => ["date", "nav date", "price date"].includes(h2));
  const closeIndex = header.findIndex((h2) => ["close", "adj close", "adjclose", "nav", "price"].includes(h2));
  if (dateIndex < 0 || closeIndex < 0) throw new Error(`${fallbackName}: CSV header must include Date and Close/NAV.`);

  const rows = lines
    .slice(1)
    .map((line) => {
      const cells = line.split(",");
      return { date: cells[dateIndex]?.trim(), close: parseMoney(cells[closeIndex]) };
    })
    .filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.date) && Number.isFinite(row.close));
  if (!rows.length) throw new Error(`${fallbackName}: No valid CSV rows found.`);
  return { rows: rows.sort((a, b) => a.date.localeCompare(b.date)), source: "CSV paste" };
}

async function fetchAssetHistory(asset, start, end) {
  if (asset.provider === "csv") return parseCsv(asset.csv, asset.name);
  const endpoint = asset.provider === "finnomena" ? "/api/history/finnomena" : "/api/history/yahoo";
  const response = await fetch(
    `${endpoint}?symbol=${encodeURIComponent(asset.symbol)}&start=${start}-01&end=${end}-31&timing=${asset.timing || "first"}`,
  );
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    throw new Error(`${asset.name}: data service returned a web page instead of fund data.`);
  }
  const payload = await response.json();
  if (!response.ok) throw new Error(`${asset.name}: ${payload.error || "Could not load history"}`);
  if (!payload.rows?.length) throw new Error(`${asset.name}: no usable rows returned.`);
  return payload;
}

async function fetchFxHistory(currency, start, end) {
  if (currency === "THB") return { rows: [] };
  const pair = `${currency}THB=X`;
  const response = await fetch(`/api/history/yahoo?symbol=${encodeURIComponent(pair)}&start=${start}-01&end=${end}-31`);
  const payload = await response.json();
  if (!response.ok || !payload.rows?.length) throw new Error(`Could not load FX rate ${pair}.`);
  return payload;
}

function computeAsset(asset, history, fxHistory, months, monthlyAmount, timing, endMonth) {
  const priceByMonth = pickMonthlyRows(history.rows, months, timing);
  const fxByMonth = asset.currency === "THB" ? new Map() : pickMonthlyRows(fxHistory.rows, months, timing);
  const latestPrice = latestRowAtOrBefore(history.rows, endMonth);
  const latestFx = asset.currency === "THB" ? { close: 1 } : latestRowAtOrBefore(fxHistory.rows, endMonth);
  let units = 0;
  let invested = 0;
  let lastPrice = null;
  let lastFx = asset.currency === "THB" ? 1 : null;
  const audit = [];
  const monthValues = [];

  months.forEach((month) => {
    const price = priceByMonth.get(month);
    const fx = asset.currency === "THB" ? 1 : fxByMonth.get(month)?.close;
    if (price) lastPrice = price;
    if (Number.isFinite(fx)) lastFx = fx;

    if (price && Number.isFinite(fx)) {
      const bought = monthlyAmount / fx / price.close;
      units += bought;
      invested += monthlyAmount;
      audit.push({
        month,
        asset: asset.name,
        code: asset.symbol,
        priceDate: price.date,
        price: price.close,
        fx,
        units: bought,
        invested: monthlyAmount,
        cumulativeUnits: units,
        valueNow: units * latestPrice.close * latestFx.close,
      });
    }
    monthValues.push({
      month,
      invested,
      value: lastPrice && Number.isFinite(lastFx) ? units * lastPrice.close * lastFx : 0,
    });
  });

  const currentValue = units * latestPrice.close * latestFx.close;
  return {
    asset,
    source: history.source,
    monthsUsed: audit.length,
    invested,
    currentValue,
    gain: currentValue - invested,
    returnPct: invested ? ((currentValue - invested) / invested) * 100 : 0,
    audit,
    monthValues,
  };
}

function aggregate(results, months) {
  const monthly = months.map((month) => ({ month, invested: 0, value: 0 }));
  const audit = [];
  results.forEach((result) => {
    const valueByMonth = new Map(result.monthValues.map((row) => [row.month, row]));
    const auditByMonth = new Map(result.audit.map((row) => [row.month, row]));
    monthly.forEach((point) => {
      const valuePoint = valueByMonth.get(point.month);
      if (valuePoint) {
        point.invested += valuePoint.invested;
        point.value += valuePoint.value;
      }
      const buy = auditByMonth.get(point.month);
      if (buy) audit.push(buy);
    });
  });
  return { monthly, audit };
}

function KpiCard({ label, value, helper, tone }) {
  const toneClass = tone === "positive" ? "text-positive" : tone === "danger" ? "text-danger" : "text-ink";
  return h("section", { className: "rounded-xl border border-line bg-white p-5 shadow-sm" }, [
    h("p", { key: "label", className: "text-xs font-bold uppercase tracking-[0.14em] text-muted" }, label),
    h("div", { key: "value", className: `mt-3 text-2xl font-black ${toneClass}` }, value),
    h("p", { key: "helper", className: "mt-2 min-h-5 text-sm text-muted" }, helper),
  ]);
}

function DesignedByJi() {
  const [photo, setPhoto] = useState(() => localStorage.getItem("designerPhoto") || "");
  const onPhoto = (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      const dataUrl = String(reader.result || "");
      localStorage.setItem("designerPhoto", dataUrl);
      setPhoto(dataUrl);
    });
    reader.readAsDataURL(file);
  };
  return h("label", { className: "flex cursor-pointer items-center gap-3 rounded-full border border-line bg-white px-3 py-2 shadow-sm" }, [
    h("input", { key: "input", type: "file", accept: "image/*", className: "sr-only", onChange: onPhoto }),
    h(
      "span",
      {
        key: "photo",
        className: "grid h-10 w-10 place-items-center overflow-hidden rounded-full bg-brand text-lg font-black text-white",
        style: photo ? { backgroundImage: `url(${photo})`, backgroundPosition: "center", backgroundSize: "cover" } : {},
      },
      photo ? "" : "📷",
    ),
    h("span", { key: "text", className: "leading-tight" }, [
      h("small", { key: "small", className: "block text-[10px] font-black uppercase tracking-[0.14em] text-muted" }, "Designed by"),
      h("strong", { key: "strong", className: "block text-base" }, "Ji"),
    ]),
  ]);
}

function AssetForm({ onCalculate, loading }) {
  const [provider, setProvider] = useState("finnomena");
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("SCBUSFOCUS(A)");
  const [currency, setCurrency] = useState("THB");
  const [csv, setCsv] = useState("");
  const [monthly, setMonthly] = useState("5000");
  const [start, setStart] = useState("2021-04");
  const [end, setEnd] = useState("2026-04");
  const [timing, setTiming] = useState("first");

  useEffect(() => {
    if (provider === "finnomena") setCurrency("THB");
    if (provider === "yahoo" && currency === "THB") setCurrency("USD");
  }, [provider]);

  const submit = (event) => {
    event.preventDefault();
    const cleanSymbol = provider === "finnomena" ? normalizeThaiFund(symbol) : symbol.trim();
    onCalculate({
      asset: {
        id: crypto.randomUUID(),
        name: (name || cleanSymbol || "Imported asset").trim(),
        provider,
        symbol: cleanSymbol,
        currency: provider === "finnomena" ? "THB" : currency,
        csv,
        timing,
      },
      monthlyAmount: parseMoney(monthly),
      start,
      end,
      timing,
    });
  };

  return h("form", { className: "rounded-2xl border border-line bg-white p-5 shadow-panel", onSubmit: submit }, [
    h("div", { key: "head", className: "flex items-center justify-between gap-4" }, [
      h("div", { key: "copy" }, [
        h("p", { className: "text-xs font-black uppercase tracking-[0.16em] text-muted" }, "Filters"),
        h("h2", { className: "mt-1 text-lg font-black" }, "Fund or asset input"),
      ]),
      h("button", { key: "button", className: "rounded-lg bg-brand px-4 py-2 font-black text-white disabled:opacity-60", disabled: loading }, loading ? "Loading..." : "Calculate"),
    ]),
    h("div", { key: "grid", className: "mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-4" }, [
      h(Field, { key: "provider", label: "Data source" }, h("select", { value: provider, onChange: (e) => setProvider(e.target.value), className: inputClass }, [
        h("option", { value: "finnomena" }, "Thai fund auto"),
        h("option", { value: "yahoo" }, "Yahoo symbol"),
        h("option", { value: "csv" }, "CSV paste"),
      ])),
      h(Field, { key: "name", label: "Display name" }, h("input", { value: name, onChange: (e) => setName(e.target.value), placeholder: "Optional label", className: inputClass })),
      h(Field, { key: "symbol", label: "Code / symbol" }, h("input", { value: symbol, onChange: (e) => setSymbol(e.target.value), placeholder: "SCBUSFOCUS(A), QQQ", className: inputClass })),
      h(Field, { key: "currency", label: "Currency" }, h("select", { value: currency, onChange: (e) => setCurrency(e.target.value), disabled: provider === "finnomena", className: inputClass }, [
        h("option", { value: "THB" }, "THB"),
        h("option", { value: "USD" }, "USD"),
        h("option", { value: "EUR" }, "EUR"),
        h("option", { value: "JPY" }, "JPY"),
      ])),
      h(Field, { key: "monthly", label: "Monthly DCA (THB)" }, h("input", { value: monthly, onChange: (e) => setMonthly(e.target.value), inputMode: "numeric", className: inputClass })),
      h(Field, { key: "start", label: "Start month" }, h("input", { type: "month", value: start, onChange: (e) => setStart(e.target.value), className: inputClass })),
      h(Field, { key: "end", label: "End month" }, h("input", { type: "month", value: end, onChange: (e) => setEnd(e.target.value), className: inputClass })),
      h(Field, { key: "timing", label: "Buy timing" }, h("select", { value: timing, onChange: (e) => setTiming(e.target.value), className: inputClass }, [
        h("option", { value: "first" }, "First price in month"),
        h("option", { value: "last" }, "Last price in month"),
      ])),
    ]),
    provider === "csv"
      ? h(Field, { key: "csv", label: "CSV prices", className: "mt-4" }, h("textarea", { value: csv, onChange: (e) => setCsv(e.target.value), className: `${inputClass} min-h-28 font-mono text-xs`, placeholder: "Date,Close\n2021-04-30,10.25" }))
      : null,
  ]);
}

const inputClass = "h-11 w-full rounded-lg border border-line bg-white px-3 text-sm font-semibold outline-none focus:border-brand focus:ring-4 focus:ring-amber-100 disabled:bg-slate-100";

function Field({ label, children, className = "" }) {
  return h("label", { className: `grid gap-1.5 text-sm font-bold text-slate-700 ${className}` }, [h("span", { key: "label" }, label), children]);
}

function App() {
  const [status, setStatus] = useState({ type: "info", message: "Choose a fund/asset and calculate. No sample asset is included unless you select it." });
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState([]);
  const [monthly, setMonthly] = useState(dummyMonthlyData);
  const [audit, setAudit] = useState([]);
  const [query, setQuery] = useState("");

  const summary = useMemo(() => {
    const invested = results.reduce((sum, row) => sum + row.invested, 0);
    const value = results.reduce((sum, row) => sum + row.currentValue, 0);
    const gain = value - invested;
    const activeMonths = new Set(audit.map((row) => row.month)).size;
    const returnPct = invested ? (gain / invested) * 100 : 0;
    const annualized = activeMonths && returnPct > -100 ? (Math.pow(1 + returnPct / 100, 12 / activeMonths) - 1) * 100 : 0;
    return { invested, value, gain, activeMonths, returnPct, annualized };
  }, [results, audit]);

  const filteredAudit = audit.filter((row) => `${row.month} ${row.asset} ${row.code}`.toLowerCase().includes(query.toLowerCase()));

  async function runCalculation({ asset, monthlyAmount, start, end, timing }) {
    if (!asset.symbol && asset.provider !== "csv") {
      setStatus({ type: "error", message: "Please enter a fund code or asset symbol." });
      return;
    }
    if (!Number.isFinite(monthlyAmount) || monthlyAmount <= 0) {
      setStatus({ type: "error", message: "Monthly DCA must be a positive number." });
      return;
    }
    setLoading(true);
    setStatus({ type: "info", message: `Loading ${asset.name} from ${providerLabel(asset.provider)}...` });
    try {
      const months = monthRange(start, end);
      const history = await fetchAssetHistory(asset, start, end);
      const fx = await fetchFxHistory(asset.currency, start, end);
      const computed = computeAsset(asset, history, fx, months, monthlyAmount, timing, end);
      const agg = aggregate([computed], months);
      setResults([computed]);
      setMonthly(agg.monthly);
      setAudit(agg.audit);
      setStatus({ type: "success", message: `Calculated ${asset.name}. Monthly table now contains this asset only.` });
    } catch (error) {
      setResults([]);
      setAudit([]);
      setStatus({ type: "error", message: error.message });
    } finally {
      setLoading(false);
    }
  }

  return h("main", { className: "min-h-screen p-4 sm:p-6 lg:p-8" }, [
    h("section", { key: "shell", className: "mx-auto max-w-7xl space-y-6" }, [
      h("header", { key: "header", className: "flex flex-col gap-4 rounded-2xl border border-line bg-white p-5 shadow-panel lg:flex-row lg:items-center lg:justify-between" }, [
        h("div", { key: "title" }, [
          h("p", { className: "text-xs font-black uppercase tracking-[0.18em] text-brand" }, "DCA investment dashboard"),
          h("h1", { className: "mt-2 max-w-3xl text-3xl font-black tracking-tight sm:text-4xl" }, "Backtest monthly DCA using real historical prices"),
          h("p", { className: "mt-2 max-w-2xl text-sm text-muted" }, "Thai mutual funds, Yahoo assets, FX conversion, KPI cards, Recharts analytics, and a monthly audit table."),
        ]),
        h(DesignedByJi, { key: "designer" }),
      ]),
      h(AssetForm, { key: "form", onCalculate: runCalculation, loading }),
      h("section", { key: "status", className: `rounded-xl border p-4 text-sm font-semibold ${status.type === "error" ? "border-red-200 bg-red-50 text-red-700" : status.type === "success" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-line bg-white text-muted"}` }, status.message),
      h("section", { key: "kpis", className: "grid gap-4 md:grid-cols-2 xl:grid-cols-4" }, [
        h(KpiCard, { key: "invested", label: "Total invested", value: currencyTHB.format(summary.invested), helper: `${summary.activeMonths || 0} active months` }),
        h(KpiCard, { key: "value", label: "Current value", value: currencyTHB.format(summary.value), helper: "Converted to THB" }),
        h(KpiCard, { key: "gain", label: "Gain / loss", value: currencyTHB.format(summary.gain), helper: `${summary.returnPct.toFixed(2)}% total return`, tone: summary.gain >= 0 ? "positive" : "danger" }),
        h(KpiCard, { key: "annualized", label: "Annualized return", value: `${summary.annualized.toFixed(2)}%`, helper: "Approximate DCA CAGR", tone: summary.annualized >= 0 ? "positive" : "danger" }),
      ]),
      h("section", { key: "charts", className: "grid gap-4 xl:grid-cols-[1.35fr_.65fr]" }, [
        h("article", { key: "growth", className: "rounded-2xl border border-line bg-white p-5 shadow-sm" }, [
          h("div", { className: "mb-4 flex items-center justify-between gap-4" }, [
            h("div", {}, [h("p", { className: "text-xs font-black uppercase tracking-[0.16em] text-muted" }, "Growth chart"), h("h2", { className: "mt-1 text-lg font-black" }, "Portfolio value vs money invested")]),
          ]),
          h("div", { className: "h-80" }, h(ResponsiveContainer, { width: "100%", height: "100%" }, h(AreaChart, { data: monthly, margin: { left: 4, right: 16, top: 10, bottom: 0 } }, [
            h(CartesianGrid, { key: "grid", strokeDasharray: "3 3", stroke: "#e5e7eb" }),
            h(XAxis, { key: "x", dataKey: "month", tick: { fontSize: 12 }, minTickGap: 28 }),
            h(YAxis, { key: "y", tickFormatter: (v) => `${Math.round(v / 1000)}k`, tick: { fontSize: 12 } }),
            h(Tooltip, { key: "tip", formatter: (v) => currencyTHB.format(v) }),
            h(Legend, { key: "legend" }),
            h(Area, { key: "value", type: "monotone", dataKey: "value", name: "Value", stroke: "#059669", fill: "#d1fae5", strokeWidth: 3 }),
            h(Line, { key: "invested", type: "monotone", dataKey: "invested", name: "Invested", stroke: "#f59e0b", strokeWidth: 3, dot: false }),
          ]))),
        ]),
        h("article", { key: "detail", className: "rounded-2xl border border-line bg-white p-5 shadow-sm" }, [
          h("p", { className: "text-xs font-black uppercase tracking-[0.16em] text-muted" }, "Selected asset"),
          results.length
            ? h("div", { className: "mt-4 space-y-4" }, results.map((result) =>
                h("div", { key: result.asset.id, className: "rounded-xl bg-soft p-4" }, [
                  h("div", { className: "text-lg font-black" }, result.asset.name),
                  h("div", { className: "mt-1 text-sm text-muted" }, `${result.asset.symbol} · ${providerLabel(result.asset.provider)} · ${result.asset.currency}`),
                  h("div", { className: "mt-4 grid grid-cols-2 gap-3 text-sm" }, [
                    h("span", { className: "text-muted" }, "Months used"),
                    h("strong", { className: "text-right" }, result.monthsUsed),
                    h("span", { className: "text-muted" }, "Return"),
                    h("strong", { className: `text-right ${result.returnPct >= 0 ? "text-positive" : "text-danger"}` }, `${result.returnPct.toFixed(2)}%`),
                    h("span", { className: "text-muted" }, "Data source"),
                    h("strong", { className: "text-right" }, result.source || "API"),
                  ]),
                ]),
              ))
            : h("div", { className: "mt-4 rounded-xl bg-soft p-4 text-sm text-muted" }, "Run a calculation to see asset detail here."),
        ]),
      ]),
      h("section", { key: "table", className: "rounded-2xl border border-line bg-white p-5 shadow-sm" }, [
        h("div", { className: "flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between" }, [
          h("div", {}, [h("p", { className: "text-xs font-black uppercase tracking-[0.16em] text-muted" }, "Monthly buys"), h("h2", { className: "mt-1 text-lg font-black" }, "Audit table")]),
          h("input", { value: query, onChange: (e) => setQuery(e.target.value), placeholder: "Search month or asset", className: "h-10 rounded-lg border border-line px-3 text-sm font-semibold outline-none focus:border-brand focus:ring-4 focus:ring-amber-100" }),
        ]),
        h("div", { className: "mt-4 max-h-[380px] overflow-auto" }, h("table", { className: "min-w-[900px] w-full text-left text-sm" }, [
          h("thead", { className: "sticky top-0 bg-white text-xs uppercase tracking-[0.1em] text-muted" }, h("tr", {}, ["Month", "Asset", "Buy date", "Buy price", "FX", "Units bought", "Invested", "Value now"].map((head) => h("th", { key: head, className: "border-b border-line px-3 py-3" }, head)))),
          h("tbody", {}, filteredAudit.length
            ? filteredAudit.map((row) => h("tr", { key: `${row.month}-${row.asset}`, className: "hover:bg-soft" }, [
                h("td", { className: "border-b border-slate-100 px-3 py-3 font-bold" }, row.month),
                h("td", { className: "border-b border-slate-100 px-3 py-3" }, [h("div", { className: "font-bold" }, row.asset), h("div", { className: "text-xs text-muted" }, row.code)]),
                h("td", { className: "border-b border-slate-100 px-3 py-3" }, row.priceDate),
                h("td", { className: "border-b border-slate-100 px-3 py-3" }, numberFmt.format(row.price)),
                h("td", { className: "border-b border-slate-100 px-3 py-3" }, numberFmt.format(row.fx)),
                h("td", { className: "border-b border-slate-100 px-3 py-3" }, numberFmt.format(row.units)),
                h("td", { className: "border-b border-slate-100 px-3 py-3" }, currencyTHB.format(row.invested)),
                h("td", { className: "border-b border-slate-100 px-3 py-3 font-bold" }, currencyTHB.format(row.valueNow)),
              ]))
            : h("tr", {}, h("td", { className: "px-3 py-8 text-center text-muted", colSpan: 8 }, "No rows yet. Run a calculation, or broaden your date range."))),
        ])),
      ]),
    ]),
  ]);
}

createRoot(document.getElementById("root")).render(h(App));
