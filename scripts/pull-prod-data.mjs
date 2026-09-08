#!/usr/bin/env node
/*
 * pull-prod-data.mjs — kéo cửa sổ data đang chạy trên production về public/data/.
 *
 * Vì sao cần: repo KHÔNG lưu data, mỗi lần CI chạy là một máy trắng. Muốn mỗi sáng chỉ hỏi
 * BigQuery đúng ngày hôm qua thì 13 ngày còn lại phải lấy từ đâu đó — và nơi duy nhất đang giữ
 * chúng là bản deploy đang chạy. Script này tải manifest.json + từng file ngày từ đó, kiểm tra
 * header, rồi ghi vào public/data/. Sau đó fetch-daily.mjs thêm ngày hôm qua, append-data.mjs
 * bỏ ngày cũ nhất, và workflow deploy lại. Cửa sổ 14 ngày cứ thế lăn từng ngày.
 *
 * Tất cả-hoặc-không: một file hỏng là thoát mã 1 và KHÔNG ghi gì, để workflow rơi về lấy trọn
 * 14 ngày từ BigQuery thay vì deploy một cửa sổ có lỗ.
 *
 * Cách dùng:
 *   node scripts/pull-prod-data.mjs                 # kéo về public/data/ (cũng tiện cho dev local)
 *   PROD_URL=https://... node scripts/pull-prod-data.mjs
 *
 * Env: PROD_URL (mặc định https://epic-order-map.vercel.app),
 *      VERCEL_BYPASS — nếu sau này bật Deployment Protection, đặt secret "Protection Bypass for
 *      Automation" vào đây; script gửi header x-vercel-protection-bypass.
 *
 * Zero dependency, ESM thuần — giống các script khác trong thư mục này.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(ROOT, "public", "data");
const PROD_URL = (process.env.PROD_URL || "https://epic-order-map.vercel.app").replace(/\/+$/, "");
const BYPASS = process.env.VERCEL_BYPASS || "";
const TIMEOUT_MS = 60_000;

/* Header bắt buộc — khớp scripts/append-data.mjs, scripts/fetch-daily.mjs, findCol trong src/detect.js */
const HEADER = [
  "load_date", "warehouse_id", "warehouse_name", "employee_id", "driver_name",
  "order_code", "contact_address", "contact_latlng", "is_epic", "is_assigned",
];
const HEADER_LINE = HEADER.join(",");

function fail(msg) {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
}

async function get(url, as = "text") {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const headers = { "Cache-Control": "no-cache" };
    if (BYPASS) headers["x-vercel-protection-bypass"] = BYPASS;
    const res = await fetch(url, { headers, signal: ctl.signal, redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // Deployment Protection trả trang đăng nhập HTML với mã 200 — bắt sớm cho khỏi khó hiểu.
    const ct = res.headers.get("content-type") || "";
    if (/text\/html/i.test(ct)) throw new Error("nhận về HTML thay vì dữ liệu (Deployment Protection? cần VERCEL_BYPASS)");
    return as === "json" ? res.json() : res.text();
  } catch (e) {
    throw new Error(`${url}: ${e.name === "AbortError" ? `quá ${TIMEOUT_MS / 1000}s` : e.message}`);
  } finally {
    clearTimeout(timer);
  }
}

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);

console.log(`🌐 Production: ${PROD_URL}${BYPASS ? " (có bypass header)" : ""}`);

let manifest;
try { manifest = await get(`${PROD_URL}/data/manifest.json`, "json"); }
catch (e) { fail(`Không lấy được manifest: ${e.message}`); }

const dates = Array.isArray(manifest?.dates) ? manifest.dates.filter(isDate) : [];
if (!dates.length) fail("manifest.json trên production không có ngày nào hợp lệ.");
console.log(`📋 Manifest : ${dates.length} ngày, ${dates[0]} → ${dates[dates.length - 1]}, sinh lúc ${manifest.generated_at || "?"}`);

/* tải hết vào bộ nhớ, kiểm tra hết, rồi mới ghi — không để lại cửa sổ nửa vời trên đĩa */
const files = [];
for (const d of dates) {
  let text;
  try { text = await get(`${PROD_URL}/data/${d}.csv`); }
  catch (e) { fail(`Không tải được ${d}.csv: ${e.message}`); }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const nl = text.indexOf("\n");
  const first = (nl >= 0 ? text.slice(0, nl) : text).replace(/\r$/, "").trim();
  if (first !== HEADER_LINE) fail(`${d}.csv có header lạ:\n   ${first}\n   Mong đợi: ${HEADER_LINE}`);
  const rows = text.split("\n").filter((l) => l.trim()).length - 1;
  if (rows < 1) fail(`${d}.csv rỗng.`);
  files.push({ d, text, rows, bytes: Buffer.byteLength(text) });
  console.log(`   ⬇ ${d}: ${rows} dòng, ${(Buffer.byteLength(text) / 1048576).toFixed(1)} MB`);
}

fs.mkdirSync(DATA_DIR, { recursive: true });
for (const f of files) {
  const p = path.join(DATA_DIR, `${f.d}.csv`);
  fs.writeFileSync(p + ".tmp", f.text, "utf8");
  fs.renameSync(p + ".tmp", p);
}
/* manifest tạm cho đúng trạng thái; append-data.mjs sẽ ghi lại bản chuẩn ngay sau đó */
const mp = path.join(DATA_DIR, "manifest.json");
fs.writeFileSync(mp + ".tmp", JSON.stringify(manifest, null, 2) + "\n", "utf8");
fs.renameSync(mp + ".tmp", mp);

const total = files.reduce((s, f) => s + f.rows, 0);
const mb = files.reduce((s, f) => s + f.bytes, 0) / 1048576;
console.log(`\n✅ Đã kéo ${files.length} ngày — ${total} dòng — ${mb.toFixed(1)} MB → ${path.relative(ROOT, DATA_DIR)}/\n`);
