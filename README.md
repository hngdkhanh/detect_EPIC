# EPIC Order Map (React)

Trang phát hiện đơn gán ngoài xa vùng gợi ý EPIC — project React nằm ngay thư mục gốc repo — chạy local bằng Docker, deploy được lên Vercel.
Dữ liệu đơn gán nằm trên **Supabase** (Postgres), app đọc thẳng lúc chạy; repo không chứa data.

## Setup local (Docker)

Yêu cầu: **Docker Desktop** đang chạy, và file `.env.local` (gitignore) chứa URL + anon key của
Supabase để Vite nhúng vào bundle lúc build:

```bash
cp .env.example .env.local        # điền VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY (Project Settings → API)
docker compose up -d --build
```

(`.env.local` không bị `.dockerignore` loại, nên `vite build` trong image đọc được. Không có hai biến
này, app rơi về chế độ file `public/data/` — xem "Cập nhật dữ liệu".)

Xong — mở **http://localhost:8080**. Container chạy nền liên tục, tự khởi động lại cùng Docker Desktop
(`restart: unless-stopped`).

Image build 2 giai đoạn: Node 20 build bản tĩnh bằng Vite → Nginx serve (image cuối ~94MB, không chứa Node).
Nginx đã cấu hình sẵn gzip, cache dài hạn cho bundle (`/assets/`), no-cache cho file CSV, SPA fallback (`nginx.conf`).

### Lệnh thường dùng

```bash
docker ps                          # kiểm tra: thấy epic-order-map ... (healthy) là đang chạy
docker logs epic-order-map         # xem log Nginx
docker compose up -d --build       # build & chạy lại sau khi đổi code (data luôn mới vì đọc từ Supabase)
docker compose down                # tắt hẳn
```

- **Đổi port**: sửa `8080:80` trong `docker-compose.yml` rồi `docker compose up -d`.
- **Chia sẻ trong mạng LAN**: người cùng mạng mở `http://<IP-máy-bạn>:8080`
  (xem IP bằng `ipconfig`; không vào được thì cho phép port 8080 qua Windows Firewall).

### Dev mode (chỉ khi cần sửa code, có hot-reload)

```bash
npm install
cp .env.example .env.local        # lần đầu: điền VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY
npm run dev                       # mở http://localhost:5173
```

Không có `.env.local` thì app tìm `public/data/manifest.json` (chế độ file cũ, xem
`scripts/append-data.mjs`), rồi mới tới `public/test.csv`.

## Deploy lên Vercel

Cách 1 — qua GitHub (khuyên dùng, đang dùng):
1. Push folder này lên một repo GitHub.
2. Vào vercel.com → **Add New Project** → import repo.
3. Vercel tự nhận preset **Vite** (build `vite build`, output `dist`).
4. **Project Settings → Environment Variables**: thêm `VITE_SUPABASE_URL` và `VITE_SUPABASE_ANON_KEY`
   (Production + Preview) **trước** khi deploy — thiếu là bundle không biết Supabase ở đâu và trang
   rơi về `public/test.csv` cũ. Đổi giá trị thì phải Redeploy vì Vite nhúng lúc build.

Từ 2026-09-10 Vercel **tự deploy từ Git** như một project Vite bình thường (`vercel.json` bật
`git.deploymentEnabled.main`). Data không đi qua deploy nữa nên không còn nguy cơ push code làm
tụt data — app đọc Supabase lúc chạy.

Cách 2 — CLI:
```bash
npm i -g vercel
vercel        # làm theo hướng dẫn, lần sau chỉ cần `vercel --prod`
```

Lưu ý: trang chứa dữ liệu đơn + tên nhân viên thật — deploy công khai nên bật
**Deployment Protection** trên Vercel, hoặc chỉ host nội bộ bằng Docker.

## Cập nhật dữ liệu

### Kho data: Supabase (Postgres)

Một bảng phẳng `public.orders` đúng 10 cột của CSV + `fetched_at`, khóa chính
`(load_date, employee_id, order_code)`; view `order_days` (ngày, số dòng) thay `manifest.json`.
Schema ở `supabase/schema.sql` — dán vào **SQL Editor** của project Supabase, chạy một lần.

> **Setup lần đầu: làm theo `supabase/SETUP.md`** — từng bước bấm gì, chạy gì, kỳ vọng thấy gì, và
> thứ tự bắt buộc (nạp 14 ngày từ production cũ **trước** khi push, vì sau đó không kéo lại được).

```
supabase/schema.sql           bảng orders + view order_days + RLS chỉ-đọc cho anon
src/supa.js                   client: fetchDays() và fetchDayCsv(date) qua PostgREST, không dùng supabase-js
scripts/push-supabase.mjs     writer: upsert CSV vào orders, giữ SUPABASE_KEEP_DAYS ngày (mặc định 90)
public/drivers.csv            mapping tài xế → bưu cục (ghi đè tên/BC của data chính) — vẫn là file tĩnh
```

App chỉ tải đơn của **ngày đang chọn**, không tải cả kho, và vẫn parse bằng `loadOrders` như file.
`src/supa.js` có hai đường, thử theo thứ tự:

| Đường | Cách | Đo 10/09, ngày 35k dòng, gói Free Singapore |
| --- | --- | --- |
| **RPC** `day_csv(d)` + `order_dates()` | Postgres ghép cả ngày thành một chuỗi CSV, **một request**; danh sách ngày dò index | mở trang ~0,1 s · một ngày ~0,5–1 s |
| Trang `orders` + view `order_days` (lùi) | PostgREST kẹp `max_rows` = 1000 → 35 trang, tải song song 8 trang một | mở trang 1–5 s · một ngày ~5 s (tuần tự là 14,5 s) |

Đường RPC cần đã chạy phần "Tăng tốc đọc" cuối `supabase/schema.sql`; chưa có thì client nhận 404
và tự rơi về đường lùi, không vỡ. Cache 3 ngày gần nhất trong RAM. Bưu cục và tài xế đang chọn
**không** bị reset khi đổi ngày. Trang Báo cáo quét các ngày khác cũng qua đường này, mỗi ngày một request.

Thứ tự nguồn khi app khởi động: Supabase (có `VITE_SUPABASE_*` lúc build) → `public/data/manifest.json`
(chế độ file, dev không có Supabase) → `public/test.csv` (file gộp cũ; cũng là đường nút
**"Nạp CSV khác…"** dùng — nạp file tay thì ngày suy ra từ chính file đó).

Quyền: RLS bật, policy chỉ cho `select` với anon key (khóa nhúng trong trình duyệt). Ghi/xoá chỉ bằng
**service key** ở CI/máy admin, key này bỏ qua RLS — **không bao giờ** đưa vào `VITE_*` hay commit.
Mức lộ data ngang trang Vercel public hiện tại; muốn khép lại: bật Supabase Auth giới hạn email
`@ghn.vn` và đổi policy sang `to authenticated`.

Dung lượng: ~16–30k dòng/ngày, 90 ngày ≈ 2–3 triệu dòng ≈ 400–500 MB kể cả index → sát gói Free
(500 MB). Nếu chạm trần: giảm `SUPABASE_KEEP_DAYS` (secret/env, workflow đọc) hoặc lên gói Pro.
Gói Free **tạm dừng project sau 7 ngày không có request** — CI ghi mỗi sáng nên không bị, tắt CI lâu
thì vào dashboard bấm Restore.

### Nạp / sửa data bằng tay

Script Node không tự đọc `.env.local` — thêm `--env-file=.env.local` (Node ≥ 20.6), ví dụ
`node --env-file=.env.local scripts/push-supabase.mjs --dir public/data`. Các dòng dưới đây giả định
`SUPABASE_URL` + `SUPABASE_SERVICE_KEY` đã có trong env của shell.

```bash
npm run push:data -- <file.csv>                    # upsert từng ngày trong file (chạy lại không nhân đôi)
npm run push:data -- <file.csv> --replace-date     # ...và xoá dòng của ngày đó KHÔNG còn trong file
npm run push:data -- --dir public/data             # nạp lần đầu từ thư mục file cũ
npm run push:data -- --trim-only                   # chỉ cắt ngày quá hạn
npm run push:data -- <file.csv> --dry-run          # validate, không ghi
```

Di trú lần đầu từ bản deploy kiểu cũ: `node scripts/pull-prod-data.mjs` (kéo 14 ngày về
`public/data/`) rồi `npm run push:data -- --dir public/data`. Hoặc đơn giản hơn: Run workflow với
`days` = 14 để lấy thẳng từ BigQuery.

### Chế độ file cũ (`public/data/`, không cần Supabase)

Vẫn hoạt động nguyên vẹn cho dev offline; `fetch-daily.mjs` tự dùng nó khi **không** có env Supabase
(hoặc có `--local`). Flow tay:

```bash
# 1. Chạy query trên BigQuery console (project dw-ghn)
#    SQL: scripts/bq_daily.sql — tự lấy D-1 theo Asia/Ho_Chi_Minh, không cần sửa ngày
# 2. Save results -> Local download -> CSV   (file rơi vào ~/Downloads)
# 3. Gộp vào public/data/:
npm run append:data
```

`scripts/append-data.mjs` (Node thuần, zero-dep):

| Việc | Chi tiết |
| --- | --- |
| Tìm file | CSV mới nhất trong `~/Downloads` có tên bắt đầu `script_job_` / `bq-results-` / `bquxjob`. Cảnh báo nếu file cũ hơn 24h. |
| Validate | Header phải khớp đúng 10 cột theo thứ tự. Sai → thoát, không ghi gì. |
| Tách ngày | Mỗi `load_date` vào một file riêng, merge vào file ngày đã có. |
| Dedupe | Key `employee_id\|order_code` trong từng ngày. Chạy lại nhiều lần không nhân đôi. |
| Giữ ngày | 14 ngày gần nhất. Ngày quá hạn bị **xoá** (dời sang `data_archive/` chỉ khi unlink bị từ chối). |
| Manifest | Ghi lại `manifest.json` (ngày, số dòng, bytes) sau mỗi lần chạy. |
| Ghi | Atomic (`.tmp` + rename). Cảnh báo nếu một ngày vượt 8 MB. |

Tuỳ chọn: `--dry-run`, `<duong-dan.csv>`, `--downloads <thu-muc>`, `--keep-days N`,
`--keep-all`, `--trim-only` (chỉ cắt ngày cũ + ghi lại manifest),
`--replace-date` (ghi đè cả ngày thay vì merge — dùng khi chạy lại một ngày đã sai),
`--migrate` (tách `public/test.csv` sẵn có ra `public/data/`).

> `public/data/*.csv` và `manifest.json` không được commit (gitignore): bản trong repo luôn cũ và
> từng làm production tụt data khi Vercel tự deploy từ Git (trước khi chuyển sang Supabase).
> `data_archive/` chỉ còn là đường lùi khi `unlink` bị từ chối (EPERM); bình thường không có gì trong đó.

> Khi format export BigQuery đổi: sửa `HEADER` trong `scripts/append-data.mjs` và
> `scripts/push-supabase.mjs`, cột bảng trong `supabase/schema.sql` + `COLUMNS` trong `src/supa.js`,
> alias list trong `loadOrders` (`src/detect.js`), và `BQ_QUERY` trong `src/GuideModal.jsx`
> **cùng lúc**. Một cột lệch âm thầm sẽ dồn hết đơn về một tài xế.

> `scripts/bq_daily.sql` và `BQ_QUERY` trong `GuideModal.jsx` là cùng một query,
> chỉ khác 2 dòng `DECLARE`: file SQL lấy D-1 tự động, GuideModal để người dùng tự điền ngày.
> `fetch-daily.mjs` đọc chính file SQL này và thay 2 dòng `DECLARE` bằng ngày cụ thể.

### Chạy tự động hàng ngày

Không dùng Data API, không dùng Google Sheet, không cần Chrome. `scripts/fetch-daily.mjs` chạy
`bq_daily.sql` thẳng trên BigQuery, ghi CSV thô vào `data_incoming/` (gitignore), rồi gọi bước ghi:
`push-supabase.mjs` khi có `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` (production), ngược lại
`append-data.mjs` (file local). Nó có hai backend BigQuery, chọn theo env:

| Backend | Khi nào | Credential |
| --- | --- | --- |
| **REST API** | có `BQ_CREDENTIALS_JSON` (nội dung) hoặc `GOOGLE_APPLICATION_CREDENTIALS` (đường dẫn) | JSON `service_account` (nên dùng) hoặc `authorized_user` (file gcloud tạo ở `%APPDATA%\gcloud\legacy_credentials\<email>\adc.json`) |
| **`bq` CLI** | không có env trên, máy có Google Cloud SDK | tài khoản `gcloud auth login` |

Hai đường vận hành, cùng một script:

#### A. GitHub Actions (chính) — máy tắt vẫn chạy

`.github/workflows/daily-data.yml` chạy 10:00 VN mỗi ngày trên GitHub, **không deploy gì**:

1. `push-supabase.mjs --trim-only --dry-run` kiểm tra bảng + key trước khi tốn tiền quét BigQuery.
2. `fetch-daily.mjs --days 2 --replace-date` hỏi BigQuery **D-1 và D-2** (~2 GB quét, ~25 giây) rồi
   upsert vào `orders`; `--replace-date` xoá dòng của hai ngày đó không còn trong lượt mới.
3. Cắt ngày quá hạn (giữ `SUPABASE_KEEP_DAYS`, mặc định 90), rồi kiểm tra Supabase đã có D-1 chưa —
   chưa có chỉ cảnh báo (warehouse chưa nạp), app hiện ngày gần nhất đang có.

Lấy chồng 2 ngày vì **data nguồn sửa lùi**: đơn được gán thêm vài giờ sau, nên bản D-1 lấy lúc
10:00 sáng vẫn thiếu. Mỗi ngày do đó được lấy hai lần — một lần làm D-1, sáng hôm sau một lần nữa
làm D-2 — rồi mới **đóng băng**. Lỡ một buổi sáng (BigQuery chưa có data) cũng tự vá ở lượt kế.
Backfill / làm mới nhiều ngày: **Run workflow** với `days` lớn hơn (tối đa 60).

Secrets cần thêm một lần (Settings → Secrets and variables → Actions):

| Secret | Lấy ở đâu |
| --- | --- |
| `BQ_CREDENTIALS_JSON` | Tốt nhất: service account key do Data team cấp, có quyền đọc 3 bảng nguồn + `bigquery.jobs.create` trên `dw-ghn`. Tạm thời: nội dung file `%APPDATA%\gcloud\legacy_credentials\<email>\adc.json` (refresh token cá nhân — hết hạn theo chính sách Workspace, đổi mật khẩu là chết) |
| `SUPABASE_URL` | Supabase → Project Settings → API → Project URL |
| `SUPABASE_SERVICE_KEY` | cùng trang, **service_role** (hoặc secret key `sb_secret_…`) — không phải anon |

Chạy tay: tab **Actions → Daily data → Supabase → Run workflow**, chọn ngày cuối, số ngày, hoặc
`dry_run` để chỉ chạy query. Deploy code là việc của Vercel (tự build khi push `main`), không liên
quan tới workflow này.

#### B. Windows Task Scheduler (dự phòng cũ)

`scripts/daily-deploy.ps1` + `register-deploy-task.ps1` là chuỗi fetch → docker → vercel của thời
data còn nằm trong deploy. Task đã gỡ; script vẫn chạy được ở chế độ file (không có env Supabase)
nhưng không còn cần thiết. Muốn chạy tay tương đương CI trên máy mình: đặt `SUPABASE_URL` +
`SUPABASE_SERVICE_KEY` rồi `node scripts/fetch-daily.mjs --days 2 --replace-date`.

| Việc | Lệnh |
| --- | --- |
| Validate query + ước lượng bytes | `node scripts/fetch-daily.mjs --dry-run` |
| Đúng như CI làm mỗi sáng (cần env Supabase) | `node scripts/fetch-daily.mjs --days 2 --replace-date` |
| Lấy lại một ngày / backfill | `node scripts/fetch-daily.mjs --date 2026-09-01 --to 2026-09-05 --replace-date` |
| Chỉ ghi file `public/data/` dù có env Supabase | `node scripts/fetch-daily.mjs --local` |
| Xem Supabase đang có ngày nào | `npm run push:data -- --trim-only --dry-run` |
| Kéo data từ bản deploy kiểu cũ về `public/data/` | `node scripts/pull-prod-data.mjs` |

Log CI ở tab Actions. `fetch-daily.mjs` thoát mã 2 khi query chạy được nhưng không có dòng nào
(warehouse chưa nạp) — coi là "chưa có data", không phải lỗi. Lỗi hay gặp nhất: credential BigQuery
hết hạn → `gcloud auth login` (local) hoặc cập nhật secret (CI).

> Hai file `.ps1` phải lưu **UTF-8 có BOM**: Windows PowerShell 5.1 đọc file không BOM theo
> codepage 1252, dấu `—` biến thành ngoặc kép cong và làm hỏng cú pháp chuỗi.

## Sự cố đã biết

- **Map trắng xóa, chấm đơn vẫn hiện**: mạng chặn DNS của nguồn ảnh nền. App đang dùng
  **Esri World Street Map** (không cần API key) vì `tile.openstreetmap.org` bị chặn trên mạng công ty,
  còn Carto bản miễn phí đóng watermark. Nếu đổi mạng mà map trắng, kiểm tra F12 → Console
  có lỗi `ERR_NAME_NOT_RESOLVED` với domain tile nào rồi đổi nguồn trong `src/MapView.jsx`.
- **Map vỡ tile / xám một mảng**: đã có `invalidateSize()` + `ResizeObserver` trong `MapView.jsx`;
  nếu vẫn gặp, hard refresh (Ctrl+F5).
- **Trang hiện data cũ / "Không tải được dữ liệu ngày…"** sau khi chuyển Supabase: F12 → Network,
  tìm request tới `*.supabase.co/rest/v1/`. Không có request nào = bundle thiếu `VITE_SUPABASE_*`
  lúc build (Vercel env chưa đặt hoặc chưa Redeploy). 401/403 = anon key sai hoặc chưa chạy
  `schema.sql` (policy đọc). 404 = chưa có bảng. Project Free bị pause = mọi request lỗi mạng →
  vào dashboard Restore.
