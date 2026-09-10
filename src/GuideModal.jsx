/* GuideModal — hướng dẫn lấy dữ liệu từ BigQuery rồi import CSV vào trang */
import { useEffect, useState } from "react";

const BQ_QUERY = `DECLARE DS_START DATE DEFAULT DATE '2026-08-25';
DECLARE DS_END   DATE DEFAULT DATE '2026-08-25';

WITH drivers AS (
  SELECT DISTINCT
         salary_date AS load_date,
         warehouse_id,
         warehouse_name,
         CAST(employee_id AS STRING) AS driver_id,
         driver_name
  FROM \`ghn-reporting.testing.epic_result\`
  WHERE salary_date BETWEEN DS_START AND DS_END
    AND COALESCE(total_salary_plan, 0) + COALESCE(salary_giao_unplanned, 0) > 0
),

assigned AS (
  SELECT  DATE(COALESCE(s.updated_time, s.created_time)) AS load_date,
          b.driver_id,
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
    AND s.type IN ('DELIVER')
    AND b.driver_id IN (SELECT driver_id FROM drivers)
  GROUP BY 1, 2, 3, 4, 5
),

assigned_f AS (
  SELECT a.*
  FROM assigned a
  JOIN drivers d
    ON a.load_date = d.load_date
   AND a.driver_id = d.driver_id
),

epic AS (
  SELECT DISTINCT
         e.checkpoint AS load_date,
         CAST(e.driver_id AS STRING) AS driver_id,
         e.order_code
  FROM \`dw-ghn.testing.epic_recommendation_result_ops\` e
  JOIN drivers d
    ON e.checkpoint = d.load_date
   AND CAST(e.driver_id AS STRING) = d.driver_id
  WHERE e.checkpoint BETWEEN DS_START AND DS_END
),

base AS (
  SELECT  COALESCE(a.load_date, e.load_date) AS load_date,
          COALESCE(a.driver_id, e.driver_id) AS driver_id,
          COALESCE(a.order_code, e.order_code) AS order_code,
          a.contact_address,
          a.contact_latlng,
          IF(e.order_code IS NOT NULL, 1, 0) AS is_epic,
          IF(a.order_code IS NOT NULL, 1, 0) AS is_assigned
  FROM assigned_f a
  FULL OUTER JOIN epic e
         ON a.load_date  = e.load_date
        AND a.driver_id  = e.driver_id
        AND a.order_code = e.order_code
)

SELECT  x.load_date,
        d.warehouse_id,
        d.warehouse_name,
        x.driver_id AS employee_id,
        d.driver_name,
        x.order_code,
        x.contact_address,
        x.contact_latlng,
        x.is_epic,
        x.is_assigned
FROM base x
LEFT JOIN drivers d
       ON x.load_date = d.load_date
      AND x.driver_id = d.driver_id
ORDER BY d.warehouse_id, x.driver_id, x.load_date, x.is_epic DESC, x.is_assigned DESC, x.order_code`;

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
              Dán query bên dưới. Chỉ cần sửa <code>DS_START</code> / <code>DS_END</code> (khoảng ngày cần xem) —
              danh sách nhân viên EPIC được lấy <b>tự động theo ngày</b> từ bảng <code>ghn-reporting.testing.epic_result</code>
              (nhân viên có lương plan/unplanned &gt; 0), kèm sẵn bưu cục.
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
            Query ra đúng format trang cần: <code>load_date, warehouse_id, warehouse_name, employee_id, driver_name,
            order_code, contact_address, contact_latlng, is_epic, is_assigned</code> — group theo bưu cục, hiện tên
            và soát sai định vị hoạt động đầy đủ. Dữ liệu nạp bằng nút chỉ tồn tại trong phiên xem — muốn cố định
            cho mọi người, đẩy file vào Supabase: <code>npm run push:data -- &lt;file.csv&gt;</code>
            (cần <code>SUPABASE_URL</code> + <code>SUPABASE_SERVICE_KEY</code>, xem README). Bình thường không cần
            làm tay: GitHub Actions tự lấy D-1 và D-2 mỗi sáng 10:00.
          </div>
        </div>
      </div>
    </div>
  );
}
