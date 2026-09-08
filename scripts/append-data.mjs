#!/usr/bin/env node
/*
 * append-data.mjs — quản lý dữ liệu của app, tách theo ngày
 *
 * Layout:
 *   public/data/<YYYY-MM-DD>.csv   một file cho mỗi load_date
 *   public/data/manifest.json      danh sách ngày có sẵn, app đọc file này trước
 *   data_archive/                  chỉ dùng khi xoá bị từ chối (EPERM); bình thường ngày quá hạn bị XOÁ
 *
 * Cách dùng:
 *   node scripts/append-data.mjs                  # tự tìm CSV mới nhất trong Downloads
 *   node scripts/append-data.mjs <duong-dan.csv>  # chỉ định file
 *   node scripts/append-data.mjs --migrate        # tách public/test.csv sẵn có ra public/data/
 *   node scripts/append-data.mjs --trim-only      # chỉ cắt ngày cũ + ghi lại manifest
 *   node scripts/append-data.mjs --dry-run
 *   node scripts/append-data.mjs --keep-days 7 | --keep-all
 *   node scripts/append-data.mjs --replace-date   # ghi đè cả ngày thay vì merge
 *   node scripts/append-data.mjs --downloads <thu-muc>
 *
 * Ghi chú: chỉ giữ 14 ngày gần nhất, ngày quá hạn bị xoá thẳng. Trước đây script DỜI sang
 * data_archive/ vì sandbox của scheduled task Claude không unlink được; task đó đã bỏ (09/2026),
 * nay data_archive/ chỉ còn là đường lùi khi unlink trả EPERM.
 *
 * Zero dependency, ESM thuần — giống detect.js / scene.js.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(ROOT, "public", "data");
const MANIFEST = path.join(DATA_DIR, "manifest.json");
const ARCHIVE = path.join(ROOT, "data_archive");
const LEGACY_CSV = path.join(ROOT, "public", "test.csv");
const DEFAULT_KEEP_DAYS = 14;
const SIZE_WARN_MB = 8; // mỗi ngày; app chỉ tải 1 ngày nên ngưỡng thấp hơn nhiều

/* Header bắt buộc — đúng thứ tự, khớp findCol trong src/detect.js */
const HEADER = [
  "load_date", "warehouse_id", "warehouse_name", "employee_id", "driver_name",
  "order_code", "contact_address", "contact_latlng", "is_epic", "is_assigned",
];

/* ---------- CSV ---------- */

function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // BOM
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ",") { row.push(field); field = ""; continue; }
    if (c === "\r") continue;
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

const needsQuote = (s) => /[",\r\n]/.test(s);
const serializeField = (s) => (needsQuote(s) ? '"' + s.replace(/"/g, '""') + '"' : s);
const serializeRow = (r) => r.map(serializeField).join(",");
const toCsv = (rows) => [HEADER, ...rows].map(serializeRow).join("\n") + "\n";

/* ---------- helpers ---------- */

const key = (r) => `${r[3]}|${r[5]}`; // employee_id | order_code (trong cùng 1 file ngày)
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);

function fail(msg) {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
}

const fmtBytes = (n) =>
  n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${(n / 1024).toFixed(0)} KB`;

function checkHeader(name, h) {
  if (h.length !== HEADER.length || h.some((c, i) => c !== HEADER[i])) {
    fail(
      `Header của ${name} không khớp hợp đồng CSV.\n` +
      `   Mong đợi: ${HEADER.join(",")}\n` +
      `   Nhận được: ${h.join(",")}\n` +
      `   Nếu format export đổi thật, sửa HEADER trong script này VÀ alias list trong src/detect.js cùng lúc.`
    );
  }
}

function readCsvFile(p, label) {
  const rows = parseCsv(fs.readFileSync(p, "utf8"));
  if (!rows.length) fail(`${label} rỗng: ${p}`);
  checkHeader(label, rows[0].map((h) => h.trim()));
  const data = rows.slice(1);
  const bad = data.filter((r) => r.length !== HEADER.length);
  if (bad.length) fail(`${bad.length} dòng ở ${label} sai số cột (${bad[0].length} thay vì ${HEADER.length}).`);
  return data;
}

/** Các ngày hiện có trong public/data/ */
function existingDays() {
  if (!fs.existsSync(DATA_DIR)) return [];
  return fs.readdirSync(DATA_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.csv$/.test(f))
    .map((f) => f.slice(0, 10))
    .sort();
}

const dayPath = (d) => path.join(DATA_DIR, `${d}.csv`);

function downloadCandidates(explicit) {
  if (explicit) return [explicit];
  return [
    path.join(os.homedir(), "Downloads"),
    path.join(os.homedir(), "mnt", "Downloads"),
    path.join(ROOT, "..", "Downloads"),
  ];
}

function findLatestDownload(explicit) {
  const dirs = downloadCandidates(explicit);
  const cands = [], tried = [];
  for (const dir of dirs) {
    tried.push(dir);
    let entries;
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const f of entries) {
      if (!/\.csv$/i.test(f)) continue;
      if (!/^(script_job_|bq-results-|bquxjob)/i.test(f)) continue;
      const p = path.join(dir, f);
      try { cands.push({ p, mtime: fs.statSync(p).mtimeMs }); } catch { /* bỏ qua */ }
    }
  }
  if (!cands.length) {
    fail(
      `Không thấy file CSV nào của BigQuery (tên bắt đầu bằng script_job_ / bq-results- / bquxjob).\n` +
      `   Đã tìm trong:\n${tried.map((d) => "     - " + d).join("\n")}\n` +
      `   Truyền đường dẫn file trực tiếp, hoặc dùng --downloads <thu-muc>.`
    );
  }
  cands.sort((a, b) => b.mtime - a.mtime);
  const best = cands[0];
  const ageH = (Date.now() - best.mtime) / 36e5;
  if (ageH > 24) console.warn(`⚠️  File mới nhất đã ${ageH.toFixed(1)} giờ tuổi — kiểm tra lại xem có đúng file vừa tải không.`);
  return best.p;
}

/* ---------- tham số ---------- */

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valueOf = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };

const dryRun = has("--dry-run");
const trimOnly = has("--trim-only");
const migrate = has("--migrate");
const replaceDate = has("--replace-date");
const keepAll = has("--keep-all");
const downloadsDir = valueOf("--downloads");

let keepDays = DEFAULT_KEEP_DAYS;
if (keepAll) keepDays = Infinity;
else if (valueOf("--keep-days") !== null) {
  keepDays = Number(valueOf("--keep-days"));
  if (!Number.isInteger(keepDays) || keepDays < 1) fail("--keep-days phải là số nguyên >= 1.");
}

const flagsWithValue = new Set(["--downloads", "--keep-days"]);
const positional = argv.filter((a, i) => {
  if (a.startsWith("--")) return false;
  const prev = argv[i - 1];
  return !(prev && flagsWithValue.has(prev));
});

/* ---------- gom dữ liệu mới ---------- */

const incoming = new Map(); // date -> rows[]
function addRows(rows, label) {
  for (const r of rows) {
    if (!isDate(r[0])) fail(`load_date không hợp lệ ở ${label}: "${r[0]}" (cần YYYY-MM-DD).`);
    if (!incoming.has(r[0])) incoming.set(r[0], []);
    incoming.get(r[0]).push(r);
  }
}

if (migrate) {
  if (!fs.existsSync(LEGACY_CSV)) fail(`--migrate cần ${LEGACY_CSV} nhưng không thấy file.`);
  console.log(`🔀 Migrate : ${LEGACY_CSV}`);
  addRows(readCsvFile(LEGACY_CSV, "test.csv"), "test.csv");
} else if (!trimOnly) {
  const srcPath = positional[0] ? path.resolve(positional[0]) : findLatestDownload(downloadsDir);
  if (!fs.existsSync(srcPath)) fail(`Không thấy file: ${srcPath}`);
  console.log(`📥 Nguồn   : ${srcPath}`);
  addRows(readCsvFile(srcPath, "nguồn"), "nguồn");
}

/* ---------- merge từng ngày ---------- */

fs.mkdirSync(DATA_DIR, { recursive: true });

const before = existingDays();
console.log(`📂 Đích    : ${DATA_DIR}`);
console.log(`   Đang có : ${before.length ? before.join(", ") : "(trống)"}`);

const writes = []; // {date, rows, added, dup, existed}
for (const [date, rows] of [...incoming].sort(([a], [b]) => a.localeCompare(b))) {
  const p = dayPath(date);
  const existed = fs.existsSync(p);
  let base = existed && !replaceDate ? readCsvFile(p, `data/${date}.csv`) : [];
  const seen = new Set(base.map(key));
  let added = 0, dup = 0;
  for (const r of rows) {
    const k = key(r);
    if (seen.has(k)) { dup++; continue; }
    seen.add(k); base.push(r); added++;
  }
  writes.push({ date, rows: base, added, dup, existed });
}

/* ---------- cắt ngày cũ ---------- */

const allDates = [...new Set([...before, ...writes.map((w) => w.date)])].sort();
const keepSet = new Set(keepDays === Infinity ? allDates : allDates.slice(-keepDays));
const expired = allDates.filter((d) => !keepSet.has(d));

/* ---------- báo cáo ---------- */

for (const w of writes) {
  console.log(`   ${w.existed ? "↻" : "＋"} ${w.date}: ${w.rows.length} dòng` +
    (w.existed ? ` (thêm ${w.added}, trùng ${w.dup}${replaceDate ? ", ghi đè" : ""})` : ""));
}
console.log(`   🗑️  Quá hạn : ${expired.length ? expired.join(", ") : "(không có)"}` +
  ` — giữ ${keepDays === Infinity ? "tất cả" : keepDays + " ngày gần nhất"}`);

/* manifest phải khớp thực tế trên đĩa: người dùng có thể đã thêm/bớt file ngày bằng tay,
   hoặc đổi --keep-days. Chỉ thoát sớm khi mọi thứ đã đúng — nếu không sẽ để lại manifest
   trỏ tới ngày không còn tồn tại và app fetch 404. */
let currentManifest = null;
try { currentManifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8")); } catch { /* thiếu hoặc hỏng */ }
const expectDates = allDates.filter((d) => keepSet.has(d));
const wantKeepDays = keepDays === Infinity ? null : keepDays;
const manifestStale =
  !currentManifest ||
  JSON.stringify(currentManifest.dates) !== JSON.stringify(expectDates) ||
  (currentManifest.keep_days ?? null) !== wantKeepDays;

if (!writes.length && !expired.length && !manifestStale) {
  console.log("\n✅ Không có gì thay đổi.\n");
  process.exit(0);
}
if (!writes.length && !expired.length && manifestStale) {
  console.log("   ♻️  manifest.json lệch với file thực tế — ghi lại.");
}

if (dryRun) {
  console.log(`\n🔍 --dry-run: sẽ ghi ${writes.length} file ngày, xoá ${expired.length} file quá hạn, cập nhật manifest. Không ghi gì.\n`);
  process.exit(0);
}

/* ---------- ghi ---------- */

for (const w of writes) {
  const text = toCsv(w.rows);
  const p = dayPath(w.date);
  fs.writeFileSync(p + ".tmp", text, "utf8");
  fs.renameSync(p + ".tmp", p);
  const mb = Buffer.byteLength(text) / (1 << 20);
  if (mb > SIZE_WARN_MB) console.warn(`⚠️  ${w.date}.csv nặng ${mb.toFixed(1)} MB — app tải nguyên ngày này mỗi lần chọn.`);
}

/* xoá ngày quá hạn — chỉ giữ 14 ngày gần nhất, ngày cũ hơn không có giá trị gì (user chốt
   2026-09-08 để nhẹ dung lượng). Riêng khi unlink bị từ chối (EPERM: thư mục mount của sandbox
   cũ) thì dời sang data_archive/ để không làm hỏng lần chạy. */
const deleted = [], archived = [];
for (const d of expired) {
  const from = dayPath(d);
  if (!fs.existsSync(from)) continue;
  try {
    fs.unlinkSync(from);
    deleted.push(d);
  } catch (e) {
    fs.mkdirSync(ARCHIVE, { recursive: true });
    let to = path.join(ARCHIVE, `${d}.csv`);
    let n = 1;
    while (fs.existsSync(to)) to = path.join(ARCHIVE, `${d}.${n++}.csv`);
    fs.renameSync(from, to);
    archived.push(d);
    console.warn(`⚠️  Không xoá được ${d}.csv (${e.code || e.message}) — đã dời sang data_archive/.`);
  }
}

/* manifest */
const finalDays = existingDays().filter((d) => keepSet.has(d));
const manifest = {
  generated_at: new Date().toISOString(),
  keep_days: keepDays === Infinity ? null : keepDays,
  columns: HEADER,
  days: finalDays.map((d) => {
    const p = dayPath(d);
    const rows = parseCsv(fs.readFileSync(p, "utf8")).length - 1;
    return { date: d, rows, bytes: fs.statSync(p).size };
  }),
};
manifest.dates = manifest.days.map((x) => x.date);
fs.writeFileSync(MANIFEST + ".tmp", JSON.stringify(manifest, null, 2) + "\n", "utf8");
fs.renameSync(MANIFEST + ".tmp", MANIFEST);

const totalBytes = manifest.days.reduce((s, x) => s + x.bytes, 0);
const totalRows = manifest.days.reduce((s, x) => s + x.rows, 0);
console.log(`\n✅ ${manifest.days.length} ngày — ${totalRows} dòng — ${fmtBytes(totalBytes)} tổng`);
console.log(`   ${manifest.days.map((x) => `${x.date} (${x.rows})`).join(", ")}`);
console.log(`   Nặng nhất: ${fmtBytes(Math.max(...manifest.days.map((x) => x.bytes)))} — đây mới là thứ trình duyệt phải tải.`);
if (deleted.length) console.log(`   Đã xoá ${deleted.length} ngày quá hạn: ${deleted.join(", ")}`);
if (archived.length) console.log(`   Đã dời ${archived.length} ngày quá hạn sang data_archive/ vì không xoá được — dọn tay.`);
console.log("");
