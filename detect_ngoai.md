# Logic phát hiện đơn gán ngoài XA vùng giao EPIC gợi ý

**Mục đích:** Trong các đơn gán ngoài gợi ý, tách phần **độn thêm gần vùng** (chấp nhận được — NV vẫn giao trong cụm tối ưu) khỏi phần **đơn ở vùng giao khác** (bất thường — NV bị kéo khỏi cụm, tín hiệu "đổi vùng giao" của Scenario 2/4B trong bộ rule cảnh báo gán ngoài). Tiêu chí tách là **khoảng cách địa lý từ đơn ngoài đến vùng gợi ý EPIC**.

**Phạm vi hiệu chỉnh:** Toàn bộ ngưỡng trong tài liệu này được hiệu chỉnh từ dữ liệu thực tế **06–13/08/2026, 126 tài xế, 756 tài xế-ngày, 133.436 đơn** (vùng HCM). Khi scale sang vùng khác cần backtest lại theo đúng quy trình ở mục 8.

---

## 1. Dữ liệu đầu vào

File CSV mỗi dòng một đơn, theo tài xế × ngày:

| Cột | Ý nghĩa |
|---|---|
| `load_date` | Ngày dữ liệu (D0) |
| `driver_id` | NVPTTT |
| `order_code` | Mã đơn |
| `contact_latlng` | Toạ độ giao `"lat,lng"` — có thể rỗng |
| `is_epic` | 1 = đơn thuộc file gợi ý EPIC |
| `is_assigned` | 1 = đơn thực tế được gán cho NV trong ngày |

Từ 2 cờ suy ra 3 nhóm đơn:

| Nhóm | Điều kiện | Vai trò |
|---|---|---|
| EPIC gán đúng | `is_epic=1, is_assigned=1` | Tử số %gán theo gợi ý |
| EPIC bị gỡ | `is_epic=1, is_assigned=0` | Thường **không có toạ độ** trong extract — vẫn tính vào mẫu số chỉ số, không dùng định vị |
| Đơn ngoài | `is_epic=0, is_assigned=1` | Đối tượng cần phân loại gần/xa |

## 2. Làm sạch dữ liệu (chạy trước mọi tính toán)

1. **Dòng không có toạ độ:** giữ lại để tính chỉ số (%gán, %đơn ngoài) nhưng loại khỏi mọi phép tính khoảng cách. Nếu loại hẳn, %gán theo gợi ý sẽ bị thổi phồng (thực tế: 55/95 đơn gợi ý của một tài xế không có toạ độ → nếu bỏ sẽ báo 100% thay vì 42%).
2. **Toạ độ rác:** loại khỏi thống kê khoảng cách các đơn có `dist > 50 km` hoặc toạ độ `0,0` / ngoài bounding box vùng vận hành. Bằng chứng: 2 đơn lỗi (một đơn `0,0`, một đơn geocode ra miền Bắc cách 1.170 km) từng đẩy trung bình khoảng cách từ 2,85 km lên 51,5 km. Toàn kỳ 06–13/08 chỉ có **4 đơn** loại này.
3. **Tài xế-ngày không có tham chiếu:** nếu toàn bộ đơn EPIC của NV trong ngày đều không có toạ độ → không dựng được vùng tham chiếu, **rule khoảng cách không chạy được** cho NV-ngày đó (các rule % vẫn chạy bình thường). Toàn kỳ: **58/816 tài xế-ngày (~7%) với 2.979 đơn ngoài không đo được** — đây là khoảng trống coverage; cần backfill toạ độ cho đơn trong file gợi ý để thu hẹp.

## 3. Thuật toán phát hiện

**Bước 1 — Tập tham chiếu (vùng EPIC):** mọi đơn `is_epic=1` có toạ độ, **kể cả đơn bị gỡ** — file gợi ý định nghĩa *vùng dự kiến*, không phụ thuộc BC có gán hay không.

**Bước 2 — Gom cụm DBSCAN** (khoảng cách haversine, `eps = 400 m`, `minPts = 3`) trên tập tham chiếu. Điểm nhiễu bị loại khỏi tham chiếu (nếu toàn bộ là nhiễu → dự phòng dùng cả tập). Lý do phải gom cụm: file gợi ý có thể chứa nhiều cụm rời nhau — nếu chỉ dùng 1 tâm điểm (centroid), đơn nằm *giữa* hai cụm sẽ bị flag oan.

**Bước 3 — Khoảng cách:** với mỗi đơn ngoài đã gán có toạ độ:
`d = khoảng cách haversine đến điểm EPIC (trong cụm) gần nhất`.

**Bước 4 — Ngưỡng thích ứng:**

```
ngưỡng = max( minKm , k × P90 khoảng cách láng giềng gần nhất nội cụm )
```

Đơn có `d > ngưỡng` → **đơn ngoài XA vùng EPIC** (mức ghi nhận). Đơn vượt thêm mốc **3 km** → **thật sự xa** (mức cảnh báo).

## 4. Từng tham số: chọn số nào, logic ra số, vì sao

**Bảng tổng hợp** — mỗi số đều được *tính ra* từ dữ liệu 06–13/08 theo một công thức lặp lại được, không phải chọn cảm tính:

| Tham số | Số chọn | Logic ra số (từ dữ liệu) |
|---|---|---|
| DBSCAN `eps` | **400 m** | P95 (qua 756 file) của "P90 giãn cách láng giềng nội file" = 373 m → làm tròn lên 400 |
| Hệ số `k` | **3** | Quét k=2→6, chọn k cho phần thích ứng vượt sàn ở đúng ~5–10% file thưa nhất (k=3 → 6,6%) |
| Sàn `minKm` 🟡 | **1 km** | Điểm gãy phân bố khoảng cách 41.356 đơn ngoài: P95 = 826 m, dải 800–1.000 m rỗng → 1 km ≈ P96 |
| Mốc "thật sự xa" 🟠 | **3 km** | P90 của nhóm đơn xa = 3,21 km → làm tròn 3 (trung bình 1,99 km bị loại vì dao động ngày lớn) |
| Sàn kích hoạt | **≥3 đơn/NV/ngày** | Kế thừa sàn "tối thiểu 3 đơn" của rule S1/S3; kiểm chứng volume ~5,6 cảnh báo/ngày |

### 4.1. DBSCAN `eps` — chọn **400 m**

**Vai trò:** hai điểm EPIC cách nhau ≤ eps được nối vào cùng cụm; eps quyết định vùng gợi ý được "vẽ" rộng hay hẹp.

**Logic ra số (3 bước):**
1. Trong từng file gợi ý (tài xế-ngày), tính khoảng cách láng giềng gần nhất của mỗi điểm EPIC, lấy **P90** làm đại diện giãn cách của file đó.
2. Nhìn phân bố đại diện này qua 756 file: trung vị 77 m, **P95 = 373 m**.
3. eps phải phủ giãn cách của ~95% file để cụm thật không bị đứt gãy → lấy 373 m làm tròn lên bậc trăm = **400 m**.

**Kiểm chứng — quét eps** (tỷ lệ điểm EPIC bị coi là nhiễu, trung vị / P90 tài xế-ngày):

| eps | 200 m | 300 m | **400 m** | 500 m | 800 m |
|---|---|---|---|---|---|
| %nhiễu | 5,3% / 18,4% | 3,8% / 13,9% | **3,0% / 10,9%** | 2,1% / 9,3% | 1,1% / 5,4% |

**Vì sao không chọn số khác:** dưới 400 m (200–300) đẩy nhiễu ở nhóm file thưa lên 14–18% — vùng tham chiếu bị thủng, đơn hợp lệ bị flag oan. Trên 400 m đường cong nhiễu đã phẳng (500 m chỉ bớt thêm ~1 điểm %) nhưng tăng rủi ro **dính hai vùng giao rời nhau làm một** — khi đó đơn nằm giữa hai vùng được tính khoảng cách thấp giả tạo và lọt lưới. 400 m là điểm cân bằng: đủ phủ 95% file, chưa trộn cụm.

### 4.2. Hệ số `k` — chọn **3**

**Vai trò:** phần thích ứng của ngưỡng = `k × P90 giãn cách nội cụm` — cho file ngoại thành thưa một ngưỡng nới hơn sàn 1 km, để không flag oan đơn cách cụm 1,2 km ở nơi mà chính các điểm gợi ý đã cách nhau 400–500 m.

**Logic ra số:** phần thích ứng đúng thiết kế khi nó **chỉ kích hoạt ở đuôi thưa** của phân bố (file ngoại thành), tức vượt sàn 1 km ở khoảng 5–10% tài xế-ngày. Quét k:

| k | 2 | **3** | 4 | 6 |
|---|---|---|---|---|
| %tài xế-ngày có k×P90 > 1 km | 2,0% | **6,6%** | 11,0% | 17,1% |

k=3 rơi đúng dải mục tiêu: sàn 1 km chi phối ~93% trường hợp (file nội thành dày — trung vị k×P90 chỉ 230 m, thấp xa sàn), phần thích ứng chỉ nới cho ~7% file thưa.

**Vì sao không chọn số khác:** k=2 → phần thích ứng gần như không bao giờ kích hoạt (2%) — thành tham số chết, file ngoại thành bị áp sàn nội thành và flag oan. k≥4 → nới ngưỡng cho cả file bình thường (11–17%), tức tự làm mù rule ở chính nhóm cần giám sát.

### 4.3. Sàn `minKm` — chọn **1 km** (mức ghi nhận 🟡)

**Vai trò:** khoảng cách tối thiểu để một đơn ngoài bị coi là "xa vùng EPIC" — ranh giới giữa "độn thêm gần vùng" (hợp lệ) và "khác vùng giao".

**Logic ra số (tìm điểm gãy của phân bố):** dựng phân bố khoảng cách của **toàn bộ 41.356 đơn ngoài** đo được: P50 = 55 m, P90 = 436 m, P95 = 826 m. Histogram dồn đặc dưới 400 m, **mỏng hẳn ở dải 800–1.000 m** (chỉ ~1,2% đơn), rồi xuất hiện quần thể thứ hai sau 1 km. Điểm gãy tự nhiên đó — nơi quần thể "độn gần vùng" kết thúc — là **1 km ≈ P96**.

**Vì sao không chọn số khác:** hạ xuống 500–600 m sẽ flag thêm gấp rưỡi (≈6,6% thay vì 4%) mà phần thêm chủ yếu là đơn viền cụm — nhiễu, làm BC mất niềm tin (đúng cảnh báo "loại trừ quá chặt → cảnh báo oan" trong bộ rule). Nâng lên 2 km sẽ nuốt mất nửa dưới của quần thể thứ hai — chính là các đơn khác vùng cần ghi nhận. 1 km nằm đúng khe rỗng giữa hai quần thể.

### 4.4. Mốc "thật sự xa" — chọn **3 km** (mức cảnh báo 🟠)

**Vai trò:** tầng nghiêm trọng bên trên mức ghi nhận — chỉ tầng này mới phát cảnh báo phía BC, nên nó quyết định trực tiếp khối lượng cảnh báo vùng phải xử lý.

**Logic ra số (2 bước):**
1. Lấy phân bố của **nhóm đơn đã vượt mức ghi nhận** (4.805 đơn/8 ngày): trung bình 1,99 km, **P90 = 3,21 km**. Trung bình bị loại làm mốc vì không ổn định — dao động theo ngày 1,53–2,65 km, và từng cho 2,85 km khi tính trên 1 ngày đơn lẻ; P90 bền với dao động và outlier hơn → lấy 3,21 km làm tròn = **3 km**.
2. Đối chiếu khối lượng cảnh báo ở 2 ứng viên lân cận (bảng dưới) — tiêu chí quyết định là **năng lực xử lý SLA D+1**, vì cả hai cutoff bắt cùng nhóm vi phạm.

| Cutoff + sàn ≥3 đơn/ngày | 2 km | **3 km** |
|---|---|---|
| Lượt cảnh báo / 8 ngày | 77 (~10/ngày) | **45 (~5,6/ngày)** |
| Tài xế bị cảnh báo | 24/126 | **14/126** |
| Tái diễn ≥3 ngày | 12 NV | **7 NV** |

**Vì sao không chọn số khác:** nhóm NV tái diễn hệ thống (5–8/8 ngày) xuất hiện **giống hệt nhau ở cả 2 km và 3 km** — cutoff không đổi đối tượng, chỉ đổi khối lượng. Vậy chọn theo khối lượng: ~6 cảnh báo/ngày (3 km) khớp năng lực DA/AM khi scale 39 BC; 2 km gần gấp đôi volume mà không thêm được NV hệ thống nào. Số tròn 3 km cũng dễ truyền thông với vùng hơn 3,21.

### 4.5. Sàn kích hoạt — chọn **≥3 đơn thật sự xa / NV / ngày**

**Vai trò:** chặn cảnh báo theo đơn lẻ — 1 đơn xa đơn lẻ thường là ngoại lệ hợp lệ (khách đổi địa chỉ, đơn gấp, điều phối đột xuất).

**Logic ra số:** kế thừa nguyên sàn **"tối thiểu 3 đơn/ngày"** đã dùng ở rule S1/S3 của bộ cảnh báo gán ngoài — giữ đồng bộ để vùng chỉ phải nhớ một con số. Kiểm chứng trên dữ liệu: có sàn → 45 lượt/8 ngày (~5,6/ngày); bỏ sàn → khối lượng gần gấp đôi, phần thêm là các NV chỉ có 1–2 đơn xa/ngày — đúng nhóm ngoại lệ hợp lệ không đáng làm việc với BC.

## 5. Kết quả áp dụng trên toàn bộ dữ liệu (06–13/08/2026) — rule khoảng cách chạy độc lập

Rule khoảng cách chạy **một mình** (chưa xét rule %gán <60% hay %đơn ngoài >30%), điều kiện cảnh báo `≥3 đơn thật sự xa/NV/ngày`. Đơn "thật sự xa" = vượt **cả** ngưỡng thích ứng **và** mốc 3 km.

### Cấp độ đơn

| Ngày | Đơn ngoài | Xa (>ngưỡng ~1 km) 🟡 | Thật sự xa (>3 km) 🟠 | Lượt cảnh báo |
|---|---|---|---|---|
| 06/08 | 5.860 | 423 | 152 | 5 |
| 07/08 | 6.672 | 1.110 | 66 | 5 |
| 08/08 | 6.257 | 1.051 | 35 | 6 |
| 09/08 | 4.056 | 402 | 39 | 5 |
| 10/08 | 7.701 | 654 | 75 | 8 |
| 11/08 | 5.450 | 680 | 117 | 5 |
| 12/08 | 6.140 | 409 | 124 | 7 |
| 13/08* | 2.304 | 76 | 47 | 4 |
| **Tổng** | **44.440** | **4.805 (10,8%)** | **655 (1,5%)** | **45** |

*Ngày 13/08 dữ liệu chỉ có 40 tài xế (partial).* Trong 44.440 đơn ngoài: 41.457 đo được, 2.979 không đo được (mục 2.3), 4 toạ độ rác.

### Cấp độ cảnh báo

- **45 lượt tài xế-ngày / 816** (~5,6 cảnh báo/ngày toàn vùng) — **14/126 tài xế**.
- **7 NV tái diễn ≥3 ngày:** 3171568 (7/8 ngày), 3177570 (7), 3172266 (5), 3176436 (5), 3181753 (4), 3175032 (3), 3177352 (3).
- Danh sách chi tiết: `canh_bao_khoang_cach_toan_ky.csv`.

### Chồng lấp với rule % — vì sao phải chạy song song

Cùng kỳ, rule % (<60% gán gợi ý & >30% đơn ngoài) kích hoạt **46 lượt — 23 tài xế**. Mức trùng với rule khoảng cách chỉ **5/45 lượt**:

| | Rule khoảng cách | Rule % | Trùng |
|---|---|---|---|
| Lượt cảnh báo | 45 | 46 | 5 |
| Tài xế | 14 | 23 | — |

→ Rule khoảng cách bắt thêm **40 lượt (13 tài xế)** mà rule % bỏ sót hoàn toàn — nhóm này **gán gợi ý vẫn cao** nên thoát điều kiện <60%, nhưng phần đơn độn thêm nằm ở vùng giao khác (hành vi "gán đủ file rồi ép thêm đơn khác vùng"). Toàn bộ nhóm tái diễn nặng nhất (3171568, 3177570 — 7/8 ngày) đều thuộc nhóm chỉ rule khoảng cách nhìn thấy. **Kết luận: hai rule đo hai hành vi khác nhau, phải chạy song song như các scenario độc lập, không thay thế nhau.**

## 6. Rule kết hợp — "gán ngoài bất thường VÀ xa vùng" (map với detect gán ngoài)

Rule 2 bước, nối bộ chỉ số khoảng cách (mục 3–4) vào detect gán ngoài bất thường:

| Bước | Điều kiện | Ý nghĩa |
|---|---|---|
| 1 — Gate khối lượng | **%đơn ngoài / tổng đơn gán > 30%** | NV bị gán ngoài đáng kể mới xét tiếp |
| 2 — Gate khoảng cách | **Số đơn XA (vượt ngưỡng thích ứng, mục 3) / số đơn gán ngoài > 80%** | Phần gán ngoài đó nằm gần như toàn bộ ở vùng giao khác |
| Cả 2 thoả | → **Cảnh báo: đổi vùng giao quy mô lớn** 🟠 | NV bị kéo hẳn khỏi cụm gợi ý — tín hiệu Scenario 2 mạnh nhất |

**Lưu ý định nghĩa:** "xa" ở bước 2 tính theo **ngưỡng thích ứng 🟡 (~1 km)**, không phải mốc 3 km — backtest cho thấy nếu dùng mốc 3 km thì **0 lượt** kích hoạt được điều kiện 80% (mốc 3 km dành riêng cho rule đếm tuyệt đối mục 4.5).

**Backtest toàn kỳ 06–13/08:**

- Bước 1 đứng một mình: **254/816 lượt (70 tài xế)** — quá rộng, không dùng làm cảnh báo trực tiếp.
- Phân bố tỷ lệ xa/đơn ngoài trong nhóm đã qua bước 1: 76% số lượt có tỷ lệ dưới 10% (độn gần vùng — hợp lệ); chỉ **3 lượt vượt 80%**.
- **Rule đầy đủ (>30% & >80%): 3 lượt (~0,4 cảnh báo/ngày) — 2 tài xế:**

| Tài xế | Ngày | Đơn ngoài / tổng gán | Đơn xa (/đơn ngoài) |
|---|---|---|---|
| 3169919 | 07/08 | 847/920 (92%) | 765 (90%) |
| 3169919 | 08/08 | 832/900 (92%) | 715 (86%) |
| 3172266 | 10/08 | 50/95 (53%) | 44 (88%, trong đó 31 đơn >3 km) |

Trường hợp 3169919 đáng chú ý kép: ~900 đơn gán/ngày là bất thường về khối lượng (nghi tài khoản gom/hub hoặc lỗi log gán) — rule trồi ngay ca này lên cho DA verify trước khi quy trách nhiệm, đúng nguyên tắc "DA phân định trước" của bộ cảnh báo.

**Biến thể nếu muốn nhạy hơn:** hạ gate 2 xuống **>50%** → 12 lượt (~1,5/ngày), 7 tài xế, 2 NV tái diễn ≥3 ngày (3169919, 3172266). Cân nhắc dùng mức 50% làm mức ghi nhận 🟡 nội bộ, giữ 80% làm mức cảnh báo 🟠 phía BC.

**Quan hệ với rule đếm tuyệt đối (mục 4.5 — ≥3 đơn >3 km/ngày):** hai rule bắt hai hình thái khác nhau và **chạy song song**: rule kết hợp (tỷ trọng) bắt ca *đổi vùng gần như toàn bộ* dù đơn chỉ cách 1–2 km; rule đếm (tuyệt đối) bắt ca *ép thêm nhiều đơn rất xa* dù tỷ trọng ngoài thấp. Backtest: 45 lượt của rule đếm và 3 lượt của rule kết hợp chỉ trùng nhau 1 lượt (3172266 ngày 10/08).

## 7. Bảng chỉ số đầu ra (mỗi NVPTTT × ngày)

| Chỉ số | Công thức | Ghi chú |
|---|---|---|
| %Gán theo gợi ý | đơn EPIC được gán / tổng đơn EPIC | Mẫu số gồm cả đơn không toạ độ; extract này chưa trừ được đơn không có hàng thực tế (không có log rã kiện) → là **cận dưới** so với định nghĩa chuẩn trong bộ rule |
| %Đơn ngoài / tổng gán | đơn ngoài / tổng đơn được gán | |
| Số đơn ngoài XA | đơn ngoài có `d > ngưỡng thích ứng` | Mức ghi nhận 🟡 |
| Số đơn THẬT SỰ XA | đơn ngoài có `d > 3 km` | ≥3 đơn/ngày → cảnh báo 🟠 |
| Khoảng cách xa nhất | max(d) trong ngày | Đưa vào gói chứng cứ |
| Danh sách mã đơn xa + d | từng đơn vượt ngưỡng | Gói chứng cứ Gtalk/AI-Portal |

## 8. Quy trình hiệu chỉnh lại (khi scale vùng mới / theo quý)

1. Gom ≥ 7–14 ngày dữ liệu vùng mới, chạy làm sạch (mục 2).
2. Tính lại: giãn cách P90 nội file (→ eps), phân bố khoảng cách đơn ngoài (→ minKm ≈ điểm gãy P95–P96), phân bố đơn xa (→ mốc nghiêm trọng ≈ P90 nhóm xa, làm tròn).
3. Mô phỏng khối lượng cảnh báo với rule ≥3 đơn/ngày; đối chiếu năng lực xử lý của DA/AM.
4. Kiểm tra nhóm tái diễn ở 2 cutoff lân cận — nếu danh sách NV hệ thống không đổi thì chọn cutoff cho khối lượng phù hợp.

## 9. Công cụ trong repo

| File | Vai trò |
|---|---|
| `detect.js` | Toàn bộ logic trên — dùng chung cho web và CLI: `node detect.js <file.csv> [--eps 400] [--k 3] [--min-km 1] [--out canh_bao.csv]` |
| `index.html` | Bản đồ trực quan: marker theo nhóm đơn, vùng bao cụm EPIC, slider chỉnh eps/k/minKm xem flag đổi trực tiếp, bảng đơn xa + xuất CSV |
| `build_data.js` | Sinh `data.js` từ CSV để mở `index.html` trực tiếp bằng file:// (trình duyệt chặn fetch file cục bộ) |
