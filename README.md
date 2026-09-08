# EPIC Order Map (React)

Trang phát hiện đơn gán ngoài xa vùng gợi ý EPIC — project React nằm ngay thư mục gốc repo — chạy local bằng Docker, deploy được lên Vercel.

## Setup local (Docker)

Yêu cầu duy nhất: **Docker Desktop** đang chạy (không cần cài Node/npm).

```bash
docker compose up -d --build
```

Xong — mở **http://localhost:8080**. Container chạy nền liên tục, tự khởi động lại cùng Docker Desktop
(`restart: unless-stopped`).

Image build 2 giai đoạn: Node 20 build bản tĩnh bằng Vite → Nginx serve (image cuối ~94MB, không chứa Node).
Nginx đã cấu hình sẵn gzip, cache dài hạn cho bundle (`/assets/`), no-cache cho file CSV, SPA fallback (`nginx.conf`).

### Lệnh thường dùng

```bash
docker ps                          # kiểm tra: thấy epic-order-map ... (healthy) là đang chạy
docker logs epic-order-map         # xem log Nginx
docker compose up -d --build       # build & chạy lại sau khi đổi code/dữ liệu
docker compose down                # tắt hẳn
```

- **Đổi port**: sửa `8080:80` trong `docker-compose.yml` rồi `docker compose up -d`.
- **Chia sẻ trong mạng LAN**: người cùng mạng mở `http://<IP-máy-bạn>:8080`
  (xem IP bằng `ipconfig`; không vào được thì cho phép port 8080 qua Windows Firewall).

### Dev mode (chỉ khi cần sửa code, có hot-reload)

```bash
npm install
npm run dev      # mở http://localhost:5173
```

## Deploy lên Vercel

Cách 1 — qua GitHub (khuyên dùng):
1. Push folder này lên một repo GitHub.
2. Vào vercel.com → **Add New Project** → import repo.
3. Vercel tự nhận preset **Vite** (build `vite build`, output `dist`) — bấm Deploy là xong.

Cách 2 — CLI:
```bash
npm i -g vercel
vercel        # làm theo hướng dẫn, lần sau chỉ cần `vercel --prod`
```

Lưu ý: trang chứa dữ liệu đơn + tên nhân viên thật — deploy công khai nên bật
**Deployment Protection** trên Vercel, hoặc chỉ host nội bộ bằng Docker.

## Cập nhật dữ liệu

Dữ liệu **tách theo ngày** trong `public/data/`:

```
public/data/manifest.json     danh sách ngày có sẵn — app đọc file này trước
public/data/2026-08-27.csv    một file cho mỗi load_date
public/drivers.csv            mapping tài xế → bưu cục (ghi đè tên/BC của file chính)
data_archive/                 ngày quá hạn được dời về đây (không xoá tự động)
```

App chỉ tải CSV của **ngày đang chọn** (~3 MB), không tải cả kho. Đổi ngày → fetch file
ngày đó, giữ cache 3 ngày gần nhất trong RAM nên bấm qua lại không tải lại. Bưu cục và
tài xế đang chọn **không** bị reset khi đổi ngày.

Không có `manifest.json` thì app rơi về file gộp `public/test.csv` như trước (đường lui
này cũng là đường mà nút **"Nạp CSV khác…"** dùng — nạp file tay thì ngày suy ra từ chính
file đó).

### Flow cập nhật hàng ngày

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
| Giữ ngày | 14 ngày gần nhất. Ngày quá hạn **dời** sang `data_archive/`. |
| Manifest | Ghi lại `manifest.json` (ngày, số dòng, bytes) sau mỗi lần chạy. |
| Ghi | Atomic (`.tmp` + rename). Cảnh báo nếu một ngày vượt 8 MB. |

Tuỳ chọn: `--dry-run`, `<duong-dan.csv>`, `--downloads <thu-muc>`, `--keep-days N`,
`--keep-all`, `--trim-only` (chỉ cắt ngày cũ + ghi lại manifest),
`--replace-date` (ghi đè cả ngày thay vì merge — dùng khi chạy lại một ngày đã sai),
`--migrate` (tách `public/test.csv` sẵn có ra `public/data/`).

> **Không xoá được, chỉ dời.** Sandbox chạy scheduled task không có quyền `unlink` trong
> thư mục được mount, nên ngày quá hạn đi vào `data_archive/`. Dọn thư mục đó bằng tay.
> Cùng lý do: `npm run build` phải chạy ngoài sandbox (vite cần xoá `dist/` trước khi ghi).

> Khi format export BigQuery đổi: sửa `HEADER` trong `scripts/append-data.mjs`,
> alias list trong `loadOrders` (`src/detect.js`), và `BQ_QUERY` trong `src/GuideModal.jsx`
> **cùng lúc**. Một cột lệch âm thầm sẽ dồn hết đơn về một tài xế.

> `scripts/bq_daily.sql` và `BQ_QUERY` trong `GuideModal.jsx` là cùng một query,
> chỉ khác 2 dòng `DECLARE`: file SQL lấy D-1 tự động, GuideModal để người dùng tự điền ngày.
> `fetch-daily.mjs` đọc chính file SQL này và thay 2 dòng `DECLARE` bằng ngày cụ thể.

### Chạy tự động hàng ngày

Không dùng Data API, không dùng Google Sheet, không cần Chrome. `scripts/fetch-daily.mjs` chạy
`bq_daily.sql` thẳng trên BigQuery, ghi CSV thô vào `data_incoming/` (gitignore), rồi gọi
`append-data.mjs`. Nó có hai backend, chọn theo env:

| Backend | Khi nào | Credential |
| --- | --- | --- |
| **REST API** | có `BQ_CREDENTIALS_JSON` (nội dung) hoặc `GOOGLE_APPLICATION_CREDENTIALS` (đường dẫn) | JSON `service_account` (nên dùng) hoặc `authorized_user` (file gcloud tạo ở `%APPDATA%\gcloud\legacy_credentials\<email>\adc.json`) |
| **`bq` CLI** | không có env trên, máy có Google Cloud SDK | tài khoản `gcloud auth login` |

Hai đường vận hành, cùng một script:

#### A. GitHub Actions (chính) — máy tắt vẫn chạy

`.github/workflows/daily-data.yml` chạy 10:00 VN mỗi ngày trên GitHub: lấy **trọn 14 ngày** gần
nhất trong một query (~8 GB quét, ~1 phút, 260k dòng), `append-data --replace-date`, rồi
`vercel pull/build/deploy --prebuilt --prod`. **Stateless**: không commit data vào repo, nên repo
không phình 7 MB/ngày và một ngày sai sẽ tự lành ở lần chạy sau (data nguồn cũng thay đổi lùi:
đơn được gán thêm sau vài giờ).

Secrets cần thêm một lần (Settings → Secrets and variables → Actions):

| Secret | Lấy ở đâu |
| --- | --- |
| `BQ_CREDENTIALS_JSON` | Tốt nhất: service account key do Data team cấp, có quyền đọc 3 bảng nguồn + `bigquery.jobs.create` trên `dw-ghn`. Tạm thời: nội dung file `%APPDATA%\gcloud\legacy_credentials\<email>\adc.json` (refresh token cá nhân — hết hạn theo chính sách Workspace, đổi mật khẩu là chết) |
| `VERCEL_TOKEN` | https://vercel.com/account/tokens |

`VERCEL_ORG_ID` / `VERCEL_PROJECT_ID` không bí mật, ghi thẳng trong workflow (giống `.vercel/project.json`).
Chạy tay: tab **Actions → Daily data → Vercel → Run workflow**, có thể chọn ngày cuối, số ngày,
và tắt deploy để chỉ kiểm tra data. Nếu BigQuery chưa có dòng nào cho D-1, workflow cảnh báo và
**bỏ qua deploy**, production giữ data cũ.

> **`vercel.json` tắt Git auto-deploy cho `main` — đừng bỏ.** Data không nằm trong repo, nên nếu
> Vercel tự build từ Git thì mỗi lần push code production sẽ tụt về mấy ngày data cũ còn sót trong
> `public/data/`. Workflow này là đường **duy nhất** deploy production, và nó chạy cả khi push vào
> `main` (bỏ qua nếu chỉ đổi `*.md`) nên đổi code vẫn lên production bình thường, kèm data mới.
> Mấy file ngày còn commit trong `public/data/` chỉ để `npm run dev` local có dữ liệu.

#### B. Windows Task Scheduler (dự phòng, cần máy bật + đã đăng nhập)

`scripts/daily-deploy.ps1` lúc 10:00: fetch D-1 (bq CLI) → gate manifest có D-1 → `docker compose
up -d --build` → `vercel --prod`. Đăng ký/gỡ bằng `scripts/register-deploy-task.ps1` (kiểm tra sẵn
`node` / `bq` / `vercel` / `docker`). Khi đường A đã chạy ổn thì gỡ task này để khỏi deploy hai lần:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\register-deploy-task.ps1 -Unregister
```

| Việc | Lệnh |
| --- | --- |
| Validate query + ước lượng bytes | `node scripts/fetch-daily.mjs --dry-run` |
| Chỉ lấy data D-1 (bq CLI) | `npm run fetch:data` |
| Lấy lại một ngày / backfill | `node scripts/fetch-daily.mjs --date 2026-09-01 --to 2026-09-05` |
| Đúng như CI làm | `node scripts/fetch-daily.mjs --days 14 --replace-date` |
| Thử chuỗi local, không deploy | `.\scripts\daily-deploy.ps1 -NoDeploy` |
| Deploy tay dù data chưa mới | `.\scripts\daily-deploy.ps1 -SkipFetch -Force` |
| Chạy task local ngay | `Start-ScheduledTask -TaskName 'EPIC Order Map - daily deploy'` |

Log local ở `logs/deploy-<ngày>.log` (30 file), log CI ở tab Actions. `fetch-daily.mjs` thoát mã 2
khi query chạy được nhưng không có dòng nào (warehouse chưa nạp) — cả hai đường coi là "chưa có
data", không phải lỗi. Lỗi hay gặp nhất: credential hết hạn → `gcloud auth login` (local) hoặc
cập nhật secret (CI).

> Hai file `.ps1` phải lưu **UTF-8 có BOM**: Windows PowerShell 5.1 đọc file không BOM theo
> codepage 1252, dấu `—` biến thành ngoặc kép cong và làm hỏng cú pháp chuỗi.

## Sự cố đã biết

- **Map trắng xóa, chấm đơn vẫn hiện**: mạng chặn DNS của nguồn ảnh nền. App đang dùng
  **Esri World Street Map** (không cần API key) vì `tile.openstreetmap.org` bị chặn trên mạng công ty,
  còn Carto bản miễn phí đóng watermark. Nếu đổi mạng mà map trắng, kiểm tra F12 → Console
  có lỗi `ERR_NAME_NOT_RESOLVED` với domain tile nào rồi đổi nguồn trong `src/MapView.jsx`.
- **Map vỡ tile / xám một mảng**: đã có `invalidateSize()` + `ResizeObserver` trong `MapView.jsx`;
  nếu vẫn gặp, hard refresh (Ctrl+F5).
