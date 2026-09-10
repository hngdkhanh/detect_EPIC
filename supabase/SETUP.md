# Chuyển data sang Supabase — làm một lần, theo đúng thứ tự

Tổng thời gian ~25 phút, phần lớn là chờ Supabase tạo project và Vercel build.

> **Thứ tự quan trọng: nạp 14 ngày từ production cũ TRƯỚC khi push code.**
> Bản deploy đang chạy là nơi duy nhất còn giữ cửa sổ 14 ngày (`/data/*.csv`). Sau khi push, Vercel
> build bản mới không còn phục vụ mấy file đó nữa, `pull-prod-data.mjs` sẽ về tay không, và muốn
> có lại lịch sử thì phải hỏi BigQuery 14 ngày (~8 GB quét thay vì 0 đồng).

Đã kiểm tra sẵn trên máy này: Node 24, Vercel CLI 59 đã đăng nhập (`duckhanh07102004`), Docker.
Chưa có `gh` CLI → GitHub Secrets làm qua web. Repo: `EPIC-GHN/detect_EPIC`, nhánh `main`.

> **Đã tạo project theo bản hướng dẫn sáng 10/09 rồi?** Chỉ cần một việc: mở SQL Editor, dán lại
> **toàn bộ** `supabase/schema.sql` bản mới, Run. File idempotent: phần đã có bị bỏ qua, phần mới
> thêm hai hàm `day_csv()` / `order_dates()` và nới các cột text về nullable. Không chạy thì app vẫn
> hoạt động nhưng tải một ngày mất ~5 s và mở trang mất ~2–5 s, thay vì ~1 s và ~0,1 s (đo 10/09
> trên ngày 35k dòng). Xong rồi tải lại trang, kiểm ở bước 4 mục 3.

---

## 1. Tạo project Supabase và chạy schema (~7 phút, phần lớn là chờ)

1. Mở https://supabase.com/dashboard → đăng nhập (GitHub hoặc email `khanhhnd@ghn.vn`).
2. **New project**:
   - **Name**: `epic-order-map`
   - **Database Password**: bấm *Generate*, **lưu vào password manager**. App không dùng mật khẩu này
     (app đi qua REST + key), chỉ cần khi nào muốn nối `psql`/pooler.
   - **Region**: **Southeast Asia (Singapore)** — gần VN nhất, mỗi lần đổi ngày nhanh hơn rõ rệt so
     với region Mỹ/EU.
   - **Plan**: Free.
3. Chờ 1–2 phút cho tới khi dashboard hết chữ "Setting up project".
4. **SQL Editor** (thanh trái) → **New query** → mở `supabase/schema.sql` trong repo, copy **toàn bộ**,
   dán vào, bấm **Run** (hoặc Ctrl+Enter).
   Kỳ vọng: `Success. No rows returned`.
5. Kiểm tra ngay trong SQL Editor:
   ```sql
   select * from public.order_days;
   ```
   Kỳ vọng: `Success. No rows returned` (bảng còn trống — đúng ở bước này).
   **Table Editor** phải thấy bảng `orders` với nhãn ổ khóa *RLS enabled*.

### Lấy 3 giá trị cần dùng

**Project Settings** (bánh răng) → **API keys** (dashboard cũ: *Settings → API*):

| Chỗ lấy | Dùng làm | Ghi chú |
| --- | --- | --- |
| **Project URL** `https://<ref>.supabase.co` | `VITE_SUPABASE_URL` **và** `SUPABASE_URL` | cùng một giá trị cho cả app lẫn script |
| **anon** / **publishable** key | `VITE_SUPABASE_ANON_KEY` | nhúng vào bundle trình duyệt, RLS chặn chỉ cho đọc |
| **service_role** / **secret** key (bấm *Reveal*) | `SUPABASE_SERVICE_KEY` | **bỏ qua RLS** — chỉ CI và máy admin, không bao giờ đặt tên `VITE_*` |

Dashboard mới có thể hiện `sb_publishable_…` / `sb_secret_…` thay cho anon/service_role kiểu JWT cũ.
Cả hai loại đều dùng được, script tự nhận.

---

## 2. Cấu hình máy local và thử kết nối (~3 phút)

`.env.local` đã tồn tại và đang có một dòng `VERCEL_OIDC_TOKEN` do Vercel CLI ghi — **thêm vào cuối
file, đừng xoá dòng đó**:

```
VITE_SUPABASE_URL=https://<ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon / publishable>
SUPABASE_URL=https://<ref>.supabase.co
SUPABASE_SERVICE_KEY=<service_role / secret>
```

`.env*` đã nằm trong `.gitignore` nên file này không bao giờ bị commit. Đừng dán key vào
`.env.example` (file đó có commit).

Các script Node **không tự đọc** `.env.local` — truyền bằng cờ `--env-file` của Node:

```powershell
node --env-file=.env.local scripts/push-supabase.mjs --trim-only --dry-run
```

Kỳ vọng:

```
☁️  Supabase : https://<ref>.supabase.co
   Đang có  : (trống)
   🗑️  Quá hạn: (không có) — giữ 90 ngày gần nhất
🔍 --dry-run: không ghi gì.
```

Lỗi hay gặp ở bước này:

| Thông báo | Nguyên nhân | Sửa |
| --- | --- | --- |
| `Bảng chưa tồn tại (HTTP 404)` | chưa chạy `schema.sql`, hoặc chạy vào project khác | quay lại bước 1.4 |
| `Supabase từ chối (HTTP 401)` | key sai / dán thiếu | copy lại, kiểm tra không lẫn khoảng trắng |
| `Key có role "anon" — cần service_role` | dán anon key vào `SUPABASE_SERVICE_KEY` | lấy đúng service_role (phải bấm *Reveal*) |
| `fetch failed` | URL sai, thiếu `https://`, hoặc project Free đang bị pause | kiểm tra URL; dashboard → *Restore project* |

---

## 3. Nạp 14 ngày đang chạy trên production (~5 phút) — TRƯỚC KHI PUSH

```powershell
node scripts/pull-prod-data.mjs
node --env-file=.env.local scripts/push-supabase.mjs --dir public/data
```

- Lệnh đầu kéo `manifest.json` + 14 file ngày từ https://epic-order-map.vercel.app về `public/data/`
  (~34 MB, vài giây). `public/data/` đã gitignore.
- Lệnh sau upsert vào Supabase theo lô 2000 dòng — khoảng 300k dòng nên mất 1–3 phút, in một dòng
  `✅ <ngày>: upsert N dòng` cho mỗi ngày, kết thúc bằng tổng số ngày và số dòng.

Kiểm tra:

```powershell
node --env-file=.env.local scripts/push-supabase.mjs --trim-only --dry-run
```

Kỳ vọng dòng `Đang có :` liệt kê đủ 14 ngày kèm số dòng mỗi ngày (mỗi ngày ~16–30k).

**Nếu `pull-prod-data.mjs` thất bại** (production đã đổi, hoặc bật Deployment Protection): bỏ qua
bước 3, đi tiếp, và ở bước 6 chạy workflow với `days` = 14 để lấy thẳng từ BigQuery. Chậm và tốn
~8 GB quét nhưng ra đúng kết quả.

---

## 4. Thử local trước khi đẩy lên (~2 phút)

```powershell
npm run dev
```

Mở http://localhost:5173 và kiểm ba thứ:

1. Dropdown **Ngày** có 14 ngày, mặc định là ngày mới nhất.
2. Bản đồ có chấm đơn, chọn bưu cục và tài xế hoạt động bình thường.
3. F12 → **Network**, gõ `supabase` vào ô filter: phải thấy đúng hai loại request, `rpc/order_dates`
   lúc mở trang và `rpc/day_csv?d=…` mỗi lần đổi ngày, đều 200, mỗi cái dưới ~1 s. Nếu thay vào đó
   là `order_days?select=…` rồi hàng chục request `orders?select=…` 1000 dòng một: Supabase chưa có
   hai hàm mới, quay lại bước 1.4 chạy lại `schema.sql`. App vẫn chạy ở chế độ đó, chỉ chậm gấp 5 lần.

Trang trống mà Console in `Supabase không trả được danh sách ngày` → xem lại bảng lỗi ở bước 2
(thường là RLS policy chưa chạy, hoặc anon key sai).

Mở luôn tab **📊 Báo cáo** một lần: nó quét nền các ngày còn lại, xác nhận đường tải nhiều ngày cũng chạy.

---

## 5. Đặt env trên Vercel rồi push (~6 phút)

**Làm env trước khi push.** `vercel.json` giờ bật Git auto-deploy cho `main`, nên push là Vercel build
ngay; build thiếu env thì bundle không biết Supabase ở đâu và trang rơi về `public/test.csv` cũ.

Cách A — dashboard: vercel.com → team → project **epic-order-map** → **Settings** → **Environment
Variables** → **Add New**, làm hai lần:

| Key | Value | Environments |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | `https://<ref>.supabase.co` | Production, Preview, Development |
| `VITE_SUPABASE_ANON_KEY` | anon / publishable key | Production, Preview, Development |

**Không** thêm `SUPABASE_SERVICE_KEY` vào Vercel — trang tĩnh không cần, và nếu đặt tên `VITE_*` thì
nó sẽ nằm trong bundle cho cả thiên hạ đọc.

Cách B — CLI (đang đăng nhập sẵn), mỗi lệnh sẽ hỏi value, dán rồi Enter:

```powershell
vercel env add VITE_SUPABASE_URL production
vercel env add VITE_SUPABASE_URL preview
vercel env add VITE_SUPABASE_ANON_KEY production
vercel env add VITE_SUPABASE_ANON_KEY preview
```

Rồi commit và push:

```powershell
git add -A
git commit -m "feat: chuyen kho data don gan sang Supabase"
git push
```

Theo dõi tab **Deployments** trên Vercel. Xong thì mở https://epic-order-map.vercel.app và kiểm đúng
ba thứ như bước 4 (F12 → Network → filter `supabase`).

**Trang hiện trống hoặc data cũ**: gần như chắc chắn env chưa có lúc build. Deployments → bản mới
nhất → dấu `⋯` → **Redeploy**, **bỏ tick** *Use existing build cache*. Vite nhúng env lúc build nên
mọi lần đổi giá trị env đều phải redeploy.

---

## 6. GitHub Secrets và chạy workflow (~5 phút)

Mở https://github.com/EPIC-GHN/detect_EPIC/settings/secrets/actions →
**New repository secret**, thêm hai cái:

| Secret | Value |
| --- | --- |
| `SUPABASE_URL` | `https://<ref>.supabase.co` |
| `SUPABASE_SERVICE_KEY` | service_role / secret key |

`BQ_CREDENTIALS_JSON` đã có sẵn từ trước. `VERCEL_TOKEN` và `VERCEL_BYPASS` không còn dùng nữa,
xoá được nhưng không bắt buộc.

**Chạy thử trước (không ghi gì):** Actions → **Daily data → Supabase** → *Run workflow* →
`days` = 2 → **tick `dry_run`** → Run.

Kỳ vọng: bước *Kiểm tra Supabase* xanh và in ra 14 ngày đang có; bước *Lấy data* in số dòng BigQuery
trả về rồi dừng ở `--no-append`.

Nếu bước lấy data đỏ với `invalid_rapt` trong log: credential BigQuery hết hạn, không liên quan
Supabase. Cách phân biệt và xử lý nằm trong log của chính bước đó (và ở README, mục *Chạy tự động
hàng ngày*).

**Chạy thật:** Run workflow lần nữa, `days` = 2, **bỏ tick** `dry_run`. Sau ~1 phút bước cuối in danh
sách ngày kèm số dòng và ghi vào Summary của run.

Từ hôm sau nó tự chạy 10:00 giờ VN mỗi ngày. Không còn bước deploy nào trong workflow — data vào
Supabase là app thấy ngay, không cần build lại.

---

## 7. Việc còn lại sau khi chạy được

- **`public/data/` trên máy** giờ chỉ là bản nháp của bước 3, xoá được: `Remove-Item public/data/*.csv`.
- **Quyền riêng tư** — việc đáng làm nhất. Trang vẫn public, anon key chỉ đọc nhưng ai có link đều
  xem được tên nhân viên và địa chỉ khách. Hai cách khép:
  - nhanh: bật **Vercel Deployment Protection** (Settings → Deployment Protection → Vercel Authentication).
  - đúng bài: bật **Supabase Auth** giới hạn email `@ghn.vn`, rồi sửa policy trong `schema.sql` từ
    `to anon, authenticated` thành `to authenticated` và chạy lại.
- **Dung lượng**: Supabase → Reports → Database. 90 ngày ≈ 400–500 MB, sát trần Free 500 MB. Chạm trần
  thì thêm secret `SUPABASE_KEEP_DAYS` (ví dụ `60`) chứ chưa cần lên gói Pro.
- **Gói Free pause project sau 7 ngày không có request** — CI ghi mỗi sáng nên không bị. Nếu tắt CI
  dài ngày thì vào dashboard bấm *Restore project*.
- **Backfill thêm lịch sử** (muốn đủ 90 ngày thật): Run workflow với `days` = 60 (tối đa), hoặc
  `node --env-file=.env.local scripts/fetch-daily.mjs --date 2026-06-15 --to 2026-07-15 --replace-date`.
  Mỗi ngày quét ~1 GB BigQuery, cân nhắc chi phí.

---

## Lệnh hay dùng về sau

| Việc | Lệnh |
| --- | --- |
| Xem Supabase đang có ngày nào | `node --env-file=.env.local scripts/push-supabase.mjs --trim-only --dry-run` |
| Lấy lại một ngày bị sai | `node --env-file=.env.local scripts/fetch-daily.mjs --date 2026-09-09 --replace-date` |
| Nạp một CSV tải tay từ BigQuery Console | `node --env-file=.env.local scripts/push-supabase.mjs "C:\Users\khanhhnd\Downloads\bq-results.csv"` |
| Chạy đúng như CI mỗi sáng | `node --env-file=.env.local scripts/fetch-daily.mjs --days 2 --replace-date` |
| Chỉ validate query + ước lượng bytes | `node scripts/fetch-daily.mjs --dry-run` |
| Quay về chế độ file, không đụng Supabase | `node scripts/fetch-daily.mjs --local` |
| Cắt bớt lịch sử ngay | `node --env-file=.env.local scripts/push-supabase.mjs --trim-only --keep-days 30` |
