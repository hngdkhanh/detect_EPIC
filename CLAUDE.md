# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

"EPIC Order Map" — a client-side React app for GHN logistics that detects delivery orders assigned far outside a driver's EPIC-suggested zone. No backend: everything (CSV parsing, DBSCAN clustering, address matching) runs in the browser from CSV files in `public/`. UI text, code comments, and user communication are in Vietnamese.

## Commands

```bash
docker compose up -d --build   # official local run → http://localhost:8080 (rebuild only after code/data changes)
npm run dev                    # dev mode with hot reload → http://localhost:5173 (needs npm install once)
npm run build                  # vite build → dist/
vercel --prod                  # deploy (Vercel project: epic-order-map, Vite preset)
```

`scripts/append-data.mjs` (`npm run append:data`) là **writer duy nhất** của dữ liệu app: đọc CSV export
BigQuery mới nhất trong `~/Downloads`, validate header 10 cột, tách mỗi `load_date` thành
`public/data/<date>.csv`, dedupe theo `employee_id|order_code` trong từng ngày, giữ 14 ngày gần nhất,
rồi ghi lại `public/data/manifest.json`. `scripts/bq_daily.sql` là bản D-1 tự động của `BQ_QUERY`
trong `GuideModal.jsx` — sửa thì sửa cả hai.

**App chỉ tải CSV của ngày đang chọn.** `App.jsx` đọc `manifest.json` trước, mặc định ngày mới nhất,
fetch `data/<date>.csv` khi đổi ngày, cache 3 ngày trong `dayCache` ref. Trong lúc tải **không** được
clear `orders`: `bcDrivers` rỗng sẽ làm effect self-heal đá `driver` về `ALL_DRV`, mất lựa chọn của
người dùng mỗi lần đổi ngày. Thiếu `manifest.json` → rơi về `public/test.csv` (chế độ `perDay=false`),
cũng là chế độ nút "Nạp CSV khác…" dùng.

**Sandbox chạy trên máy user không xoá được file trong thư mục mount** (`unlink` → EPERM). Hệ quả:
ngày quá hạn được `mv` sang `data_archive/` chứ không xoá, và `npm run build` phải chạy ngoài mount
vì vite `emptyOutDir` cần unlink.

**Tự động hoá chia hai mắt xích, hai máy.** 10:00 — scheduled task của Claude (Chrome + sandbox) lấy
data và chạy `append-data.mjs`; nó KHÔNG deploy và KHÔNG commit. 10:15 — Windows Task Scheduler chạy
`scripts/daily-deploy.ps1` trên chính máy user: gate theo `manifest.json` (bỏ qua nếu ngày mới nhất
không phải D-1), rồi `docker compose up -d --build` + `vercel --prod`. Đăng ký một lần bằng
`scripts/register-deploy-task.ps1`. Lý do phải tách: sandbox chỉ ra được npm + github,
`vercel.com`/`api.vercel.com` bị chặn, và credential Vercel nằm trong profile Windows chứ không
phải `.vercel/` trong repo (file đó chỉ có projectId/orgId).

There is no test suite or linter. Verification is done by hand: Node scripts that import `src/detect.js` / `src/scene.js` directly (pure ESM, zero deps), and headless-Chrome checks via `playwright-core` (`chromium.launch({ channel: "chrome" })`) against localhost:8080.

## Architecture

One-directional data flow, with strict separation between algorithm, scene assembly, and rendering:

```
public/data/<date>.csv (chọn theo manifest.json) + optional drivers.csv override
  → detect.js   loadOrders / buildDriverInfo            (parse + driver→BC/name map)
  → App.jsx     filter cascade: Bưu cục → Tài xế → Ngày  (state + all UI wiring)
  → scene.js    computeScene → {layers, perDrv, farRows, counts, stats}   (pure data, no DOM)
  → MapView.jsx renders layer descriptors imperatively with Leaflet
```

- **`src/detect.js`** — pure algorithm module, no DOM/React. Per-driver detection: DBSCAN (haversine, minPts=3) over that driver's `is_epic=1` points defines the EPIC zone; an assigned non-EPIC order is "far" when its distance to the nearest in-cluster EPIC point exceeds `max(minKm, k × P90 intra-cluster nearest-neighbor)`. `suggestParams` auto-derives eps per driver (P90 NN, rounded to 50m, clamped [200, 800]); **k=3 and the 1km floor are fixed from the 06–13/08/2026 backtest** (see `detect_ngoai.md`) — don't change them casually. Address verdicts for far orders: A (street+ward match center) = misgeocode, dropped from warnings; B (partial) = kept with "❓ định vị?" tag; C = real warning.
- **`src/scene.js`** — the only bridge between algorithm and UI. Emits flat layer descriptors tagged `{driver, cat: hull|order|far}`; `MapView` uses those tags for visibility (checkbox-focused drivers + layer toggles) via full `removeLayer`/`addLayer` — unselected drivers must disappear completely, never dim, and selection must never auto-zoom (both were explicit user requirements). Also exports `groupByDriver`/`evalAbnormal`/`scanAbnormal` for the navbar "🚨 Bất thường" scan (flag: far ≥ 10% of assigned AND ≥ 5 orders).
- **`src/App.jsx`** — all state. The BC→driver→date selects self-heal via validity effects, so navigation code just sets `bc` + `driver` together. The abnormal scan deliberately runs in a chunked effect (~30ms slices off the render path) because it evaluates every driver in the dataset — don't move it back into a `useMemo`.
- **`src/MapView.jsx`** — the only file touching Leaflet. Tiles come from **Esri World Street Map** because `tile.openstreetmap.org` is DNS-blocked on the company network and free Carto watermarks; if the map goes white, suspect tile DNS first (see README "Sự cố đã biết").
- **`src/GuideModal.jsx`** — embeds the canonical BigQuery query (`BQ_QUERY`, backticks escaped as `` \` ``) that produces the app's CSV. When the data pipeline changes, this query and the parser must move together.

## CSV contract (subtle traps)

Header columns are resolved by alias lists in `loadOrders`' `findCol` (e.g. driver id: `driver_id` **or** `employee_id`; BC: `bc_name`/`warehouse_name`/…). When the export format changes, extend the alias lists — a silently unmatched column collapses all orders onto one driver.

- Missing `is_assigned` column → every row treated as assigned → app runs "toàn đơn" plain mode (no detection).
- Rows with `is_epic=1, is_assigned=0` (removed EPIC suggestions) carry the **actual deliverer's** name in `driver_name`, not the owner of `driver_id` — `buildDriverInfo` must keep skipping unassigned rows.
- `public/drivers.csv` is an optional mapping file whose name/BC values **override** the main CSV.

## Data access & privacy

- Fresh data comes from BigQuery (query in GuideModal) or the GHN **Data API** (`data-api.md`). The Data API speaks **Trino SQL, not BigQuery**: no `DECLARE`, backticked identifiers → `"quoted"` catalogs (quote mixed-case table names exactly), `STRING` → `VARCHAR`, `DATE_SUB` → `date_add('day', -n, …)`. API tokens go in env vars only, never in repo files or committed code.
- `public/test.csv` contains **real employee names and customer addresses**. The Vercel deployment (https://epic-order-map.vercel.app) is public — Deployment Protection has been recommended to the user repeatedly; re-flag when deploying new data.

## Reference docs (Vietnamese, in repo root)

- `detect_ngoai.md` — full write-up and calibration of the far-order detection algorithm (backtest: 126 drivers, 133k orders, HCM).
- `warning_gan_ngoai_EPIC.md` — the V1 business rule set for outside-assignment warnings (4 behavior scenarios + SOP).
- `data-api.md` — GHN Data API usage (submit `POST /queries`, drain `GET /next` until `hasMore:false`, quotas, error handling).
