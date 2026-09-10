/* supa.js — đọc data đơn gán từ Supabase (PostgREST), thay cho public/data/<date>.csv + manifest.json.
 *
 * Zero dependency: gọi thẳng REST của PostgREST bằng fetch, không dùng supabase-js. Trả text/csv
 * đúng 10 cột nên App vẫn parse bằng loadOrders() trong detect.js — thuật toán, scene, map không đổi.
 *
 * Cấu hình qua Vite env (nhúng lúc build): VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY.
 * Thiếu một trong hai → hasSupabase() = false → App rơi về manifest.json / test.csv như cũ.
 *
 * PostgREST giới hạn mỗi response `max_rows` dòng (Supabase mặc định 1000), một ngày có ~15–40k
 * dòng nên tải theo trang bằng header Range và đọc Content-Range để biết tổng — không phụ thuộc
 * người dùng có chỉnh max_rows trong dashboard hay không. Trang phải có order ổn định.
 */

const URL_ = (import.meta.env.VITE_SUPABASE_URL || "").replace(/\/+$/, "");
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || "";

/* Khớp thứ tự HEADER trong scripts/append-data.mjs; findCol của loadOrders nhận employee_id + warehouse_name. */
export const COLUMNS = [
  "load_date", "warehouse_id", "warehouse_name", "employee_id", "driver_name",
  "order_code", "contact_address", "contact_latlng", "is_epic", "is_assigned",
];
const PAGE = 10000;

export const hasSupabase = () => Boolean(URL_ && KEY);

function headers(extra) {
  return { apikey: KEY, Authorization: `Bearer ${KEY}`, ...extra };
}

async function rest(path, init) {
  const r = await fetch(`${URL_}/rest/v1/${path}`, init);
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try { const j = await r.json(); if (j && j.message) msg += ` — ${j.message}`; } catch { /* không phải JSON */ }
    throw new Error(msg);
  }
  return r;
}

/** Các ngày đang có data, tăng dần: [{date, n, fetchedAt}] */
export async function fetchDays() {
  const r = await rest("order_days?select=load_date,n,fetched_at&order=load_date.asc", { headers: headers() });
  const rows = await r.json();
  return rows.map(x => ({ date: x.load_date, n: x.n, fetchedAt: x.fetched_at }));
}

/* Content-Range dạng "0-999/24000", hoặc dấu sao + "/0" khi rỗng.
   Trả {end, total}; total = null khi server không đếm. */
function parseRange(h) {
  const m = /^(\*|(\d+)-(\d+))\/(\d+|\*)$/.exec(h || "");
  if (!m) return { end: -1, total: null };
  return { end: m[3] === undefined ? -1 : Number(m[3]), total: m[4] === "*" ? null : Number(m[4]) };
}

/** CSV (kèm header) của một ngày — đúng format public/data/<date>.csv. */
export async function fetchDayCsv(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("ngày không hợp lệ");
  const q = `orders?select=${COLUMNS.join(",")}&load_date=eq.${date}&order=employee_id.asc,order_code.asc`;
  const out = [];
  let from = 0, total = null, header = null;
  for (;;) {
    const r = await rest(q, {
      headers: headers({
        Accept: "text/csv",
        "Range-Unit": "items",
        Range: `${from}-${from + PAGE - 1}`,
        // chỉ trang đầu cần đếm tổng — count=exact là một COUNT(*) thêm mỗi request
        ...(total === null ? { Prefer: "count=exact" } : {}),
      }),
    });
    const txt = await r.text();
    const { end, total: t } = parseRange(r.headers.get("content-range"));
    if (t !== null) total = t;
    const lines = txt.split(/\r?\n/).filter(Boolean);
    if (!lines.length) break;
    if (header === null) { header = lines[0]; out.push(header); }
    out.push(...lines.slice(1));
    // hết trang khi: server không báo end (rỗng), hoặc đã tới tổng, hoặc trang trả ít hơn yêu cầu mà không biết tổng
    if (end < 0) break;
    from = end + 1;
    if (total !== null ? from >= total : lines.length - 1 < PAGE) break;
  }
  if (header === null) return COLUMNS.join(",") + "\n";
  return out.join("\n") + "\n";
}
