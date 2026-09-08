/* ReportView — trang "Báo cáo bất thường": tổng hợp mọi tài xế vượt ngưỡng gán-ngoài trong ngày
   (toàn bộ bưu cục). Chỉ hiển thị dữ liệu do report.js tính; không đụng Leaflet. */
import { useEffect, useMemo, useRef, useState } from "react";
import { fmtKm } from "./scene.js";
import { SCENARIOS, lookupDriver } from "./report.js";
import { vnorm } from "./SearchSelect.jsx";
import MiniMap from "./MiniMap.jsx";
import { slugify } from "./xlsx.js";

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

/* ---- thẻ tóm tắt cảnh báo — đúng template tin nhắn AM gửi bưu cục ----
   Cảnh báo gán ngoài bất thường / <BC>: <Tài xế> / Số đơn gán ngoài bất thường: N / Chi tiết: [Excel] */
const summaryText = (s, date) =>
  `Cảnh báo gán ngoài bất thường (${date})\n${s.bc}: ${s.name}\nSố đơn gán ngoài bất thường: ${s.far}` +
  (s.maybe ? ` (trong đó ${s.maybe} đơn nghi sai định vị)` : "");

/* Dòng chữ in lên đầu ảnh PNG — để app chat chỉ nhận ảnh (không nhận chữ) vẫn đủ thông tin */
const pngLines = (s, date) => [
  { text: `CẢNH BÁO GÁN NGOÀI BẤT THƯỜNG · ${date}`, bold: true, color: "#bf000f" },
  { text: `${s.bc}: ${s.name}`, bold: true },
  { text: `Số đơn gán ngoài bất thường: ${s.far}` + (s.maybe ? ` (❓ ${s.maybe} nghi sai định vị)` : ""), color: "#5c6873" },
];
const blobToDataUrl = b => new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(b); });

/* Copy TẤT CẢ trường hợp trong một lần: text/plain = danh sách đánh số theo template;
   text/html = cùng nội dung + ảnh bản đồ từng tài xế (nhúng data URL) cho app nhận rich text.
   Không có image/png vì clipboard chỉ chứa được một ảnh — ảnh riêng từng người dùng nút Copy trên thẻ. */
const MAX_IMG_ALL = 20; // quá số này chỉ copy chữ + html không ảnh, tránh clipboard vài chục MB
const allText = (list, date) =>
  `Cảnh báo gán ngoài bất thường (${date}) — ${list.length} tài xế\n\n` +
  list.map((s, i) => `${i + 1}. ${s.bc}: ${s.name}\n   Số đơn gán ngoài bất thường: ${s.far}` +
    (s.maybe ? ` (trong đó ${s.maybe} đơn nghi sai định vị)` : "")).join("\n\n");
const escHtml = t => String(t).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function CopyAllButton({ list, date, mapRefs }) {
  const [state, setState] = useState("");
  const flash = st => { setState(st); setTimeout(() => setState(""), 2500); };
  async function copy() {
    const text = allText(list, date);
    if (!navigator.clipboard) { flash("fail"); return; }
    if (!window.ClipboardItem) { navigator.clipboard.writeText(text).then(() => flash("text"), () => flash("fail")); return; }
    setState("busy");
    const withImg = list.length <= MAX_IMG_ALL;
    const html = (async () => {
      const items = [];
      for (const [i, s] of list.entries()) {
        let img = "";
        const ref = withImg && mapRefs.current[s.id];
        if (ref) {
          // vẽ tuần tự cho nhẹ máy; lỗi một ảnh thì bỏ ảnh đó, không hỏng cả gói
          const b = await ref.toPng({ lines: pngLines(s, date), width: 400 }).catch(() => null);
          if (b) img = `<br><img src="${await blobToDataUrl(b)}" width="400">`;
        }
        items.push(`<li><b>${escHtml(s.bc)}: ${escHtml(s.name)}</b><br>Số đơn gán ngoài bất thường: <b>${s.far}</b>` +
          (s.maybe ? ` (trong đó ${s.maybe} đơn nghi sai định vị)` : "") + `${img}</li>`);
      }
      return new Blob([`<div><b>Cảnh báo gán ngoài bất thường (${date}) — ${list.length} tài xế</b><ol>${items.join("")}</ol></div>`], { type: "text/html" });
    })();
    try {
      await navigator.clipboard.write([new ClipboardItem({ "text/plain": new Blob([text], { type: "text/plain" }), "text/html": html })]);
      flash(withImg ? "ok" : "text");
    } catch {
      navigator.clipboard.writeText(text).then(() => flash("text"), () => flash("fail"));
    }
  }
  const label = { busy: "⏳ Đang gom nội dung…", ok: `✓ Đã copy ${list.length} trường hợp (chữ + ảnh)`, text: `✓ Đã copy ${list.length} trường hợp (chữ)`, fail: "✕ Không copy được" }[state]
    || `📋 Copy tất cả (${list.length} tài xế)`;
  return (
    <button className="filebtn" onClick={copy} disabled={state === "busy"}
      title="Sao chép nội dung cảnh báo của MỌI tài xế bất thường trong ngày — dán vào Gmail/Lark doc được cả chữ và ảnh, vào chat được chữ">{label}</button>
  );
}

function SummaryCard({ s, date, onExport, onGoto, registerMap }) {
  const mapRef = useRef(null);
  const [state, setState] = useState(""); // "" | "busy" | "ok" | "text" | "fail"
  const flash = st => { setState(st); setTimeout(() => setState(""), 2200); };

  /* Copy = chữ + ảnh trong MỘT ClipboardItem (text/plain + text/html + image/png): app nhận
     rich text (Gmail/Word/Lark doc) dán được cả hai; app chat chỉ nhận ảnh thì lấy PNG (đã in chữ);
     app chỉ nhận chữ thì lấy text. Không có ClipboardItem/không vẽ được ảnh → rơi về copy chữ. */
  async function copy() {
    const text = summaryText(s, date);
    if (!navigator.clipboard) { flash("fail"); return; }
    if (!window.ClipboardItem || !mapRef.current) {
      navigator.clipboard.writeText(text).then(() => flash("text"), () => flash("fail"));
      return;
    }
    setState("busy");
    // truyền Promise vào ClipboardItem để không mất "user gesture" trong lúc chờ tile tải
    const png = mapRef.current.toPng({ lines: pngLines(s, date) }).then(b => { if (!b) throw new Error("no map"); return b; });
    const html = png.then(blobToDataUrl).then(u =>
      new Blob([`<div><b>Cảnh báo gán ngoài bất thường (${date})</b><br>${s.bc}: <b>${s.name}</b><br>Số đơn gán ngoài bất thường: <b>${s.far}</b><br><img src="${u}" width="480"></div>`],
        { type: "text/html" }));
    try {
      await navigator.clipboard.write([new ClipboardItem({
        "text/plain": new Blob([text], { type: "text/plain" }),
        "text/html": html,
        "image/png": png,
      })]);
      flash("ok");
    } catch {
      navigator.clipboard.writeText(text).then(() => flash("text"), () => flash("fail"));
    }
  }
  async function savePng() {
    const b = mapRef.current && await mapRef.current.toPng({ lines: pngLines(s, date) }).catch(() => null);
    if (!b) { flash("fail"); return; }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(b);
    a.download = `canh_bao_gan_ngoai_${slugify(s.name)}_${s.id}_${date}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  const copyLabel = { busy: "⏳ Đang tạo ảnh…", ok: "✓ Đã copy chữ + ảnh", text: "✓ Đã copy chữ (không ảnh)", fail: "✕ Không copy được" }[state] || "📋 Copy";
  return (
    <div className="sum-card">
      <div className="sum-title">Cảnh báo gán ngoài bất thường</div>
      <div className="sum-who">{s.bc}: <span className="sum-nm">{s.name}</span></div>
      <div className="sum-n">Số đơn gán ngoài bất thường: <b>{s.far}</b>{s.maybe > 0 && <span className="cell-sub"> · ❓ {s.maybe} nghi sai định vị</span>}</div>
      <div className="sum-row">
        Chi tiết:
        <button className="filebtn sm" onClick={() => onExport(s)} title="Tải Excel danh sách từng đơn gán ngoài xa vùng EPIC của tài xế này">⬇ Tải Excel</button>
        <button className="linkbtn" onClick={copy} disabled={state === "busy"}
          title="Sao chép cả nội dung chữ và ảnh bản đồ (ảnh có in sẵn tiêu đề) — dán thẳng vào Zalo/Lark/Gmail">{copyLabel}</button>
        <button className="linkbtn" onClick={savePng} title="Tải ảnh PNG (tiêu đề + bản đồ) về máy">🖼 Ảnh</button>
        <button className="linkbtn" onClick={() => onGoto(s)} title="Mở tài xế này trên bản đồ">🗺 Bản đồ →</button>
      </div>
      <MiniMap ref={el => { mapRef.current = el; if (registerMap) registerMap(s.id, el); }} points={s.points} alt={`Bản đồ đơn xa của ${s.name}`} />
    </div>
  );
}

/* ---- tra cứu tài xế: gõ ID hoặc tên → ngày nào bị cảnh báo gán ngoài bất thường ---- */
const DAY_STATUS = {
  flag: { icon: "🚨", label: "Bị cảnh báo" },
  ok: { icon: "✅", label: "Không bị cảnh báo" },
  na: { icon: "–", label: "Không đánh giá được (không có đơn gán / không có điểm EPIC / không có trong dữ liệu)" },
  pending: { icon: "…", label: "Chưa quét xong" },
};

function DriverLookup({ directory, history, dates, date, summaries, onGoto, onExportDriverXlsx, onPickDate }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(null); // id đã chọn
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const boxRef = useRef(null);

  useEffect(() => {
    const onDoc = e => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const hits = useMemo(() => {
    const k = vnorm(q.trim());
    if (!k) return [];
    const exact = directory.filter(d => String(d.id) === q.trim());
    const rest = directory.filter(d => String(d.id) !== q.trim() && (String(d.id).includes(k) || vnorm(d.name).includes(k)));
    return exact.concat(rest).slice(0, 10);
  }, [q, directory]);

  const info = sel && (directory.find(d => d.id === sel) || { id: sel, name: sel, bc: "" });
  const res = useMemo(() => (sel ? lookupDriver(sel, { dates, history, date }) : null), [sel, dates, history, date]);

  function pick(d) { setSel(d.id); setQ(`${d.name} · ${d.id}`); setOpen(false); }
  function onKey(e) {
    if (e.key === "Escape") setOpen(false);
    else if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setHi(h => Math.min(h + 1, hits.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHi(h => Math.max(h - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); if (hits[hi]) pick(hits[hi]); }
  }

  const flaggedDays = res ? res.days.filter(x => x.status === "flag") : [];
  const evalDays = res ? res.days.filter(x => x.status === "flag" || x.status === "ok").slice().reverse() : [];
  const pendingN = res ? res.days.length - res.scanned : 0;
  const todaySum = sel && summaries.find(s => s.id === sel);

  return (
    <div className="lookup" ref={boxRef}>
      <div className="lk-input">
        <input value={q} placeholder="Nhập ID hoặc tên nhân viên giao hàng…" autoComplete="off"
          onChange={e => { setQ(e.target.value); setSel(null); setOpen(true); setHi(0); }}
          onFocus={() => setOpen(true)} onKeyDown={onKey} />
        {q && <button className="linkbtn" onClick={() => { setQ(""); setSel(null); }} title="Xoá">✕</button>}
        {open && q.trim() && !sel && (
          <div className="ss-pop lk-pop">
            <div className="ss-list">
              {hits.map((d, i) => (
                <div key={d.id} className={"ss-item" + (i === hi ? " hi" : "")} onMouseEnter={() => setHi(i)} onClick={() => pick(d)}>
                  <b>{d.name}</b> <span className="cell-sub">· ID {d.id} · {d.bc}</span>
                </div>
              ))}
              {!hits.length && <div className="ss-empty">Không có tài xế nào khớp trong {directory.length} tài xế đã có dữ liệu</div>}
            </div>
          </div>
        )}
      </div>

      {res && (
        <div className={"lk-result" + (res.flagged ? " bad" : res.evaluated ? " good" : "")}>
          <div className="lk-head">
            <div>
              <div className="lk-nm">{info.name} <span className="cell-sub">· ID {info.id}</span></div>
              <div className="cell-sub">{info.bc}</div>
            </div>
            <div className="lk-verdict">
              {res.flagged
                ? <>🚨 Bị cảnh báo gán ngoài bất thường <b>{res.flagged}</b> / {res.evaluated} ngày đánh giá được</>
                : res.evaluated
                  ? <>✅ Không bị cảnh báo trong <b>{res.evaluated}</b> ngày đánh giá được</>
                  : <>– Không đánh giá được ở ngày nào đã quét</>}
              {pendingN > 0 && <span className="cell-sub"> · còn {pendingN} ngày chưa quét xong</span>}
            </div>
          </div>

          <div className="lk-days">
            {res.days.map(x => (
              <button key={x.date} type="button" className={"lk-day " + x.status + (x.date === date ? " cur" : "")}
                title={`${x.date}: ${DAY_STATUS[x.status].label}${x.row ? ` — ${x.row.far} đơn xa / ${x.row.assigned} gán (${Math.round(100 * x.row.ratio)}%)` : ""}. Bấm để xem báo cáo ngày này.`}
                onClick={() => onPickDate(x.date)}>
                <span className="lk-d">{x.date.slice(5)}</span>
                <span className="lk-i">{DAY_STATUS[x.status].icon}</span>
                {x.row && <span className="lk-f">{x.row.far}</span>}
              </button>
            ))}
          </div>

          {evalDays.length > 0 && (
            <div className="tablebox rp-table lk-table">
              <table>
                <thead><tr><th>Ngày</th><th>Kết quả</th><th className="num">Gán</th><th className="num">Xa (❓)</th><th className="num">Xa/gán</th><th className="num">%Gán gợi ý</th><th className="num">Xa nhất</th><th>Kịch bản</th><th></th></tr></thead>
                <tbody>
                  {evalDays.map(x => {
                    const r = x.row, comp = r.epicTotal ? r.epicAssigned / r.epicTotal : null;
                    return (
                      <tr key={x.date} className={x.status === "flag" ? "flag" : ""}>
                        <td>{x.date}{x.date === date && <span className="cell-sub"> (đang xem)</span>}</td>
                        <td>{x.status === "flag" ? <span className="tag repeat">🚨 cảnh báo</span> : <span className="cell-sub">✅ bình thường</span>}</td>
                        <td className="num">{r.assigned}</td>
                        <td className={"num" + (x.status === "flag" ? " red" : "")}>{r.far}{r.maybe > 0 && <span className="cell-sub"> ({r.maybe})</span>}</td>
                        <td className="num">{pct(r.ratio)}</td>
                        <td className="num">{pct(comp)}</td>
                        <td className="num">{r.far ? fmtKm(r.maxDist) : "–"}</td>
                        <td>{x.status === "flag" && x.scenarios.length ? x.scenarios.map(k => <span className={"tag sc " + k} key={k}>{SCEN_LABEL[k]}</span>) : <span className="cell-sub">—</span>}</td>
                        <td>
                          {x.date === date
                            ? <>
                                <button className="linkbtn" onClick={() => onGoto({ id: sel, bc: info.bc })}>Xem bản đồ →</button>
                                {todaySum && <button className="linkbtn" onClick={() => onExportDriverXlsx(todaySum)} title="Tải Excel đơn xa của ngày này">⬇ Excel</button>}
                              </>
                            : <button className="linkbtn" onClick={() => onPickDate(x.date)} title="Chuyển báo cáo sang ngày này">Mở ngày →</button>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <div className="rp-note">
            Tiêu chí mỗi ngày: đơn XA vùng EPIC ≥ 10% tổng đơn gán <b>và</b> ≥ 5 đơn (đã loại đơn sai định vị).
            Ngày "–" là ngày tài xế không có đơn gán, không có điểm EPIC, hoặc không có trong dữ liệu.
            {flaggedDays.length > 0 && <> Ngày bị cảnh báo: <b>{flaggedDays.map(x => x.date.slice(5)).join(", ")}</b>.</>}
          </div>
        </div>
      )}
    </div>
  );
}

export default function ReportView({ report, dates, histProgress, removedDest, summaries = [], onExportDriverXlsx, onExportAllXlsx, directory = [], history = {}, onPickDate, onGoto, onExport, onBack, driverInfoNote }) {
  const [bcFilter, setBcFilter] = useState(null);
  const [sortKey, setSortKey] = useState("far");
  const mapRefs = useRef({}); // id tài xế → handle MiniMap (toPng) — cho nút "Copy tất cả"
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

      {/* ---- 1b. tra cứu tài xế ---- */}
      <section className="rp-sec">
        <div className="section-title">
          Tra cứu tài xế
          <span className="hint"> — nhập ID hoặc tên để xem tài xế có bị cảnh báo gán ngoài bất thường ở ngày nào trong {dates.length} ngày dữ liệu
            {histPending && <> (đang quét lịch sử {histProgress.done}/{histProgress.total}…)</>}</span>
        </div>
        <DriverLookup directory={directory} history={history} dates={dates} date={report.date} summaries={summaries}
          onGoto={onGoto} onExportDriverXlsx={onExportDriverXlsx} onPickDate={onPickDate} />
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

      {/* ---- 9. tóm tắt cảnh báo gửi bưu cục — mỗi tài xế bất thường một thẻ theo template ---- */}
      <section className="rp-sec">
        <div className="section-title">
          Tóm tắt cảnh báo gửi bưu cục · {summaries.length}
          <span className="hint"> — mỗi tài xế một thẻ: copy chữ, tải Excel chi tiết đơn, ảnh bản đồ vùng EPIC và đơn xa</span>
        </div>
        {summaries.length ? (
          <>
            <div className="sum-bar">
              <span className="mm-legend">
                <i className="mm-dot epic" /> vùng EPIC gợi ý &nbsp; <i className="mm-dot near" /> đơn ngoài gần vùng &nbsp; <i className="mm-dot far" /> đơn gán ngoài XA (cảnh báo)
              </span>
              <span className="sum-bar-actions">
                <CopyAllButton list={summaries} date={report.date} mapRefs={mapRefs} />
                <button className="filebtn" onClick={onExportAllXlsx}
                  title="Một file Excel: sheet tổng hợp theo tài xế + sheet chi tiết mọi đơn xa trong ngày">⬇ Excel tất cả ({summaries.length} tài xế)</button>
              </span>
            </div>
            <div className="sum-grid">
              {summaries.map(s => <SummaryCard key={s.id} s={s} date={report.date} onExport={onExportDriverXlsx} onGoto={onGoto}
                registerMap={(id, el) => { if (el) mapRefs.current[id] = el; else delete mapRefs.current[id]; }} />)}
            </div>
          </>
        ) : <div className="empty">{table.length ? "Đang tính…" : "Không có tài xế nào vượt ngưỡng — không có cảnh báo cần gửi 🎉"}</div>}
      </section>
    </div>
  );
}
