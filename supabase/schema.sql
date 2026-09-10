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

create table if not exists public.orders (
  load_date       date        not null,
  warehouse_id    text        not null default '',
  warehouse_name  text        not null default '',
  employee_id     text        not null,
  driver_name     text        not null default '',
  order_code      text        not null,
  contact_address text        not null default '',
  contact_latlng  text        not null default '',
  is_epic         smallint    not null default 0,
  is_assigned     smallint    not null default 0,
  fetched_at      timestamptz not null default now(),
  primary key (load_date, employee_id, order_code)
);

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
