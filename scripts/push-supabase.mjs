#!/usr/bin/env node
/*
 * push-supabase.mjs — ghi CSV đơn gán (10 cột) vào bảng public.orders trên Supabase.
 *
 * Thay cho append-data.mjs khi data nằm ở Supabase: fetch-daily.mjs tự gọi script này khi thấy
 * SUPABASE_URL + SUPABASE_SERVICE_KEY. Cũng dùng tay để nạp lần đầu (nhiều file / cả thư mục).
 *
 * Cách dùng:
 *   node scripts/push-supabase.mjs <a.csv> [<b.csv> ...]     # upsert (merge) từng ngày trong file
 *   node scripts/push-supabase.mjs --dir public/data          # mọi *.csv trong thư mục (nạp lần đầu)
 *   node scripts/push-supabase.mjs a.csv --replace-date       # xoá luôn dòng của ngày đó KHÔNG có trong file
 *   node scripts/push-supabase.mjs --trim-only                # chỉ cắt ngày quá hạn
 *   node scripts/push-supabase.mjs --dry-run                  # đọc + validate, không ghi
 *   node scripts/push-supabase.mjs --keep-days 90 | --keep-all
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_KEY (nhận cả SUPABASE_SERVICE_ROLE_KEY), SUPABASE_KEEP_DAYS.
 *
 * Cách ghi: upsert theo khoá (load_date, employee_id, order_code) qua PostgREST
 * (Prefer: resolution=merge-duplicates), lô 2000 dòng, mỗi dòng gắn fetched_at = mốc của lần chạy.
 * --replace-date: sau khi upsert xong, xoá dòng của ngày đó có fetched_at < mốc → đúng nghĩa
 * "ghi đè cả ngày" của append-data nhưng app đang mở không bao giờ thấy ngày rỗng.
 * Cắt ngày cũ: giữ KEEP_DAYS ngày gần nhất THEO NGÀY CÓ TRONG BẢNG (không theo lịch), giống append-data.
 *
 * Exit: 0 ok · 1 lỗi. Zero dependency (Node >= 18 có fetch), ESM thuần.
 */
import fs from "node:fs";
import path from "node:path";

const HEADER = [
  "load_date", "warehouse_id", "warehouse_name", "employee_id", "driver_name",
  "order_code", "contact_address", "contact_latlng", "is_epic", "is_assigned",
];
const BATCH = 2000;
const DEFAULT_KEEP_DAYS = Number(process.env.SUPABASE_KEEP_DAYS || 90);

function fail(msg, code = 1) { console.error(`\n❌ ${msg}\n`); process.exit(code); }

/* ---------- tham số ---------- */
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valueOf = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const dryRun = has("--dry-run"), replaceDate = has("--replace-date"), trimOnly = has("--trim-only");
let keepDays = has("--keep-all") ? Infinity : DEFAULT_KEEP_DAYS;
if (valueOf("--keep-days") !== null) {
  keepDays = Number(valueOf("--keep-days"));
  if (!Number.isInteger(keepDays) || keepDays < 1) fail("--keep-days phải là số nguyên >= 1.");
}
const flagsWithValue = new Set(["--dir", "--keep-days"]);
const files = argv.filter((a, i) => !a.startsWith("--") && !(argv[i - 1] && flagsWithValue.has(argv[i - 1])));
if (valueOf("--dir") !== null) {
  const dir = path.resolve(valueOf("--dir"));
  if (!fs.existsSync(dir)) fail(`Không thấy thư mục ${dir}`);
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".csv")).sort()) files.push(path.join(dir, f));
}
if (!files.length && !trimOnly) fail("Cần ít nhất một file CSV, --dir <thư mục>, hoặc --trim-only.");

/* ---------- Supabase ---------- */
const URL_ = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
if (!URL_ || !KEY) fail("Thiếu env SUPABASE_URL và/hoặc SUPABASE_SERVICE_KEY (xem .env.example).");
if (/^eyJ/.test(KEY)) {
  // JWT cũ: kiểm tra đúng role, vì dán nhầm anon key sẽ chết ở RLS với thông báo tối nghĩa
  try {
    const role = JSON.parse(Buffer.from(KEY.split(".")[1], "base64url").toString()).role;
    if (role !== "service_role") fail(`Key có role "${role}" — cần service_role (Project Settings → API), anon key không ghi được.`);
  } catch { /* không decode được thì để server nói */ }
}

async function rest(method, pathQ, { body, prefer, accept } = {}) {
  const r = await fetch(`${URL_}/rest/v1/${pathQ}`, {
    method,
    headers: {
      apikey: KEY, Authorization: `Bearer ${KEY}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(prefer ? { Prefer: prefer } : {}),
      Accept: accept || "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    let detail = "";
    try { detail = (await r.text()).slice(0, 400); } catch { /* bỏ */ }
    if (r.status === 404 && /relation|Could not find/.test(detail))
      fail(`Bảng chưa tồn tại (HTTP 404). Chạy supabase/schema.sql trong SQL Editor trước.\n   ${detail}`);
    if (r.status === 401 || r.status === 403) fail(`Supabase từ chối (HTTP ${r.status}) — kiểm tra SUPABASE_SERVICE_KEY.\n   ${detail}`);
    throw new Error(`${method} ${pathQ.split("?")[0]} → HTTP ${r.status} ${detail}`);
  }
  return r;
}

async function listDays() {
  const r = await rest("GET", "order_days?select=load_date,n,fetched_at&order=load_date.asc");
  return r.json();
}

/* ---------- CSV ---------- */
function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = []; let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; continue; }
    if (c === '"') { q = true; continue; }
    if (c === ",") { row.push(field); field = ""; continue; }
    if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((x) => x !== "")) rows.push(row);
      row = [];
      continue;
    }
    field += c;
  }
  if (field !== "" || row.length) { row.push(field); if (row.some((x) => x !== "")) rows.push(row); }
  return rows;
}
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);

/* ---------- đọc + gom theo ngày, dedupe trong bộ nhớ ----------
   Cùng một khoá xuất hiện 2 lần trong MỘT lệnh upsert làm Postgres báo "cannot affect row a second
   time" → dedupe trước; dòng sau thắng (append-data để dòng đầu thắng — khác biệt không đáng kể). */
const byDay = new Map(); // date -> Map(key -> row)
let dupRows = 0, skipRows = 0, totalRows = 0;
const BAD_ROW_LIMIT = 0.01; // >1% dòng thiếu khoá = format nguồn đổi, không phải rác lẻ
for (const f of files) {
  const p = path.resolve(f);
  if (!fs.existsSync(p)) fail(`Không thấy file ${p}`);
  const rows = parseCsv(fs.readFileSync(p, "utf8"));
  if (!rows.length) fail(`${p} rỗng.`);
  const header = rows[0].map((h) => h.trim().toLowerCase());
  if (header.length !== HEADER.length || header.some((h, i) => h !== HEADER[i]))
    fail(`Header ${path.basename(p)} không khớp.\n   Cần: ${HEADER.join(",")}\n   Có : ${header.join(",")}`);
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.length !== HEADER.length) fail(`${path.basename(p)} dòng ${i + 1}: ${r.length} cột (cần ${HEADER.length}).`);
    if (!isDate(r[0])) fail(`${path.basename(p)} dòng ${i + 1}: load_date "${r[0]}" không phải YYYY-MM-DD.`);
    totalRows++;
    /* Thiếu employee_id / order_code thì không có khoá chính → bỏ dòng, KHÔNG chết cả lần chạy
       (một dòng rác không được phép làm production mất data cả ngày). Nhưng nhiều dòng như vậy
       nghĩa là format nguồn đã đổi — lúc đó chết to là đúng, xem BAD_ROW_LIMIT. */
    if (!r[3] || !r[5]) {
      if (skipRows === 0) console.warn(`⚠️  ${path.basename(p)} dòng ${i + 1}: thiếu employee_id/order_code — bỏ dòng này.`);
      skipRows++;
      continue;
    }
    if (!byDay.has(r[0])) byDay.set(r[0], new Map());
    const m = byDay.get(r[0]); const k = `${r[3]}|${r[5]}`;
    if (m.has(k)) dupRows++;
    m.set(k, r);
  }
  console.log(`📥 ${path.relative(process.cwd(), p)}: ${rows.length - 1} dòng`);
}
if (skipRows) {
  const ratio = skipRows / Math.max(totalRows, 1);
  console.warn(`⚠️  Bỏ ${skipRows}/${totalRows} dòng thiếu employee_id/order_code (${(ratio * 100).toFixed(2)}%).`);
  if (ratio > BAD_ROW_LIMIT)
    fail(`Quá ${(BAD_ROW_LIMIT * 100).toFixed(0)}% dòng thiếu khoá — nghi format export đổi.\n` +
         `   Kiểm tra cột employee_id / order_code trong scripts/bq_daily.sql trước khi ghi.`);
}
const toRecord = (r, fetchedAt) => ({
  load_date: r[0], warehouse_id: r[1], warehouse_name: r[2], employee_id: r[3], driver_name: r[4],
  order_code: r[5], contact_address: r[6], contact_latlng: r[7],
  is_epic: r[8] === "1" ? 1 : 0, is_assigned: r[9] === "1" ? 1 : 0, fetched_at: fetchedAt,
});

/* ---------- main ---------- */
console.log(`☁️  Supabase : ${URL_}`);
const before = await listDays();
console.log(`   Đang có  : ${before.length ? before.map((d) => `${d.load_date} (${d.n})`).join(", ") : "(trống)"}`);
if (byDay.size) {
  const plan = [...byDay].sort(([a], [b]) => a.localeCompare(b)).map(([d, m]) => `${d} (${m.size})`).join(", ");
  console.log(`   Sẽ ghi   : ${plan}${dupRows ? ` — bỏ ${dupRows} dòng trùng khoá trong file` : ""}${replaceDate ? " — ghi đè cả ngày" : " — merge"}`);
}

const allDates = [...new Set([...before.map((d) => d.load_date), ...byDay.keys()])].sort();
const keep = new Set(keepDays === Infinity ? allDates : allDates.slice(-keepDays));
const expired = allDates.filter((d) => !keep.has(d));
console.log(`   🗑️  Quá hạn: ${expired.length ? expired.join(", ") : "(không có)"} — giữ ${keepDays === Infinity ? "tất cả" : keepDays + " ngày gần nhất"}`);

if (dryRun) { console.log("\n🔍 --dry-run: không ghi gì.\n"); process.exit(0); }

const fetchedAt = new Date().toISOString();
const t0 = Date.now();
for (const [date, m] of [...byDay].sort(([a], [b]) => a.localeCompare(b))) {
  if (!keep.has(date)) { console.log(`   ⏭  ${date}: quá hạn, không ghi`); continue; }
  const recs = [...m.values()].map((r) => toRecord(r, fetchedAt));
  for (let i = 0; i < recs.length; i += BATCH) {
    await rest("POST", "orders?on_conflict=load_date,employee_id,order_code",
      { body: recs.slice(i, i + BATCH), prefer: "resolution=merge-duplicates,return=minimal" });
  }
  let removed = "";
  if (replaceDate) {
    const r = await rest("DELETE", `orders?load_date=eq.${date}&fetched_at=lt.${encodeURIComponent(fetchedAt)}`,
      { prefer: "return=headers-only,count=exact" });
    const cr = r.headers.get("content-range") || "";
    const n = Number((cr.split("/")[1] || "0").replace("*", "0"));
    removed = n ? `, xoá ${n} dòng không còn trong file` : "";
  }
  console.log(`   ✅ ${date}: upsert ${recs.length} dòng${removed}`);
}

for (const d of expired) {
  await rest("DELETE", `orders?load_date=eq.${d}`, { prefer: "return=minimal" });
  console.log(`   🗑️  đã xoá ngày quá hạn ${d}`);
}

const after = await listDays();
const total = after.reduce((s, d) => s + d.n, 0);
console.log(`\n✅ ${after.length} ngày — ${total} dòng — ${((Date.now() - t0) / 1000).toFixed(0)}s`);
console.log(`   ${after.map((d) => `${d.load_date} (${d.n})`).join(", ")}\n`);
