/* MapView — quản lý Leaflet imperative bên trong React:
   - dựng lại toàn bộ layer khi dữ liệu scene đổi
   - hiện/ẩn theo (tài xế được tick + 3 công tắc lớp) mà KHÔNG đụng khung nhìn
   - expose api: zoomToDriver / openOrder qua apiRef */
import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

/* Khung nhìn "robust": bỏ điểm cách tâm (median) quá 20 km — tránh đơn geocode lỗi kéo map văng xa */
function robustBounds(latlngs) {
  if (!latlngs.length) return null;
  const lats = latlngs.map(p => p[0]).sort((a, b) => a - b);
  const lngs = latlngs.map(p => p[1]).sort((a, b) => a - b);
  const mLat = lats[Math.floor(lats.length / 2)], mLng = lngs[Math.floor(lngs.length / 2)];
  const kmLat = 111, kmLng = 111 * Math.cos(mLat * Math.PI / 180);
  const keep = latlngs.filter(p => Math.abs(p[0] - mLat) * kmLat < 20 && Math.abs(p[1] - mLng) * kmLng < 20);
  return L.latLngBounds(keep.length ? keep : latlngs);
}

export default function MapView({ layers, focused, toggles, apiRef }) {
  const divRef = useRef(null);
  const mapRef = useRef(null);
  const groupRef = useRef(null);
  const regRef = useRef(new Map());      // driver_id -> [{layer, cat}]
  const markersRef = useRef(new Map());  // order_code -> marker
  const boundsRef = useRef(new Map());   // driver_id -> LatLngBounds

  useEffect(() => {
    const map = L.map(divRef.current, { zoomControl: true });
    // dùng Esri World Street Map (không cần API key) — mạng này chặn DNS tile.openstreetmap.org,
    // còn Carto miễn phí thì đóng watermark "API KEY REQUIRED"
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}", {
      maxZoom: 19,
      attribution: "Tiles &copy; Esri — Sources: Esri, HERE, Garmin, OpenStreetMap contributors",
    }).addTo(map);
    groupRef.current = L.layerGroup().addTo(map);
    map.setView([10.8, 106.68], 12);
    mapRef.current = map;
    // Leaflet đo kích thước khung lúc init — nếu layout (flex/font) chưa ổn định thì tile vẽ lệch/xám.
    // Đo lại sau frame đầu + mỗi khi khung đổi kích thước.
    requestAnimationFrame(() => map.invalidateSize());
    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(divRef.current);
    map._ro = ro;
    if (apiRef) {
      apiRef.current = {
        zoomToDriver: id => { const b = boundsRef.current.get(id); if (b) map.fitBounds(b.pad(0.15)); },
        openOrder: code => {
          const m = markersRef.current.get(code);
          if (m) { map.setView(m.getLatLng(), 16); m.openPopup(); }
        },
      };
    }
    return () => { if (map._ro) map._ro.disconnect(); map.remove(); };
  }, []);

  // dựng lại layer khi scene đổi (đổi BC/ngày/tham số/dữ liệu)
  useEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    group.clearLayers();
    regRef.current.clear();
    markersRef.current.clear();
    boundsRef.current.clear();

    const ptsByDrv = new Map();
    for (const ld of layers) {
      let layer;
      if (ld.type === "circle") {
        layer = L.circleMarker([ld.lat, ld.lng], ld.style);
        if (ld.popup) layer.bindPopup(ld.popup);
        if (ld.code) {
          markersRef.current.set(ld.code, layer);
          if (!ptsByDrv.has(ld.driver)) ptsByDrv.set(ld.driver, []);
          ptsByDrv.get(ld.driver).push([ld.lat, ld.lng]);
        }
      } else if (ld.type === "polygon") {
        layer = L.polygon(ld.latlngs, ld.style);
      } else {
        layer = L.polyline(ld.latlngs, ld.style);
      }
      layer.addTo(group);
      if (!regRef.current.has(ld.driver)) regRef.current.set(ld.driver, []);
      regRef.current.get(ld.driver).push({ layer, cat: ld.cat });
    }
    for (const [id, pts] of ptsByDrv) {
      const b = robustBounds(pts);
      if (b) boundsRef.current.set(id, b);
    }
    const all = [...ptsByDrv.values()].flat();
    const b = robustBounds(all);
    if (b) mapRef.current.fitBounds(b.pad(0.12));
    applyVisibility();
  }, [layers]);

  // tick tài xế / công tắc lớp → chỉ hiện/ẩn, KHÔNG đổi khung nhìn
  useEffect(() => { applyVisibility(); }, [focused, toggles]);

  function applyVisibility() {
    const group = groupRef.current;
    if (!group) return;
    for (const [drv, items] of regRef.current) {
      const drvOk = focused.size === 0 || focused.has(drv);
      for (const it of items) {
        if (drvOk && toggles[it.cat]) {
          if (!group.hasLayer(it.layer)) group.addLayer(it.layer);
          if (focused.has(drv) && it.layer.bringToFront) it.layer.bringToFront();
        } else {
          group.removeLayer(it.layer);
        }
      }
    }
  }

  return <div ref={divRef} id="map" />;
}
