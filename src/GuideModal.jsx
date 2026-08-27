/* GuideModal — hướng dẫn lấy dữ liệu từ BigQuery rồi import CSV vào trang */
import { useEffect, useState } from "react";

const BQ_QUERY = `DECLARE DS_START DATE DEFAULT DATE '2026-08-25';
DECLARE DS_END   DATE DEFAULT DATE '2026-08-25';
DECLARE V_DRIVER_IDS ARRAY<STRING> DEFAULT [
  '3012244','3022603','3118691','3113106','3133188','3134916','3135467','3143228','3144869','3147902','3160403','3172266'
];

WITH assigned AS (
  SELECT  DATE(COALESCE(s.updated_time, s.created_time)) AS load_date,
          b.driver_id,
          b.driver_name,
          s.order_code,
          s.contact_address,
          CONCAT(CAST(s.contact_lat AS STRING), ',', CAST(s.contact_lng AS STRING)) AS contact_latlng
  FROM \`dw-ghn.dataraw_v2.Dtr_lastmile_v2_tripitem\` s
  LEFT JOIN \`dw-ghn.dataraw_v2.Dtr_lastmile_v2_trip\` b
         ON s.trip_code = b.trip_code
  WHERE s.createddate_partition BETWEEN DATE_SUB(DS_START, INTERVAL 7 DAY) AND DS_END
    AND b.createddate_partition BETWEEN DATE_SUB(DS_START, INTERVAL 7 DAY) AND DS_END
    AND DATE(COALESCE(s.updated_time, s.created_time)) BETWEEN DS_START AND DS_END
    AND SUBSTR(s.order_code, -3) != '_PR'
    AND b.status <> 'CANCELLED'
    AND b.driver_id IN UNNEST(V_DRIVER_IDS)
  GROUP BY 1, 2, 3, 4, 5, 6
),

epic AS (
  SELECT DISTINCT
         checkpoint AS load_date,
         CAST(driver_id AS STRING) AS driver_id,
         order_code
  FROM \`dw-ghn.testing.epic_recommendation_result_ops\`
  WHERE checkpoint BETWEEN DS_START AND DS_END
    AND CAST(driver_id AS STRING) IN UNNEST(V_DRIVER_IDS)
)

SELECT  COALESCE(a.load_date, e.load_date) AS load_date,
        COALESCE(a.driver_id, e.driver_id) AS driver_id,
        a.driver_name,
        COALESCE(a.order_code, e.order_code) AS order_code,
        a.contact_address,
        a.contact_latlng,
        IF(e.order_code IS NOT NULL, 1, 0) AS is_epic,
        IF(a.order_code IS NOT NULL, 1, 0) AS is_assigned
FROM assigned a
FULL OUTER JOIN epic e
       ON a.load_date  = e.load_date
      AND a.driver_id  = e.driver_id
      AND a.order_code = e.order_code
ORDER BY load_date, driver_id, is_epic DESC, is_assigned DESC, order_code`;

export default function GuideModal({ open, onClose }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = e => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => { if (!open) setCopied(false); }, [open]);

  if (!open) return null;

  async function copyQuery() {
    try {
      await navigator.clipboard.writeText(BQ_QUERY);
    } catch {
      // fallback cho trình duyệt chặn clipboard API trên http
      const ta = document.createElement("textarea");
      ta.value = BQ_QUERY;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">📖 Hướng dẫn lấy dữ liệu từ BigQuery</div>
          <button className="modal-close" onClick={onClose} title="Đóng (Esc)">✕</button>
        </div>

        <div className="modal-body">
          <ol className="steps">
            <li>
              Mở <a href="https://console.cloud.google.com/bigquery" target="_blank" rel="noreferrer">BigQuery Console</a> (project <b>dw-ghn</b>) → bấm <b>Compose new query</b>.
            </li>
            <li>
              Dán query bên dưới. Sửa 2 chỗ trước khi chạy:
              <ul>
                <li><code>DS_START</code> / <code>DS_END</code> — khoảng ngày cần xem</li>
                <li><code>V_DRIVER_IDS</code> — danh sách ID tài xế cần soát</li>
              </ul>
            </li>
            <li>Bấm <b>Run</b> → chờ kết quả → <b>Save results ▾</b> → chọn <b>CSV (local file)</b>
              &nbsp;(kết quả lớn hơn 10MB thì chọn <b>CSV (Google Drive)</b> rồi tải về).</li>
            <li>Quay lại trang này → bấm nút <b>"Nạp CSV khác…"</b> góc phải trên → chọn file vừa tải. Xong.</li>
          </ol>

          <div className="sql-head">
            <span className="section-title">Query</span>
            <button className="copybtn" onClick={copyQuery}>{copied ? "Đã copy ✓" : "⧉ Copy query"}</button>
          </div>
          <pre className="sql">{BQ_QUERY}</pre>

          <div className="guide-note">
            File CSV cần đúng các cột: <code>load_date, driver_id, order_code, contact_latlng, is_epic, is_assigned</code>
            (query trên đã ra đúng format, kèm <code>driver_name</code> và <code>contact_address</code> để hiện tên
            và soát sai định vị). Dữ liệu nạp bằng nút chỉ tồn tại trong phiên xem — muốn cố định cho mọi người,
            thay file <code>public/test.csv</code> rồi <code>docker compose up -d --build</code>.
          </div>
        </div>
      </div>
    </div>
  );
}
