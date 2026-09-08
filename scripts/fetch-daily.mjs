#!/usr/bin/env node
/*
 * fetch-daily.mjs — lấy data từ BigQuery rồi gọi append-data.mjs.
 * Thay cho bước "mở Chrome → BigQuery Console → tải CSV" trước đây.
 *
 * Hai cách nói chuyện với BigQuery, chọn tự động theo env:
 *   1. REST API (GitHub Actions / máy không có gcloud): đặt BQ_CREDENTIALS_JSON (nội dung JSON)
 *      hoặc GOOGLE_APPLICATION_CREDENTIALS (đường dẫn file). Nhận cả hai loại credential:
 *        - service_account  (key JSON của service account — nên dùng)
 *        - authorized_user  (refresh token cá nhân, chính là file gcloud tạo ở
 *          %APPDATA%\gcloud\legacy_credentials\<email>\adc.json — tạm dùng khi chưa có SA)
 *      Zero dependency: tự đổi credential → access token, tự gọi jobs.insert / getQueryResults.
 *   2. `bq` CLI (Google Cloud SDK trên máy user, đã `gcloud auth login`) khi không có env trên.
 *
 * Cách dùng:
 *   node scripts/fetch-daily.mjs                     # D-1 theo giờ VN, rồi append
 *   node scripts/fetch-daily.mjs --date 2026-09-05   # một ngày cụ thể
 *   node scripts/fetch-daily.mjs --date 2026-09-01 --to 2026-09-05   # một khoảng
 *   node scripts/fetch-daily.mjs --days 14           # 14 ngày kết thúc ở D-1 (GitHub Actions dùng)
 *   node scripts/fetch-daily.mjs --to 2026-09-05 --days 7
 *   node scripts/fetch-daily.mjs --dry-run           # chỉ validate query + ước lượng bytes quét
 *   node scripts/fetch-daily.mjs --no-append         # chỉ ghi CSV ra data_incoming/
 *   node scripts/fetch-daily.mjs --replace-date      # truyền tiếp cho append-data (ghi đè cả ngày)
 *
 * Env: BQ_PROJECT (mặc định dw-ghn), BQ_BIN (đường dẫn bq.cmd nếu không tự tìm được),
 *      BQ_CREDENTIALS_JSON / GOOGLE_APPLICATION_CREDENTIALS (bật chế độ REST).
 *
 * Exit code: 0 ok · 1 lỗi cấu hình/BigQuery · 2 query chạy được nhưng không có dòng nào cho
 * khoảng ngày yêu cầu (data D-1 chưa sẵn) — daily-deploy.ps1 dựa vào manifest nên tự bỏ qua deploy.
 *
 * Query là scripts/bq_daily.sql: bỏ hai dòng DECLARE, thay DS_START / DS_END bằng DATE literal,
 * phần còn lại giữ nguyên → bq_daily.sql vẫn là nguồn duy nhất của SQL D-1 (cùng với BQ_QUERY
 * trong GuideModal.jsx cho bản điền tay). Kết quả vì thế là một SELECT đơn, không phải script.
 *
 * Zero dependency, ESM thuần.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SQL_FILE = path.join(ROOT, "scripts", "bq_daily.sql");
const APPEND = path.join(ROOT, "scripts", "append-data.mjs");
const INCOMING = path.join(ROOT, "data_incoming");
const PROJECT = process.env.BQ_PROJECT || "dw-ghn";
const KEEP_INCOMING = 7;       // giữ lại vài file CSV thô gần nhất để soi khi có sự cố
const MIN_ROWS_WARN = 5000;    // một ngày bình thường ~30-40k dòng

/* Header bắt buộc — khớp scripts/append-data.mjs và findCol trong src/detect.js */
const HEADER = [
  "load_date", "warehouse_id", "warehouse_name", "employee_id", "driver_name",
  "order_code", "contact_address", "contact_latlng", "is_epic", "is_assigned",
];

/* ---------- tham số ---------- */

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valueOf = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const dryRun = has("--dry-run");
const noAppend = has("--no-append");
const replaceDate = has("--replace-date");

function fail(msg, code = 1) {
  console.error(`\n❌ ${msg}\n`);
  process.exit(code);
}

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);
const addDays = (ymd, n) => {
  const d = new Date(ymd + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
/** Hôm nay theo giờ VN → YYYY-MM-DD (máy CI chạy UTC, không dùng new Date() trực tiếp) */
const vnToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date());

const argDate = valueOf("--date"), argTo = valueOf("--to"), argDays = valueOf("--days");
for (const [k, v] of [["--date", argDate], ["--to", argTo]]) if (v !== null && !isDate(v)) fail(`${k} phải có dạng YYYY-MM-DD.`);
let days = null;
if (argDays !== null) {
  days = Number(argDays);
  if (!Number.isInteger(days) || days < 1 || days > 60) fail("--days phải là số nguyên 1..60.");
}
const dateTo = argTo || argDate || addDays(vnToday(), -1);
const dateFrom = days ? addDays(dateTo, -(days - 1)) : (argDate || dateTo);
if (dateTo < dateFrom) fail("--to phải >= --date.");

/* ---------- SQL ---------- */

function buildSql(from, to) {
  if (!fs.existsSync(SQL_FILE)) fail(`Không thấy ${SQL_FILE}`);
  const raw = fs.readFileSync(SQL_FILE, "utf8");
  const body = raw.split("\n")
    .filter((l) => !/^\s*DECLARE\s/.test(l) && !/^\s*--/.test(l))
    .join("\n");
  if (!/\bDS_START\b/.test(body) || !/\bDS_END\b/.test(body))
    fail("bq_daily.sql không còn dùng DS_START/DS_END — cập nhật fetch-daily.mjs.");
  return body.replace(/\bDS_START\b/g, `DATE '${from}'`).replace(/\bDS_END\b/g, `DATE '${to}'`).trim();
}

const sql = buildSql(dateFrom, dateTo);

/* =====================================================================================
   Backend 1 — REST API (credential JSON)
   ===================================================================================== */

function loadCredential() {
  if (process.env.BQ_CREDENTIALS_JSON) {
    try { return JSON.parse(process.env.BQ_CREDENTIALS_JSON); }
    catch (e) { fail(`BQ_CREDENTIALS_JSON không phải JSON hợp lệ: ${e.message}`); }
  }
  const p = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (p) {
    if (!fs.existsSync(p)) fail(`GOOGLE_APPLICATION_CREDENTIALS trỏ tới file không tồn tại: ${p}`);
    try { return JSON.parse(fs.readFileSync(p, "utf8")); }
    catch (e) { fail(`File credential không phải JSON hợp lệ: ${e.message}`); }
  }
  return null;
}

const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

async function httpJson(url, { method = "GET", headers = {}, body, timeoutMs = 120_000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method, headers, body, signal: ctl.signal });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* để nguyên text */ }
    if (!res.ok) {
      const msg = json?.error?.message || json?.error_description || text.slice(0, 500);
      const err = new Error(`HTTP ${res.status} ${method} ${url.replace(/\?.*$/, "")}: ${msg}`);
      err.status = res.status;
      throw err;
    }
    return json;
  } finally { clearTimeout(timer); }
}

async function getAccessToken(cred) {
  const tokenUri = cred.token_uri || "https://oauth2.googleapis.com/token";
  let form;
  if (cred.type === "authorized_user") {
    form = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: cred.client_id, client_secret: cred.client_secret, refresh_token: cred.refresh_token,
    });
  } else if (cred.type === "service_account") {
    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = b64url(JSON.stringify({
      iss: cred.client_email, scope: "https://www.googleapis.com/auth/bigquery",
      aud: tokenUri, iat: now, exp: now + 3600,
    }));
    const sig = b64url(crypto.sign("RSA-SHA256", Buffer.from(`${header}.${claims}`), cred.private_key));
    form = new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${header}.${claims}.${sig}` });
  } else {
    fail(`Credential type "${cred.type}" chưa hỗ trợ (cần service_account hoặc authorized_user).`);
  }
  try {
    const j = await httpJson(tokenUri, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString(),
    });
    return j.access_token;
  } catch (e) {
    fail(`Không lấy được access token (${cred.type}${cred.account ? " " + cred.account : ""}): ${e.message}\n` +
         "   Refresh token bị thu hồi / hết hạn theo chính sách Workspace? Tạo lại credential và cập nhật secret.");
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Chạy query qua REST. Trả về {rows: object[]} hoặc {bytes} khi dryRun. */
async function runRest(cred, { dryRun: dry }) {
  const token = await getAccessToken(cred);
  const H = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const base = `https://bigquery.googleapis.com/bigquery/v2/projects/${PROJECT}`;

  let job;
  try {
    job = await httpJson(`${base}/jobs`, {
      method: "POST", headers: H,
      body: JSON.stringify({ configuration: { query: { query: sql, useLegacySql: false }, dryRun: !!dry } }),
    });
  } catch (e) {
    fail(`jobs.insert lỗi: ${e.message}${e.status === 403 ? "\n   Credential không có quyền BigQuery trên project/bảng." : ""}`);
  }
  if (job.status?.errorResult) fail(`BigQuery từ chối query: ${job.status.errorResult.message}`);
  if (dry) return { bytes: Number(job.statistics?.totalBytesProcessed || 0) };

  const { jobId, location } = job.jobReference;
  const loc = location ? `location=${encodeURIComponent(location)}` : "";
  console.log(`   job ${jobId}${location ? " @" + location : ""}`);

  // chờ job xong
  const t0 = Date.now();
  for (;;) {
    if (job.status?.state === "DONE") break;
    if (Date.now() - t0 > 25 * 60_000) fail(`Job ${jobId} chạy quá 25 phút.`);
    await sleep(2000);
    try { job = await httpJson(`${base}/jobs/${jobId}?${loc}`, { headers: H }); }
    catch (e) { if (e.status && e.status >= 500) { console.warn(`   ⚠️ ${e.message} — thử lại`); continue; } throw e; }
  }
  if (job.status.errorResult) fail(`Query lỗi: ${job.status.errorResult.message}`);

  // đọc kết quả theo trang
  const rows = [];
  let fields = null, pageToken = null, pages = 0;
  do {
    const qs = new URLSearchParams({ maxResults: "100000", timeoutMs: "60000" });
    if (location) qs.set("location", location);
    if (pageToken) qs.set("pageToken", pageToken);
    let page;
    try { page = await httpJson(`${base}/queries/${jobId}?${qs}`, { headers: H, timeoutMs: 180_000 }); }
    catch (e) {
      if (e.status && e.status >= 500) { console.warn(`   ⚠️ ${e.message} — thử lại trang`); await sleep(2000); continue; }
      throw e;
    }
    if (!page.jobComplete) { await sleep(1000); continue; }
    fields = fields || (page.schema?.fields || []).map((f) => f.name);
    for (const r of page.rows || []) {
      const o = {};
      r.f.forEach((c, i) => { o[fields[i]] = c.v; });
      rows.push(o);
    }
    pageToken = page.pageToken || null;
    pages++;
  } while (pageToken);
  const total = Number(job.statistics?.query?.totalBytesProcessed || 0);
  console.log(`   ${pages} trang, quét ${(total / 1e9).toFixed(2)} GB`);
  return { rows };
}

/* =====================================================================================
   Backend 2 — bq CLI
   ===================================================================================== */

function findBq() {
  if (process.env.BQ_BIN) return process.env.BQ_BIN;
  if (process.platform !== "win32") return "bq";
  const r = spawnSync("where.exe", ["bq.cmd"], { encoding: "utf8" });
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim().split(/\r?\n/)[0];
  const cands = [
    path.join(process.env.LOCALAPPDATA || "", "Google", "Cloud SDK", "google-cloud-sdk", "bin", "bq.cmd"),
    "C:\\Program Files (x86)\\Google\\Cloud SDK\\google-cloud-sdk\\bin\\bq.cmd",
    "C:\\Program Files\\Google\\Cloud SDK\\google-cloud-sdk\\bin\\bq.cmd",
  ];
  const hit = cands.find((p) => fs.existsSync(p));
  if (!hit) {
    fail(
      "Không tìm thấy `bq` (Google Cloud SDK) và cũng không có BQ_CREDENTIALS_JSON / GOOGLE_APPLICATION_CREDENTIALS.\n" +
      "   Cài SDK từ https://cloud.google.com/sdk/docs/install rồi `gcloud auth login`, hoặc đặt env BQ_BIN trỏ tới bq.cmd."
    );
  }
  return hit;
}

function runBqCli(args, input) {
  const BQ = findBq();
  const sdkBin = path.dirname(BQ);
  // bq gọi gcloud để lấy credential → thư mục SDK phải nằm trong PATH của tiến trình con.
  // PYTHONIOENCODING: bq là Python, không ép UTF-8 thì tên tiếng Việt ra mojibake trên Windows.
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") || "PATH";
  const env = {
    ...process.env,
    [pathKey]: sdkBin + path.delimiter + (process.env[pathKey] || ""),
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
  };
  const opts = { input, encoding: "utf8", env, maxBuffer: 1024 * 1024 * 1024, timeout: 25 * 60 * 1000 };
  const r = process.platform === "win32"
    // .cmd chỉ chạy được qua cmd.exe; /s + bọc thêm một cặp "" để đường dẫn có dấu cách sống sót.
    ? spawnSync("cmd.exe", ["/d", "/s", "/c", `""${BQ}" ${args.join(" ")}"`], { ...opts, windowsVerbatimArguments: true })
    : spawnSync(BQ, args, opts);
  if (r.error) fail(`Không chạy được bq: ${r.error.message}`);
  return { ...r, bin: BQ };
}

function explainBqFailure(out) {
  const t = (out || "").toLowerCase();
  if (/reauth|credential|refresh token|invalid_grant|login required|not logged in/.test(t))
    return "Phiên gcloud hết hạn hoặc chưa đăng nhập → chạy `gcloud auth login` (tài khoản @ghn.vn) rồi thử lại.";
  if (/access denied|permission|403/.test(t))
    return "Tài khoản không có quyền trên bảng/project. Kiểm tra bằng cách chạy query trong BigQuery Console.";
  if (/not found: table|not found: dataset/.test(t))
    return "Bảng nguồn đổi tên. Sửa bq_daily.sql VÀ BQ_QUERY trong GuideModal.jsx.";
  return "";
}

function runBq({ dryRun: dry }) {
  const BASE = [`--project_id=${PROJECT}`, "--headless", "--quiet", "query", "--nouse_legacy_sql"];
  if (dry) {
    const r = runBqCli([...BASE, "--dry_run"], sql);
    const out = (r.stdout || "") + (r.stderr || "");
    if (r.status !== 0) fail(`bq --dry_run lỗi:\n${out}\n   ${explainBqFailure(out)}`);
    const m = out.match(/(\d+) bytes/);
    return { bytes: m ? Number(m[1]) : 0 };
  }
  const t0 = Date.now();
  const r = runBqCli([...BASE, "--format=json", "--max_rows=10000000"], sql);
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  if (r.status !== 0) {
    const out = (r.stdout || "") + (r.stderr || "");
    fail(`bq exit ${r.status} sau ${secs}s:\n${out.slice(0, 2000)}\n   ${explainBqFailure(out)}`);
  }
  let rows;
  try { const txt = r.stdout.trim(); rows = txt ? JSON.parse(txt) : []; }
  catch (e) { fail(`Không parse được output JSON của bq (${e.message}). 300 ký tự đầu:\n${r.stdout.slice(0, 300)}`); }
  if (!Array.isArray(rows)) fail("Output bq không phải mảng JSON.");
  /* Phòng khi SQL lại thành script nhiều statement: bq --format=json trả MẢNG CỦA MẢNG
     (một mảng con mỗi statement). Lấy mảng con cuối cùng có dữ liệu. */
  if (rows.length && rows.every((x) => Array.isArray(x))) {
    const withData = rows.filter((x) => x.length);
    rows = withData.length ? withData[withData.length - 1] : [];
  }
  return { rows };
}

/* =====================================================================================
   main
   ===================================================================================== */

const cred = loadCredential();
console.log(`🗓  Ngày     : ${dateFrom}${dateTo !== dateFrom ? " → " + dateTo : ""} (giờ VN)`);
console.log(`☁️  Project  : ${PROJECT}`);
console.log(`🔧 Backend  : ${cred ? `REST API (${cred.type}${cred.account ? " " + cred.account : cred.client_email ? " " + cred.client_email : ""})` : "bq CLI"}`);

if (dryRun) {
  const { bytes } = cred ? await runRest(cred, { dryRun: true }) : runBq({ dryRun: true });
  console.log(`\n✅ Query hợp lệ — sẽ quét ~${(bytes / 1e9).toFixed(2)} GB.\n`);
  process.exit(0);
}

console.log("⏳ Chạy query trên BigQuery…");
const t0 = Date.now();
const { rows } = cred ? await runRest(cred, { dryRun: false }) : runBq({ dryRun: false });
console.log(`   ${rows.length} dòng sau ${((Date.now() - t0) / 1000).toFixed(0)}s`);

if (!rows.length) {
  fail(`Query chạy OK nhưng không có dòng nào cho ${dateFrom}${dateTo !== dateFrom ? "→" + dateTo : ""}.\n` +
       `   Có thể data D-1 chưa được nạp vào warehouse — thử lại sau, hoặc chạy với --date.`, 2);
}

/* kiểm tra cột theo TÊN (không theo thứ tự) */
const cols = Object.keys(rows[0]);
const missing = HEADER.filter((h) => !cols.includes(h));
if (missing.length) fail(`Kết quả thiếu cột: ${missing.join(", ")}. Có: ${cols.join(", ")}\n   Sửa bq_daily.sql cho khớp HEADER.`);

/* ---------- chuẩn hoá + ghi CSV ---------- */

const norm = (v) => (v === null || v === undefined ? "" : String(v));
const outRows = rows.map((o) => HEADER.map((h) => norm(o[h])));

const badDate = outRows.filter((r) => !isDate(r[0]));
if (badDate.length) fail(`${badDate.length} dòng có load_date không phải YYYY-MM-DD, ví dụ: "${badDate[0][0]}".`);
const outside = outRows.filter((r) => r[0] < dateFrom || r[0] > dateTo);
if (outside.length) fail(`${outside.length} dòng có load_date ngoài khoảng yêu cầu (vd ${outside[0][0]}) — query sai điều kiện ngày?`);

const perDay = new Map();
for (const r of outRows) perDay.set(r[0], (perDay.get(r[0]) || 0) + 1);
const dayList = [...perDay].sort(([a], [b]) => a.localeCompare(b));
console.log(`   Theo ngày : ${dayList.map(([d, n]) => `${d} (${n})`).join(", ")}`);
const thin = dayList.filter(([, n]) => n < MIN_ROWS_WARN);
if (thin.length) console.warn(`⚠️  Ngày ít dòng bất thường (bình thường ~30-40k): ${thin.map(([d, n]) => `${d}=${n}`).join(", ")}`);
const expected = [];
for (let d = dateFrom; d <= dateTo; d = addDays(d, 1)) expected.push(d);
const absent = expected.filter((d) => !perDay.has(d));
if (absent.length) console.warn(`⚠️  Không có dòng nào cho: ${absent.join(", ")}`);

const needsQuote = (s) => /[",\r\n]/.test(s);
const ser = (s) => (needsQuote(s) ? '"' + s.replace(/"/g, '""') + '"' : s);
const csv = [HEADER, ...outRows].map((r) => r.map(ser).join(",")).join("\n") + "\n";

fs.mkdirSync(INCOMING, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outFile = path.join(INCOMING, `bq_${dateFrom}${dateTo !== dateFrom ? "_" + dateTo : ""}_${stamp}.csv`);
fs.writeFileSync(outFile, csv, "utf8");
console.log(`💾 Đã ghi   : ${path.relative(ROOT, outFile)} (${(Buffer.byteLength(csv) / (1 << 20)).toFixed(1)} MB)`);

/* dọn file thô cũ — lỗi (sandbox không unlink được) thì bỏ qua */
try {
  const old = fs.readdirSync(INCOMING).filter((f) => /^bq_.*\.csv$/.test(f))
    .map((f) => ({ f, t: fs.statSync(path.join(INCOMING, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t).slice(KEEP_INCOMING);
  for (const { f } of old) fs.unlinkSync(path.join(INCOMING, f));
} catch { /* không quan trọng */ }

/* ---------- append ---------- */

if (noAppend) {
  console.log("\n⏭  --no-append: dừng ở đây. Chạy tiếp: node scripts/append-data.mjs " + JSON.stringify(outFile) + "\n");
  process.exit(0);
}

console.log("\n📦 append-data.mjs …\n");
const ap = spawnSync(process.execPath, [APPEND, outFile, ...(replaceDate ? ["--replace-date"] : [])],
  { stdio: "inherit", cwd: ROOT });
if (ap.status !== 0) fail(`append-data.mjs exit ${ap.status}.`);
