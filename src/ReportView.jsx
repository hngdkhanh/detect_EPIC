/* ReportView — trang "Báo cáo bất thường": tổng hợp mọi tài xế vượt ngưỡng gán-ngoài trong ngày
   (toàn bộ bưu cục). Chỉ hiển thị dữ liệu do report.js tính; không đụng Leaflet. */
import { useMemo, useState } from "react";
import { fmtKm } from "./scene.js";
import { SCENARIOS } from "./report.js";

const pct = (x, digits = 0) => (x == null ? "–" : (100 * x).toFixed(digits) + "%");
const num = x => (x == null ? "–" : String(x));
const SCEN_LABEL = Object.fromEntries(SCENARIOS.map(s => [s.key, s.label]));

function Delta({ cur, prev, invert = false }) {
  if (prev == null) return null;
  const d = cur - prev;
  if (d === 0) return <span className="kpi-delta flat">= hôm trước</span>;
  const bad = invert ? d < 0 : d > 0;
  return <span className={"kpi-delta " + (bad ? "bad" : "good")}>{d > 0 ? "▲ +" : "▼ "}{d} so với hôm trước</span>;
}

/* ---- biểu đồ SVG tối giản (1 series, 1 màu; nhãn dùng token chữ) ---- */
function BarH({ rows, valueOf, labelOf, max, onClick, active }) {
  const rowH = 22, labelW = 190, valW = 40, w = 520, plotW = w - labelW - valW;
  const h = rows.length * rowH + 4;
  const mx = max || Math.max(1, ...rows.map(valueOf));
  return (
    <svg className="chart" viewBox={`0 0 ${w} ${h}`} width="100%" height={h} role="img" aria-label="Số tài xế bất thường theo bưu cục">
      {rows.map((r, i) => {
        const v = valueOf(r), bw = Math.max(2, (v / mx) * plotW), y = i * rowH + 3;
        const isAct = active === labelOf(r);
        return (
          <g key={labelOf(r)} className={"barrow" + (isAct ? " act" : "")} onClick={() => onClick && onClick(r)} style={{ cursor: onClick ? "pointer" : "default" }}>
            <title>{`${labelOf(r)}: ${v} tài xế bất thường`}</title>
            <rect x="0" y={y - 2} width={w} height={rowH} className="hit" />
            <text x={labelW - 8} y={y + 12} textAnchor="end" className="lbl">{labelOf(r).length > 30 ? labelOf(r).slice(0, 29) + "…" : labelOf(r)}</text>
            <rect x={labelW} y={y} width={bw} height={rowH - 8} rx="3" className="bar" />
            <text x={labelW + bw + 6} y={y + 12} className="val">{v}</text>
          </g>
        );
      })}
    </svg>
  );
}

function BarV({ buckets, highlightFrom }) {
  const w = 480, h = 160, padL = 8, padB = 28, padT = 16, bw = (w - padL * 2) / buckets.length;
  const mx = Math.max(1, ...buckets.map(b => b.n));
  const plotH = h - padB - padT;
  return (
    <svg className="chart" viewBox={`0 0 ${w} ${h}`} width="100%" height={h} role="img" aria-label="Phân bố khoảng cách đơn xa">
      <line x1={padL} x2={w - padL} y1={h - padB} y2={h - padB} className="axis" />
      {buckets.map((b, i) => {
        const bh = (b.n / mx) * plotH, x = padL + i * bw + bw * 0.18, y = h - padB - bh;
        const far = b.lo >= highlightFrom;
        return (
          <g key={b.label}>
            <title>{`${b.label}: ${b.n} đơn${far ? " (thật sự xa)" : ""}`}</title>
            <rect x={x} y={bh ? y : h - padB - 2} width={bw * 0.64} height={Math.max(2, bh)} rx="3" className={"bar" + (far ? " far" : "")} />
            <text x={x + bw * 0.32} y={(bh ? y : h - padB - 2) - 4} textAnchor="middle" className="val">{b.n}</text>
            <text x={x + bw * 0.32} y={h - padB + 16} textAnchor="middle" className="lbl">{b.label}</text>
          </g>
        );
      })}
    </svg>
  );
}

function TrendLine({ points, current }) {
  const w = 640, h = 170, padL = 32, padR = 12, padT = 16, padB = 32;
  const xs = points.map((_, i) => padL + (points.length > 1 ? (i * (w - padL - padR)) / (points.length - 1) : (w - padL - padR) / 2));
  const vals = points.map(p => p.abnormal).filter(v => v != null);
  const mx = Math.max(1, ...vals);
  const yOf = v => padT + (1 - v / mx) * (h - padT - padB);
  const ticks = [0, Math.round(mx / 2), mx];
  const path = points.map((p, i) => (p.abnormal == null ? null : `${xs[i].toFixed(1)},${yOf(p.abnormal).toFixed(1)}`))
    .reduce((acc, seg, i) => {
      if (!seg) return acc + (acc.endsWith(" ") || !acc ? "" : " ");
      const prevNull = i === 0 || points[i - 1].abnormal == null;
      return acc + (prevNull ? `M${seg} ` : `L${seg} `);
    }, "").trim();
  return (
    <svg className="chart" viewBox={`0 0 ${w} ${h}`} width="100%" height={h} role="img" aria-label="Số tài xế bất thường theo ngày">
      {ticks.map(t => (
        <g key={t}>
          <line x1={padL} x2={w - padR} y1={yOf(t)} y2={yOf(t)} className="grid" />
          <text x={padL - 6} y={yOf(t) + 4} textAnchor="end" className="lbl">{t}</text>
        </g>
      ))}
      <path d={path} className="line" />
      {points.map((p, i) => (
        <g key={p.date}>
          <title>{p.abnormal == null ? `${p.date}: chưa quét` : `${p.date}: ${p.abnormal} tài xế bất thường · ${p.far} đơn xa`}</title>
          <rect x={xs[i] - 12} y={padT - 8} width={24} height={h - padT - padB + 16} className="hit" />
          {p.abnormal == null
            ? <circle cx={xs[i]} cy={h - padB} r="3" className="pt pending" />
            : <circle cx={xs[i]} cy={yOf(p.abnormal)} r={p.date === current ? 5 : 3.5} className={"pt" + (p.date === current ? " cur" : "")} />}
          {p.abnormal != null && (points.length <= 8 || p.date === current || i === 0 || i === points.length - 1) && (
            <text x={xs[i]} y={yOf(p.abnormal) - 9} textAnchor="middle" className="val">{p.abnormal}</text>
          )}
          <text x={xs[i]} y={h - padB + 16} textAnchor="middle" className={"lbl" + (p.date === current ? " cur" : "")}>{p.date.slice(5)}</text>
        </g>
      ))}
    </svg>
  );
}

export default function ReportView({ report, dates, histProgress, removedDest, onGoto, onExport, onBack, driverInfoNote }) {
  const [bcFilter, setBcFilter] = useState(null);
  const [sortKey, setSortKey] = useState("far");
  const { kpi, table, byBc, scenarioCounts, hist, trend, quality } = report;

  const rows = useMemo(() => {
    const arr = (bcFilter ? table.filter(t => t.bc === bcFilter) : table).slice();
    const cmp = {
      far: (a, b) => b.far - a.far || b.ratio - a.ratio,
      ratio: (a, b) => b.ratio - a.ratio || b.far - a.far,
      compliance: (a, b) => (a.compliance ?? 2) - (b.compliance ?? 2),
      dist: (a, b) => b.maxDist - a.maxDist,
      repeat: (a, b) => b.flag7 - a.flag7 || b.flag14 - a.flag14 || b.far - a.far,
      bc: (a, b) => a.bc.localeCompare(b.bc, "vi") || b.far - a.far,
    }[sortKey];
    return arr.sort(cmp);
  }, [table, bcFilter, sortKey]);

  const histPending = histProgress && histProgress.done < histProgress.total;
  const Th = ({ k, children, className }) => (
    <th className={(className || "") + (sortKey === k ? " sorted" : "")} onClick={() => setSortKey(k)} title="Bấm để sắp xếp">{children}{sortKey === k ? " ▾" : ""}</th>
  );

  return (
    <div className="report">
      <div className="rp-head">
        <div>
          <div className="rp-title">🚨 Báo cáo bất thường gán ngoài — {report.date}</div>
          <div className="rp-sub">
            Quét <b>toàn bộ bưu cục</b> trong dữ liệu ngày, tham số tự đề xuất theo từng tài xế. Tiêu chí bất thường:
            đơn <b>XA vùng EPIC ≥ 10%</b> tổng đơn gán thực tế <b>và ≥ 5 đơn</b>, đã loại đơn sai định vị.
          </div>
        </div>
        <div className="rp-actions">
          <button className="filebtn" onClick={onExport} disabled={!table.length}
            title="Xuất từng đơn xa của mọi tài xế bất thường trong ngày, kèm kịch bản và số ngày tái phạm">⬇ Xuất CSV đơn xa</button>
          <button className="filebtn" onClick={onBack}>🗺 Về bản đồ</button>
        </div>
      </div>

      {/* ---- 1. KPI ---- */}
      <section className="rp-sec">
        <div className="kpis">
          <div className="kpi alert">
            <div className="v">{kpi.abnormal}<span className="of"> / {kpi.evaluated}</span></div>
            <div className="l">Tài xế bất thường / tài xế được đánh giá</div>
            <Delta cur={kpi.abnormal} prev={kpi.prev && kpi.prev.abnormal} />
          </div>
          <div className="kpi">
            <div className="v">{kpi.bcAbnormal}<span className="of"> / {kpi.bcTotal}</span></div>
            <div className="l">Bưu cục có bất thường / tổng bưu cục</div>
            <Delta cur={kpi.bcAbnormal} prev={kpi.prev && kpi.prev.bcAbnormal} />
          </div>
          <div className="kpi alert">
            <div className="v">{kpi.farTotal}</div>
            <div className="l">Đơn xa cảnh báo của tài xế bất thường{kpi.maybeTotal > 0 && <> · ❓ {kpi.maybeTotal} nghi sai định vị</>}</div>
            <Delta cur={kpi.farTotal} prev={kpi.prev && kpi.prev.farTotal} />
          </div>
          <div className="kpi">
            <div className="v">{report.scannedDates.length > 1 ? kpi.repeat : "–"}</div>
            <div className="l">Tái phạm — bị flag ≥ 3 ngày trong 7 ngày gần nhất</div>
            {histPending && <span className="kpi-delta flat">đang quét lịch sử {histProgress.done}/{histProgress.total}…</span>}
          </div>
          <div className="kpi">
            <div className="v">{report.scannedDates.length > 1 ? kpi.isNew : "–"}</div>
            <div className="l">Mới xuất hiện — chưa từng bị flag trong các ngày đã quét</div>
            {kpi.prev && <span className="kpi-delta flat">so với {kpi.prev.date}</span>}
          </div>
        </div>
      </section>

      <div className="rp-grid">
        {/* ---- 2. theo bưu cục ---- */}
        <section className="rp-sec">
          <div className="section-title">Phân bố theo bưu cục <span className="hint">— bấm để lọc bảng tài xế</span></div>
          {byBc.length ? (
            <>
              <BarH rows={byBc} valueOf={b => b.abnormal} labelOf={b => b.bc} active={bcFilter}
                onClick={b => setBcFilter(f => (f === b.bc ? null : b.bc))} />
              <div className="tablebox rp-table">
                <table>
                  <thead><tr><th>Bưu cục</th><th className="num">Bất thường</th><th className="num">Tài xế</th><th className="num">Tỷ lệ</th><th className="num">Đơn xa</th><th className="num">%Gán gợi ý BC</th></tr></thead>
                  <tbody>
                    {byBc.map(b => (
                      <tr key={b.bc} className={bcFilter === b.bc ? "active" : ""} onClick={() => setBcFilter(f => (f === b.bc ? null : b.bc))}>
                        <td>{b.bc}</td>
                        <td className="num red">{b.abnormal}</td>
                        <td className="num">{b.drivers}</td>
                        <td className="num">{pct(b.pct)}</td>
                        <td className="num">{b.far}{b.maybe > 0 && <span className="qtag">❓ {b.maybe}</span>}</td>
                        <td className="num">{pct(b.compliance)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : <div className="empty">Không có bưu cục nào có tài xế bất thường 🎉</div>}
        </section>

        {/* ---- 4. kịch bản ---- */}
        <section className="rp-sec">
          <div className="section-title">Phân loại theo kịch bản hành vi</div>
          <div className="scen-list">
            {scenarioCounts.map(s => (
              <div className={"scen" + (s.n ? "" : " zero")} key={s.key}>
                <div className="scen-n">{s.n}</div>
                <div className="scen-body">
                  <div className="scen-l">{s.label}</div>
                  <div className="scen-d">{s.desc}</div>
                </div>
              </div>
            ))}
          </div>
          <div className="rp-note">Một tài xế có thể rơi vào nhiều kịch bản. Tách 4A/4B (năng suất, %GTC) cần thêm cột từ BigQuery, chưa có trong export hiện tại.</div>

          {/* ---- 5. histogram ---- */}
          <div className="section-title" style={{ marginTop: 12 }}>Phân bố khoảng cách đơn xa</div>
          {report.allFarCount ? (
            <>
              <BarV buckets={hist} highlightFrom={3000} />
              <div className="rp-note">
                <b>{report.far3km}</b> / {report.allFarCount} đơn xa ({pct(report.far3km / report.allFarCount)}) cách vùng EPIC ≥ 3 km — mốc "thật sự xa" (tô đậm).
                Phần còn lại nằm trong dải 1–3 km sát biên ngưỡng thích ứng.
              </div>
            </>
          ) : <div className="empty">Không có đơn xa nào.</div>}
        </section>
      </div>

      {/* ---- 3. bảng tài xế ---- */}
      <section className="rp-sec">
        <div className="section-title">
          Tài xế bất thường · {rows.length}{bcFilter && <> — lọc <b>{bcFilter}</b> <button className="linkbtn" onClick={() => setBcFilter(null)}>✕ bỏ lọc</button></>}
        </div>
        <div className="tablebox rp-table tall">
          <table>
            <thead>
              <tr>
                <th>Tài xế</th>
                <Th k="bc">Bưu cục</Th>
                <th className="num">Gán</th>
                <th className="num">Ngoài</th>
                <Th k="far" className="num">Xa (❓)</Th>
                <Th k="ratio" className="num">Xa/gán</Th>
                <Th k="compliance" className="num">%Gán gợi ý</Th>
                <Th k="dist" className="num">Xa nhất · trung vị</Th>
                <th className="num">eps</th>
                <Th k="repeat" className="num">Flag 7n · 14n</Th>
                <th>Kịch bản</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map(t => (
                <tr key={t.id}>
                  <td><div className="cell-nm">{t.name}</div><div className="cell-sub">ID {t.id}</div></td>
                  <td className="cell-bc">{t.bc}</td>
                  <td className="num">{t.assigned}</td>
                  <td className="num">{t.outside}</td>
                  <td className="num red">{t.far}{t.maybe > 0 && <span className="cell-sub"> ({t.maybe})</span>}</td>
                  <td className="num">{pct(t.ratio)}</td>
                  <td className={"num" + (t.compliance != null && t.compliance < 0.2 ? " red" : "")}>{pct(t.compliance)}<span className="cell-sub"> {t.epicAssigned}/{t.epicTotal}</span></td>
                  <td className="num">{fmtKm(t.maxDist)}<span className="cell-sub"> · {fmtKm(t.medDist)}</span></td>
                  <td className="num cell-sub">{t.eps} m{t.allNoise ? " ⚠" : ""}</td>
                  <td className="num">
                    {report.scannedDates.length > 1 ? <>{t.flag7} · {t.flag14}</> : "–"}
                    {t.repeat && <span className="tag repeat">tái phạm</span>}
                    {t.isNew && <span className="tag new">mới</span>}
                  </td>
                  <td>{t.scenarios.length ? t.scenarios.map(k => <span className={"tag sc " + k} key={k}>{SCEN_LABEL[k]}</span>) : <span className="cell-sub">—</span>}</td>
                  <td><button className="linkbtn" onClick={() => onGoto(t)} title="Mở tài xế này trên bản đồ">Xem bản đồ →</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length && <div className="empty">Không có tài xế nào vượt ngưỡng.</div>}
        </div>
      </section>

      <div className="rp-grid">
        {/* ---- 7. xu hướng ---- */}
        <section className="rp-sec">
          <div className="section-title">
            Xu hướng {dates.length} ngày
            {histPending && <span className="hint"> — đang quét {histProgress.done}/{histProgress.total} ngày…</span>}
          </div>
          {dates.length > 1 ? (
            <>
              <TrendLine points={trend} current={report.date} />
              <div className="rp-note">Số tài xế bất thường mỗi ngày (mọi bưu cục). Điểm rỗng dưới trục = ngày chưa quét xong.</div>
              <div className="rp-two">
                <div>
                  <div className="mini-title">Tái phạm (≥ 3/7 ngày) · {table.filter(t => t.repeat).length}</div>
                  {table.filter(t => t.repeat).slice(0, 12).map(t => (
                    <div className="mini-row" key={t.id} onClick={() => onGoto(t)}>
                      <span className="mini-nm">{t.name}</span><span className="mini-sub">{t.bc}</span><span className="mini-n">{t.flag7}/7 · {t.flag14}/14</span>
                    </div>
                  ))}
                  {!table.some(t => t.repeat) && <div className="empty">{histPending ? "Đang quét…" : "Không có."}</div>}
                </div>
                <div>
                  <div className="mini-title">Mới xuất hiện hôm nay · {table.filter(t => t.isNew).length}</div>
                  {table.filter(t => t.isNew).slice(0, 12).map(t => (
                    <div className="mini-row" key={t.id} onClick={() => onGoto(t)}>
                      <span className="mini-nm">{t.name}</span><span className="mini-sub">{t.bc}</span><span className="mini-n">{t.far} xa</span>
                    </div>
                  ))}
                  {!table.some(t => t.isNew) && <div className="empty">{histPending ? "Đang quét…" : "Không có."}</div>}
                </div>
              </div>
            </>
          ) : <div className="empty">Chỉ có 1 ngày dữ liệu — cần ≥ 2 ngày để xem xu hướng và tái phạm.</div>}
        </section>

        <section className="rp-sec">
          {/* ---- 6. đơn EPIC bị gỡ đi đâu ---- */}
          <div className="section-title">Đơn EPIC bị gỡ của tài xế bất thường</div>
          {removedDest && removedDest.available ? (
            <div className="dest-list">
              <div className="dest"><span className="dest-n">{removedDest.removed}</span> đơn gợi ý bị gỡ / không gán</div>
              <div className="dest"><span className="dest-n">{removedDest.self}</span> vẫn do chính tài xế giao (ngoài luồng gán)</div>
              <div className="dest"><span className="dest-n">{removedDest.sameBc}</span> chuyển cho tài xế khác cùng bưu cục</div>
              <div className="dest"><span className="dest-n">{removedDest.otherBc}</span> chuyển cho tài xế bưu cục khác / CTV</div>
              <div className="dest"><span className="dest-n">{removedDest.unknown}</span> không rõ người giao</div>
            </div>
          ) : (
            <div className="rp-note">
              <b>{removedDest ? removedDest.removed : 0}</b> đơn gợi ý bị gỡ / không gán ở các tài xế bất thường.
              Export hiện tại không có cột <code>actual_driver_id / actual_driver_name</code> nên chưa biết đơn đi đâu (kịch bản 1 và 3).
              Thêm 2 cột này vào query BigQuery là khối này tự hiện.
            </div>
          )}

          {/* ---- 8. chất lượng dữ liệu ---- */}
          <div className="section-title" style={{ marginTop: 12 }}>Chất lượng dữ liệu &amp; độ tin cậy cảnh báo</div>
          <div className="qual-grid">
            <div className="qual"><div className="v">{quality.skipped}</div><div className="l">Tài xế không đánh giá được<br />(không có đơn gán hoặc không có điểm EPIC)</div></div>
            <div className="qual"><div className="v">{quality.allNoise}</div><div className="l">Tài xế không tạo được cụm EPIC<br />(so với toàn bộ điểm gợi ý)</div></div>
            <div className="qual"><div className="v">{quality.noCoord}</div><div className="l">Đơn thiếu toạ độ (toàn ngày)<br />(chủ yếu là đơn gợi ý bị gỡ — {quality.removed} đơn)</div></div>
            <div className="qual"><div className="v">{quality.misgeo}</div><div className="l">Đơn sai định vị đã loại<br />(trùng đường &amp; phường/xã trung tâm)</div></div>
            <div className="qual"><div className="v">{quality.maybe}</div><div className="l">Đơn ❓ có thể sai định vị<br />(chỉ trùng phường/xã, vẫn tính cảnh báo)</div></div>
            <div className="qual"><div className="v">{quality.epsMin == null ? "–" : quality.epsMin === quality.epsMax ? `${quality.epsMin} m` : `${quality.epsMin}–${quality.epsMax} m`}</div><div className="l">Dải eps tự đề xuất<br />(k = 3, sàn 1 km cố định)</div></div>
          </div>
          {driverInfoNote && <div className="rp-note">{driverInfoNote}</div>}
        </section>
      </div>
    </div>
  );
}
