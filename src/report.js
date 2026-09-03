/* report.js — tổng hợp kết quả quét bất thường (evalAbnormal của mọi tài xế trong ngày)
   thành dữ liệu cho trang "Báo cáo bất thường": KPI, phân bố theo bưu cục, bảng tài xế,
   kịch bản hành vi, histogram khoảng cách, xu hướng nhiều ngày, chất lượng dữ liệu.
   Thuần dữ liệu, không đụng DOM/React. */
import * as D from "./detect.js";
import { NO_BC } from "./scene.js";

/* Tiêu chí bất thường — giống nút "🚨 Bất thường" trên navbar */
export const FLAG = { pct: 0.10, minFar: 5 };
export const isAbnormal = r => !!r && r.far >= FLAG.minFar && r.ratio >= FLAG.pct;

/* Kịch bản hành vi — bám warning_gan_ngoai_EPIC.md và bộ tham số chốt từ backtest 06–13/08.
   Một tài xế có thể rơi vào nhiều kịch bản cùng lúc. */
export const SCENARIOS = [
  { key: "go_epic",  label: "Gỡ EPIC hàng loạt",      desc: "Gán < 20% đơn gợi ý (kịch bản 2 — gỡ gợi ý không đúng tuyến mong muốn)" },
  { key: "doi_vung", label: "Đổi vùng quy mô lớn",    desc: "Đơn ngoài > 30% tổng gán VÀ > 80% đơn ngoài là đơn xa (rule tỷ trọng)" },
  { key: "that_xa",  label: "Nhiều đơn thật sự xa",   desc: "≥ 3 đơn cách vùng EPIC ≥ 3 km (rule đếm tuyệt đối)" },
  { key: "don_ngoai", label: "Gán đủ EPIC, độn ngoài", desc: "Gán ≥ 60% đơn gợi ý nhưng vẫn nhiều đơn xa (kịch bản 4)" },
];
export function classify(r) {
  const tags = [];
  const compliance = r.epicTotal ? r.epicAssigned / r.epicTotal : null;
  if (compliance != null && r.epicTotal >= 5 && compliance < 0.2) tags.push("go_epic");
  if (r.assigned && r.outside / r.assigned > 0.3 && r.outside && r.far / r.outside > 0.8) tags.push("doi_vung");
  if (r.far3km >= 3) tags.push("that_xa");
  if (compliance != null && compliance >= 0.6) tags.push("don_ngoai");
  return tags;
}

/* Bucket khoảng cách (m) cho histogram đơn xa */
export const DIST_BUCKETS = [
  { label: "1–2 km", lo: 0,     hi: 2000 },
  { label: "2–3 km", lo: 2000,  hi: 3000 },
  { label: "3–5 km", lo: 3000,  hi: 5000 },
  { label: "5–10 km", lo: 5000, hi: 10000 },
  { label: "> 10 km", lo: 10000, hi: Infinity },
];

const dayDiff = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 86400000);

/* rows: kết quả evalAbnormal của MỌI tài xế đánh giá được trong ngày `date`
         ({ id, name, bc, ...evalAbnormal }); skipped: số tài xế không đánh giá được.
   history: { [date]: { rows, skipped, drivers } } — các ngày đã quét (kể cả ngày hiện tại).
   dates: mọi ngày có dữ liệu (đã sort tăng) — ngày chưa quét hiện null trên đường xu hướng. */
export function buildReport({ rows, skipped, drivers, date, history = {}, dates = [] }) {
  const abnormal = rows.filter(isAbnormal);

  /* ---- lịch sử: tài xế → tập ngày bị flag (mọi ngày đã quét) ---- */
  const flaggedDates = new Map();
  // ngày tải/quét lỗi (failed) không tính vào lịch sử — tránh hiện "0 bất thường" giả
  const scannedDates = Object.keys(history).filter(d => !history[d].failed).sort();
  for (const d of scannedDates) {
    for (const r of history[d].rows) {
      if (!isAbnormal(r)) continue;
      let s = flaggedDates.get(r.id);
      if (!s) flaggedDates.set(r.id, (s = new Set()));
      s.add(d);
    }
  }
  const earlierScanned = scannedDates.filter(d => d < date);
  const countWithin = (id, days) => {
    const s = flaggedDates.get(id);
    if (!s) return 0;
    let n = 0;
    for (const d of s) { const k = dayDiff(date, d); if (k >= 0 && k < days) n++; }
    return n;
  };

  /* ---- bảng tài xế bất thường ---- */
  const table = abnormal.map(r => {
    const flag7 = countWithin(r.id, 7), flag14 = countWithin(r.id, 14);
    const everBefore = [...(flaggedDates.get(r.id) || [])].some(d => d < date);
    return {
      ...r,
      compliance: r.epicTotal ? r.epicAssigned / r.epicTotal : null,
      scenarios: classify(r),
      flag7, flag14,
      repeat: flag7 >= 3,
      isNew: earlierScanned.length > 0 && !everBefore,
    };
  }).sort((a, b) => b.far - a.far || b.ratio - a.ratio);

  /* ---- KPI ---- */
  const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);
  const kpi = {
    abnormal: abnormal.length,
    evaluated: rows.length,
    drivers,
    bcAbnormal: new Set(abnormal.map(r => r.bc)).size,
    bcTotal: new Set(rows.map(r => r.bc)).size,
    farTotal: sum(abnormal, r => r.far),
    maybeTotal: sum(abnormal, r => r.maybe),
    repeat: table.filter(t => t.repeat).length,
    isNew: table.filter(t => t.isNew).length,
    prev: null,
  };
  const prevDate = earlierScanned[earlierScanned.length - 1];
  if (prevDate) {
    const pr = history[prevDate].rows, pa = pr.filter(isAbnormal);
    kpi.prev = {
      date: prevDate,
      abnormal: pa.length,
      bcAbnormal: new Set(pa.map(r => r.bc)).size,
      farTotal: sum(pa, r => r.far),
      maybeTotal: sum(pa, r => r.maybe),
    };
  }

  /* ---- theo bưu cục ---- */
  const bcMap = new Map();
  for (const r of rows) {
    let b = bcMap.get(r.bc);
    if (!b) bcMap.set(r.bc, (b = { bc: r.bc, drivers: 0, abnormal: 0, far: 0, maybe: 0, epicTotal: 0, epicAssigned: 0 }));
    b.drivers++;
    b.epicTotal += r.epicTotal; b.epicAssigned += r.epicAssigned;
    if (isAbnormal(r)) { b.abnormal++; b.far += r.far; b.maybe += r.maybe; }
  }
  const byBc = [...bcMap.values()]
    .filter(b => b.abnormal > 0)
    .map(b => ({ ...b, pct: b.abnormal / b.drivers, compliance: b.epicTotal ? b.epicAssigned / b.epicTotal : null }))
    .sort((a, b) => b.abnormal - a.abnormal || b.far - a.far || a.bc.localeCompare(b.bc, "vi"));

  /* ---- kịch bản ---- */
  const scenarioCounts = SCENARIOS.map(s => ({ ...s, n: table.filter(t => t.scenarios.includes(s.key)).length }));
  scenarioCounts.push({ key: "khac", label: "Chưa xếp kịch bản", desc: "Vượt ngưỡng bất thường nhưng không khớp rule nào ở trên", n: table.filter(t => !t.scenarios.length).length });

  /* ---- histogram khoảng cách đơn xa (chỉ tài xế bất thường) ---- */
  const allFar = abnormal.flatMap(r => r.farDists);
  const hist = DIST_BUCKETS.map(b => ({ ...b, n: allFar.filter(d => d >= b.lo && d < b.hi).length }));
  const far3km = allFar.filter(d => d >= 3000).length;

  /* ---- xu hướng theo ngày ---- */
  const trend = dates.map(d => {
    const h = history[d];
    if (!h || h.failed) return { date: d, abnormal: null, far: null };
    const a = h.rows.filter(isAbnormal);
    return { date: d, abnormal: a.length, far: sum(a, r => r.far), evaluated: h.rows.length };
  });

  /* ---- chất lượng dữ liệu (toàn bộ tài xế trong ngày) ---- */
  const epsList = rows.map(r => r.eps);
  const quality = {
    noCoord: sum(rows, r => r.noCoord),
    misgeo: sum(rows, r => r.misgeo),
    maybe: sum(rows, r => r.maybe),
    skipped,
    allNoise: rows.filter(r => r.allNoise).length,
    epsMin: epsList.length ? Math.min(...epsList) : null,
    epsMax: epsList.length ? Math.max(...epsList) : null,
    removed: sum(rows, r => r.removed),
  };

  return { date, kpi, table, byBc, scenarioCounts, hist, far3km, allFarCount: allFar.length, trend, quality, scannedDates };
}

/* Chạy lại detect cho danh sách tài xế (bất thường) để lấy TỪNG đơn xa — dùng cho xuất CSV
   và khối "đơn EPIC bị gỡ đi đâu". Cùng logic soát địa chỉ với evalAbnormal. */
export function farOrdersOf(orders, date, ids) {
  const want = new Set(ids);
  const byDrv = new Map();
  for (const o of orders) {
    if (o.date !== date || !want.has(o.driver)) continue;
    let arr = byDrv.get(o.driver);
    if (!arr) byDrv.set(o.driver, (arr = []));
    arr.push(o);
  }
  const out = [];
  for (const [id, dOrders] of byDrv) {
    const det = D.detect(dOrders, D.suggestParams(dOrders));
    const centerProfile = D.buildCenterProfile(
      dOrders.filter(o => o.epic).concat(det.results.filter(r => !r.far).map(r => r.order)));
    for (const r of det.results) {
      if (!r.far) continue;
      const verdict = D.addrVerdict(r.order, centerProfile);
      if (verdict === "A") continue;
      out.push({ driver: id, order: r.order, dist: r.dist, threshold: det.threshold, verdict });
    }
  }
  out.sort((a, b) => b.dist - a.dist);
  return out;
}

/* Đơn EPIC bị gỡ của các tài xế bất thường đi đâu — chỉ có dữ liệu khi export có cột
   actual_driver_id/actual_driver_name (export 10 cột hiện tại KHÔNG có → trả available=false). */
export function removedDestinations(orders, date, ids, driverInfo) {
  const want = new Set(ids);
  let removed = 0, withActual = 0;
  const buckets = { self: 0, sameBc: 0, otherBc: 0, unknown: 0 };
  for (const o of orders) {
    if (o.date !== date || !want.has(o.driver) || !o.epic || o.assigned) continue;
    removed++;
    if (!o.actualIds && !o.actualNames) continue;
    withActual++;
    const ownerBc = (driverInfo[o.driver] && driverInfo[o.driver].bc) || NO_BC;
    const actIds = o.actualIds.split(",").map(s => s.trim()).filter(Boolean);
    if (!actIds.length) { buckets.unknown++; continue; }
    if (actIds.every(a => a === o.driver)) { buckets.self++; continue; }
    const bcs = actIds.map(a => (driverInfo[a] && driverInfo[a].bc) || null);
    if (bcs.every(b => b === null)) buckets.unknown++;
    else if (bcs.some(b => b && b !== ownerBc)) buckets.otherBc++;
    else buckets.sameBc++;
  }
  return { removed, available: withActual > 0, ...buckets };
}
