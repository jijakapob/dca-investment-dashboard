# DCA Investment Dashboard

Local React dashboard for backtesting monthly DCA contributions in THB from Apr 2021 to Apr 2026 or any selected period.

## Run

```powershell
npm start
```

Open:

```text
http://localhost:4173
```

The current app is built as a React + Tailwind + Recharts prototype. In this Codex runtime it is served by `server.js` and loads React/Recharts from browser ESM CDNs because `npm` is not available on the machine. The `package.json`, `vite.config.js`, and `tailwind.config.js` files are included so it can also run as a normal Vite project later after `npm install`.

## What It Calculates

- Adds the same THB contribution every month for each asset.
- Uses the first available trading/NAV price each month by default, with a month-end option.
- Converts non-THB assets back to THB using Yahoo FX pairs such as `USDTHB=X`.
- Shows total invested, current value, gain/loss, total return, annualized return, chart, and monthly audit rows.

## Data Sources

- `Yahoo symbol`: works for many stocks, ETFs, funds, crypto pairs, and FX pairs supported by Yahoo Finance, for example `QQQ`, `SPY`, `AAPL`, `BTC-USD`.
- `CSV paste`: use this for Thai mutual funds when public historical NAV APIs are unavailable or rate-limited. Paste rows with at least:

```csv
Date,Close
2021-04-30,10.25
2021-05-31,10.66
```

For Thai funds, `Close` can be the fund NAV.

## Notes

Yahoo data uses adjusted close when Yahoo provides it, so stock and ETF history reflects splits and distributions better than raw close.
