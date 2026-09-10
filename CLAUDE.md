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

`scripts/append-data.mjs` (`npm run append:data`) là **writer duy nhất** của dữ liệu app: đọc một CSV
(đường dẫn truyền vào, hoặc export BigQuery mới nhất trong `~/Downloads`), validate header 10 cột, tách
mỗi `load_date` thành `public/data/<date>.csv`, dedupe theo `employee_id|order_code` trong từng ngày,
giữ 14 ngày gần nhất, rồi ghi lại `public/data/manifest.json`. `scripts/fetch-daily.mjs`
(`npm run fetch:data`) là nguồn tự động: chạy `scripts/bq_daily.sql` trên BigQuery, ghi CSV thô vào
`data_incoming/` rồi gọi `append-data.mjs`. Hai backend zero-dep, chọn theo env: **REST API**
(`BQ_CREDENTIALS_JSON` / `GOOGLE_APPLICATION_CREDENTIALS`, nhận `service_account` lẫn `authorized_user`,
tự đổi token + `jobs.insert` + `getQueryResults` phân trang) hoặc **`bq` CLI** (Google Cloud SDK trên
máy user, `--format=json`, `.cmd` phải gọi qua `cmd.exe /d /s /c ""…""`, PATH phải có thư mục SDK để
bq gọi được gcloud, `PYTHONIOENCODING=utf-8` để tên tiếng Việt không mojibake). Script bỏ 2 dòng
`DECLARE` của file SQL và thay `DS_START`/`DS_END` bằng `DATE '…'` literal → gửi đi là một SELECT đơn
(script nhiều statement làm `bq --format=json` trả mảng-của-mảng, `--format=csv` in cả SQL lên đầu).
`bq_daily.sql` vẫn là bản D-1 tự động của `BQ_QUERY` trong `GuideModal.jsx` — sửa thì sửa cả hai.
**Không dùng GHN Data API cho pipeline này** (quyết định của user 2026-09-08), không đưa data qua
Google Sheet.

**App chỉ tải CSV của ngày đang chọn.** `App.jsx` đọc `manifest.json` trước, mặc định ngày mới nhất,
fetch `data/<date>.csv` khi đổi ngày, cache 3 ngày trong `dayCache` ref. Trong lúc tải **không** được
clear `orders`: `bcDrivers` rỗng sẽ làm effect self-heal đá `driver` về `ALL_DRV`, mất lựa chọn của
người dùng mỗi lần đổi ngày. Thiếu `manifest.json` → rơi về `public/test.csv` (chế độ `perDay=false`),
cũng là chế độ nút "Nạp CSV khác…" dùng.

**Chỉ giữ 14 ngày, ngày quá hạn bị xoá thẳng** (user chốt 2026-09-08 để nhẹ dung lượng). `append-data`
chỉ rơi về dời sang `data_archive/` khi `unlink` trả EPERM (di sản của sandbox mount của task Claude cũ,
đã bỏ). **`public/data/*.csv` và `manifest.json` không còn được commit** (gitignore): bản trong repo luôn
cũ và từng làm production tụt data khi Vercel tự deploy từ Git. Dev local / docker: chạy
`node scripts/pull-prod-data.mjs` một lần để có 14 ngày đang chạy trên production.

**Tự động hoá chính là GitHub Actions** (`.github/workflows/daily-data.yml`, 03:00 UTC = 10:00 VN,
user chọn hướng "máy tắt vẫn chạy" 2026-09-08), **cửa sổ lăn**: `pull-prod-data.mjs` kéo 14 ngày đang
chạy trên production về → `fetch-daily.mjs --days 2 --replace-date` hỏi BigQuery D-1 + D-2 (REST, secret
`BQ_CREDENTIALS_JSON`, ~2 GB) → `append-data` ghép + bỏ ngày cũ nhất → gate manifest có D-1 →
`vercel pull/build/deploy --prebuilt --prod` (secret `VERCEL_TOKEN`, org/project id ghi thẳng trong yml).
**CI không commit data**; trạng thái 14 ngày nằm ở bản deploy đang chạy. Kéo production thất bại →
tự rơi về `--days 14` (~8 GB). **Lấy chồng 2 ngày** (user chốt 2026-09-10, sau khi 2026-09-08 chọn D-1-only)
vì data nguồn sửa lùi: mỗi ngày được lấy hai lượt — D-1 rồi hôm sau D-2 — mới **đóng băng**, và lỡ một
buổi sáng thì lượt kế tự vá. Làm mới cả cửa sổ bằng Run workflow `days=14`. Nếu bật Deployment Protection,
đặt secret `VERCEL_BYPASS` để `pull-prod-data.mjs` gửi header `x-vercel-protection-bypass`.

**`vercel.json` tắt Git auto-deploy cho `main` (`git.deploymentEnabled.main = false`) và đó là điều
kiện sống của thiết kế stateless**: data không nằm trong repo, nên nếu để Vercel tự build từ Git thì
mỗi lần push code production sẽ tụt về vài ngày data cũ còn sót trong `public/data/` (đã xảy ra thật
2026-09-08). Vì vậy workflow là đường **duy nhất** deploy production và nó chạy cả trên `push` vào
`main` (bỏ qua khi chỉ đổi `*.md`). Muốn bật lại Git auto-deploy thì phải commit data trước.
`public/data/` không còn file nào trong git (gitignore từ 2026-09-08), nên bẫy này đã đóng. Data nguồn
thay đổi lùi (đơn gán thêm sau vài giờ) nên hai lần fetch cùng ngày có thể khác vài dòng; đừng xem
đó là bug. Dự phòng: Windows Scheduled Task `EPIC Order Map - daily deploy` 10:00 chạy
`scripts/daily-deploy.ps1` (fetch bq CLI → gate → docker → vercel; `-NoDeploy` để thử), cần session
user; gỡ bằng `register-deploy-task.ps1 -Unregister` khi CI đã ổn. Không còn mắt xích Claude + Chrome.
Hai file `.ps1` phải là **UTF-8 có BOM**: PowerShell 5.1 đọc file không BOM theo cp1252 và dấu `—`
thành ngoặc kép cong, hỏng cú pháp chuỗi.

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
- **`src/App.jsx`** — all state. The BC→driver→date selects self-heal via validity effects, so navigation code just sets `bc` + `driver` together. The abnormal scan (`scanDay`) deliberately runs in a chunked effect (~30ms slices off the render path) because it evaluates every driver in the dataset — don't move it back into a `useMemo`. It keeps the **full** `evalAbnormal` result for every evaluated driver in `scan` (the 🚨 button filters with `isAbnormal`) and mirrors it into `history[date]`; opening the report triggers a sequential background scan of the other manifest days (fetch → `loadOrders` → `scanDay`, only per-driver metrics are retained, never the orders).
- **`src/report.js` + `src/ReportView.jsx`** — the "📊 Báo cáo" page (`view === "report"`), rendered as an overlay on top of `<main>` so the Leaflet map stays mounted and keeps its zoom. `report.js` is pure: `buildReport` turns the scan rows + `history` into KPIs (with D-1 deltas), per-BC table, scenario tags (`classify`, rules from `warning_gan_ngoai_EPIC.md` / memory), distance histogram, trend + repeat offenders (flagged ≥3 of last 7 days), and data-quality counters; `farOrdersOf` re-runs detect for the abnormal drivers only (CSV export). `removedDestinations` needs `actual_driver_id/name` columns, which the current 10-column export lacks — on that data the block shows a note instead (on unassigned rows `driver_name` is the owner's name, verified 2026-09-03).
- **`src/MapView.jsx`** — the only file touching Leaflet. Tiles come from **Esri World Street Map** because `tile.openstreetmap.org` is DNS-blocked on the company network and free Carto watermarks; if the map goes white, suspect tile DNS first (see README "Sự cố đã biết").
- **`src/report.js` / `src/ReportView.jsx`** — the "📊 Báo cáo" page. `driverSummaries` re-runs detect for the abnormal drivers only and feeds the closing "Tóm tắt cảnh báo gửi bưu cục" section: one card per driver in the message template (BC: tài xế / số đơn / nút Excel / mini-map). `App.jsx` memoizes it on the joined abnormal-id key, not on `report`, because `report` changes identity every time a history day finishes scanning. `lookupDriver` + the `DriverLookup` box ("Tra cứu tài xế", right under the KPIs) answer "was employee X flagged on any day?" purely from `history` (per-day evaluated rows) — no extra detect; a day where the driver has no evaluated row shows as `na`, a day not yet scanned as `pending`. `directory` (App) is the union of current-day drivers and every id seen in `history`.
- **`src/xlsx.js`** — dependency-free real `.xlsx` writer (OOXML in a store-mode ZIP with CRC32, inline strings, bold frozen header). Used for the per-driver and all-drivers Excel buttons; verified to open in Excel/OPC. Don't add SheetJS for this.
- **`src/MiniMap.jsx`** — static map thumbnail: composes Esri tiles as `<img>` (same tile source as MapView, no Leaflet) + SVG dots; tiles load only when scrolled into view (IntersectionObserver) because a report can hold dozens of cards. Exposes `toPng()` via ref: redraws tiles + dots + a caption block on a 2× canvas (works because Esri sends `Access-Control-Allow-Origin: *`; `<img crossOrigin="anonymous">` so the cache is shared). The card's Copy button writes one `ClipboardItem` with `text/plain` + `text/html` + `image/png` (Promise values, so the user gesture survives tile loading) and falls back to text-only.
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
