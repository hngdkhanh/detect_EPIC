/* supa.js — đọc data đơn gán từ Supabase (PostgREST), thay cho public/data/<date>.csv + manifest.json.
 *
 * Zero dependency: gọi thẳng REST của PostgREST bằng fetch, không dùng supabase-js. Trả CSV
 * đúng 10 cột nên App vẫn parse bằng loadOrders() trong detect.js — thuật toán, scene, map không đổi.
 *
 * Cấu hình qua Vite env (nhúng lúc build): VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY.
 * Thiếu một trong hai → hasSupabase() = false → App rơi về manifest.json / test.csv như cũ.
 *
 * Hai đường tải một ngày, thử theo thứ tự (đo 2026-09-10 trên ngày 35k dòng, từ VN):
 *   1. RPC day_csv(d) — Postgres ghép cả ngày thành MỘT chuỗi CSV, một request (về dạng JSON
 *      string). Hàm trả scalar text nên không bị max_rows kẹp. Cần đã chạy phần "Tăng tốc đọc"
 *      trong supabase/schema.sql.
 *   2. Bảng orders theo trang (Range) — server kẹp max_rows (Supabase mặc định 1000 → 35 trang).
 *      Tuần tự mất 14,5 s; tải trang 2..n SONG SONG sau khi trang 1 báo tổng còn ~5 s (nút thắt là
 *      server sort 35k dòng cho MỖI trang, tăng số kết nối không giúp — đo 8/16/35 đều ~5,5 s).
 *      Đây là đường lùi khi schema chưa có hàm (404) — app không bao giờ vỡ vì thiếu SQL.
 * Danh sách ngày cũng vậy: RPC order_dates() (dò index, mili-giây) → view order_days (group by cả
 * bảng, ~1 s ở 260k dòng và tăng theo số dòng).
 */

const URL_ = (import.meta.env.VITE_SUPABASE_URL || "").replace(/\/+$/, "");
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || "";

/* Khớp thứ tự HEADER trong scripts/append-data.mjs; findCol của loadOrders nhận employee_id + warehouse_name. */
export const COLUMNS = [
  "load_date", "warehouse_id", "warehouse_name", "employee_id", "driver_name",
  "order_code", "contact_address", "contact_latlng", "is_epic", "is_assigned",
];
const PAGE = 10000;   // xin bao nhiêu dòng/trang; server tự kẹp về max_rows, ta đọc Content-Range để biết con số thật
const PARALLEL = 8;   // số trang tải cùng lúc ở đường lùi (trình duyệt HTTP/1.1 cũng chỉ mở ~6 kết nối/host)
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const hasSupabase = () => Boolean(URL_ && KEY);

const headers = extra => ({ apikey: KEY, Authorization: `Bearer ${KEY}`, ...extra });

/* fetch + ném Error có .status khi không ok, để caller phân biệt 404 (thiếu hàm) với lỗi thật */
async function rest(path, init) {
  const r = await fetch(`${URL_}/rest/v1/${path}`, init);
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try { const j = await r.json(); if (j && j.message) msg += ` — ${j.message}`; } catch { /* không phải JSON */ }
    const err = new Error(msg);
    err.status = r.status;
    throw err;
  }
  return r;
}

/* Nhớ "hàm chưa có" trong phiên để không tốn thêm một request 404 cho mỗi ngày */
const rpcMissing = { order_dates: false, day_csv: false };

/** Các ngày đang có data, tăng dần: [{date, n?, fetchedAt?}] — App chỉ dùng .date */
export async function fetchDays() {
  if (!rpcMissing.order_dates) {
    try {
      const r = await rest("rpc/order_dates", { headers: headers() });
      const dates = await r.json();
      return dates.filter(d => DATE_RE.test(d)).map(d => ({ date: d }));
    } catch (e) {
      if (e.status !== 404) throw e;
      rpcMissing.order_dates = true; // schema cũ → view
    }
  }
  const r = await rest("order_days?select=load_date,n,fetched_at&order=load_date.asc", { headers: headers() });
  const rows = await r.json();
  return rows.map(x => ({ date: x.load_date, n: x.n, fetchedAt: x.fetched_at }));
}

/** CSV (kèm header) của một ngày — đúng format public/data/<date>.csv. */
export async function fetchDayCsv(date) {
  if (!DATE_RE.test(date)) throw new Error("ngày không hợp lệ");
  const viaRpc = await rpcDayCsv(date);
  if (viaRpc !== null) return viaRpc;
  return pagedDayCsv(date);
}

/* Đường 1: một request. PostgREST trả hàm scalar text dưới dạng MỘT JSON string (không có media
   type text/plain cho kiểu này — đo 2026-09-10: 406 PGRST107), nên JSON.parse là ra CSV; 5 MB
   parse mất ~20 ms, không đáng kể. Trả null khi hàm chưa tồn tại (404) để caller rơi về đường 2. */
async function rpcDayCsv(date) {
  if (rpcMissing.day_csv) return null;
  let r;
  try {
    r = await rest(`rpc/day_csv?d=${date}`, { headers: headers() });
  } catch (e) {
    if (e.status === 404) { rpcMissing.day_csv = true; return null; }
    throw e;
  }
  const csv = await r.json();
  if (typeof csv !== "string") throw new Error("day_csv trả về không phải chuỗi");
  return csv.endsWith("\n") ? csv : csv + "\n";
}

/* Content-Range dạng "0-999/24000", hoặc dấu sao + "/0" khi rỗng.
   Trả {end, total}; total = null khi server không đếm. */
function parseRange(h) {
  const m = /^(\*|(\d+)-(\d+))\/(\d+|\*)$/.exec(h || "");
  if (!m) return { end: -1, total: null };
  return { end: m[3] === undefined ? -1 : Number(m[3]), total: m[4] === "*" ? null : Number(m[4]) };
}

/* Đường 2: bảng orders theo trang. Trang 1 kèm count=exact cho biết tổng và max_rows thật của
   server (= end + 1); các trang còn lại tải song song PARALLEL cái một, ghép lại đúng thứ tự.
   Order phải ổn định (employee_id, order_code) để phân trang không lặp/sót dòng.
   Biết trước một lệch nhỏ: text/csv của PostgREST nhân đôi dấu backslash trong dữ liệu ("\t" →
   "\\t"; 139/29630 dòng địa chỉ ở file thử 2026-09-07), day_csv() không bị. Chỉ cosmetic trong
   địa chỉ, và đường này chỉ dùng khi schema chưa có hàm — không sửa, coi là lý do để chạy SQL. */
async function pagedDayCsv(date) {
  const q = `orders?select=${COLUMNS.join(",")}&load_date=eq.${date}&order=employee_id.asc,order_code.asc`;
  const page = async (from, to, count) => {
    const r = await rest(q, {
      headers: headers({
        Accept: "text/csv", "Range-Unit": "items", Range: `${from}-${to}`,
        ...(count ? { Prefer: "count=exact" } : {}),
      }),
    });
    const lines = (await r.text()).split(/\r?\n/).filter(Boolean);
    return { lines, range: parseRange(r.headers.get("content-range")) };
  };

  const first = await page(0, PAGE - 1, true);
  if (first.lines.length < 2 || first.range.end < 0) return COLUMNS.join(",") + "\n";
  const header = first.lines[0];
  const rows = [first.lines.slice(1)];
  const pageSize = first.range.end + 1;
  const total = first.range.total;

  if (total === null) {
    // server không đếm (không nên xảy ra với count=exact) → đi tuần tự cho tới trang ngắn
    let from = pageSize;
    for (;;) {
      const p = await page(from, from + pageSize - 1, false);
      const body = p.lines.slice(1);
      if (!body.length) break;
      rows.push(body);
      if (body.length < pageSize || p.range.end < 0) break;
      from = p.range.end + 1;
    }
  } else {
    const starts = [];
    for (let from = pageSize; from < total; from += pageSize) starts.push(from);
    const parts = new Array(starts.length);
    let next = 0;
    const worker = async () => {
      while (next < starts.length) {
        const i = next++;
        parts[i] = (await page(starts[i], starts[i] + pageSize - 1, false)).lines.slice(1);
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, starts.length) }, worker));
    rows.push(...parts);
  }
  return [header, ...rows.flat()].join("\n") + "\n";
}
