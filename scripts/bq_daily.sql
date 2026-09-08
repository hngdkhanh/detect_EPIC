-- bq_daily.sql — query lấy data D-1 cho public/data/<date>.csv
--
-- Tự động: scripts/fetch-daily.mjs đọc file này, THAY 2 dòng DECLARE bên dưới bằng ngày cụ thể
-- (các dòng bắt đầu bằng DECLARE và -- bị bỏ), rồi chạy qua `bq` CLI. Giữ tên DS_START / DS_END.
-- Tay: chạy trên BigQuery console, project dw-ghn, Save results -> CSV, rồi `npm run append:data`.
--   https://console.cloud.google.com/bigquery?project=dw-ghn
--
-- Bản này khác BQ_QUERY trong src/GuideModal.jsx đúng 2 dòng DECLARE:
-- ở đây ngày tự động là hôm qua, GuideModal để người dùng tự điền ngày.
-- Khi pipeline đổi, sửa CẢ HAI cho khớp.

DECLARE DS_START DATE DEFAULT DATE_SUB(CURRENT_DATE('Asia/Ho_Chi_Minh'), INTERVAL 1 DAY);
DECLARE DS_END   DATE DEFAULT DATE_SUB(CURRENT_DATE('Asia/Ho_Chi_Minh'), INTERVAL 1 DAY);

WITH drivers AS (
  SELECT DISTINCT
         salary_date AS load_date,
         warehouse_id,
         warehouse_name,
         CAST(employee_id AS STRING) AS driver_id,
         driver_name
  FROM `ghn-reporting.testing.epic_result`
  WHERE salary_date BETWEEN DS_START AND DS_END
    AND COALESCE(total_salary_plan, 0) + COALESCE(salary_giao_unplanned, 0) > 0
),

assigned AS (
  SELECT  DATE(COALESCE(s.updated_time, s.created_time)) AS load_date,
          b.driver_id,
          s.order_code,
          s.contact_address,
          CONCAT(CAST(s.contact_lat AS STRING), ',', CAST(s.contact_lng AS STRING)) AS contact_latlng
  FROM `dw-ghn.dataraw_v2.Dtr_lastmile_v2_tripitem` s
  LEFT JOIN `dw-ghn.dataraw_v2.Dtr_lastmile_v2_trip` b
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
  FROM `dw-ghn.testing.epic_recommendation_result_ops` e
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
ORDER BY d.warehouse_id, x.driver_id, x.load_date, x.is_epic DESC, x.is_assigned DESC, x.order_code
