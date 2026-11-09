---
paths:
  - "app/**"
  - "next.config.ts"
---

# Next.js 16 rules (Cache Components + Partial Prefetching are ON)

- Pages that read the DB or the clock render inside `<Suspense>` and call `await connection()` before any
  query or `new Date()`. See `app/page.tsx`.
- **Every GET route handler with side effects or live data must `await connection()` as its first line.**
  Otherwise the build prerenders it. `/api/cron/sync` once ran a real sync during `next build` this way.
- Cache external fetches with a `"use cache"` function + `cacheLife({...})` (example: `cachedLiveQuote` in
  `lib/dashboard.ts`). Wrap the cached call in try/catch outside the cached function so failures aren't cached.
- Background work after the response goes through `after()` from `next/server`. It must not use
  `cookies()`/`headers()` when called from a Server Component.
- `maxDuration`: the page uses 60 and the cron route uses 300 (the Vercel Hobby fluid-compute max). Don't raise them.
- Server → client props must be serialisable (strings, numbers, plain objects). Dates are strings.
- Before using an API you haven't used in this repo, read its doc in `node_modules/next/dist/docs/01-app/`.
