import { useEffect, useMemo, useRef, useState } from "react";
import * as D from "./detect.js";
import { computeScene, groupByDriver, evalAbnormal, NO_BC, ALL_DRV, fmtKm } from "./scene.js";
import MapView from "./MapView.jsx";
import GuideModal from "./GuideModal.jsx";
import SearchSelect from "./SearchSelect.jsx";
import ReportView from "./ReportView.jsx";
import { buildReport, isAbnormal, farOrdersOf, driverSummaries, removedDestinations, SCENARIOS } from "./report.js";
import { downloadXlsx, slugify } from "./xlsx.js";

/* Dữ liệu tách theo ngày trong /public/data — app chỉ tải file của ngày đang chọn.
   manifest.json liệt kê các ngày có sẵn; thiếu nó thì rơi về file gộp cũ (LEGACY_CSV). */
const MANIFEST_URL = "data/manifest.json";
const dayUrl = d => `data/${d}.csv`;
const LEGACY_CSV = "test.csv";
const DAY_CACHE_MAX = 3; // số ngày giữ trong RAM
const EMPTY_SCAN = { rows: [], skipped: 0, drivers: 0 };

/* Chấm MỌI tài xế của 1 ngày bằng evalAbnormal, theo lô ~30ms rồi nhả main thread
   (file lớn, nghìn tài xế không làm đơ UI). Trả hàm huỷ. Kết quả: mọi tài xế đánh giá được
   (kể cả không bất thường) — nút 🚨 lọc theo isAbnormal, trang báo cáo dùng toàn bộ. */
function scanDay(dayOrders, date, info, onDone) {
  let cancelled = false;
  const entries = [...groupByDriver(dayOrders, date)];
  const rows = [];
  let skipped = 0, i = 0;
  function step() {
    if (cancelled) return;
    const t0 = performance.now();
    while (i < entries.length && performance.now() - t0 < 30) {
      const [id, dOrders] = entries[i++];
      const r = evalAbnormal(dOrders);
      if (!r) { skipped++; continue; }
      const d = info[id] || {};
      rows.push({ id, name: d.name || String(id), bc: d.bc || NO_BC, ...r });
    }
    if (i < entries.length) setTimeout(step, 0);
    else onDone({ rows, skipped, drivers: entries.length });
  }
  step();
  return () => { cancelled = true; };
}

export default function App() {
  const [orders, setOrders] = useState([]);
  const [driverCsv, setDriverCsv] = useState(null);
  const [manifestDates, setManifestDates] = useState([]);
  const [perDay, setPerDay] = useState(false); // true = đang chạy chế độ tách theo ngày
  const [loadingDay, setLoadingDay] = useState(false);
  const [dataErr, setDataErr] = useState(null);
  const dayCache = useRef(new Map());
  const [bc, setBc] = useState("");
  const [driver, setDriver] = useState(ALL_DRV);
  const [date, setDate] = useState("");
  const [eps, setEps] = useState(400);
  const [k, setK] = useState(3);
  const [minKm, setMinKm] = useState(1);
  const [sort, setSort] = useState("don");
  const [auto, setAuto] = useState(true); // tự đề xuất tham số theo từng tài xế
  const [focused, setFocused] = useState(() => new Set());
  const [toggles, setToggles] = useState({ hull: true, order: true, far: true });
  const [activeCode, setActiveCode] = useState(null);
  const [showGuide, setShowGuide] = useState(false);
  const [showAbn, setShowAbn] = useState(false);
  const [showCfg, setShowCfg] = useState(false); // dropdown tham số — chỉ mở khi cần chỉnh
  const [view, setView] = useState("map"); // "map" | "report" — báo cáo phủ lên bản đồ, map vẫn mount
  const mapApi = useRef(null);
  const abnRef = useRef(null);
  const cfgRef = useRef(null);

  /* ---- nạp manifest + drivers.csv, rồi tải ngày mới nhất ---- */
  useEffect(() => {
    Promise.all([
      fetch(MANIFEST_URL).then(r => (r.ok ? r.json() : null)).catch(() => null),
      fetch("drivers.csv").then(r => (r.ok ? r.text() : null)).catch(() => null),
    ]).then(([man, drv]) => {
      setDriverCsv(drv);
      const ds = man && Array.isArray(man.dates) ? man.dates.slice().sort() : null;
      if (ds && ds.length) {
        setManifestDates(ds);
        setPerDay(true);
        setDate(ds[ds.length - 1]); // mặc định ngày mới nhất
        return;
      }
      // không có manifest → file gộp cũ, giữ nguyên hành vi cũ
      fetch(LEGACY_CSV).then(r => (r.ok ? r.text() : null)).catch(() => null)
        .then(csv => { if (csv) setOrders(D.loadOrders(csv)); });
    });
  }, []);

  /* ---- tải CSV của ngày đang chọn (chỉ ở chế độ tách ngày) ----
     KHÔNG xoá orders cũ trong lúc tải: danh sách BC / tài xế phải còn nguyên,
     nếu không select tài xế sẽ tự nhảy về "cả bưu cục" mỗi lần đổi ngày. */
  useEffect(() => {
    if (!perDay || !date) return;
    const cached = dayCache.current.get(date);
    if (cached) { setOrders(cached); return; }
    let cancelled = false;
    setLoadingDay(true);
    setDataErr(null);
    fetch(dayUrl(date))
      .then(r => (r.ok ? r.text() : Promise.reject(new Error("HTTP " + r.status))))
      .then(txt => {
        if (cancelled) return;
        const next = D.loadOrders(txt);
        const c = dayCache.current;
        c.set(date, next);
        for (const k of [...c.keys()]) { if (c.size <= DAY_CACHE_MAX) break; if (k !== date) c.delete(k); }
        setOrders(next);
      })
      .catch(err => { if (!cancelled) setDataErr(`Không tải được dữ liệu ngày ${date} (${err.message}).`); })
      .finally(() => { if (!cancelled) setLoadingDay(false); });
    return () => { cancelled = true; };
  }, [perDay, date]);

  const driverInfo = useMemo(() => D.buildDriverInfo(orders, driverCsv), [orders, driverCsv]);
  const bcOf = id => (driverInfo[id] && driverInfo[id].bc) || NO_BC;

  /* ---- cascade lọc: BC → tài xế → ngày ---- */
  const allDrivers = useMemo(() => [...new Set(orders.map(o => o.driver))], [orders]);
  const bcs = useMemo(() => [...new Set(allDrivers.map(bcOf))].sort(), [allDrivers, driverInfo]);
  useEffect(() => { if (bcs.length && !bcs.includes(bc)) setBc(bcs[0]); }, [bcs]);

  const bcDrivers = useMemo(() => allDrivers.filter(d => bcOf(d) === bc).sort(), [allDrivers, bc, driverInfo]);
  useEffect(() => { if (driver !== ALL_DRV && !bcDrivers.includes(driver)) setDriver(ALL_DRV); }, [bcDrivers]);

  const drvIds = driver === ALL_DRV ? bcDrivers : [driver];
  const drvKey = drvIds.join(",");
  const derivedDates = useMemo(() => {
    const set = new Set(drvIds);
    return [...new Set(orders.filter(o => set.has(o.driver)).map(o => o.date))].sort();
  }, [orders, drvKey]);
  const dates = perDay ? manifestDates : derivedDates;
  useEffect(() => {
    if (dates.length && !dates.includes(date)) setDate(perDay ? dates[dates.length - 1] : dates[0]);
  }, [dates, perDay]);

  // đổi phạm vi xem → bỏ hết tick
  useEffect(() => { setFocused(new Set()); setActiveCode(null); }, [bc, driver, date]);

  /* ---- quét bất thường toàn dữ liệu (mọi bưu cục) theo ngày đang chọn ----
     chạy NGOÀI render (scanDay, lô ~30ms) — không đưa vào useMemo. Kết quả đầy đủ mọi tài xế
     được giữ trong `scan` (trang báo cáo dùng) và ghi vào `history[date]` (xu hướng). */
  const [scan, setScan] = useState(EMPTY_SCAN);
  const [abnBusy, setAbnBusy] = useState(false);
  const [history, setHistory] = useState({});       // { [date]: {rows, skipped, drivers, failed?} }
  const [histProgress, setHistProgress] = useState(null);
  useEffect(() => {
    if (!orders.length || !date) { setScan(EMPTY_SCAN); setAbnBusy(false); return; }
    setAbnBusy(true);
    return scanDay(orders, date, driverInfo, res => {
      setScan(res);
      setAbnBusy(false);
      // lúc đang tải ngày mới, orders vẫn là ngày cũ → drivers = 0 → không ghi đè lịch sử
      if (res.drivers > 0) setHistory(h => ({ ...h, [date]: res }));
    });
  }, [orders, date, driverInfo]);
  const abnormal = useMemo(
    () => scan.rows.filter(isAbnormal).sort((a, b) => b.far - a.far || b.ratio - a.ratio),
    [scan],
  );

  /* ---- mọi ngày có dữ liệu (cho xu hướng): manifest, hoặc suy từ file nạp tay ---- */
  const allDates = useMemo(
    () => (perDay ? manifestDates : [...new Set(orders.map(o => o.date))].sort()),
    [perDay, manifestDates, orders],
  );

  /* ---- quét nền lịch sử khi mở báo cáo: từng ngày còn thiếu, tải CSV → scanDay ----
     Chạy tuần tự để không chiếm băng thông/CPU; kết quả chỉ giữ chỉ số per-driver
     (không giữ orders) nên nhẹ. Đổi view/ngày → huỷ và tính lại danh sách thiếu. */
  useEffect(() => {
    if (view !== "report") return;
    const missing = allDates.filter(d => !history[d] && d !== date);
    if (!missing.length) { setHistProgress(null); return; }
    let cancelled = false, cancelScan = null;
    setHistProgress({ done: allDates.length - missing.length, total: allDates.length });
    (async () => {
      for (const d of missing) {
        if (cancelled) return;
        let dayOrders, failed = false;
        if (!perDay) dayOrders = orders;
        else if (dayCache.current.has(d)) dayOrders = dayCache.current.get(d);
        else {
          try {
            const txt = await fetch(dayUrl(d)).then(r => (r.ok ? r.text() : Promise.reject(new Error("HTTP " + r.status))));
            dayOrders = D.loadOrders(txt);
          } catch { dayOrders = []; failed = true; }
        }
        if (cancelled) return;
        const info = perDay ? D.buildDriverInfo(dayOrders, driverCsv) : driverInfo;
        const res = await new Promise(resolve => { cancelScan = scanDay(dayOrders, d, info, resolve); });
        if (cancelled) return;
        setHistory(h => ({ ...h, [d]: { ...res, failed: failed || res.drivers === 0 } }));
        setHistProgress(p => (p ? { ...p, done: p.done + 1 } : p));
      }
      if (!cancelled) setHistProgress(null);
    })();
    return () => { cancelled = true; if (cancelScan) cancelScan(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, allDates, date, perDay]);

  const report = useMemo(
    () => buildReport({ rows: scan.rows, skipped: scan.skipped, drivers: scan.drivers, date, history, dates: allDates }),
    [scan, date, history, allDates],
  );
  const removedDest = useMemo(
    () => (view === "report" ? removedDestinations(orders, date, report.table.map(t => t.id), driverInfo) : null),
    [view, orders, date, report, driverInfo],
  );
  /* Thẻ "Tóm tắt cảnh báo" cuối trang báo cáo: chạy lại detect cho từng tài xế bất thường để có
     từng đơn xa (Excel) + điểm vẽ mini-map. Phụ thuộc vào DANH SÁCH id chứ không phải `report`
     — report đổi identity mỗi lần quét xong thêm một ngày lịch sử, còn đơn xa của ngày thì không. */
  /* Danh bạ cho ô "Tra cứu tài xế" trên báo cáo: mọi id từng xuất hiện trong ngày đang xem
     hoặc trong lịch sử đã quét (tên/BC ưu tiên dữ liệu ngày hiện tại). */
  const directory = useMemo(() => {
    if (view !== "report") return [];
    const m = new Map();
    for (const d of Object.keys(history)) for (const r of history[d].rows) m.set(r.id, { id: r.id, name: r.name, bc: r.bc });
    for (const id of allDrivers) {
      const info = driverInfo[id] || {};
      m.set(id, { id, name: info.name || String(id), bc: info.bc || NO_BC });
    }
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name, "vi"));
  }, [view, history, allDrivers, driverInfo]);
  const abnIdKey = report.table.map(t => t.id).join(",");
  const summaries = useMemo(
    () => (view === "report" && abnIdKey ? driverSummaries(orders, date, report.table) : []),
    [view, orders, date, abnIdKey], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const [abnPos, setAbnPos] = useState(null);
  function placeAbn() {
    const btn = abnRef.current && abnRef.current.querySelector(".abn-btn");
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    const w = Math.min(400, window.innerWidth - 24);
    // kẹp trong viewport — nút có thể nằm sát mép phải khi navbar xuống dòng
    setAbnPos({ top: r.bottom + 6, left: Math.min(Math.max(12, r.left), window.innerWidth - w - 12), width: w });
  }
  useEffect(() => {
    if (!showAbn) return;
    const onDoc = e => { if (abnRef.current && !abnRef.current.contains(e.target)) setShowAbn(false); };
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("resize", placeAbn);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("resize", placeAbn);
    };
  }, [showAbn]);
  useEffect(() => {
    if (!showCfg) return;
    const onDoc = e => { if (cfgRef.current && !cfgRef.current.contains(e.target)) setShowCfg(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [showCfg]);
  function gotoAbnormal(row) {
    setBc(row.bc);
    setDriver(row.id);
    setShowAbn(false);
    setView("map");
  }

  /* ---- tính toàn cảnh ---- */
  const scene = useMemo(
    () => computeScene({ orders, drvIds, date, eps, k, minKm, driverInfo, auto }),
    [orders, drvKey, date, eps, k, minKm, driverInfo, auto],
  );

  const sortedDrv = useMemo(() => {
    const arr = scene.perDrv.slice();
    if (sort === "don") arr.sort((a, b) => b.total - a.total);
    else if (sort === "far") arr.sort((a, b) => b.far - a.far || b.total - a.total);
    else arr.sort((a, b) => a.name.localeCompare(b.name, "vi"));
    return arr;
  }, [scene, sort]);

  const visibleFarRows = useMemo(
    () => scene.farRows.filter(r => focused.size === 0 || focused.has(r.order.driver)),
    [scene, focused],
  );

  /* ---- hành động ---- */
  function toggleDriver(id) {
    setFocused(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }
  function onUpload(e) {
    const f = e.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const next = D.loadOrders(reader.result);
        if (!next.length) { alert("Không đọc được dòng dữ liệu hợp lệ nào trong file CSV."); return; }
        setPerDay(false);   // file người dùng nạp tay: ngày suy ra từ chính file đó
        setManifestDates([]);
        setDataErr(null);
        dayCache.current.clear();
        setHistory({}); // lịch sử của bộ dữ liệu cũ không còn ý nghĩa
        setOrders(next);
      } catch (err) { alert("Lỗi đọc CSV: " + err.message); }
    };
    reader.readAsText(f, "utf-8");
  }
  function exportCsv() {
    if (!visibleFarRows.length) return;
    const lines = ["load_date,driver_id,driver_name,bc_name,order_code,contact_address,contact_latlng,dist_to_epic_m,threshold_m,verdict"];
    for (const r of visibleFarRows) {
      const info = driverInfo[r.order.driver] || { name: "", bc: "" };
      const addr = (r.order.address || "").replace(/"/g, '""');
      const verdict = r.verdict === "B" ? "co_the_sai_dinh_vi" : "canh_bao";
      lines.push(`${date},${r.order.driver},"${info.name || ""}","${info.bc || ""}",${r.order.code},"${addr}","${r.order.lat},${r.order.lng}",${Math.round(r.dist)},${Math.round(r.threshold)},${verdict}`);
    }
    const scope = driver === ALL_DRV ? "BC" : driver;
    const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `canh_bao_don_xa_EPIC_${scope}_${date}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }
  /* Xuất từng đơn xa của MỌI tài xế bất thường trong ngày (mọi bưu cục), kèm kịch bản + tái phạm —
     file AM gửi bưu cục xử lý theo SOP. Chạy lại detect cho vài chục tài xế nên nhanh. */
  function exportReportCsv() {
    if (!report.table.length) return;
    const byId = Object.fromEntries(report.table.map(t => [t.id, t]));
    const far = farOrdersOf(orders, date, Object.keys(byId));
    const scenLabel = Object.fromEntries(SCENARIOS.map(s => [s.key, s.label]));
    const q = s => `"${String(s == null ? "" : s).replace(/"/g, '""')}"`;
    const lines = ["load_date,driver_id,driver_name,bc_name,order_code,contact_address,contact_latlng,dist_to_epic_m,threshold_m,verdict,far_ratio_pct,epic_compliance_pct,scenarios,flag_7d,flag_14d"];
    for (const r of far) {
      const t = byId[r.driver];
      const verdict = r.verdict === "B" ? "co_the_sai_dinh_vi" : "canh_bao";
      lines.push([
        date, r.driver, q(t.name), q(t.bc), r.order.code, q(r.order.address), q(`${r.order.lat},${r.order.lng}`),
        Math.round(r.dist), Math.round(r.threshold), verdict,
        Math.round(100 * t.ratio), t.compliance == null ? "" : Math.round(100 * t.compliance),
        q(t.scenarios.map(k => scenLabel[k]).join("; ")), t.flag7, t.flag14,
      ].join(","));
    }
    const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `bao_cao_bat_thuong_EPIC_${date}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }
  /* Excel .xlsx cho thẻ tóm tắt: một sheet đơn xa của 1 tài xế (nút "Chi tiết" trên thẻ),
     hoặc mỗi tài xế một sheet + sheet tổng hợp (nút "Excel tất cả"). File gửi thẳng bưu cục
     nên cột đặt tên tiếng Việt, khác với CSV kỹ thuật ở trên. */
  const XLSX_HEADER = ["Ngày", "Bưu cục", "Mã tài xế", "Tài xế", "Mã đơn", "Địa chỉ giao", "Toạ độ", "Cách vùng EPIC (m)", "Ngưỡng (m)", "Kết luận"];
  const XLSX_WIDTHS = [12, 24, 12, 24, 14, 60, 22, 18, 12, 24];
  const xlsxRows = s => s.farRows.map(r => [
    date, s.bc, s.id, s.name, r.order.code, r.order.address, `${r.order.lat},${r.order.lng}`,
    Math.round(r.dist), Math.round(r.threshold), r.verdict === "B" ? "❓ có thể sai định vị" : "Cảnh báo gán ngoài xa vùng EPIC",
  ]);
  function exportDriverXlsx(s) {
    if (!s || !s.farRows.length) return;
    downloadXlsx(`canh_bao_gan_ngoai_${slugify(s.name)}_${s.id}_${date}.xlsx`,
      [{ name: s.name || s.id, header: XLSX_HEADER, rows: xlsxRows(s), widths: XLSX_WIDTHS }]);
  }
  function exportAllXlsx() {
    if (!summaries.length) return;
    const all = { name: "Tổng hợp", header: ["Bưu cục", "Mã tài xế", "Tài xế", "Số đơn gán ngoài bất thường", "❓ nghi sai định vị"], widths: [28, 12, 28, 26, 20],
      rows: summaries.map(s => [s.bc, s.id, s.name, s.far, s.maybe]) };
    const detail = { name: "Chi tiết đơn xa", header: XLSX_HEADER, widths: XLSX_WIDTHS, rows: summaries.flatMap(xlsxRows) };
    downloadXlsx(`canh_bao_gan_ngoai_bat_thuong_${date}.xlsx`, [all, detail]);
  }

  const st = scene.stats;
  const effK = auto ? 3 : k, effMin = auto ? 1 : minKm; // giá trị hiệu lực khi bật tự đề xuất
  return (
    <div className="app">
      <header>
        <h1>EPIC Order Map<span className="sub">phát hiện đơn gán ngoài xa vùng gợi ý</span></h1>
        <div className="controls">
          <div className="ctl">
            <label>Bưu cục</label>
            <SearchSelect width={215} placeholder="Tìm bưu cục…"
              options={bcs.map(b => ({ value: b, label: b }))}
              value={bc} onChange={setBc} />
          </div>
          <div className="ctl">
            <label>Tài xế</label>
            <SearchSelect width={250} placeholder="Tìm theo tên hoặc ID…"
              options={[
                { value: ALL_DRV, label: `— Cả bưu cục (${bcDrivers.length} tài xế) —` },
                ...bcDrivers.map(d => {
                  const info = driverInfo[d];
                  return { value: d, label: d + (info && info.name ? " — " + info.name : "") };
                }),
              ]}
              value={driver} onChange={setDriver} />
          </div>
          <div className="ctl">
            <label>Ngày{loadingDay ? " — đang tải…" : ""}</label>
            <select value={date} onChange={e => setDate(e.target.value)} disabled={loadingDay}>
              {dates.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
          <div className="cfg-wrap" ref={cfgRef}>
            <button className={"filebtn cfg-btn" + (auto ? "" : " custom")}
              title="Tham số thuật toán phát hiện đơn xa — mặc định tự đề xuất theo từng tài xế, chỉ mở khi cần chỉnh"
              onClick={() => setShowCfg(s => !s)}>
              ⚙ Tham số: {auto ? "tự đề xuất" : "tuỳ chỉnh"}
            </button>
            {showCfg && (
              <div className="cfg-pop">
                <label className="autobox" title="Tính eps riêng cho từng tài xế theo mật độ điểm EPIC (P90 láng giềng); k=3, sàn 1km theo backtest">
                  <input type="checkbox" checked={auto} onChange={e => setAuto(e.target.checked)} />
                  Tự đề xuất tham số theo từng tài xế
                </label>
                <div className={"ctl" + (auto ? " dim" : "")}>
                  <label>DBSCAN eps</label>
                  <input type="range" min="100" max="1000" step="50" value={eps} disabled={auto} onChange={e => setEps(+e.target.value)} />
                  <span className="val">{auto ? "auto" : eps + " m"}</span>
                </div>
                <div className={"ctl" + (auto ? " dim" : "")}>
                  <label>Hệ số k</label>
                  <input type="range" min="1" max="6" step="0.5" value={k} disabled={auto} onChange={e => setK(+e.target.value)} />
                  <span className="val">{auto ? "3.0×" : k.toFixed(1) + "×"}</span>
                </div>
                <div className={"ctl" + (auto ? " dim" : "")}>
                  <label>Ngưỡng tối thiểu</label>
                  <input type="range" min="0.2" max="3" step="0.1" value={minKm} disabled={auto} onChange={e => setMinKm(+e.target.value)} />
                  <span className="val">{auto ? "1.0 km" : minKm.toFixed(1) + " km"}</span>
                </div>
              </div>
            )}
          </div>
          <div className="abn-wrap" ref={abnRef}>
            <button className={"filebtn abn-btn" + (abnormal.length ? " has" : "")}
              title="Tài xế có đơn xa vùng EPIC ≥ 10% tổng đơn gán thực tế (và ≥ 5 đơn) — quét toàn bộ bưu cục trong dữ liệu"
              onClick={() => { placeAbn(); setShowAbn(s => !s); }}>
              🚨 Bất thường: {abnBusy ? "…" : abnormal.length}
            </button>
            {showAbn && abnPos && (
              <div className="abn-pop" style={{ top: abnPos.top, left: abnPos.left, width: abnPos.width }}>
                <div className="abn-head">Tài xế gán ngoài bất thường{date ? ` — ${date}` : ""}</div>
                <div className="abn-note">
                  Quét <b>toàn bộ bưu cục</b> trong dữ liệu, tham số tự đề xuất theo từng tài xế.
                  Tiêu chí: đơn <b>XA vùng EPIC ≥ 10%</b> tổng đơn gán thực tế <b>và ≥ 5 đơn</b> (đã
                  loại đơn sai định vị). Bấm vào tài xế để mở xem trên bản đồ.
                </div>
                <div className="abn-list">
                  {abnormal.map(r => (
                    <div className="abn-row" key={r.id} onClick={() => gotoAbnormal(r)}>
                      <div className="abn-info">
                        <div className="abn-nm">{r.name}</div>
                        <div className="abn-sub">ID {r.id} · {r.bc}</div>
                      </div>
                      <div className="abn-stats">
                        <span className="abn-far">⚠ {r.far} / {r.assigned} đơn</span>
                        <span className="abn-pct">{Math.round(r.ratio * 100)}% đơn gán
                          {r.maybe > 0 && <> · ❓ {r.maybe} nghi sai định vị</>}</span>
                      </div>
                    </div>
                  ))}
                  {!abnormal.length && (
                    <div className="abn-empty">{abnBusy ? "Đang quét…" : "Không có tài xế nào vượt ngưỡng 🎉"}</div>
                  )}
                </div>
                <button className="abn-report" onClick={() => { setShowAbn(false); setView("report"); }}>
                  📊 Xem báo cáo tổng hợp →
                </button>
              </div>
            )}
          </div>
          <button className={"filebtn" + (view === "report" ? " on" : "")}
            title="Trang phân tích tổng hợp các tài xế bất thường: KPI, theo bưu cục, kịch bản, xu hướng nhiều ngày"
            onClick={() => setView(v => (v === "report" ? "map" : "report"))}>
            {view === "report" ? "🗺 Bản đồ" : "📊 Báo cáo"}
          </button>
          <label className="filebtn">Nạp CSV khác…
            <input type="file" accept=".csv" style={{ display: "none" }} onChange={onUpload} />
          </label>
          <button className="filebtn" onClick={() => setShowGuide(true)}>📖 Hướng dẫn lấy dữ liệu</button>
        </div>
      </header>

      <GuideModal open={showGuide} onClose={() => setShowGuide(false)} />

      {dataErr && (
        <div className="data-err" role="alert">
          ⚠️ {dataErr} Kiểm tra <code>public/data/</code> và <code>manifest.json</code>, chạy <code>node scripts/pull-prod-data.mjs</code> để kéo 14 ngày từ production về, hoặc <code>npm run append:data</code>.
        </div>
      )}

      <main>
        {view === "report" && (
          <ReportView report={report} dates={allDates} histProgress={histProgress} removedDest={removedDest}
            summaries={summaries} onExportDriverXlsx={exportDriverXlsx} onExportAllXlsx={exportAllXlsx}
            directory={directory} history={history} onPickDate={setDate}
            directory={directory} history={history} scanBusy={abnBusy}
            onGoto={gotoAbnormal} onExport={exportReportCsv} onBack={() => setView("map")}
            driverInfoNote={loadingDay ? `Đang tải dữ liệu ngày ${date}…` : null} />
        )}
        <div id="mapwrap">
          <MapView layers={scene.layers} focused={focused} toggles={toggles} apiRef={mapApi} />

          {/* công tắc lớp bản đồ */}
          <div className="float-panel toggles">
            {!scene.plain && (
              <label className="switch-row">Vùng cụm EPIC
                <input type="checkbox" checked={toggles.hull} onChange={e => setToggles({ ...toggles, hull: e.target.checked })} />
                <span className="sw" />
              </label>
            )}
            <label className="switch-row">Đơn trên bản đồ
              <input type="checkbox" checked={toggles.order} onChange={e => setToggles({ ...toggles, order: e.target.checked })} />
              <span className="sw" />
            </label>
            {!scene.plain && (
              <label className="switch-row">Đơn cảnh báo
                <input type="checkbox" checked={toggles.far} onChange={e => setToggles({ ...toggles, far: e.target.checked })} />
                <span className="sw" />
              </label>
            )}
          </div>

          {/* chú giải */}
          {!scene.plain && (
            <div className="float-panel legend-panel">
              <div className="lg-title">Chú giải</div>
              <div className="legend">
                <div className="row"><span className="dot good" /> EPIC — gán đúng gợi ý <span className="n">{scene.counts.good}</span></div>
                <div className="row"><span className="dot removed" /> EPIC — bị gỡ / không gán <span className="n">{scene.counts.removed}</span></div>
                <div className="row"><span className="dot near" /> Ngoài — gần vùng EPIC <span className="n">{scene.counts.near}</span></div>
                <div className="row"><span className="dot far" /> ⚠ Ngoài — XA vùng EPIC <span className="n">{scene.counts.far}</span></div>
                <div className="row"><span className="dot misgeo" /> Sai định vị — loại khỏi cảnh báo <span className="n">{scene.counts.misgeo}</span></div>
                <div className="row"><span className="swatch-hull" /> Vùng cụm EPIC <span className="n">{scene.clusterCount} cụm</span></div>
                <div className="row"><span className="nocoord">◌</span> Không có toạ độ <span className="n">{st.noCoord}</span></div>
              </div>
            </div>
          )}
        </div>

        <aside>
          <div className="drv-head">
            <div className="t">Tài xế · <span>{sortedDrv.length}</span></div>
            <select value={sort} onChange={e => setSort(e.target.value)} title="Sắp xếp">
              <option value="don">Theo số đơn</option>
              <option value="far">Theo cảnh báo</option>
              <option value="ten">Theo tên</option>
            </select>
          </div>

          <div id="drvList">
            {sortedDrv.map(p => (
              <div className="drv-card" key={p.id}>
                <input type="checkbox" title="Chỉ hiện tài xế được tick"
                  checked={focused.has(p.id)} onChange={() => toggleDriver(p.id)} />
                <span className="bar" style={{ background: p.color }} />
                <div className="info">
                  <div className="nm" style={{ color: p.color }}>{p.name}</div>
                  <div className="sub">{p.sub}</div>
                </div>
                {p.far > 0 && <span className="badge red">⚠ {p.far}</span>}
                <span className="badge">{p.total}</span>
                <button className="locate" title="Phóng tới khu vực giao"
                  onClick={() => mapApi.current && mapApi.current.zoomToDriver(p.id)}>◎</button>
              </div>
            ))}
          </div>

          {!scene.plain && (
            <div className="aside-sec">
              <div className="tiles">
                <div className="tile">
                  <div className="v">{st.compliance != null ? st.compliance + "%" : "–"}</div>
                  <div className="l">%Gán theo gợi ý<br />(đơn EPIC được gán / tổng đơn EPIC)</div>
                </div>
                <div className="tile">
                  <div className="v">{st.outsidePct != null ? st.outsidePct + "%" : "–"}</div>
                  <div className="l">%Đơn ngoài / tổng đơn gán</div>
                </div>
                <div className="tile alert">
                  <div className="v">{scene.counts.far} đơn</div>
                  <div className="l">Đơn ngoài XA vùng EPIC<br />(vượt ngưỡng, sau soát địa chỉ)</div>
                </div>
                <div className="tile">
                  <div className="v">{st.maxDist != null ? fmtKm(st.maxDist) : "–"}</div>
                  <div className="l">Khoảng cách xa nhất<br />đến vùng EPIC</div>
                </div>
              </div>
            </div>
          )}

          <div className="aside-sec">
            <div className="thresh-note">
              {scene.plain ? (
                <>Chế độ <b>toàn đơn</b> — file không có cột <b>is_epic / is_assigned</b> nên không chạy phát hiện;
                  mỗi tài xế một màu. Ngày này: <b>{st.totalOrders}</b> đơn / <b>{st.drvCount}</b> tài xế.</>
              ) : driver === ALL_DRV ? (
                <>{auto && st.epsMin != null && <>⚙ <b>Tham số tự đề xuất theo từng tài xế</b> — eps <b>{st.epsMin === st.epsMax ? `${st.epsMin} m` : `${st.epsMin}–${st.epsMax} m`}</b> (≈ P90 láng giềng điểm EPIC của mỗi người), k = 3, sàn 1 km.<br /></>}
                  Ngưỡng "xa" tính <b>riêng từng tài xế</b> = max(<b>{effMin.toFixed(1)} km</b>, {effK.toFixed(1)} × P90 láng giềng nội cụm của tài xế đó)
                  {st.thMin != null && <> — hôm nay dao động <b>{fmtKm(st.thMin)}</b> → <b>{fmtKm(st.thMax)}</b>.</>}
                  {st.noiseCnt > 0 && <><br />⚠ {st.noiseCnt} tài xế không tạo được cụm EPIC — so với toàn bộ điểm gợi ý của người đó.</>}
                </>
              ) : (
                <>{auto && st.epsMin != null && <>⚙ <b>Tham số tự đề xuất</b> — eps <b>{st.epsMin} m</b> (≈ P90 láng giềng điểm EPIC), k = 3, sàn 1 km.<br /></>}
                  Ngưỡng "xa" = max(<b>{effMin.toFixed(1)} km</b>, {effK.toFixed(1)} × P90 khoảng cách láng giềng nội cụm
                  {st.p90 != null && <> <b>{fmtKm(st.p90)}</b></>}) {st.threshold != null && <>= <b>{fmtKm(st.threshold)}</b>.</>}
                  {st.noiseCnt > 0 && <><br />⚠ DBSCAN không tạo được cụm nào — đang so với toàn bộ điểm EPIC.</>}
                </>
              )}
              {!scene.plain && (scene.counts.misgeo > 0 || st.maybeCnt > 0) && (
                <><br />📍 Soát địa chỉ: loại <b>{scene.counts.misgeo}</b> đơn sai định vị (trùng đường &amp; phường/xã trung tâm)
                  {st.maybeCnt > 0 && <> · ❓ <b>{st.maybeCnt}</b> đơn "có thể sai định vị" (chỉ trùng phường/xã) vẫn giữ trong bảng</>}.</>
              )}
            </div>
          </div>

          {!scene.plain && (
            <div className="aside-sec">
              <div className="section-title">Đơn bị cảnh báo (xa vùng EPIC)</div>
              <div className="tablebox">
                <table>
                  <thead><tr><th>Mã đơn</th><th>Tài xế</th><th className="num">Cách vùng EPIC</th></tr></thead>
                  <tbody>
                    {visibleFarRows.map(r => (
                      <tr key={r.order.code}
                        className={activeCode === r.order.code ? "active" : ""}
                        onClick={() => { setActiveCode(r.order.code); mapApi.current && mapApi.current.openOrder(r.order.code); }}>
                        <td>{r.order.code}{r.verdict === "B" && <span className="qtag">❓ định vị?</span>}</td>
                        <td>{(driverInfo[r.order.driver] && driverInfo[r.order.driver].name) || r.order.driver}</td>
                        <td className="num">{fmtKm(r.dist)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!visibleFarRows.length && <div className="empty">Không có đơn nào vượt ngưỡng.</div>}
              </div>
              <button className="export" onClick={exportCsv}>⬇ Xuất danh sách cảnh báo (CSV)</button>
            </div>
          )}
        </aside>
      </main>
    </div>
  );
}
