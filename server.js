import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT || 4173);

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".jsx": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

let fundsCache = null;
let fundsCacheTime = 0;
const fundsCacheMs = 1000 * 60 * 60;
let fundHistoryCache = null;
let secFundsCache = null;
let secFundsCacheTime = 0;
const secFactsheetKey = process.env.SEC_FACTSHEET_KEY || "";
const secDailyInfoKey = process.env.SEC_DAILYINFO_KEY || "";

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function toUnix(dateText) {
  const date = new Date(`${dateText}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  return Math.floor(date.getTime() / 1000);
}

function normalizeSeries(result, symbol) {
  const quote = result?.indicators?.quote?.[0];
  const adj = result?.indicators?.adjclose?.[0]?.adjclose || [];
  const timestamps = result?.timestamp || [];
  const currency = result?.meta?.currency || "USD";
  const exchange = result?.meta?.exchangeName || "Yahoo";
  const rows = timestamps
    .map((stamp, index) => {
      const close = adj[index] ?? quote?.close?.[index];
      if (!Number.isFinite(close)) return null;
      return {
        date: new Date(stamp * 1000).toISOString().slice(0, 10),
        close: Number(close),
      };
    })
    .filter(Boolean);

  return {
    symbol,
    currency,
    exchange,
    rows,
    source: "Yahoo Finance chart API",
  };
}

function normalizeFinnomenaBars(payload, symbol) {
  if (payload?.s !== "ok") {
    throw new Error(payload?.errmsg || "No Finnomena NAV data returned");
  }
  const timestamps = payload.t || [];
  const closes = payload.c || [];
  const rows = timestamps
    .map((stamp, index) => {
      const close = closes[index];
      if (!Number.isFinite(close)) return null;
      return {
        date: new Date(stamp * 1000).toISOString().slice(0, 10),
        close: Number(close),
      };
    })
    .filter(Boolean);

  return {
    symbol,
    currency: "THB",
    exchange: "Finnomena",
    rows,
    source: "Finnomena public fund API",
  };
}

async function fetchYahoo(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
      accept: "application/json,text/plain,*/*",
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Yahoo returned ${response.status}: ${text.slice(0, 180)}`);
  }
  return response.json();
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
      accept: "application/json,text/plain,*/*",
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Remote API returned ${response.status}: ${text.slice(0, 180)}`);
  }
  return response.json();
}

async function fetchSecJson(url, { key, method = "GET", body } = {}) {
  if (!key) throw new Error("SEC API key is not configured");
  const response = await fetch(url, {
    method,
    headers: {
      "content-type": "application/json",
      "Ocp-Apim-Subscription-Key": key,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`SEC returned ${response.status}: ${text.slice(0, 180)}`);
  }
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function comparableFundCode(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/[()]/g, "")
    .trim();
}

function fundCodeCandidates(fund) {
  return [
    fund?.proj_abbr_name,
    fund?.class_abbr_name,
    fund?.fund_abbr_name,
    fund?.proj_name_en,
    fund?.proj_name_th,
  ].filter(Boolean);
}

async function getFinnomenaFunds() {
  const now = Date.now();
  if (fundsCache && now - fundsCacheTime < fundsCacheMs) return fundsCache;

  const payload = await fetchJson("https://www.finnomena.com/fn3/api/fund/v2/public/funds");
  if (!payload?.status || !Array.isArray(payload.data)) {
    throw new Error("Could not load Thai fund list");
  }
  fundsCache = payload.data;
  fundsCacheTime = now;
  return fundsCache;
}

async function getFundHistoryCache() {
  if (fundHistoryCache) return fundHistoryCache;
  try {
    const raw = await readFile(join(__dirname, "data", "fund-cache.json"), "utf8");
    fundHistoryCache = JSON.parse(raw).funds || {};
  } catch {
    fundHistoryCache = {};
  }
  return fundHistoryCache;
}

async function getSecFunds() {
  const now = Date.now();
  if (secFundsCache && now - secFundsCacheTime < fundsCacheMs) return secFundsCache;

  const amcs = await fetchSecJson("https://api.sec.or.th/FundFactsheet/fund/amc", {
    key: secFactsheetKey,
  });
  if (!Array.isArray(amcs)) throw new Error("SEC fund AMC list was not an array");

  const groupedFunds = await Promise.all(
    amcs
      .filter((amc) => amc?.unique_id)
      .map((amc) =>
        fetchSecJson(`https://api.sec.or.th/FundFactsheet/fund/amc/${encodeURIComponent(amc.unique_id)}`, {
          key: secFactsheetKey,
        })
          .then((payload) => (Array.isArray(payload) ? payload : []))
          .catch(() => []),
      ),
  );

  secFundsCache = groupedFunds.flat().filter((fund) => fund?.proj_id && fund?.proj_abbr_name);
  secFundsCacheTime = now;
  return secFundsCache;
}

async function resolveFinnomenaFund(input) {
  const localCode = comparableFundCode(input);
  const localKnownFunds = {
    "B-INNOTECH": {
      short_code: "B-INNOTECH",
      fund_id: "B-INNOTECH",
      name_th: "B-INNOTECH",
    },
    "SCBUSFOCUS(A)": {
      short_code: "SCBUSFOCUS(A)",
      fund_id: "SCBUSFOCUS(A)",
      name_th: "SCBUSFOCUS(A)",
    },
    "K-USXNDQ-A(A)": {
      short_code: "K-USXNDQ-A(A)",
      fund_id: "K-USXNDQ-A(A)",
      name_th: "K-USXNDQ-A(A)",
    },
  };

  const localMatch = Object.entries(localKnownFunds).find(([code]) => comparableFundCode(code) === localCode);
  if (localMatch) return localMatch[1];

  const funds = await getFinnomenaFunds();
  const exact = funds.find(
    (fund) => comparableFundCode(fund.short_code) === localCode || comparableFundCode(fund.fund_id) === localCode,
  );
  if (exact) return exact;

  const partial = funds.find((fund) => comparableFundCode(fund.short_code).includes(localCode));
  if (partial) return partial;

  return {
    short_code: String(input || "").trim().toUpperCase().replace(/\s+\(/g, "("),
    fund_id: "",
    name_th: "",
  };
}

function monthWindows(startMonth, endMonth) {
  const months = [];
  const cursor = new Date(`${startMonth.slice(0, 7)}-01T00:00:00Z`);
  const end = new Date(`${endMonth.slice(0, 7)}-01T00:00:00Z`);
  while (cursor <= end) {
    const year = cursor.getUTCFullYear();
    const month = cursor.getUTCMonth();
    const first = new Date(Date.UTC(year, month, 1));
    const last = new Date(Date.UTC(year, month + 1, 0));
    months.push({ first, last });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}

function dateText(date) {
  return date.toISOString().slice(0, 10);
}

function shiftedDate(base, days) {
  const copy = new Date(base);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function normalizeSecNavPayload(payload) {
  const rows = Array.isArray(payload) ? payload : payload ? [payload] : [];
  return rows
    .map((row) => ({
      date: row.nav_date,
      close: Number(row.last_val),
    }))
    .filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.date) && Number.isFinite(row.close));
}

async function findSecFund(symbol) {
  const localCode = comparableFundCode(symbol);
  const secFunds = await getSecFunds();
  const exactMatch = secFunds.find((fund) =>
    fundCodeCandidates(fund).some((candidate) => comparableFundCode(candidate) === localCode),
  );
  if (exactMatch) return exactMatch;

  const partialMatch = secFunds.find((fund) =>
    fundCodeCandidates(fund).some((candidate) => comparableFundCode(candidate).includes(localCode)),
  );
  if (partialMatch) return partialMatch;

  const candidateBodies = [
    { class_abbr_name: symbol },
    { proj_abbr_name: symbol },
    { search: symbol },
    { fund: symbol },
  ];

  let lastError;
  for (const body of candidateBodies) {
    try {
      const payload = await fetchSecJson("https://api.sec.or.th/FundFactsheet/fund/class_fund", {
        key: secFactsheetKey,
        method: "POST",
        body,
      });
      const rows = Array.isArray(payload) ? payload : [];
      const exact = rows.find(
        (row) =>
          comparableFundCode(row.class_abbr_name) === comparableFundCode(symbol) ||
          comparableFundCode(row.proj_abbr_name) === comparableFundCode(symbol),
      );
      if (exact) return exact;
      if (rows[0]) return rows[0];
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  throw new Error(`SEC could not find fund "${symbol}"`);
}

async function fetchSecNavOnDate(projId, date) {
  const payload = await fetchSecJson(
    `https://api.sec.or.th/FundDailyInfo/${encodeURIComponent(projId)}/dailynav/${date}`,
    { key: secDailyInfoKey },
  );
  return normalizeSecNavPayload(payload)[0] || null;
}

async function findSecNavNearDate(projId, baseDate, direction) {
  for (let offset = 0; offset <= 10; offset += 1) {
    const date = dateText(shiftedDate(baseDate, direction * offset));
    try {
      const row = await fetchSecNavOnDate(projId, date);
      if (row) return row;
    } catch (error) {
      if (!String(error.message).includes("404")) throw error;
    }
  }
  return null;
}

async function fetchSecMonthlyHistory(symbol, start, end) {
  const fund = await findSecFund(symbol);
  if (!fund?.proj_id) throw new Error(`SEC fund lookup returned no proj_id for "${symbol}"`);
  const rows = [];
  for (const window of monthWindows(start, end)) {
    const first = await findSecNavNearDate(fund.proj_id, window.first, 1);
    const last = await findSecNavNearDate(fund.proj_id, window.last, -1);
    if (first) rows.push(first);
    if (last && last.date !== first?.date) rows.push(last);
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return {
    symbol,
    currency: "THB",
    exchange: "SEC Thailand",
    rows,
    source: "SEC Thailand Fund Daily Info API",
    fundId: fund.proj_id,
    displayName: fund.class_abbr_name || fund.proj_abbr_name || symbol,
  };
}

async function handleYahoo(reqUrl, res) {
  const symbol = reqUrl.searchParams.get("symbol")?.trim();
  const start = reqUrl.searchParams.get("start") || "2021-04-01";
  const end = reqUrl.searchParams.get("end") || "2026-04-30";
  if (!symbol) return json(res, 400, { error: "Missing symbol" });

  const period1 = toUnix(start);
  const period2 = toUnix(end) + 86400;
  if (!period1 || !period2) return json(res, 400, { error: "Invalid date range" });

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol,
  )}?period1=${period1}&period2=${period2}&interval=1d&events=div%2Csplits&includeAdjustedClose=true`;

  try {
    const data = await fetchYahoo(url);
    const result = data?.chart?.result?.[0];
    const apiError = data?.chart?.error;
    if (apiError) throw new Error(apiError.description || apiError.code);
    if (!result) throw new Error("No price rows returned");
    json(res, 200, normalizeSeries(result, symbol));
  } catch (error) {
    json(res, 502, {
      error: error.message,
      hint: "Try another Yahoo symbol such as QQQ, SPY, AAPL, BTC-USD, or paste CSV data.",
    });
  }
}

async function handleFinnomena(reqUrl, res) {
  const symbolInput = reqUrl.searchParams.get("symbol")?.trim().toUpperCase();
  const start = reqUrl.searchParams.get("start") || "2021-04-01";
  const end = reqUrl.searchParams.get("end") || "2026-04-30";
  if (!symbolInput) return json(res, 400, { error: "Missing fund code" });

  const from = toUnix(start);
  const to = toUnix(end) + 86400;
  if (!from || !to) return json(res, 400, { error: "Invalid date range" });

  try {
    if (secFactsheetKey && secDailyInfoKey) {
      const secHistory = await fetchSecMonthlyHistory(symbolInput, start, end);
      if (secHistory.rows.length) {
        return json(res, 200, {
          ...secHistory,
          requestedSymbol: symbolInput,
        });
      }
    }

    const fund = await resolveFinnomenaFund(symbolInput);
    const symbol = fund.short_code;
    const historyCache = await getFundHistoryCache();
    if (historyCache[symbol]) {
      const normalized = normalizeFinnomenaBars(historyCache[symbol], symbol);
      return json(res, 200, {
        ...normalized,
        fundId: fund.fund_id,
        displayName: fund.name_th || symbol,
        requestedSymbol: symbolInput,
        source: "Bundled Finnomena NAV cache",
      });
    }

    const url = `https://www.finnomena.com/fn3/api/fund/v2/public/tv/history?symbol=${encodeURIComponent(
      symbol,
    )}&resolution=D&from=${from}&to=${to}`;
    const payload = await fetchJson(url);
    const normalized = normalizeFinnomenaBars(payload, symbol);
    if (!normalized.rows.length) throw new Error("No NAV rows returned");
    json(res, 200, {
      ...normalized,
      fundId: fund.fund_id,
      displayName: fund.name_th || symbol,
      requestedSymbol: symbolInput,
    });
  } catch (error) {
    json(res, 502, {
      error: `Could not load Thai fund "${symbolInput}". ${error.message}`,
      hint:
        secFactsheetKey && secDailyInfoKey
          ? "SEC Thai fund connection is not working yet. Check the SEC API keys in Render."
          : "Try the official short code, for example SCBUSFOCUS(A), K-USXNDQ-A(A), or B-INNOTECH.",
    });
  }
}

async function handleSecStatus(res) {
  if (!secFactsheetKey || !secDailyInfoKey) {
    return json(res, 200, {
      configured: false,
      factsheet: "missing",
      dailyInfo: "missing",
    });
  }

  const [factsheet, dailyInfo] = await Promise.allSettled([
    fetchSecJson("https://api.sec.or.th/FundFactsheet/fund/amc", { key: secFactsheetKey }),
    fetchSecJson("https://api.sec.or.th/FundDailyInfo/2026-01-02", { key: secDailyInfoKey }),
  ]);

  return json(res, 200, {
    configured: true,
    factsheet: factsheet.status === "fulfilled" ? "ok" : factsheet.reason.message,
    dailyInfo: dailyInfo.status === "fulfilled" ? "ok" : dailyInfo.reason.message,
  });
}

async function handleStatic(pathname, res) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const safePath = normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(__dirname, safePath);
  const allowed =
    filePath === join(__dirname, "index.html") ||
    filePath.startsWith(join(__dirname, "src")) ||
    filePath.startsWith(join(__dirname, "public"));

  if (!filePath.startsWith(__dirname) || !allowed) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  try {
    const content = await readFile(filePath);
    res.writeHead(200, { "content-type": mimeTypes[extname(filePath)] || "application/octet-stream" });
    res.end(content);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

createServer(async (req, res) => {
  const reqUrl = new URL(req.url || "/", `http://${req.headers.host}`);
  if (reqUrl.pathname === "/api/history/yahoo") {
    await handleYahoo(reqUrl, res);
    return;
  }
  if (reqUrl.pathname === "/api/history/finnomena") {
    await handleFinnomena(reqUrl, res);
    return;
  }
  if (reqUrl.pathname === "/api/sec-status") {
    await handleSecStatus(res);
    return;
  }
  await handleStatic(reqUrl.pathname, res);
}).listen(port, () => {
  console.log(`DCA dashboard running at http://localhost:${port}`);
});
