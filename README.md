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

Việc này cũng chạy tự động qua scheduled task của Claude lúc **10h sáng hàng ngày**
(mở BigQuery bằng Chrome, tải CSV, chạy `append-data.mjs`), rồi báo qua push notification.
Task **không** deploy và **không** commit: sandbox chạy task không có `vercel` CLI và bị chặn
mạng tới vercel.com, nên `docker compose up -d --build` + `vercel --prod` vẫn phải chạy tay.

## Sự cố đã biết

- **Map trắng xóa, chấm đơn vẫn hiện**: mạng chặn DNS của nguồn ảnh nền. App đang dùng
  **Esri World Street Map** (không cần API key) vì `tile.openstreetmap.org` bị chặn trên mạng công ty,
  còn Carto bản miễn phí đóng watermark. Nếu đổi mạng mà map trắng, kiểm tra F12 → Console
  có lỗi `ERR_NAME_NOT_RESOLVED` với domain tile nào rồi đổi nguồn trong `src/MapView.jsx`.
- **Map vỡ tile / xám một mảng**: đã có `invalidateSize()` + `ResizeObserver` trong `MapView.jsx`;
  nếu vẫn gặp, hard refresh (Ctrl+F5).
