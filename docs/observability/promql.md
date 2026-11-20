# PromQL

## Khái niệm

**PromQL** là ngôn ngữ truy vấn của Prometheus. Mọi dashboard, alert và recording rule đều là một biểu thức PromQL, nên đọc được PromQL là điều kiện để hiểu hệ thống monitoring đang thật sự đo cái gì.

PromQL là ngôn ngữ **hàm trên time series**, không phải SQL: không có `JOIN`, `GROUP BY` theo kiểu bảng. Mỗi biểu thức trả về một trong bốn kiểu:

| Kiểu               | Là gì                                                     | Ví dụ                                 |
| ------------------ | --------------------------------------------------------- | ------------------------------------- |
| **Instant vector** | Tập series, **mỗi series một giá trị** tại một thời điểm. | `up`, `process_resident_memory_bytes` |
| **Range vector**   | Tập series, **mỗi series một dãy sample** trong cửa sổ.   | `http_requests_total[5m]`             |
| **Scalar**         | Một con số không có label.                                | `0.95`, `scalar(...)`                 |
| **String**         | Chuỗi, hầu như chỉ dùng làm tham số.                      | `"route"` trong `label_replace`       |

Graph chỉ vẽ được **instant vector**. Range vector phải đi qua một hàm (`rate`, `avg_over_time`...) để thành instant vector.

## Cách hoạt động

### Instant query và range query

```text
Instant query:  "giá trị tại thời điểm T là gì?"           → một điểm mỗi series (stat, table, alert)
Range query:    lặp lại instant query tại T0, T0+step, ...   → một đường mỗi series (graph)
```

Graph trên Grafana là **range query**: Prometheus đánh giá biểu thức tại mỗi `step` (ví dụ 15s, 30s, 1m tuỳ độ rộng khung thời gian), mỗi lần đánh giá độc lập.

### Lookback và staleness

Tại thời điểm đánh giá T, selector `up` lấy **sample gần nhất trong 5 phút trước T** (lookback delta). Vì vậy:

- Target chết, series vẫn hiện giá trị cũ tối đa 5 phút, trừ khi Prometheus kịp ghi **staleness marker** (khi target biến mất khỏi service discovery hoặc scrape thất bại, marker được ghi ngay và series dừng lại).
- Dữ liệu cũ vẫn nằm trong TSDB; "biến mất khỏi graph" không có nghĩa là bị xoá.

### Selector

```promql
http_server_request_duration_seconds_count{namespace="apps", route!="unmatched", status_code=~"5.."}
```

| Toán tử | Nghĩa                                                                |
| ------- | -------------------------------------------------------------------- |
| `=`     | bằng                                                                 |
| `!=`    | khác                                                                 |
| `=~`    | khớp regex (**neo cả chuỗi**: `"5.."` khớp `500`, không khớp `1500`) |
| `!~`    | không khớp regex                                                     |

Tên metric thật ra cũng là một label (`__name__`), nên `{__name__=~"nodejs_heap.*"}` là hợp lệ. Mọi selector phải có ít nhất một matcher không khớp chuỗi rỗng; `{app=~".*"}` bị từ chối vì nó chọn toàn bộ TSDB.

## rate, irate, increase

Counter chỉ tăng và reset về 0 khi process restart. Ba hàm biến counter thành thông tin có nghĩa:

| Hàm               | Trả về                                             | Dùng khi                                                |
| ----------------- | -------------------------------------------------- | ------------------------------------------------------- |
| `rate(c[5m])`     | Tốc độ trung bình **mỗi giây** trong cửa sổ.       | Graph, alert. Mặc định nên dùng hàm này.                |
| `irate(c[5m])`    | Tốc độ giữa **hai sample cuối** trong cửa sổ.      | Graph zoom gần, cần thấy spike. Không dùng cho alert.   |
| `increase(c[1h])` | Tổng mức tăng trong cửa sổ, bằng `rate × số giây`. | "Bao nhiêu lỗi trong 1 giờ qua" (con số cho người đọc). |

Những điều thường bị hiểu sai:

- **Cửa sổ phải chứa ít nhất 2 sample.** Với scrape 15s, `[30s]` thường chỉ có 1–2 sample và graph sẽ lỗ chỗ. Quy tắc: cửa sổ ≥ 4 × scrape interval. Grafana có `$__rate_interval` tính sẵn giá trị này (xem [Grafana](grafana.md#biến-có-sẵn)).
- **`increase()` trả về số thập phân** vì Prometheus ngoại suy tới hai mép cửa sổ. `increase(...[1h]) = 59.7` là bình thường.
- **Counter reset được xử lý tự động**: giá trị giảm được hiểu là restart và cộng nối tiếp.
- **Series mới sinh không có "điểm 0".** Một tổ hợp label (ví dụ `status_code="503"`) chỉ xuất hiện khi lần đầu có request đó. Nếu cả loạt request rơi trọn giữa hai lần scrape, sample đầu tiên đã mang giá trị cuối và `rate()` thấy mức tăng bằng 0. Thư viện client có thể khởi tạo trước các label biết trước về 0 để tránh mất tín hiệu này.
- **Luôn `rate` trước, `sum` sau.** `rate(sum(c))` sai: khi một Pod restart, tổng giảm và bị hiểu nhầm là counter reset. Cú pháp PromQL cũng buộc thứ tự đúng, vì `sum` trả về instant vector, không lấy `[5m]` được (trừ subquery).

## Aggregation

```promql
sum by (route) (rate(http_server_request_duration_seconds_count[5m]))     # giữ label route, gộp mọi label khác
sum without (pod, instance) (rate(...))                                   # gộp bỏ pod, instance, giữ phần còn lại
```

| Toán tử                           | Ý nghĩa                                                                  |
| --------------------------------- | ------------------------------------------------------------------------ |
| `sum`, `avg`, `min`, `max`        | Gộp theo nhóm.                                                           |
| `count`                           | Số series trong nhóm (ví dụ số Pod, số core).                            |
| `topk(5, ...)`, `bottomk`         | N series lớn/nhỏ nhất (tại mỗi step, nên trên graph có thể hơn 5 đường). |
| `quantile(0.9, ...)`              | Quantile **giữa các series**, không phải quantile latency.               |
| `count_values`, `group`, `stddev` | Ít dùng hơn.                                                             |

`by` an toàn hơn cho dashboard (biết chắc label nào còn lại); `without` hợp với recording rule (giữ nguyên label mới được thêm sau này như `cluster`, `region`).

Hàm `*_over_time` gộp **theo thời gian trên từng series**, khác với aggregation gộp **giữa các series**:

```promql
max_over_time(process_resident_memory_bytes[1h])     # đỉnh RSS của từng Pod trong 1 giờ
avg_over_time(up[1d])                                 # tỷ lệ thời gian target sống trong ngày
```

## Histogram quantile

```promql
histogram_quantile(0.95,
  sum by (le, route) (rate(http_server_request_duration_seconds_bucket[5m]))
)
```

Đọc từ trong ra:

1. `rate(..._bucket[5m])`: tốc độ request rơi vào mỗi bucket, trên mỗi Pod.
2. `sum by (le, route)`: cộng bucket của mọi Pod. **Bắt buộc giữ `le`**, vì đó là ranh giới bucket mà hàm cần.
3. `histogram_quantile(0.95, ...)`: nội suy tuyến tính trong bucket chứa quantile 95%.

Hệ quả của nội suy:

- Kết quả **không bao giờ vượt bucket hữu hạn lớn nhất**. Nếu bucket lớn nhất là `10` mà request mất 30s, p99 vẫn hiện `10`.
- Kết quả gần đúng trong phạm vi một bucket. p95 = `0.0047` khi mọi request < 5ms nghĩa là "nằm trong bucket 0–5ms", không phải "chính xác 4.7ms".
- Không có request nào → `NaN` (0/0). Dashboard thấy khoảng trống, không phải 0.

Latency trung bình tính từ `_sum` và `_count`:

```promql
sum(rate(http_server_request_duration_seconds_sum[5m])) / sum(rate(http_server_request_duration_seconds_count[5m]))
```

Trung bình che giấu đuôi phân phối. Một service có 1% request mất 10s vẫn có trung bình đẹp; quantile hoặc heatmap mới lộ ra.

**Apdex / tỷ lệ request đủ nhanh** (nền tảng của SLO latency) đọc thẳng từ một bucket, không cần nội suy:

```promql
sum(rate(http_server_request_duration_seconds_bucket{le="0.25"}[5m]))
  / sum(rate(http_server_request_duration_seconds_count[5m]))
```

## Toán tử hai ngôi và vector matching

Phép toán giữa hai instant vector **ghép series theo label giống hệt nhau**:

```promql
# Tỷ lệ 5xx theo route: hai vế đều chỉ còn label route, nên ghép 1-1
sum by (route) (rate(x_count{status_code=~"5.."}[5m]))
  / sum by (route) (rate(x_count[5m]))
```

Khi hai vế có label khác nhau:

```promql
# on(): chỉ so khớp theo label được liệt kê
a / on (pod) b
# ignoring(): bỏ qua label khi so khớp
a / ignoring (status_code) b
# group_left: nhiều series vế trái ghép với một series vế phải (many-to-one), kéo label từ phải sang
rate(container_cpu_usage_seconds_total[5m]) * on (pod) group_left (owner) kube_pod_owner_info
```

Toán tử logic làm việc trên **tập series**, không trên giá trị:

| Toán tử      | Kết quả                                                   |
| ------------ | --------------------------------------------------------- |
| `a and b`    | Series của `a` có cặp tương ứng trong `b`.                |
| `a or b`     | Series của `a`, cộng thêm series của `b` mà `a` không có. |
| `a unless b` | Series của `a` không có cặp trong `b`.                    |

`or` là cách chuẩn để thay "không có dữ liệu" bằng 0:

```promql
# Không có series 5xx nào → 0% thay vì No data (khi vẫn có traffic)
(sum(rate(x_count{status_code=~"5.."}[5m])) or vector(0)) / sum(rate(x_count[5m]))

# Theo route: lấy tập route từ tổng traffic, nhân 0 làm giá trị mặc định
(sum by (route) (rate(x_count{status_code=~"5.."}[5m])) or 0 * sum by (route) (rate(x_count[5m])))
  / sum by (route) (rate(x_count[5m]))
```

So sánh (`>`, `<`, `==`) mặc định là **bộ lọc**: `up == 0` trả về các series có giá trị 0, không trả về true/false. Thêm `bool` để lấy 0/1: `up == bool 0`. Đây chính là cách alert rule hoạt động: biểu thức trả về series nào thì series đó đang "firing".

## Các hàm hay dùng khác

| Hàm / cú pháp                                | Dùng cho                                                                                                                      |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `absent(up{job="x"})`                        | Trả về 1 khi **không có** series nào. Alert "job biến mất hoàn toàn".                                                         |
| `label_replace(v, "dst", "$1", "src", "re")` | Tạo/đổi label bằng regex, ví dụ gom `status_code` thành `2xx/4xx/5xx`.                                                        |
| `predict_linear(v[6h], 4*3600)`              | Ngoại suy tuyến tính: "đĩa đầy sau 4 giờ nữa?".                                                                               |
| `clamp_min`, `clamp_max`                     | Chặn giá trị, tránh số âm do nhiễu.                                                                                           |
| `offset 1w`                                  | So với cùng thời điểm tuần trước: `rate(x[5m]) / rate(x[5m] offset 1w)`.                                                      |
| `x[1h:1m]` (subquery)                        | Đánh giá biểu thức instant mỗi 1m trong 1h, để dùng `*_over_time` trên kết quả của `rate`. Đắt, nên thay bằng recording rule. |
| `@ end()`                                    | Cố định thời điểm đánh giá, ví dụ chọn top 5 theo giá trị cuối kỳ.                                                            |

## Đặc điểm cần lưu ý

- **Chi phí query tỷ lệ với số series × số sample được đọc.** `rate(x[1d])` trên 10.000 series với step 15s là rất nặng. Dashboard mở mặc định 7 ngày có thể làm Prometheus OOM.
- **Regex trên label cardinality cao rất chậm.** `{pod=~".*abc.*"}` phải quét mọi giá trị của `pod`. Lọc trước bằng label có ít giá trị (`namespace`, `app`).
- **Kết quả `rate` phụ thuộc cửa sổ.** Cửa sổ dài thì mượt nhưng chậm phản ứng (alert trễ); ngắn thì nhạy nhưng nhiễu. Alert thường dùng 5m, graph dùng `$__rate_interval`.
- **Aggregation làm mất label.** `sum(rate(...))` không còn biết lỗi đến từ Pod nào. Dashboard tốt có cả tầng tổng (service) và tầng chi tiết (`by (pod)`).
- **NaN, Inf và không có dữ liệu là ba trạng thái khác nhau.** 0/0 = NaN (không có traffic), x/0 = +Inf, còn selector không khớp series nào thì kết quả rỗng. Alert trên biểu thức rỗng không bao giờ firing, nên "im lặng" chưa chắc là "khoẻ".

## Góc nhìn kiến trúc

- **Query lặp lại nên thành recording rule.** Biểu thức RED dùng ở cả dashboard và alert nên được tính sẵn mỗi chu kỳ (`job:http_requests:rate5m`). Query đọc nhanh hơn, logic nằm một chỗ, và có thể bỏ label `pod` để giảm cardinality khi lưu dài hạn.
- **PromQL là chuẩn chung, không riêng Prometheus.** Thanos, Cortex/Mimir, VictoriaMetrics (MetricsQL, mở rộng của PromQL), Grafana Cloud, Amazon Managed Prometheus, Google Managed Prometheus đều nhận PromQL. Đầu tư vào dashboard và alert viết bằng PromQL không bị khoá vào một nhà cung cấp.
- **So với SQL/log query.** PromQL rất mạnh cho câu hỏi tổng hợp theo thời gian ("tỷ lệ lỗi 5 phút qua") nhưng không trả lời được câu hỏi về từng sự kiện ("request nào lỗi"). Đó là việc của logs và traces; hai thế giới nối với nhau qua label chung (`namespace`, `pod`, `app`) và exemplar.
- **Độ chính xác có giới hạn và đó là đánh đổi có chủ đích.** `rate` ngoại suy, `histogram_quantile` nội suy, lookback 5 phút làm trễ tín hiệu. Đổi lại là chi phí lưu trữ cố định và query nhanh trên hàng triệu series. Khi cần con số chính xác tuyệt đối (billing, audit), metrics không phải nguồn dữ liệu đúng.
