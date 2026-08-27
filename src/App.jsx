import { useEffect, useMemo, useRef, useState } from "react";
import * as D from "./detect.js";
import { computeScene, NO_BC, ALL_DRV, fmtKm } from "./scene.js";
import MapView from "./MapView.jsx";
import GuideModal from "./GuideModal.jsx";

const DATA_CSV = "test.csv"; // đặt trong /public — đổi tên ở đây nếu dùng file khác

export default function App() {
  const [orders, setOrders] = useState([]);
  const [driverCsv, setDriverCsv] = useState(null);
  const [bc, setBc] = useState("");
  const [driver, setDriver] = useState(ALL_DRV);
  const [date, setDate] = useState("");
  const [eps, setEps] = useState(400);
  const [k, setK] = useState(3);
  const [minKm, setMinKm] = useState(1);
  const [sort, setSort] = useState("don");
  const [focused, setFocused] = useState(() => new Set());
  const [toggles, setToggles] = useState({ hull: true, order: true, far: true });
  const [activeCode, setActiveCode] = useState(null);
  const [showGuide, setShowGuide] = useState(false);
  const mapApi = useRef(null);

  /* ---- nạp dữ liệu ban đầu từ /public ---- */
  useEffect(() => {
    Promise.all([
      fetch(DATA_CSV).then(r => (r.ok ? r.text() : null)).catch(() => null),
      fetch("drivers.csv").then(r => (r.ok ? r.text() : null)).catch(() => null),
    ]).then(([csv, drv]) => {
      setDriverCsv(drv);
      if (csv) setOrders(D.loadOrders(csv));
    });
  }, []);

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
  const dates = useMemo(() => {
    const set = new Set(drvIds);
    return [...new Set(orders.filter(o => set.has(o.driver)).map(o => o.date))].sort();
  }, [orders, drvKey]);
  useEffect(() => { if (dates.length && !dates.includes(date)) setDate(dates[0]); }, [dates]);

  // đổi phạm vi xem → bỏ hết tick
  useEffect(() => { setFocused(new Set()); setActiveCode(null); }, [bc, driver, date]);

  /* ---- tính toàn cảnh ---- */
  const scene = useMemo(
    () => computeScene({ orders, drvIds, date, eps, k, minKm, driverInfo }),
    [orders, drvKey, date, eps, k, minKm, driverInfo],
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

  const st = scene.stats;
  return (
    <div className="app">
      <header>
        <h1>EPIC Order Map<span className="sub">phát hiện đơn gán ngoài xa vùng gợi ý</span></h1>
        <div className="controls">
          <div className="ctl">
            <label>Bưu cục</label>
            <select value={bc} onChange={e => setBc(e.target.value)}>
              {bcs.map(b => <option key={b} value={b}>{b}</option>)}
            </select>
          </div>
          <div className="ctl">
            <label>Tài xế</label>
            <select value={driver} onChange={e => setDriver(e.target.value)}>
              <option value={ALL_DRV}>— Cả bưu cục ({bcDrivers.length} tài xế) —</option>
              {bcDrivers.map(d => {
                const info = driverInfo[d];
                return <option key={d} value={d}>{d + (info && info.name ? " — " + info.name : "")}</option>;
              })}
            </select>
          </div>
          <div className="ctl">
            <label>Ngày</label>
            <select value={date} onChange={e => setDate(e.target.value)}>
              {dates.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
          <div className="ctl">
            <label>DBSCAN eps</label>
            <input type="range" min="100" max="1000" step="50" value={eps} onChange={e => setEps(+e.target.value)} />
            <span className="val">{eps} m</span>
          </div>
          <div className="ctl">
            <label>Hệ số k</label>
            <input type="range" min="1" max="6" step="0.5" value={k} onChange={e => setK(+e.target.value)} />
            <span className="val">{k.toFixed(1)}×</span>
          </div>
          <div className="ctl">
            <label>Ngưỡng tối thiểu</label>
            <input type="range" min="0.2" max="3" step="0.1" value={minKm} onChange={e => setMinKm(+e.target.value)} />
            <span className="val">{minKm.toFixed(1)} km</span>
          </div>
          <label className="filebtn">Nạp CSV khác…
            <input type="file" accept=".csv" style={{ display: "none" }} onChange={onUpload} />
          </label>
          <button className="filebtn" onClick={() => setShowGuide(true)}>📖 Hướng dẫn lấy dữ liệu</button>
        </div>
      </header>

      <GuideModal open={showGuide} onClose={() => setShowGuide(false)} />

      <main>
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
                <>Ngưỡng "xa" tính <b>riêng từng tài xế</b> = max(<b>{minKm.toFixed(1)} km</b>, {k.toFixed(1)} × P90 láng giềng nội cụm của tài xế đó)
                  {st.thMin != null && <> — hôm nay dao động <b>{fmtKm(st.thMin)}</b> → <b>{fmtKm(st.thMax)}</b>.</>}
                  {st.noiseCnt > 0 && <><br />⚠ {st.noiseCnt} tài xế không tạo được cụm EPIC — so với toàn bộ điểm gợi ý của người đó.</>}
                </>
              ) : (
                <>Ngưỡng "xa" = max(<b>{minKm.toFixed(1)} km</b>, {k.toFixed(1)} × P90 khoảng cách láng giềng nội cụm
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
