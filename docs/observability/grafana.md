# Grafana

## Khái niệm

**Grafana** là lớp hiển thị: nó **không lưu metrics**. Mỗi lần mở dashboard, Grafana gửi query tới **datasource** (Prometheus, Loki, Tempo, PostgreSQL, CloudWatch...) rồi vẽ kết quả.

```text
Trình duyệt ──> Grafana ──PromQL (range query)──> Prometheus ──> TSDB
                  │
                  └── database riêng (SQLite/PostgreSQL/MySQL):
                      user, org, quyền, dashboard, datasource, alert, annotation
```

Các khái niệm chính:

| Khái niệm        | Là gì                                                                                        |
| ---------------- | -------------------------------------------------------------------------------------------- |
| **Datasource**   | Kết nối tới một backend dữ liệu: URL, cách xác thực, tuỳ chọn riêng (ví dụ scrape interval). |
| **Dashboard**    | Một tài liệu JSON gồm panel, biến, khung thời gian. Định danh bằng `uid`.                    |
| **Panel**        | Một query (hoặc vài query) + cách vẽ: time series, stat, gauge, table, heatmap...            |
| **Variable**     | Dropdown đầu dashboard (`$namespace`, `$pod`), giá trị được thay vào query trước khi gửi.    |
| **Folder**       | Nhóm dashboard, đơn vị phân quyền.                                                           |
| **Provisioning** | Nạp datasource, dashboard, alert từ file lúc khởi động thay vì tạo bằng tay trên UI.         |

## Cách hoạt động

### Grafana trong Kubernetes

Grafana là một ứng dụng web stateful nhẹ, chạy như Deployment + Service:

```text
Namespace observability
┌──────────────────────────────────────────────────────────────────────┐
│  Deployment grafana (1 replica, strategy Recreate)                   │
│    ├─ env từ Secret: admin user/password                              │
│    ├─ /etc/grafana/provisioning/datasources  ← ConfigMap datasources  │
│    ├─ /etc/grafana/provisioning/dashboards   ← ConfigMap providers    │
│    ├─ /var/lib/grafana-dashboards            ← ConfigMap JSON         │
│    └─ /var/lib/grafana (SQLite)              ← emptyDir hoặc PVC      │
│                                                                      │
│  Service grafana ──> Pod :3000          Service prometheus ──> :9090  │
└──────────────────────────────────────────────────────────────────────┘
```

- Grafana gọi Prometheus qua **DNS của Service** (`http://prometheus.observability.svc:9090`), không qua IP của Pod. Prometheus scrape từng Pod trực tiếp, nhưng client của Prometheus thì luôn đi qua Service để có địa chỉ ổn định.
- Database mặc định là **SQLite trên đĩa local**, nên chỉ chạy được **một replica** và phải dùng strategy `Recreate`: hai Pod cùng ghi một file SQLite sẽ làm hỏng dữ liệu (với PVC `ReadWriteOnce`, Pod mới còn không mount được). Muốn HA thì chuyển database sang PostgreSQL/MySQL dùng chung, khi đó Grafana stateless và scale ngang được.
- Grafana không cần gọi Kubernetes API, nên tắt `automountServiceAccountToken`.

### Access mode của datasource

| Mode                       | Ai gửi query tới Prometheus     | Hệ quả                                                        |
| -------------------------- | ------------------------------- | ------------------------------------------------------------- |
| `proxy` (server, mặc định) | Backend Grafana, trong cluster. | Prometheus không cần lộ ra ngoài; Grafana giữ credential.     |
| `direct` (browser)         | Trình duyệt người dùng.         | Đã deprecated: phải lộ Prometheus, lộ credential, vướng CORS. |

### Provisioning

Grafana đọc thư mục `/etc/grafana/provisioning/` lúc khởi động:

```text
/etc/grafana/provisioning/
├── datasources/*.yaml     # danh sách datasource
├── dashboards/*.yaml      # "provider": thư mục nào chứa dashboard JSON
├── alerting/*.yaml        # rule, contact point, notification policy
└── plugins/*.yaml
```

Datasource:

```yaml
apiVersion: 1
prune: true                       # xoá datasource mà phiên bản trước của file đã tạo
datasources:
  - name: Prometheus
    type: prometheus
    uid: prometheus               # uid cố định, dashboard tham chiếu bằng uid này
    url: http://prometheus.monitoring.svc:9090
    access: proxy
    isDefault: true
    editable: false
    jsonData:
      timeInterval: 15s           # bằng scrape_interval, dùng để tính $__rate_interval
```

Dashboard provider:

```yaml
apiVersion: 1
providers:
  - name: default
    folder: Platform
    type: file
    updateIntervalSeconds: 30     # quét lại thư mục định kỳ
    allowUiUpdates: false         # true: sửa được trên UI nhưng mất khi file đổi
    options:
      path: /var/lib/grafana-dashboards
```

Hai loại có cách reload khác nhau:

| Loại       | Đổi file xong thì                                                                                                              |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Datasource | Chỉ đọc lúc khởi động. Cần restart Pod (hoặc gọi API reload provisioning).                                                     |
| Dashboard  | Provider quét lại mỗi `updateIntervalSeconds`. Kết hợp với kubelet sync ConfigMap (~1 phút) là tự cập nhật, không cần restart. |

### Đưa dashboard JSON vào Pod

Dashboard JSON thường dài hàng nghìn dòng, sửa trực tiếp trong YAML rất khó. Cách phổ biến với manifest thuần:

```bash
# Giữ JSON thành file riêng, sinh ConfigMap từ thư mục
kubectl create configmap grafana-dashboards -n monitoring \
  --from-file=dashboards/ --dry-run=client -o yaml \
  | kubectl apply --server-side -f -
```

- `--dry-run=client -o yaml | kubectl apply` biến lệnh `create` (không idempotent) thành `apply` (chạy lại được).
- `--server-side`: `kubectl apply` thường lưu toàn bộ object vào annotation `last-applied-configuration`, mà annotation bị giới hạn **256KiB**. Vài dashboard lớn là vượt; server-side apply không dùng annotation đó.
- ConfigMap giới hạn **1MiB**; nhiều dashboard thì tách nhiều ConfigMap.
- Mount **cả thư mục**, không `subPath`, để thay đổi ConfigMap tới được Pod.

Các lựa chọn khác: Kustomize `configMapGenerator`, Helm chart của Grafana (`dashboards` values), **sidecar** theo dõi mọi ConfigMap có label `grafana_dashboard: "1"` trong cluster (cách kube-prometheus-stack dùng, cho phép mỗi team tự ship dashboard cùng app), hoặc Grafana Operator với CRD `GrafanaDashboard`.

## Thiết kế dashboard

### Biến có sẵn

| Biến               | Giá trị                                                                                                    |
| ------------------ | ---------------------------------------------------------------------------------------------------------- |
| `$__rate_interval` | `max($__interval + scrape interval, 4 × scrape interval)`. Dùng cho mọi `rate()`/`increase()` trong graph. |
| `$__interval`      | Khoảng cách giữa hai điểm trên graph, tự co giãn theo khung thời gian và độ rộng panel.                    |
| `$__range`         | Độ dài khung thời gian đang chọn, ví dụ `increase(x[$__range])` cho "tổng trong kỳ".                       |

Viết cứng `rate(x[1m])` thì khi xem 7 ngày (step vài phút) Prometheus bỏ qua phần lớn sample giữa các điểm; khi scrape interval là 1m thì cửa sổ chỉ chứa 1 sample và graph trống. `$__rate_interval` tránh cả hai, với điều kiện `timeInterval` của datasource khai báo đúng scrape interval.

### Template variable

```text
datasource  type: datasource (prometheus)         → đổi cluster/môi trường không cần sửa dashboard
namespace   label_values(http_..._count, namespace)
app         label_values(http_..._count{namespace="$namespace"}, app)
pod         label_values(up{namespace="$namespace", app="$app"}, pod)    multi, All = ".*"
```

- Biến **phụ thuộc nhau** (cascading): `app` lọc theo `$namespace`, `pod` lọc theo `$app`.
- Biến **multi-value** được Grafana nối thành regex `(a|b|c)`, nên trong query phải dùng `=~` (`pod=~"$pod"`), không dùng `=`.
- Đặt **custom all value** `.*` thay vì để Grafana liệt kê mọi giá trị: query ngắn hơn và tự gồm cả Pod mới sinh sau khi dashboard được mở.
- `label_values` có cardinality cao (`pod`, `route`) nên luôn có filter đi kèm, nếu không mỗi lần mở dashboard là một lần quét toàn TSDB.

### Bố cục theo phương pháp

Dashboard tốt trả lời câu hỏi theo thứ tự người trực sự cố cần:

```text
┌ Overview (stat) ─────────────────────────────────────────────┐   "Có vấn đề không?"
│  Request rate │ Error ratio │ p95 latency │ Targets up        │   1 dòng, ngưỡng màu
├ Rate ────────────────────────────────────────────────────────┤
│  by route                   │  by status code                 │   "Vấn đề ở đâu?"
├ Errors ──────────────────────────────────────────────────────┤
├ Duration ────────────────────────────────────────────────────┤
│  p50/p95/p99 │ p95 by route │ heatmap                         │
├ Saturation (per pod) ────────────────────────────────────────┤   "Vì sao?"
│  CPU, memory, event loop / GC, requests per pod              │
└──────────────────────────────────────────────────────────────┘
```

- **RED** cho service (Rate, Errors, Duration), **USE** cho tài nguyên (Utilization, Saturation, Errors). Xem [Metrics](metrics.md#nên-đo-gì-red-và-use).
- **Hàng trên cùng là stat có ngưỡng màu**: nhìn 2 giây biết xanh/đỏ. Ngưỡng nên trùng với ngưỡng alert để hai nơi không mâu thuẫn.
- **Heatmap** cho latency: thấy được phân phối hai đỉnh (ví dụ cache hit/miss) mà mọi đường quantile đều che mất.
- Mỗi panel có **description** nói rõ query đo gì và cách đọc. Người mở dashboard lúc 3 giờ sáng không phải người viết nó.
- `graphTooltip: shared crosshair` giúp so cùng một thời điểm giữa nhiều panel (latency tăng có trùng lúc CPU chạm limit không?).

### Đơn vị

Chọn đúng `unit` để Grafana tự đổi thang: `s` (0.004 → 4 ms), `bytes` (IEC: KiB/MiB), `reqps`, `percentunit` (0.05 → 5%). Giữ metric ở đơn vị gốc (giây, byte, tỷ lệ 0–1) theo quy ước của Prometheus, phần hiển thị để Grafana lo.

## CLI phổ biến

```bash
# Mở UI
kubectl port-forward -n <ns> svc/grafana 3000:80

# Mật khẩu admin
kubectl get secret -n <ns> grafana-admin -o jsonpath='{.data.admin-password}' | base64 -d

# Kiểm tra kết nối datasource
curl -s -u admin:$PASS localhost:3000/api/datasources/uid/prometheus/health

# Liệt kê dashboard đã nạp
curl -s -u admin:$PASS 'localhost:3000/api/search?type=dash-db' | jq '.[] | {uid, title, folderTitle}'

# Xuất JSON của dashboard (sau khi sửa trên UI) để lưu lại vào git
curl -s -u admin:$PASS localhost:3000/api/dashboards/uid/<uid> | jq '.dashboard | del(.id, .version)' > <uid>.json

# Log provisioning
kubectl logs -n <ns> deploy/grafana | grep -i provisioning
```

### Lỗi thường gặp

| Triệu chứng                                                 | Nguyên nhân                                                                                                     |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Panel báo `Datasource ... was not found`                    | Dashboard tham chiếu uid datasource không tồn tại. Cố định `uid` khi provision, hoặc dùng biến `${datasource}`. |
| Datasource health check lỗi `no such host`                  | Sai tên Service/namespace trong URL, hoặc Service chưa được tạo.                                                |
| Graph trống ở khung 7 ngày nhưng có dữ liệu ở 1 giờ         | `rate(x[1m])` viết cứng; dùng `$__rate_interval`.                                                               |
| Graph trống ở mọi khung, query chạy được trên Prometheus    | Biến multi-value dùng `=` thay vì `=~`, hoặc biến chưa có giá trị (query `label_values` trả rỗng).              |
| Sửa dashboard trên UI, vài phút sau mất                     | Dashboard được provision; file nguồn ghi đè. Xuất JSON và cập nhật file.                                        |
| Sửa ConfigMap, Grafana không đổi                            | Mount bằng `subPath`, kubelet chưa sync, hoặc đó là datasource (cần restart).                                   |
| `metadata.annotations: Too long` khi apply                  | ConfigMap dashboard vượt 256KiB annotation; dùng `kubectl apply --server-side`.                                 |
| Pod CrashLoop, log `permission denied` ở `/var/lib/grafana` | Volume không thuộc UID 472 của image; đặt `fsGroup: 472`.                                                       |
| Mất user, dashboard tạo tay sau khi Pod bị xoá              | Database SQLite nằm trên `emptyDir`. Dùng PVC hoặc database ngoài, và provision mọi thứ quan trọng.             |

## Đặc điểm cần lưu ý

- **Grafana không phải nơi lưu sự thật.** Mọi thứ cần giữ (datasource, dashboard, alert) nên nằm trong git và được provision. Khi đó database của Grafana chỉ còn chứa session, preference, và mất cũng không sao.
- **Mỗi panel là một (hoặc vài) query mỗi lần refresh.** Dashboard 30 panel, refresh 10s, 20 người mở là ~60 query/giây vào Prometheus. Refresh 30s–1m là đủ cho hầu hết dashboard.
- **Dashboard không phải alert.** Không ai ngồi nhìn dashboard 24/7. Dashboard dùng để chẩn đoán sau khi alert kêu; nếu một panel quan trọng đến mức phải nhìn liên tục thì nó nên là alert rule.
- **Quyền xem dashboard = quyền chạy query trên datasource.** Viewer có thể dùng Explore để chạy PromQL tuỳ ý trên datasource họ thấy. Tách datasource/folder theo team nếu dữ liệu nhạy cảm.
- **Version của schema dashboard.** JSON xuất từ Grafana mới có thể không nạp được vào Grafana cũ. Cố định phiên bản image và nâng cấp có kiểm soát.

## Góc nhìn kiến trúc

- **Dashboard as code.** JSON trong git là bước đầu; xa hơn là sinh JSON bằng code (Grafonnet/Jsonnet, Grafana Foundation SDK cho Go/TypeScript/Python) để tái sử dụng panel, đảm bảo mọi service có cùng một bộ RED với cùng ngưỡng. Đánh đổi: thêm một bước build, người không biết lập trình khó sửa.
- **Tự host vs managed.** Grafana tự host trong cluster rẻ và đủ cho một team. Ở quy mô tổ chức, Grafana Cloud, Amazon Managed Grafana, Azure Managed Grafana gánh phần HA, SSO, nâng cấp, nhưng tính tiền theo user và kéo dữ liệu đi qua mạng ngoài.
- **Một Grafana cho nhiều cluster.** Mô hình phổ biến: mỗi cluster có Prometheus riêng, một Grafana trung tâm nối tới nhiều datasource (hoặc tới một Thanos/Mimir gộp dữ liệu). Biến `datasource` trên dashboard cho phép cùng một dashboard xem cluster nào cũng được.
- **Grafana vs các lựa chọn khác.** Kibana gắn chặt với Elasticsearch; Datadog/New Relic gộp thu thập, lưu trữ và hiển thị trong một sản phẩm trả phí. Grafana chỉ làm hiển thị nên ghép được với nhiều backend, đổi lại phải tự lắp và vận hành từng mảnh.
- **Grafana không chỉ để vẽ.** Grafana Alerting, correlations giữa metrics/logs/traces (click từ panel latency sang log của đúng Pod, đúng khoảng thời gian) là lý do nó trở thành "mặt tiền" chung của observability stack. Điều kiện để correlation hoạt động là các tín hiệu dùng **chung label** (`namespace`, `pod`, `app`).
