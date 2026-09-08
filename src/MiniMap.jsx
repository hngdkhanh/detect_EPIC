/* MiniMap — ảnh bản đồ tĩnh cho thẻ tóm tắt cảnh báo: ghép trực tiếp tile Esri
   (cùng nguồn với MapView) rồi phủ SVG chấm điểm lên trên. KHÔNG dùng Leaflet —
   thẻ này chỉ cần một khung ảnh, không cần pan/zoom, và một trang báo cáo có thể
   có vài chục thẻ nên mỗi thẻ chỉ tải tile khi cuộn tới (IntersectionObserver).
   Qua ref còn có toPng({lines}) → Blob PNG (chữ chú thích + bản đồ) để nút Copy/Tải
   ảnh dùng; vẽ được vì tile Esri trả Access-Control-Allow-Origin: * (canvas không taint). */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

const TILE = 256;
const MIN_Z = 9, MAX_Z = 16;
const H_RATIO = 0.6; // tỷ lệ cao/rộng của ảnh PNG xuất (480×288)
const tileUrl = (z, x, y) =>
  `https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/${z}/${y}/${x}`;

/* Web Mercator → pixel ở kích thước thế giới s = 256 × 2^z */
const projX = (lng, s) => ((lng + 180) / 360) * s;
const projY = (lat, s) => {
  const sin = Math.sin(Math.max(-85.05, Math.min(85.05, lat)) * Math.PI / 180);
  return (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * s;
};

/* Bỏ điểm cách trung vị > 20 km — cùng luật robustBounds của MapView, tránh một đơn
   geocode lỗi kéo khung nhìn ra tận tỉnh khác làm ảnh vô dụng */
function robust(pts) {
  if (pts.length < 3) return pts;
  const lats = pts.map(p => p.lat).sort((a, b) => a - b);
  const lngs = pts.map(p => p.lng).sort((a, b) => a - b);
  const mLat = lats[lats.length >> 1], mLng = lngs[lngs.length >> 1];
  const kmLat = 111, kmLng = 111 * Math.cos(mLat * Math.PI / 180);
  const keep = pts.filter(p => Math.abs(p.lat - mLat) * kmLat < 20 && Math.abs(p.lng - mLng) * kmLng < 20);
  return keep.length ? keep : pts;
}

/* Chọn zoom lớn nhất mà bbox vẫn lọt khung, rồi tính gốc toạ độ pixel của khung */
function fit(pts, W, H, pad) {
  let lat0 = Infinity, lat1 = -Infinity, lng0 = Infinity, lng1 = -Infinity;
  for (const p of pts) {
    if (p.lat < lat0) lat0 = p.lat;
    if (p.lat > lat1) lat1 = p.lat;
    if (p.lng < lng0) lng0 = p.lng;
    if (p.lng > lng1) lng1 = p.lng;
  }
  let z = MAX_Z;
  for (; z > MIN_Z; z--) {
    const s = TILE * 2 ** z;
    if (projX(lng1, s) - projX(lng0, s) <= W - pad * 2 && projY(lat0, s) - projY(lat1, s) <= H - pad * 2) break;
  }
  const s = TILE * 2 ** z;
  return {
    z, s,
    ox: (projX(lng0, s) + projX(lng1, s)) / 2 - W / 2,
    oy: (projY(lat0, s) + projY(lat1, s)) / 2 - H / 2,
  };
}

/* Danh sách tile phủ khung {w,h} tại view */
function tilesFor({ z, ox, oy }, w, h) {
  const n = 2 ** z, out = [];
  for (let ty = Math.floor(oy / TILE); ty <= Math.floor((oy + h - 1) / TILE); ty++) {
    if (ty < 0 || ty >= n) continue;
    for (let tx = Math.floor(ox / TILE); tx <= Math.floor((ox + w - 1) / TILE); tx++) {
      out.push({ key: `${tx}_${ty}`, url: tileUrl(z, ((tx % n) + n) % n, ty), left: tx * TILE - ox, top: ty * TILE - oy });
    }
  }
  return out;
}

// màu chấm khớp --map-* trong styles.css / MARKER_STYLE của scene.js (canvas không đọc được CSS var)
const DOT = {
  epic: { r: 3, fill: "#0ca30c", stroke: "#ffffff", w: 1 },
  near: { r: 2.5, fill: "#fab219", stroke: "#8a6200", w: 0.8 },
  far: { r: 5, fill: "#d03b3b", stroke: "#ffffff", w: 1.5 },
};
const ORDER = { epic: 0, near: 1, far: 2 }; // đơn xa vẽ sau cùng để không bị chấm khác đè

const loadImg = url => new Promise(resolve => {
  const im = new Image();
  im.crossOrigin = "anonymous"; // cùng chế độ với <img> hiển thị → dùng lại cache, không tải lại
  im.onload = () => resolve(im);
  im.onerror = () => resolve(null); // tile lỗi → bỏ qua, vẫn xuất ảnh
  im.src = url;
});

/* Vẽ PNG: khối chữ `lines` ({text, bold, color}) phía trên, bản đồ + chấm + © Esri bên dưới. Scale 2× cho nét. */
async function renderPng({ view, dots, w, h, lines }) {
  const scale = 2, pad = 12, lineH = 20;
  const headH = lines.length ? pad + lines.length * lineH + 6 : 0;
  const canvas = document.createElement("canvas");
  canvas.width = w * scale; canvas.height = (headH + h) * scale;
  const ctx = canvas.getContext("2d");
  ctx.scale(scale, scale);
  ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, w, headH + h);
  ctx.textBaseline = "top";
  lines.forEach((l, i) => {
    ctx.font = `${l.bold ? "700" : "400"} 14px Roboto, "Noto Sans", system-ui, sans-serif`;
    ctx.fillStyle = l.color || "#141414";
    ctx.fillText(l.text, pad, pad + i * lineH);
  });
  const imgs = await Promise.all(tilesFor(view, w, h).map(t => loadImg(t.url).then(im => ({ ...t, im }))));
  ctx.save();
  ctx.translate(0, headH);
  ctx.beginPath(); ctx.rect(0, 0, w, h); ctx.clip();
  ctx.fillStyle = "#e9e5dc"; ctx.fillRect(0, 0, w, h); // nền khi tile không tải được
  for (const t of imgs) if (t.im) ctx.drawImage(t.im, t.left, t.top, TILE, TILE);
  for (const p of dots) {
    const d = DOT[p.k] || DOT.near;
    ctx.beginPath();
    ctx.arc(projX(p.lng, view.s) - view.ox, projY(p.lat, view.s) - view.oy, d.r, 0, Math.PI * 2);
    ctx.fillStyle = d.fill; ctx.fill();
    ctx.lineWidth = d.w; ctx.strokeStyle = d.stroke; ctx.stroke();
  }
  ctx.font = '400 9px Roboto, "Noto Sans", system-ui, sans-serif';
  const attr = "© Esri", tw = ctx.measureText(attr).width + 8;
  ctx.fillStyle = "rgba(255,255,255,0.75)"; ctx.fillRect(w - tw - 4, h - 14, tw, 12);
  ctx.fillStyle = "#333333"; ctx.fillText(attr, w - tw, h - 12);
  ctx.restore();
  return new Promise((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error("toBlob null"))), "image/png"));
}

const MiniMap = forwardRef(function MiniMap({ points, height = 170, alt = "" }, ref) {
  const boxRef = useRef(null);
  const [w, setW] = useState(0);
  const [seen, setSeen] = useState(false);
  const stateRef = useRef(null); // {pts, dots} của lần render mới nhất — cho toPng

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    const io = new IntersectionObserver(es => {
      if (es.some(e => e.isIntersecting)) { setSeen(true); io.disconnect(); }
    }, { rootMargin: "200px" });
    io.observe(el);
    return () => { ro.disconnect(); io.disconnect(); };
  }, []);

  useImperativeHandle(ref, () => ({
    /* lines: [{text, bold?, color?}] in phía trên bản đồ. Trả Blob PNG; null nếu chưa có toạ độ. */
    toPng: async ({ lines = [], width } = {}) => {
      const st = stateRef.current;
      if (!st) return null;
      // ảnh xuất dùng bề rộng cố định (mặc định 480) để mọi thẻ cho ảnh cùng cỡ, không lệ thuộc layout
      const W = width || 480, H = Math.round(H_RATIO * W);
      const view = fit(robust(st.pts), W, H, 16);
      return renderPng({ view, dots: st.dots, w: W, h: H, lines });
    },
  }));

  const pts = (points || []).filter(p => isFinite(p.lat) && isFinite(p.lng));
  const ready = w > 40 && pts.length > 0;
  let body = null;

  if (ready) {
    const view = fit(robust(pts), w, height, 16);
    const { s, ox, oy } = view;
    const dots = pts.slice().sort((a, b) => (ORDER[a.k] || 0) - (ORDER[b.k] || 0));
    stateRef.current = { pts, dots };
    body = (
      <>
        {seen && tilesFor(view, w, height).map(t => (
          <img key={t.key} src={t.url} alt="" draggable="false" loading="lazy" crossOrigin="anonymous"
            style={{ left: t.left, top: t.top }}
            onError={e => { e.currentTarget.style.visibility = "hidden"; }} />
        ))}
        <svg width={w} height={height} aria-label={alt} role="img">
          {dots.map((p, i) => {
            const d = DOT[p.k] || DOT.near;
            return <circle key={i} cx={(projX(p.lng, s) - ox).toFixed(1)} cy={(projY(p.lat, s) - oy).toFixed(1)}
              r={d.r} fill={d.fill} stroke={d.stroke} strokeWidth={d.w} />;
          })}
        </svg>
        <span className="attr">© Esri</span>
      </>
    );
  } else stateRef.current = null;

  return (
    <div className="minimap" ref={boxRef} style={{ height }}>
      {body}
      {!pts.length && <div className="mm-empty">Không có toạ độ để vẽ bản đồ</div>}
    </div>
  );
});
export default MiniMap;
