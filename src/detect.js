/**
 * detect.js — Logic phát hiện đơn gán ngoài gợi ý XA vùng EPIC (bản ES module cho React).
 *
 * Thuật toán:
 *   1. Tập tham chiếu = mọi đơn is_epic=1 có toạ độ (cả bị gỡ) — file gợi ý định nghĩa VÙNG dự kiến.
 *   2. DBSCAN (haversine) gom cụm tập tham chiếu; điểm nhiễu bị loại
 *      (nếu tất cả là nhiễu → dùng toàn bộ điểm EPIC làm dự phòng).
 *   3. Với mỗi đơn ngoài gợi ý đã gán: d = khoảng cách đến điểm EPIC (trong cụm) gần nhất.
 *   4. Ngưỡng thích ứng: max(minKm, k × P90 khoảng cách láng giềng gần nhất nội cụm).
 */

/* ============ Parse CSV (hỗ trợ trường có dấu ngoặc kép chứa dấu phẩy) ============ */
export function parseCSV(text) {
  const rows = [];
  let field = "", row = [], inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some(f => f !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); if (row.some(f => f !== "")) rows.push(row); }
  return rows;
}

/* Đọc CSV cột: load_date, driver_id, order_code, contact_latlng, is_epic, is_assigned
   Tuỳ chọn thêm (tự nhận nếu có): driver_name, bc_name, contact_address */
export function loadOrders(csvText) {
  const rows = parseCSV(csvText.trim());
  const header = rows[0].map(h => h.trim().toLowerCase());
  const findCol = (...names) => { for (const n of names) { const i = header.indexOf(n); if (i >= 0) return i; } return -1; };
  const idx = {
    date: header.indexOf("load_date"),
    driver: findCol("driver_id", "employee_id"),
    code: header.indexOf("order_code"),
    latlng: header.indexOf("contact_latlng"),
    epic: header.indexOf("is_epic"),
    assigned: header.indexOf("is_assigned"),
    name: findCol("driver_name", "ten_nv", "ten_nvpttt", "nv_name", "name"),
    bc: findCol("bc_name", "warehouse_name", "bc", "hub_name", "ten_bc", "station_name", "buu_cuc"),
    address: findCol("contact_address", "address", "dia_chi", "diachi"),
    actualId: findCol("actual_driver_id"),
    actualName: findCol("actual_driver_name"),
  };
  const orders = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const ll = (r[idx.latlng] || "").split(",");
    const lat = parseFloat(ll[0]), lng = parseFloat(ll[1]);
    const hasCoord = isFinite(lat) && isFinite(lng);
    orders.push({
      date: r[idx.date],
      driver: r[idx.driver],
      code: r[idx.code],
      lat: hasCoord ? lat : null,
      lng: hasCoord ? lng : null,
      hasCoord,
      epic: r[idx.epic] === "1",
      // file không có cột is_assigned (vd export "toàn đơn") → coi mọi dòng là đơn đã gán
      assigned: idx.assigned >= 0 ? r[idx.assigned] === "1" : true,
      name: idx.name >= 0 ? (r[idx.name] || "").trim() : "",
      bc: idx.bc >= 0 ? (r[idx.bc] || "").trim() : "",
      // một số file export bọc địa chỉ trong nháy kép thừa → gỡ bỏ
      address: idx.address >= 0 ? (r[idx.address] || "").trim().replace(/^"+|"+$/g, "").trim() : "",
      // ai THỰC SỰ giao đơn (có thể nhiều người, cách nhau dấu phẩy) — khác driver_id ở đơn EPIC bị gỡ
      actualIds: idx.actualId >= 0 ? (r[idx.actualId] || "").trim() : "",
      actualNames: idx.actualName >= 0 ? (r[idx.actualName] || "").trim() : "",
    });
  }
  return orders;
}

/* Đọc file mapping riêng drivers.csv: driver_id + driver_name + bc_name */
export function loadDriverMap(csvText) {
  const rows = parseCSV(csvText.trim());
  if (!rows.length) return {};
  const header = rows[0].map(h => h.trim().toLowerCase());
  const findCol = (...names) => { for (const n of names) { const i = header.indexOf(n); if (i >= 0) return i; } return -1; };
  const iId = findCol("driver_id", "employee_id", "id");
  const iName = findCol("driver_name", "ten_nv", "ten_nvpttt", "nv_name", "name");
  const iBc = findCol("bc_name", "bc", "hub_name", "ten_bc", "station_name", "buu_cuc");
  if (iId < 0) return {};
  const map = {};
  for (let i = 1; i < rows.length; i++) {
    const id = (rows[i][iId] || "").trim();
    if (!id) continue;
    map[id] = {
      name: iName >= 0 ? (rows[i][iName] || "").trim() : "",
      bc: iBc >= 0 ? (rows[i][iBc] || "").trim() : "",
    };
  }
  return map;
}

/* Gộp thông tin NV từ cột trong CSV chính + file mapping ngoài (mapping ưu tiên hơn) */
export function buildDriverInfo(orders, extCsvText) {
  const info = {};
  for (const o of orders) {
    // dòng EPIC bị gỡ (is_assigned=0) mang tên NGƯỜI GIAO THẬT chứ không phải tên của driver_id
    // → chỉ lấy tên từ dòng đã gán cho chính tài xế đó
    if (!o.assigned) continue;
    if (o.name || o.bc) info[o.driver] = { name: o.name || "", bc: o.bc || "" };
  }
  if (extCsvText) {
    const ext = loadDriverMap(extCsvText);
    for (const id of Object.keys(ext)) {
      const cur = info[id] || { name: "", bc: "" };
      info[id] = { name: ext[id].name || cur.name, bc: ext[id].bc || cur.bc };
    }
  }
  return info;
}

/* Nhãn hiển thị: "3181955 — Nguyễn Văn A · BC Tân Bình" */
export function driverLabel(id, info) {
  const d = info && info[id];
  if (!d || (!d.name && !d.bc)) return String(id);
  let s = String(id);
  if (d.name) s += " — " + d.name;
  if (d.bc) s += " · " + d.bc;
  return s;
}

/* ============ So khớp địa chỉ — khử cảnh báo do sai định vị (geocode lỗi) ============
     verdict "A": trùng cả tên đường LẪN phường/xã → sai định vị → loại khỏi cảnh báo
     verdict "B": trùng phường/xã HOẶC tên đường   → có thể sai định vị → giữ + gắn nhãn
     verdict "C": không trùng / thiếu địa chỉ      → cảnh báo thật */
function stripVN(s) {
  return String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d");
}
function addrSegments(s) {
  const t = stripVN(s)
    // mở rộng viết tắt THẬN TRỌNG: chỉ khi có dấu chấm hoặc theo sau là số
    .replace(/\btp\.\s*/g, "thanh pho ")
    .replace(/\bq\.?\s*(?=\d)/g, "quan ").replace(/\bq\.\s*/g, "quan ")
    .replace(/\bp\.?\s*(?=\d)/g, "phuong ").replace(/\bp\.\s*/g, "phuong ")
    .replace(/\bh\.\s*/g, "huyen ").replace(/\bx\.\s*/g, "xa ").replace(/\btt\.\s*/g, "thi tran ")
    .replace(/[^a-z0-9,\/ ]/g, " ").replace(/ +/g, " ");
  // bỏ hậu tố "cũ" cuối từng đoạn (địa giới sáp nhập) — không đụng "Củ Chi"
  return t.split(",").map(x => x.trim().replace(/ cu$/, "")).filter(Boolean);
}
export function addrWard(s) {
  if (!s) return null;
  for (const seg of addrSegments(s)) {
    const m = seg.match(/\b(phuong|xa|thi tran) (.+)$/);
    if (m) return (m[1] + " " + m[2]).trim();
  }
  return null;
}
export function addrStreet(s) {
  if (!s) return null;
  const segs = addrSegments(s);
  if (!segs.length) return null;
  const st = segs[0]
    .replace(/^[a-z]{0,2}\d[a-z0-9\/\-]*\s+/, "")
    .replace(/\b(duong|ap|khu pho|kp|to)\b/g, " ")
    .replace(/ +/g, " ").trim();
  return st.length >= 3 ? st : null;
}
function tokenSim(a, b) {
  const A = new Set(a.split(" ")), B = new Set(b.split(" "));
  let i = 0; for (const x of A) if (B.has(x)) i++;
  return i / (A.size + B.size - i);
}
export function buildCenterProfile(orders) {
  const wards = new Set(), streets = new Set();
  for (const o of orders) {
    if (!o.address) continue;
    const w = addrWard(o.address); if (w) wards.add(w);
    const st = addrStreet(o.address); if (st) streets.add(st);
  }
  return { wards, streets: [...streets] };
}
export function addrVerdict(order, profile) {
  if (!order.address) return "C";
  const w = addrWard(order.address), st = addrStreet(order.address);
  const wardHit = !!(w && profile.wards.has(w));
  const stHit = !!(st && profile.streets.some(s2 => tokenSim(st, s2) >= 0.75));
  if (wardHit && stHit) return "A";
  if (wardHit || stHit) return "B";
  return "C";
}

/* ============ Hình học ============ */
const R_EARTH = 6371000;
export function haversine(a, b) {
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(s));
}

export function dbscan(points, epsMeters, minPts) {
  const n = points.length;
  const labels = new Array(n).fill(undefined);
  const neighborsOf = i => {
    const out = [];
    for (let j = 0; j < n; j++) if (j !== i && haversine(points[i], points[j]) <= epsMeters) out.push(j);
    return out;
  };
  let cluster = -1;
  for (let i = 0; i < n; i++) {
    if (labels[i] !== undefined) continue;
    const nb = neighborsOf(i);
    if (nb.length + 1 < minPts) { labels[i] = -1; continue; }
    cluster++;
    labels[i] = cluster;
    const queue = [...nb];
    while (queue.length) {
      const j = queue.shift();
      if (labels[j] === -1) labels[j] = cluster;
      if (labels[j] !== undefined) continue;
      labels[j] = cluster;
      const nb2 = neighborsOf(j);
      if (nb2.length + 1 >= minPts) queue.push(...nb2);
    }
  }
  return labels;
}

export function convexHull(points) {
  if (points.length < 3) return points.slice();
  const pts = points.slice().sort((a, b) => a.lng - b.lng || a.lat - b.lat);
  const cross = (o, a, b) => (a.lng - o.lng) * (b.lat - o.lat) - (a.lat - o.lat) * (b.lng - o.lng);
  const lower = [], upper = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  for (const p of pts.slice().reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

export function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/* ============ Tự đề xuất tham số theo dữ liệu từng tài xế ============
   eps ≈ P90 khoảng cách láng giềng gần nhất giữa các điểm EPIC của tài xế đó
   (làm tròn bội 50m, kẹp trong [200m, 800m] — dày quá không xé vụn vùng,
   thưa quá không nhập nhầm các vùng tách biệt).
   k = 3 và sàn 1km giữ cố định theo backtest 06–13/08. */
export function suggestParams(orders) {
  const pts = orders.filter(o => o.epic && o.hasCoord);
  let eps = 400; // mặc định khi quá ít điểm để ước lượng
  if (pts.length >= 3) {
    const nn = [];
    for (let i = 0; i < pts.length; i++) {
      let best = Infinity;
      for (let j = 0; j < pts.length; j++) {
        if (i === j) continue;
        const d = haversine(pts[i], pts[j]);
        if (d < best) best = d;
      }
      if (isFinite(best)) nn.push(best);
    }
    nn.sort((a, b) => a - b);
    const p90 = percentile(nn, 0.9);
    eps = Math.min(800, Math.max(200, Math.round(p90 / 50) * 50));
  }
  return { epsMeters: eps, k: 3, minKm: 1 };
}

/* ============ Thuật toán phát hiện chính ============ */
export function detect(orders, { epsMeters, k, minKm, minPts = 3 }) {
  const epicPts = orders.filter(o => o.epic && o.hasCoord);
  const outsideAssigned = orders.filter(o => !o.epic && o.assigned && o.hasCoord);

  const labels = dbscan(epicPts, epsMeters, minPts);
  let refPts = epicPts.filter((_, i) => labels[i] >= 0);
  const clusterIds = [...new Set(labels.filter(l => l >= 0))];
  const clusters = clusterIds.map(id => epicPts.filter((_, i) => labels[i] === id));
  const allNoise = refPts.length === 0;
  if (allNoise) refPts = epicPts;

  const nnDists = [];
  for (let i = 0; i < refPts.length; i++) {
    let best = Infinity;
    for (let j = 0; j < refPts.length; j++) {
      if (i === j) continue;
      const d = haversine(refPts[i], refPts[j]);
      if (d < best) best = d;
    }
    if (isFinite(best)) nnDists.push(best);
  }
  nnDists.sort((a, b) => a - b);
  const p90 = percentile(nnDists, 0.9);
  const threshold = Math.max(minKm * 1000, k * p90);

  const results = outsideAssigned.map(o => {
    let best = Infinity, nearest = null;
    for (const p of refPts) {
      const d = haversine(o, p);
      if (d < best) { best = d; nearest = p; }
    }
    return { order: o, dist: best, nearest, far: refPts.length > 0 && best > threshold };
  });

  return { epicPts, clusters, allNoise, refPts, p90, threshold, results };
}

export default {
  parseCSV, loadOrders, loadDriverMap, buildDriverInfo, driverLabel,
  addrWard, addrStreet, buildCenterProfile, addrVerdict,
  haversine, dbscan, convexHull, percentile, detect,
};
