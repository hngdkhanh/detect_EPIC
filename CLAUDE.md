# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

"EPIC Order Map" — a client-side React app for GHN logistics that detects delivery orders assigned far outside a driver's EPIC-suggested zone. No app server: everything (CSV parsing, DBSCAN clustering, address matching) runs in the browser. Since 2026-09-10 the order data lives in a **Supabase** Postgres table (`public.orders`, read via PostgREST as `text/csv`); before that it was per-day CSV files in `public/data/`, and that file mode still works as a fallback. UI text, code comments, and user communication are in Vietnamese.

## Commands

```bash
docker compose up -d --build   # official local run → http://localhost:8080 (rebuild only after code/data changes)
npm run dev                    # dev mode with hot reload → http://localhost:5173 (needs npm install once)
npm run build                  # vite build → dist/
vercel --prod                  # deploy (Vercel project: epic-order-map, Vite preset)
```

**Kho data là Supabase** (user chốt 2026-09-10): `supabase/schema.sql` tạo bảng `orders` (10 cột CSV +
`fetched_at`, PK `load_date, employee_id, order_code`), view `order_days` (thay manifest) và RLS chỉ-đọc
cho anon. `scripts/push-supabase.mjs` (`npm run push:data`) là **writer** của kho này: đọc CSV 10 cột,
dedupe theo khoá trong bộ nhớ (cùng khoá 2 lần trong một upsert làm Postgres báo lỗi), upsert lô 2000
qua PostgREST (`Prefer: resolution=merge-duplicates`), `--replace-date` = upsert rồi xoá dòng của ngày đó
có `fetched_at` cũ hơn mốc lần chạy (app đang mở không bao giờ thấy ngày rỗng), giữ `SUPABASE_KEEP_DAYS`
ngày gần nhất theo ngày có trong bảng (mặc định **90**). Env: `SUPABASE_URL` + `SUPABASE_SERVICE_KEY`
(service_role, bỏ qua RLS — chỉ CI/máy admin). Client `src/supa.js` (zero-dep, không supabase-js) đọc
`VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` và có **hai đường, RPC trước, trang sau**: `fetchDays()` gọi
RPC `order_dates()` (CTE đệ quy dò index, ms) rồi mới rơi về view `order_days` (group by cả bảng, 1–5 s
trên Free); `fetchDayCsv(date)` gọi RPC `day_csv(d)` (Postgres `string_agg` cả ngày thành MỘT chuỗi CSV,
PostgREST trả về dạng JSON string → `JSON.parse`) rồi mới rơi về `orders` `text/csv` theo trang `Range` +
`Content-Range`, tải song song 8 trang. Rơi về khi RPC trả 404 (schema chưa có hàm) và nhớ trong phiên.
Số đo 2026-09-10 trên project thật (Free, Singapore, ngày 35k dòng): trang tuần tự 14,5 s → song song
~5 s (nút thắt là server sort mỗi trang, 8/16/35 kết nối như nhau) → RPC ~0,5–1 s. **Quirk PostgREST
đã gặp:** `max_rows` kẹp 1000 dù xin 10000 (đọc `Content-Range`); hàm trả `text` không có media type
`text/plain` (406 PGRST107) nên nhận JSON; `text/csv` nhân đôi backslash trong dữ liệu (139/29630 dòng
địa chỉ) còn `day_csv()` thì không. Đã kiểm chứng bằng Postgres 15 + PostgREST trong Docker với file
ngày thật, so từng field sau `loadOrders`: RPC giống hệt file gốc. Lưu ý lịch sử: schema bản đầu để
cột text `not null`, COPY/Import CSV của Supabase đọc ô trống thành NULL và bị từ chối → bản hiện tại
nullable + `alter ... drop not null` cho project cũ.

`scripts/append-data.mjs` (`npm run append:data`) là writer của **chế độ file cũ** (fallback / dev offline):
đọc một CSV (đường dẫn truyền vào, hoặc export BigQuery mới nhất trong `~/Downloads`), validate header 10
cột, tách mỗi `load_date` thành `public/data/<date>.csv`, dedupe theo `employee_id|order_code` trong từng
ngày, giữ 14 ngày gần nhất, rồi ghi lại `public/data/manifest.json`. `scripts/fetch-daily.mjs`
(`npm run fetch:data`) là nguồn tự động: chạy `scripts/bq_daily.sql` trên BigQuery, ghi CSV thô vào
`data_incoming/` rồi gọi `push-supabase.mjs` khi có env Supabase, ngược lại `append-data.mjs` (`--local`
ép file). Hai backend BigQuery zero-dep, chọn theo env: **REST API**
(`BQ_CREDENTIALS_JSON` / `GOOGLE_APPLICATION_CREDENTIALS`, nhận `service_account` lẫn `authorized_user`,
tự đổi token + `jobs.insert` + `getQueryResults` phân trang) hoặc **`bq` CLI** (Google Cloud SDK trên
máy user, `--format=json`, `.cmd` phải gọi qua `cmd.exe /d /s /c ""…""`, PATH phải có thư mục SDK để
bq gọi được gcloud, `PYTHONIOENCODING=utf-8` để tên tiếng Việt không mojibake). Script bỏ 2 dòng
`DECLARE` của file SQL và thay `DS_START`/`DS_END` bằng `DATE '…'` literal → gửi đi là một SELECT đơn
(script nhiều statement làm `bq --format=json` trả mảng-của-mảng, `--format=csv` in cả SQL lên đầu).
`bq_daily.sql` vẫn là bản D-1 tự động của `BQ_QUERY` trong `GuideModal.jsx` — sửa thì sửa cả hai.
**Không dùng GHN Data API cho pipeline này** (quyết định của user 2026-09-08), không đưa data qua
Google Sheet.

**App chỉ tải đơn của ngày đang chọn.** `App.jsx` chọn nguồn lúc khởi động theo thứ tự Supabase
(`hasSupabase()` + `fetchDays()` thành công) → `public/data/manifest.json` → `public/test.csv`; state
`source` ("supabase" | "files") quyết định `loadDayText()` gọi `fetchDayCsv` hay fetch `data/<date>.csv`.
Mặc định ngày mới nhất, cache 3 ngày trong `dayCache` ref. Trong lúc tải **không** được clear `orders`:
`bcDrivers` rỗng sẽ làm effect self-heal đá `driver` về `ALL_DRV`, mất lựa chọn của người dùng mỗi lần
đổi ngày. `perDay=false` (test.csv / nút "Nạp CSV khác…") không đụng Supabase.

**Giữ 90 ngày trên Supabase** (đổi bằng env `SUPABASE_KEEP_DAYS`); chế độ file cũ vẫn giữ 14 ngày và
`append-data` chỉ rơi về dời sang `data_archive/` khi `unlink` trả EPERM. `public/data/*.csv` và
`manifest.json` không được commit (gitignore từ 2026-09-08). Dung lượng: 90 ngày × 16–30k dòng ≈ 400–500 MB
kể cả index, sát trần gói Free 500 MB — nếu Supabase báo đầy thì hạ KEEP_DAYS trước khi nghĩ tới gói Pro.
Gói Free pause project sau 7 ngày không request; CI ghi mỗi sáng nên không bị.

**Tự động hoá là GitHub Actions** (`.github/workflows/daily-data.yml`, 03:00 UTC = 10:00 VN, user chọn
hướng "máy tắt vẫn chạy" 2026-09-08), **không deploy**: kiểm tra Supabase (`push-supabase --trim-only
--dry-run`) → `fetch-daily.mjs --days 2 --replace-date` hỏi BigQuery D-1 + D-2 (REST, secret
`BQ_CREDENTIALS_JSON`, ~2 GB) và upsert vào `orders` (secrets `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`) →
bước cuối chỉ cảnh báo nếu chưa có D-1. **Lấy chồng 2 ngày** (user chốt 2026-09-10) vì data nguồn sửa lùi:
mỗi ngày được lấy hai lượt — D-1 rồi hôm sau D-2 — mới **đóng băng**, và lỡ một buổi sáng thì lượt kế
tự vá. Backfill bằng Run workflow `days=N` (tối đa 60). Data nguồn thay đổi lùi (đơn gán thêm sau vài
giờ) nên hai lần fetch cùng ngày có thể khác vài dòng; đừng xem đó là bug. `pull-prod-data.mjs` chỉ còn
để di trú từ bản deploy kiểu cũ / docker nội bộ chạy chế độ file; CI không gọi nữa.

**Deploy code là việc của Vercel**: `vercel.json` bật lại `git.deploymentEnabled.main = true` (2026-09-10)
vì data không còn đi qua deploy — push `main` là Vercel tự build, không còn nguy cơ tụt data. Điều kiện
sống mới: Vercel Project Settings phải có `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` (Vite nhúng lúc
build; đổi giá trị phải Redeploy), thiếu thì bundle rơi về `test.csv`. Dev local / docker: `.env.local`
với hai biến đó (`.dockerignore` không loại `.env*`, nên `vite build` trong image đọc được). Windows
Scheduled Task `EPIC Order Map - daily deploy` đã gỡ; `scripts/daily-deploy.ps1` + `register-deploy-task.ps1`
là di sản chế độ file, vẫn chạy được nhưng không cần. Hai file `.ps1` phải là **UTF-8 có BOM**: PowerShell
5.1 đọc file không BOM theo cp1252 và dấu `—` thành ngoặc kép cong, hỏng cú pháp chuỗi.

There is no test suite or linter. Verification is done by hand: Node scripts that import `src/detect.js` / `src/scene.js` directly (pure ESM, zero deps), and headless-Chrome checks via `playwright-core` (`chromium.launch({ channel: "chrome" })`) against localhost:8080.

## Architecture

One-directional data flow, with strict separation between algorithm, scene assembly, and rendering:

```
Supabase orders (text/csv của ngày chọn, qua supa.js; fallback public/data/<date>.csv) + optional drivers.csv override
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
- **`src/supa.js`** — the only file that knows the Supabase REST shape (`order_days` view, `orders` table, CSV paging). Keep it zero-dep; do not add supabase-js. If `COLUMNS` changes, change `supabase/schema.sql`, `push-supabase.mjs` `HEADER` and `loadOrders` aliases in the same commit.

## CSV contract (subtle traps)

Header columns are resolved by alias lists in `loadOrders`' `findCol` (e.g. driver id: `driver_id` **or** `employee_id`; BC: `bc_name`/`warehouse_name`/…). When the export format changes, extend the alias lists — a silently unmatched column collapses all orders onto one driver.

- Missing `is_assigned` column → every row treated as assigned → app runs "toàn đơn" plain mode (no detection).
- Rows with `is_epic=1, is_assigned=0` (removed EPIC suggestions) carry the **actual deliverer's** name in `driver_name`, not the owner of `driver_id` — `buildDriverInfo` must keep skipping unassigned rows.
- `public/drivers.csv` is an optional mapping file whose name/BC values **override** the main CSV.

## Data access & privacy

- Fresh data comes from BigQuery (query in GuideModal) or the GHN **Data API** (`data-api.md`). The Data API speaks **Trino SQL, not BigQuery**: no `DECLARE`, backticked identifiers → `"quoted"` catalogs (quote mixed-case table names exactly), `STRING` → `VARCHAR`, `DATE_SUB` → `date_add('day', -n, …)`. API tokens go in env vars only, never in repo files or committed code.
- `public/test.csv` contains **real employee names and customer addresses**. The Vercel deployment (https://epic-order-map.vercel.app) is public — Deployment Protection has been recommended to the user repeatedly; re-flag when deploying new data.
- The Supabase anon key is embedded in the bundle by design; the RLS policy makes it read-only, so exposure equals today's public page. The **service key must never appear in `VITE_*`, `.env.example` values, or the repo** — CI secrets and `.env.local` only. Closing the exposure means Supabase Auth restricted to `@ghn.vn` plus a `to authenticated` policy.

## Reference docs (Vietnamese)

- `supabase/SETUP.md` — step-by-step first-time setup of the Supabase data store (create project, run schema, seed from the old production deploy **before** pushing, Vercel env vars, GitHub secrets, troubleshooting table). Written 2026-09-10, not yet executed against a real project.
- `detect_ngoai.md` — full write-up and calibration of the far-order detection algorithm (backtest: 126 drivers, 133k orders, HCM).
- `warning_gan_ngoai_EPIC.md` — the V1 business rule set for outside-assignment warnings (4 behavior scenarios + SOP).
- `data-api.md` — GHN Data API usage (submit `POST /queries`, drain `GET /next` until `hasMore:false`, quotas, error handling).
