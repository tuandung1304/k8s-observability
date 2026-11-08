# Metrics & Instrumentation

## Khái niệm

Observability có ba loại tín hiệu chính, mỗi loại trả lời một câu hỏi khác nhau:

| Tín hiệu    | Trả lời câu hỏi                           | Chi phí                                           |
| ----------- | ----------------------------------------- | ------------------------------------------------- |
| **Metrics** | Hệ thống có ổn không? Xu hướng ra sao?    | Rẻ, cố định: một con số mỗi chuỗi mỗi lần scrape. |
| **Logs**    | Chuyện gì đã xảy ra với _request này_?    | Tăng theo traffic, đắt khi lưu trữ và tìm kiếm.   |
| **Traces**  | Request mất thời gian ở service/bước nào? | Tăng theo traffic, thường phải sampling.          |

**Metric** là một chuỗi số theo thời gian (time series), định danh bằng **tên + tập label**:

```text
http_server_request_duration_seconds_count{method="GET", route="/users/:id", status_code="200"}  1523
└────────────── tên metric ──────────────┘└─────────────────── label ──────────────────────┘  └ giá trị
```

Mỗi tổ hợp label khác nhau là **một time series riêng**. Đây là điểm mấu chốt để hiểu chi phí của metrics (xem [Cardinality](#cardinality)).

**Instrumentation** là việc thêm code vào ứng dụng để sinh ra metrics. Ứng dụng tự đếm và giữ số trong RAM, rồi phơi ra ở endpoint `/metrics` cho Prometheus đến lấy.

## Cách hoạt động

### Mô hình pull

```text
                       mỗi 15s: GET /metrics
Prometheus ───────────────────────────────────────┬──> Pod core 10.244.0.4:3000
   │                                              ├──> Pod core 10.244.0.7:3000
   │ lưu vào TSDB, gắn thêm label                 └──> Pod core 10.244.0.9:3000
   │ job, instance, pod, namespace...
   ▼
PromQL / Grafana / Alerting
```

- Ứng dụng **không gửi** metrics đi đâu. Nó chỉ cập nhật counter/histogram trong bộ nhớ, tốn vài trăm nanosecond mỗi request.
- Prometheus **chủ động scrape** từng target theo chu kỳ. Scrape thất bại thì metric `up{...}` bằng 0, nên "target chết" tự nó đã là một tín hiệu.
- Giá trị trong `/metrics` là **giá trị tích luỹ từ lúc process khởi động**, không phải "số request trong 15s qua". Phép tính tốc độ (`rate`) làm ở phía Prometheus.

So với mô hình push (StatsD, OTLP push, Datadog agent):

| Pull (Prometheus)                                                       | Push                                                                    |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Prometheus biết target nào phải tồn tại → phát hiện target chết.        | Không có dữ liệu = không biết là service chết hay chỉ không có traffic. |
| Ứng dụng không cần biết địa chỉ hệ thống monitoring.                    | Ứng dụng phải cấu hình endpoint, retry, buffer.                         |
| Cần đường mạng từ Prometheus tới target, khó với job ngắn hạn, sau NAT. | Hợp với serverless, batch job, client sau firewall.                     |

Job chạy vài giây (CronJob) có thể kết thúc trước lần scrape tiếp theo; trường hợp này dùng **Pushgateway** hoặc OTLP push.

### Scrape từng Pod, không scrape qua Service

Mỗi Pod có bộ đếm riêng trong RAM. Nếu Prometheus scrape qua ClusterIP Service, mỗi lần scrape rơi vào **một Pod ngẫu nhiên** (xem [Service](../kubernetes/service.md#cân-bằng-tải-theo-connection-không-theo-request)), nên số liệu nhảy lung tung giữa các Pod và không cộng lại được.

Cách đúng là Prometheus dùng **service discovery** để lấy danh sách IP từng Pod rồi scrape riêng từng cái, cần RBAC.

### Exposition format

`/metrics` trả về text thuần, mỗi dòng một sample:

```text
# HELP http_server_request_duration_seconds Duration of HTTP server requests
# TYPE http_server_request_duration_seconds histogram
http_server_request_duration_seconds_bucket{le="0.005",method="GET",route="/users/:id",status_code="200"} 120
http_server_request_duration_seconds_bucket{le="0.01",method="GET",route="/users/:id",status_code="200"} 340
...
http_server_request_duration_seconds_bucket{le="+Inf",method="GET",route="/users/:id",status_code="200"} 352
http_server_request_duration_seconds_sum{method="GET",route="/users/:id",status_code="200"} 2.71
http_server_request_duration_seconds_count{method="GET",route="/users/:id",status_code="200"} 352
```

Content-Type là `text/plain; version=0.0.4`. Prometheus cũng hỗ trợ OpenMetrics và protobuf (bắt buộc với native histogram).

## Bốn loại metric

| Loại          | Ý nghĩa                                                          | Ví dụ                                                  | Truy vấn thường dùng              |
| ------------- | ---------------------------------------------------------------- | ------------------------------------------------------ | --------------------------------- |
| **Counter**   | Chỉ tăng (reset về 0 khi process restart).                       | `http_requests_total`, `process_cpu_seconds_total`     | `rate()`, `increase()`            |
| **Gauge**     | Lên xuống tự do, là giá trị tức thời.                            | `process_resident_memory_bytes`, số connection đang mở | dùng trực tiếp, `avg_over_time()` |
| **Histogram** | Đếm quan sát vào các **bucket** cố định, kèm `_sum` và `_count`. | latency, kích thước payload                            | `histogram_quantile()`            |
| **Summary**   | Tính sẵn quantile (p50, p99) **ngay trong process**.             | latency khi không cần gộp nhiều instance               | đọc trực tiếp                     |

### Đừng bao giờ đọc thẳng giá trị counter

`http_requests_total = 15230` không nói lên gì: con số này phụ thuộc vào thời điểm Pod khởi động. Câu hỏi có nghĩa là "**bao nhiêu request mỗi giây**": `rate(http_requests_total[5m])`. `rate()` cũng tự xử lý trường hợp counter reset khi Pod restart.

### Histogram và Summary

Histogram lưu số quan sát rơi vào từng khoảng `le` (less than or equal), **tích luỹ**: bucket `le="0.1"` đếm mọi request ≤ 100ms, đã bao gồm cả bucket `le="0.05"`.

Từ bucket, Prometheus **ước lượng** quantile bằng nội suy tuyến tính:

```promql
histogram_quantile(0.95, sum by (le, route) (rate(http_server_request_duration_seconds_bucket[5m])))
```

| Tiêu chí                    | Histogram                                    | Summary                                       |
| --------------------------- | -------------------------------------------- | --------------------------------------------- |
| Gộp nhiều Pod               | **Được**: cộng bucket rồi mới tính quantile. | **Không**: không thể lấy trung bình các p99.  |
| Độ chính xác                | Phụ thuộc cách chọn bucket.                  | Chính xác (trong cửa sổ thời gian của nó).    |
| Đổi quantile sau khi đã thu | Được, tính lúc query.                        | Không, quantile cố định trong code.           |
| Chi phí trong ứng dụng      | Rẻ (tăng một counter).                       | Đắt hơn (duy trì cấu trúc dữ liệu streaming). |

Với service chạy nhiều replica, **gần như luôn dùng histogram**. Trung bình của p99 các Pod không phải p99 của cả service.

### Chọn bucket

- Độ chính xác chỉ tốt **quanh ranh giới bucket**. Nếu SLO là "95% request < 300ms" thì phải có bucket `0.25` và `0.5`, tốt nhất có đúng `0.3`.
- Mỗi bucket là một time series cho **mỗi** tổ hợp label. 11 bucket × 20 route × 3 method × 6 status = ~4000 series chỉ cho một metric.
- **Native histogram** (Prometheus 2.40+, ổn định từ 3.x) tự chia bucket theo hàm mũ, chính xác hơn và rẻ hơn nhiều, nhưng cần client và Prometheus cùng bật. `prom-client` chưa hỗ trợ.

## Cardinality

**Cardinality** = số time series. Đây là yếu tố số một quyết định RAM, disk và tốc độ query của Prometheus.

```text
số series của một metric = tích số giá trị khác nhau của mọi label (× số bucket nếu là histogram)
```

Một label có giá trị không bị chặn sẽ làm nổ Prometheus:

| Label nên dùng                                 | Label **không được** dùng                      |
| ---------------------------------------------- | ---------------------------------------------- |
| `route="/users/:id"` (template)                | `path="/users/8f3a..."` (URL thật)             |
| `status_code="404"`, hoặc `status_class="4xx"` | `user_id`, `email`, `request_id`, `session_id` |
| `method="GET"`                                 | message lỗi, query string, `user_agent`        |

Thông tin cấp request (user nào, request id nào) thuộc về **logs và traces**. Metrics chỉ nên trả lời câu hỏi tổng hợp.

## Nên đo gì: RED và USE

| Phương pháp                          | Áp dụng cho                          | Đo                                                                        |
| ------------------------------------ | ------------------------------------ | ------------------------------------------------------------------------- |
| **RED**                              | Service xử lý request (API, worker). | **R**ate (req/s), **E**rrors (tỷ lệ lỗi), **D**uration (phân bố latency). |
| **USE**                              | Tài nguyên (CPU, RAM, disk, pool).   | **U**tilization, **S**aturation (hàng đợi, chờ), **E**rrors.              |
| **Four Golden Signals** (Google SRE) | Cả hai.                              | Latency, Traffic, Errors, Saturation.                                     |

Một histogram latency có label `status_code` là đủ cho cả ba chữ RED:

```promql
# Rate
sum(rate(http_server_request_duration_seconds_count[5m]))
# Errors: tỷ lệ 5xx
sum(rate(http_server_request_duration_seconds_count{status_code=~"5.."}[5m]))
  / sum(rate(http_server_request_duration_seconds_count[5m]))
# Duration: p95
histogram_quantile(0.95, sum by (le) (rate(http_server_request_duration_seconds_bucket[5m])))
```

## Quy ước đặt tên

- `snake_case`, có tiền tố theo domain: `http_server_...`, `db_client_...`, `queue_...`.
- **Đơn vị cơ bản, ghi vào tên**: `_seconds` (không dùng ms), `_bytes`, `_ratio`.
- Counter kết thúc bằng `_total`. Histogram tự sinh `_bucket`, `_sum`, `_count`.
- `core` đặt tên theo OpenTelemetry semantic conventions (`http.server.request.duration` → `http_server_request_duration_seconds`), để sau này đổi sang OTel SDK không phải sửa dashboard.

## Instrumentation trong `core`

Code nằm ở `apps/core/src/metrics/`, dùng thẳng thư viện `prom-client` thay vì wrapper như `@willsoto/nestjs-prometheus`, để thấy rõ từng mảnh.

| Thành phần              | Vai trò                                                                                                                                |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `Registry` riêng        | Không dùng registry global của `prom-client`, để mỗi app instance (ví dụ trong test) có metrics riêng, không lỗi "already registered". |
| `collectDefaultMetrics` | Metric của process Node.js: CPU, RAM, heap, GC, **event loop lag**, số handle đang mở.                                                 |
| `HttpMetricsMiddleware` | Bấm giờ khi request vào, ghi vào histogram khi `res` phát sự kiện `finish`.                                                            |
| `GET /metrics`          | Trả `registry.metrics()` với đúng Content-Type.                                                                                        |

Các quyết định:

- **Ghi ở sự kiện `finish`**, không ghi trong interceptor. Interceptor không chạy cho route không tồn tại và chạy _sau_ guard, nên bỏ sót 404 và 401. Ở `finish`, exception filter đã đặt status code cuối cùng.
- **Label `route` là template** (`/users/:id`), lấy từ `req.route.path` sau khi routing xong. Request tới path không tồn tại gộp chung vào `route="unmatched"` để chặn cardinality.
  - Bẫy: Nest gắn middleware như một Express route wildcard, nên với path không khớp, `req.route` là layer của chính middleware (`{/*splat}`). Middleware lưu lại layer lúc bắt đầu và coi request là `unmatched` nếu tới `finish` nó vẫn không đổi.
- **Bỏ qua `/health` và `/metrics`**: kubelet probe và Prometheus scrape gọi đều đặn, sẽ làm sai lệch req/s và latency của traffic thật. Sức khoẻ target đã có metric `up` lo.

## CLI phổ biến

```bash
# Xem metrics của một Pod cụ thể (port-forward qua Service chỉ nối tới một Pod)
kubectl port-forward pod/<pod-name> 8080:3000
curl -s localhost:8080/metrics

# Lọc nhanh một metric
curl -s localhost:8080/metrics | grep '^http_server_request_duration_seconds_count'

# Kiểm tra format hợp lệ trước khi cho Prometheus scrape (promtool đi kèm Prometheus)
curl -s localhost:8080/metrics | promtool check metrics
```

### Lỗi thường gặp

| Triệu chứng                                                     | Nguyên nhân                                                                    |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Prometheus chậm dần, OOM                                        | Label cardinality cao (URL thật, user id).                                     |
| Số request "giảm" đột ngột                                      | Đọc thẳng counter, Pod vừa restart. Dùng `rate()`.                             |
| p99 trông quá đẹp hoặc phẳng lì                                 | Bucket quá thưa quanh vùng latency thật; quantile bị kẹp vào ranh giới bucket. |
| `Error: A metric with the name ... has already been registered` | Dùng registry global và khởi tạo module nhiều lần (test, hot reload).          |
| Số liệu nhảy lung tung giữa các lần scrape                      | Scrape qua Service thay vì từng Pod.                                           |

## Đặc điểm cần lưu ý

- Metrics trả lời **"có vấn đề không, ở đâu"**; logs và traces trả lời **"tại sao"**. Đừng cố nhét chi tiết request vào label.
- Giá trị trong `/metrics` là **trạng thái của một process**. Muốn nhìn cả service phải gộp (`sum by`) qua mọi Pod, nên label `pod`/`instance` do Prometheus gắn vào là rất quan trọng.
- Histogram gộp được, summary thì không. Đây là lý do thực tế để chọn histogram trong môi trường nhiều replica.
- Chi phí metrics tỉ lệ với **cardinality**, không phải traffic. 10 req/s hay 10.000 req/s tốn cùng một lượng series.
- `prom-client` vs OpenTelemetry SDK: `prom-client` đơn giản, đúng chuẩn Prometheus. OTel SDK thống nhất metrics, traces, logs và trung lập với vendor, nhưng nặng hơn và cấu hình phức tạp hơn. Đặt tên theo semantic conventions từ đầu giúp chuyển đổi về sau rẻ hơn.
