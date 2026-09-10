-- schema.sql — bảng đơn gán của EPIC Order Map trên Supabase (Postgres).
--
-- Chạy MỘT LẦN trong Supabase Dashboard → SQL Editor (project mới). Chạy lại vô hại (idempotent).
--
-- Vì sao 1 bảng phẳng đúng 10 cột của CSV: app vẫn parse bằng loadOrders() trong src/detect.js,
-- Supabase trả thẳng text/csv qua PostgREST (Accept: text/csv) nên client không cần thư viện,
-- không đổi thuật toán. Khóa chính (load_date, employee_id, order_code) chính là key dedupe
-- `employee_id|order_code` trong từng ngày của append-data.mjs — upsert = merge, chạy lại không nhân đôi.
--
-- fetched_at: mốc lần fetch gần nhất ghi/đụng vào dòng. push-supabase.mjs --replace-date dùng nó
-- để xoá những dòng của ngày đó KHÔNG còn trong lần fetch mới (đơn bị gỡ khỏi gán), mà không cần
-- xoá trắng ngày trước rồi chèn lại (app đang mở không bao giờ thấy ngày rỗng).

-- Các cột text ngoài khoá KHÔNG not null: COPY / Table Editor "Import CSV" của Supabase đọc ô trống
-- thành NULL và sẽ bị từ chối nếu not null (đo 2026-09-10 với file thật: dòng EPIC bị gỡ không có
-- địa chỉ). push-supabase.mjs gửi '' nên không gặp, nhưng đừng bắt mọi đường nạp phải biết điều đó;
-- day_csv() và text/csv của PostgREST đều in NULL thành ô trống, app đọc như nhau.
create table if not exists public.orders (
  load_date       date        not null,
  warehouse_id    text        default '',
  warehouse_name  text        default '',
  employee_id     text        not null,
  driver_name     text        default '',
  order_code      text        not null,
  contact_address text        default '',
  contact_latlng  text        default '',
  is_epic         smallint    not null default 0,
  is_assigned     smallint    not null default 0,
  fetched_at      timestamptz not null default now(),
  primary key (load_date, employee_id, order_code)
);

-- Project đã tạo bằng bản schema đầu (2026-09-10 sáng, các cột text not null) → nới ra.
-- Cột vốn đã nullable thì DROP NOT NULL là no-op, nên chạy lại bao nhiêu lần cũng được.
alter table public.orders
  alter column warehouse_id    drop not null,
  alter column warehouse_name  drop not null,
  alter column driver_name     drop not null,
  alter column contact_address drop not null,
  alter column contact_latlng  drop not null;

-- app tải nguyên một ngày, script xoá theo ngày → index theo load_date là đủ
create index if not exists orders_load_date_idx on public.orders (load_date);

-- Danh sách ngày có data (thay manifest.json). security_invoker = on → view chạy bằng quyền của
-- người gọi và tôn trọng RLS của orders (policy đọc bên dưới đã cho anon select), thay vì chạy
-- quyền owner; nhờ vậy Security Advisor của Supabase không báo "security definer view".
create or replace view public.order_days
  with (security_invoker = on) as
  select load_date, count(*)::int as n, max(fetched_at) as fetched_at
  from public.orders
  group by load_date
  order by load_date;

-- Chỉ ĐỌC cho anon key (khóa nhúng trong trình duyệt). Ghi/xoá chỉ qua service key ở CI,
-- key đó bỏ qua RLS. Mức lộ data = trang Vercel public hiện tại; muốn khép lại thì bật Supabase
-- Auth và đổi `to anon, authenticated` thành `to authenticated` + policy theo email @ghn.vn.
alter table public.orders enable row level security;

drop policy if exists "orders: doc cong khai" on public.orders;
create policy "orders: doc cong khai"
  on public.orders for select
  to anon, authenticated
  using (true);

grant select on public.orders     to anon, authenticated;
grant select on public.order_days to anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- Tăng tốc đọc — thêm 2026-09-10 sau khi đo trên project thật: PostgREST kẹp max_rows = 1000 nên
-- một ngày 35k dòng thành 35 trang tuần tự × ~450 ms = 14,5 s. Hai hàm dưới đưa về một request.
-- Đã chạy schema bản cũ rồi thì chạy lại CẢ FILE này là đủ (create or replace, idempotent).
-- Chưa chạy thì src/supa.js tự rơi về tải trang song song (~1,5 s) — không vỡ, chỉ chậm hơn.
--
-- day_csv(d): ghép cả ngày thành MỘT chuỗi CSV ngay trong Postgres. App gọi
--   GET /rest/v1/rpc/day_csv?d=2026-09-09 → PostgREST trả scalar text dưới dạng một JSON string
--   (không có media type text/plain cho hàm trả text — PostgREST báo 406 PGRST107), client
--   JSON.parse là ra CSV; không bị max_rows vì là scalar. Mọi field text đều bọc nháy kép
--   (parseCSV trong detect.js đọc được), NULL thành ô trống, ngày và số để trần.
--   Không ORDER BY: app group theo tài xế, không phụ thuộc thứ tự dòng.
-- order_dates(): danh sách ngày bằng "loose index scan" — CTE đệ quy nhảy tới ngày kế tiếp qua
--   index load_date, ~số-ngày lần dò index thay vì group by cả bảng như view order_days.
--   View order_days vẫn giữ cho push-supabase.mjs / CI (cần số dòng, chậm 1–3 s không sao).
-- set search_path = '' + tên bảng đầy đủ: theo khuyến nghị của Supabase Security Advisor.
-- ---------------------------------------------------------------------------------------------

create or replace function public.csv_q(t text)
returns text
language sql immutable parallel safe
set search_path = ''
as $$ select '"' || replace(coalesce(t, ''), '"', '""') || '"' $$;

create or replace function public.day_csv(d date)
returns text
language sql stable
set search_path = ''
as $$
  select 'load_date,warehouse_id,warehouse_name,employee_id,driver_name,order_code,contact_address,contact_latlng,is_epic,is_assigned'
      || E'\n'
      || coalesce(string_agg(
             o.load_date::text
             || ',' || public.csv_q(o.warehouse_id)
             || ',' || public.csv_q(o.warehouse_name)
             || ',' || public.csv_q(o.employee_id)
             || ',' || public.csv_q(o.driver_name)
             || ',' || public.csv_q(o.order_code)
             || ',' || public.csv_q(o.contact_address)
             || ',' || public.csv_q(o.contact_latlng)
             || ',' || o.is_epic::text
             || ',' || o.is_assigned::text,
             E'\n'), '')
      || E'\n'
  from public.orders o
  where o.load_date = d;
$$;

create or replace function public.order_dates()
returns setof date
language sql stable
set search_path = ''
as $$
  with recursive d(load_date) as (
    select min(o.load_date) from public.orders o
    union all
    select (select min(o.load_date) from public.orders o where o.load_date > d.load_date)
    from d
    where d.load_date is not null
  )
  select d.load_date from d where d.load_date is not null order by 1;
$$;

grant execute on function public.csv_q(text)   to anon, authenticated;
grant execute on function public.day_csv(date) to anon, authenticated;
grant execute on function public.order_dates() to anon, authenticated;
