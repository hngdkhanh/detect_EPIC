/* scene.js — chuyển (orders, bộ lọc, tham số) thành dữ liệu vẽ: layers cho map,
   thống kê per-driver cho sidebar, bảng cảnh báo. Thuần dữ liệu, không đụng DOM/Leaflet. */
import * as D from "./detect.js";

export const NO_BC = "(chưa rõ bưu cục)";
export const ALL_DRV = "__ALL__";

export const PALETTE = [
  "#2a78d6", "#d03b3b", "#0ca30c", "#b97e00", "#7b52c7", "#0f9ba8", "#d0559a",
  "#6b7f2a", "#8a5a3b", "#4a5fd0", "#c7671e", "#3a8f5f", "#a04ad0", "#496b7d", "#b3a11e",
  "#d03b6f", "#2a9d8f", "#8f6bd0",
];

export const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
export const fmtKm = m => (m / 1000).toFixed(2) + " km";

const MARKER_STYLE = {
  good:    { color: "#ffffff", fillColor: "#0ca30c", radius: 6,  weight: 1.5, fillOpacity: 0.95 },
  removed: { color: "#ffffff", fillColor: "#898781", radius: 5,  weight: 1.5, fillOpacity: 0.85 },
  near:    { color: "#8a6200", fillColor: "#fab219", radius: 6,  weight: 1.5, fillOpacity: 0.95 },
  far:     { color: "#ffffff", fillColor: "#d03b3b", radius: 8,  weight: 2,   fillOpacity: 1 },
  misgeo:  { color: "#ffffff", fillColor: "#9067c6", radius: 6,  weight: 1.5, fillOpacity: 0.9 },
};
const KIND_LABEL = {
  good: "🟢 EPIC — gán đúng gợi ý", removed: "⚪ EPIC — bị gỡ / không gán",
  near: "🟠 Ngoài gợi ý — gần vùng EPIC", far: "🔴 Ngoài gợi ý — XA vùng EPIC",
  misgeo: "🟣 Sai định vị — đơn thực tế thuộc địa bàn trung tâm",
};

export function computeScene({ orders, drvIds, date, eps, k, minKm, driverInfo, auto }) {
  const drvSet = new Set(drvIds);
  const dayOrders = orders.filter(o => drvSet.has(o.driver) && o.date === date);
  const colorOf = id => PALETTE[Math.max(0, drvIds.indexOf(id)) % PALETTE.length];
  const nameOf = id => (driverInfo[id] && driverInfo[id].name) || String(id);
  const plain = !dayOrders.some(o => o.epic);

  const layers = [], perDrv = [], farRows = [];
  const counts = { good: 0, removed: 0, near: 0, far: 0, misgeo: 0 };

  const popup = (o, kindLabel, extra = "") =>
    `<b>${esc(o.code)}</b>` + (kindLabel ? `<br>${kindLabel}` : "") +
    (o.address ? `<br>📍 ${esc(o.address)}` : "") +
    `<br>Tài xế ${esc(D.driverLabel(o.driver, driverInfo))} · ${esc(o.date)}` + extra;

  /* ---- chế độ "toàn đơn": file không có is_epic → chỉ vẽ đơn, mỗi tài xế một màu ---- */
  if (plain) {
    for (const id of drvIds) {
      const dOrders = dayOrders.filter(o => o.driver === id);
      if (!dOrders.length) continue;
      const color = colorOf(id);
      const pts = dOrders.filter(o => o.hasCoord);
      for (const o of pts) {
        layers.push({
          driver: id, cat: "order", type: "circle", lat: o.lat, lng: o.lng, code: o.code,
          style: { color: "#ffffff", fillColor: color, radius: 5, weight: 1.2, fillOpacity: 0.9 },
          popup: popup(o),
        });
      }
      perDrv.push({
        id, color, name: nameOf(id), total: dOrders.length, far: 0,
        sub: `ID ${id} · có toạ độ ${pts.length}/${dOrders.length}`,
      });
    }
    return {
      plain, layers, perDrv, farRows, counts, clusterCount: 0,
      stats: { totalOrders: perDrv.reduce((s, p) => s + p.total, 0), drvCount: perDrv.length },
    };
  }

  /* ---- chế độ detect: chạy RIÊNG từng tài xế (vùng EPIC là của cá nhân) rồi tổng hợp ---- */
  let clusterCount = 0;
  const dets = [];
  const epsUsed = [];
  for (const id of drvIds) {
    const dOrders = dayOrders.filter(o => o.driver === id);
    if (!dOrders.length) continue;
    // chế độ tự đề xuất: tham số tính RIÊNG theo phân bố điểm EPIC của từng tài xế
    const params = auto ? D.suggestParams(dOrders) : { epsMeters: eps, k, minKm };
    epsUsed.push(params.epsMeters);
    const det = D.detect(dOrders, params);
    dets.push(det);
    clusterCount += det.clusters.length;
    const dColor = colorOf(id);

    // vùng cụm EPIC — tô theo màu tài xế để khớp với thẻ bên phải
    for (const cl of det.clusters) {
      const hull = D.convexHull(cl);
      if (hull.length >= 3) {
        layers.push({
          driver: id, cat: "hull", type: "polygon", latlngs: hull.map(p => [p.lat, p.lng]),
          style: { color: dColor, weight: 1.5, fillColor: dColor, fillOpacity: 0.12, interactive: false },
        });
      }
    }

    const addMarker = (o, kind, extra = "") => {
      counts[kind]++;
      layers.push({
        driver: o.driver, cat: kind === "far" ? "far" : "order", type: "circle",
        lat: o.lat, lng: o.lng, code: o.code,
        style: MARKER_STYLE[kind], popup: popup(o, KIND_LABEL[kind], extra),
      });
    };

    for (const o of dOrders.filter(x => x.epic && x.hasCoord)) {
      // đơn gợi ý bị gỡ: hiện ai giao thực tế (từ cột actual_driver_name nếu có)
      const extra = (!o.assigned && o.actualNames && o.actualIds !== o.driver)
        ? `<br>↪ Giao thực tế: <b>${esc(o.actualNames)}</b>` : "";
      addMarker(o, o.assigned ? "good" : "removed", extra);
    }

    // hồ sơ địa chỉ vùng trung tâm: đơn EPIC + đơn ngoài-nhưng-gần → bắt đơn sai định vị
    const centerProfile = D.buildCenterProfile(
      dOrders.filter(o => o.epic).concat(det.results.filter(r => !r.far).map(r => r.order)));
    let farCnt = 0;

    for (const r of det.results) {
      if (r.far) {
        const verdict = D.addrVerdict(r.order, centerProfile);
        if (verdict === "A") {
          // trùng cả đường lẫn phường/xã → toạ độ sai, đơn thực tế trong địa bàn → loại khỏi cảnh báo
          addMarker(r.order, "misgeo",
            `<br>📍 Địa chỉ trùng <b>đường & phường/xã</b> với vùng trung tâm — pin lệch ${fmtKm(r.dist)}, đã loại khỏi cảnh báo`);
          continue;
        }
        farCnt++;
        layers.push({
          driver: id, cat: "far", type: "polyline",
          latlngs: [[r.order.lat, r.order.lng], [r.nearest.lat, r.nearest.lng]],
          style: { color: "#d03b3b", weight: 1.5, dashArray: "5 5", opacity: 0.7, interactive: false },
        });
        layers.push({
          driver: id, cat: "far", type: "circle", lat: r.order.lat, lng: r.order.lng, halo: true,
          style: { radius: 13, color: "#d03b3b", weight: 1.5, fill: false, opacity: 0.5, interactive: false },
        });
        const wardTxt = verdict === "B" ? (D.addrWard(r.order.address) || "địa bàn trung tâm") : null;
        addMarker(r.order, "far",
          `<br>Cách vùng EPIC: <b>${fmtKm(r.dist)}</b> (ngưỡng ${fmtKm(det.threshold)})` +
          (verdict === "B" ? `<br>❓ <b>Có thể sai định vị</b> — địa chỉ cùng "${esc(wardTxt)}" với trung tâm` : ""));
        farRows.push({ order: r.order, dist: r.dist, threshold: det.threshold, verdict });
      } else {
        addMarker(r.order, "near", `<br>Cách vùng EPIC: <b>${fmtKm(r.dist)}</b>`);
      }
    }

    const epicTotal = dOrders.filter(o => o.epic).length;
    const epicAssigned = dOrders.filter(o => o.epic && o.assigned).length;
    perDrv.push({
      id, color: dColor, name: nameOf(id),
      total: dOrders.filter(o => o.assigned).length, far: farCnt,
      sub: `ID ${id} · %gợi ý ${epicTotal ? Math.round(100 * epicAssigned / epicTotal) + "%" : "–"}` +
           ` · ngoài ${dOrders.filter(o => !o.epic && o.assigned).length}` +
           (auto ? ` · eps ${params.epsMeters}m` : ""),
    });
  }

  farRows.sort((a, b) => b.dist - a.dist);

  const epicTotal = dayOrders.filter(o => o.epic).length;
  const epicAssigned = dayOrders.filter(o => o.epic && o.assigned).length;
  const totalAssigned = dayOrders.filter(o => o.assigned).length;
  const outsideAssigned = dayOrders.filter(o => !o.epic && o.assigned).length;
  const allDists = dets.flatMap(d => d.results.map(r => r.dist));
  const ths = dets.map(d => d.threshold);
  return {
    plain, layers, perDrv, farRows, counts, clusterCount,
    stats: {
      compliance: epicTotal ? Math.round(100 * epicAssigned / epicTotal) : null,
      outsidePct: totalAssigned ? Math.round(100 * outsideAssigned / totalAssigned) : null,
      epicAssigned, epicTotal, noCoord: dayOrders.filter(o => !o.hasCoord).length,
      maxDist: allDists.length ? Math.max(...allDists) : null,
      thMin: ths.length ? Math.min(...ths) : null,
      thMax: ths.length ? Math.max(...ths) : null,
      p90: dets.length === 1 ? dets[0].p90 : null,
      threshold: dets.length === 1 ? dets[0].threshold : null,
      noiseCnt: dets.filter(d => d.allNoise).length,
      maybeCnt: farRows.filter(r => r.verdict === "B").length,
      epsMin: epsUsed.length ? Math.min(...epsUsed) : null,
      epsMax: epsUsed.length ? Math.max(...epsUsed) : null,
    },
  };
}
