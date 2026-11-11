---
name: run-locally
description: Start RateCast locally (Postgres in Docker, sync, Next server) and check the page renders on desktop and at phone width. Use when asked to run, start, preview or screenshot the app, or to confirm a change works in the real app.
---

# Run RateCast locally

1. **Database.** Start it, or create it if missing:
   ```bash
   docker start ratecast-pg 2>/dev/null || docker run -d --name ratecast-pg -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=rates -p 54329:5432 postgres:16-alpine
   test -f .env.local || echo 'DATABASE_URL=postgres://postgres:dev@localhost:54329/rates' > .env.local
   ```
2. **Sync.** Run `npm run sync`. The first run downloads 2 years of history and replays 90 days (~10 s). Later
   runs take ~2 s. Expect `[ok]`, an `events: N rows · fed-page …, cbsl-mpr …` line (no `FAILED`) and per-currency
   `forecast ... tomorrow ≈ ...` lines.
3. **Serve.** For quick iteration, run `npm run dev` in the background. To check production behaviour (Cache
   Components, prerendering), use `npm run build && PORT=3123 npx next start` in the background.
4. **Check data.** `curl -s localhost:3123/api/dashboard | jq '.lastSync, (.currencies[] | {target, live: .live.midRate, tomorrow: .tomorrow.predicted})'`
5. **Check visually.** There is no Chrome, so use Brave + Playwright with real device emulation. Headless
   `--window-size` can't go below ~500px, so don't trust it for mobile:
   ```js
   // scratchpad/pw/shot.mjs  (npm i playwright-core in that scratch folder)
   import { chromium } from "playwright-core";
   const b = await chromium.launch({ executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" });
   const p = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true });
   await p.goto("http://localhost:3123/", { waitUntil: "networkidle" });
   console.log("scrollWidth", await p.evaluate(() => document.documentElement.scrollWidth)); // must be 390
   await p.screenshot({ path: process.argv[2], fullPage: true });
   await b.close();
   ```
   Also take a 1280px-wide screenshot and look at both images. Check the **Policy events** card (upcoming
   FOMC/CBSL dates, no red source warnings) and the dotted event markers on the chart.
6. Stop the server afterwards (`pkill -f "next start"`). Leave the DB container running.
