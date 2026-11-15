# Service Discovery & Relabeling

## Khái niệm

Prometheus kéo metrics (pull), nên nó phải biết **scrape ai**. Trong Kubernetes, Pod sinh ra, chết đi và đổi IP liên tục, nên danh sách target viết tay (`static_configs`) sẽ sai ngay sau lần rollout tiếp theo.

**Service discovery (SD)** để Prometheus tự lấy danh sách target từ một nguồn sự thật: API server của Kubernetes, Consul, EC2, DNS, file...

**Relabeling** là bước lọc và biến đổi danh sách đó trước khi scrape: chọn target nào giữ, đổi địa chỉ/port/path, gắn label gì vào time series.

```text
API server ──list/watch──> kubernetes_sd_configs ──> target + __meta_* labels
                                                         │
                                          relabel_configs (keep/drop/rewrite)
                                                         │
                                                         ▼
                                    scrape __scheme__://__address__/__metrics_path__
                                                         │
                                          metric_relabel_configs (lọc sau khi scrape)
                                                         ▼
                                                       TSDB
```

## Cách hoạt động

### Role

`kubernetes_sd_configs` có nhiều `role`, mỗi role sinh target theo một loại object:

| Role            | Một target cho mỗi                                                 | Địa chỉ mặc định             | Dùng cho                                       |
| --------------- | ------------------------------------------------------------------ | ---------------------------- | ---------------------------------------------- |
| `node`          | Node                                                               | `InternalIP:10250` (kubelet) | node-exporter, kubelet/cAdvisor                |
| `pod`           | Port khai báo của mỗi container (hoặc Pod nếu không khai báo port) | `podIP:containerPort`        | App tự phơi `/metrics`                         |
| `endpointslice` | Endpoint của Service                                               | `podIP:port`                 | Scrape theo Service, có thêm label của Service |
| `service`       | Port của Service                                                   | `svc DNS:port`               | Blackbox probe (kiểm tra từ bên ngoài)         |
| `ingress`       | Path của Ingress                                                   | host                         | Blackbox probe                                 |

Prometheus mở **watch** tới API server nên thay đổi đến gần như ngay lập tức, không phải polling. Trong repo này, scale `core` từ 5 xuống 3 thì sau vài giây trang Targets chỉ còn 3.

Quyền cần thiết xem [ServiceAccount & RBAC](../kubernetes/rbac.md#áp-dụng-cho-prometheus).

### Label `__meta_*` và label đặc biệt

Mỗi target được discover mang theo rất nhiều label tạm, ví dụ với role `pod`:

```text
__address__                                          = 10.244.0.17:3000
__meta_kubernetes_namespace                          = apps
__meta_kubernetes_pod_name                           = core-664797b7d8-kn4mc
__meta_kubernetes_pod_ip                             = 10.244.0.17
__meta_kubernetes_pod_phase                          = Running
__meta_kubernetes_pod_node_name                      = k8s-observability-control-plane
__meta_kubernetes_pod_label_app                      = core
__meta_kubernetes_pod_annotation_prometheus_io_scrape = true
__meta_kubernetes_pod_container_port_name            = http
```

Quy tắc:

- Label bắt đầu bằng `__` **bị xoá sau relabeling**. Muốn giữ thông tin nào (namespace, pod) phải copy sang label thường.
- Ký tự không hợp lệ trong tên label/annotation được đổi thành `_`: `prometheus.io/scrape` → `prometheus_io_scrape`.
- Vài label đặc biệt điều khiển việc scrape: `__address__`, `__metrics_path__`, `__scheme__`, `__param_<name>`, `__scrape_interval__`.
- Prometheus tự gắn `job` và `instance` (mặc định `instance = __address__`).

Xem trực tiếp trong UI: **Status → Service discovery** hiển thị label trước và sau relabel cho từng target, kể cả target bị drop. Đây là công cụ debug quan trọng nhất.

### Relabel rule

```yaml
- source_labels: [a, b] # nối giá trị bằng separator (mặc định ";") → "va;vb"
  regex: "(.+);(\\d+)" # regex được neo cả hai đầu (^...$)
  replacement: "${1}:${2}"
  target_label: __address__
  action: replace # mặc định
```

| Action                    | Tác dụng                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------- |
| `replace`                 | Ghi `replacement` vào `target_label` **nếu regex khớp**; không khớp thì bỏ qua.                   |
| `keep`                    | Bỏ target nếu regex **không** khớp.                                                               |
| `drop`                    | Bỏ target nếu regex khớp.                                                                         |
| `labelmap`                | Copy mọi label có tên khớp regex sang tên mới (ví dụ toàn bộ `__meta_kubernetes_pod_label_(.+)`). |
| `labeldrop` / `labelkeep` | Xoá/giữ label theo tên.                                                                           |
| `hashmod`                 | Chia target giữa nhiều Prometheus (sharding).                                                     |

Vì `replace` bỏ qua khi không khớp, rule `regex: "(.+)"` trên annotation path có nghĩa là "Pod có annotation thì dùng, không thì giữ `/metrics` mặc định".

## Cấu hình trong repo

`k8s/observability/prometheus-config.yaml` có ba job:

| Job               | SD                      | Ghi chú                                                                           |
| ----------------- | ----------------------- | --------------------------------------------------------------------------------- |
| `prometheus`      | static `localhost:9090` | Tự scrape chính nó.                                                               |
| `node-exporter`   | `role: node`            | Đổi port 10250 → 9100. Thay cho IP cứng `192.168.97.2:9100` trước đây.            |
| `kubernetes-pods` | `role: pod`, chỉ `apps` | Opt-in bằng annotation, chỉ Pod `Running`, gắn `namespace`, `pod`, `node`, `app`. |

Pod của `core` khai báo trong pod template:

```yaml
annotations:
  prometheus.io/scrape: "true"
  prometheus.io/port: "3000"
  prometheus.io/path: /metrics
```

Annotation `prometheus.io/*` **không phải tính năng của Kubernetes hay Prometheus**, chỉ là quy ước mà relabel rule đọc. Đổi annotation trong pod template cũng là đổi template, nên kích hoạt một lần rolling update.

### Vì sao `role: pod` mà không phải `endpointslice`

| `role: pod` + annotation                                     | `role: endpointslice` (qua Service)                                           |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| Không cần Service. Scrape được cả worker không nhận traffic. | Cần Service; target là Pod đứng sau Service.                                  |
| Thấy cả Pod **chưa Ready** → biết Pod đang khởi động/kẹt.    | Chỉ Pod Ready nằm trong EndpointSlice (trừ khi đọc thêm `notReadyAddresses`). |
| Chỉ cần quyền `pods`.                                        | Cần `endpointslices`, `services`, `pods`.                                     |
| Không có label của Service.                                  | Có `__meta_kubernetes_service_name`, tiện gom theo service.                   |

Phía Prometheus Operator, hai cách này tương ứng **PodMonitor** và **ServiceMonitor**.

### Thay đổi config

- ConfigMap mount **cả thư mục** vào `/etc/prometheus`. Mount bằng `subPath` thì file **không bao giờ được cập nhật** khi ConfigMap đổi; đây là lý do manifest cũ phải xoá Pod mỗi lần sửa config.
- Kubelet đồng bộ ConfigMap vào volume sau tối đa khoảng một phút. Sau đó gọi `POST /-/reload` (bật bằng `--web.enable-lifecycle`). Config sai thì Prometheus giữ config cũ và log lỗi, không sập.
- Thực tế người ta chạy thêm sidecar (`config-reloader`) tự gọi reload khi file đổi, hoặc dùng Prometheus Operator.

## CLI phổ biến

```bash
kubectl port-forward -n observability deploy/prometheus 9090:9090
# http://localhost:9090/targets             → trạng thái từng target, lỗi scrape gần nhất
# http://localhost:9090/service-discovery   → label trước/sau relabel

# Liệt kê target qua API
curl -s 'localhost:9090/api/v1/targets?state=active' \
  | jq -r '.data.activeTargets[] | [.labels.job, .scrapeUrl, .health] | @tsv'

# Kiểm tra cú pháp config trước khi apply
kubectl get cm -n observability prometheus-config -o jsonpath='{.data.prometheus\.yml}' > /tmp/p.yml
promtool check config /tmp/p.yml

# Reload sau khi sửa ConfigMap
kubectl apply -f k8s/observability/prometheus-config.yaml
kubectl exec -n observability deploy/prometheus -- wget -qO- --post-data= localhost:9090/-/reload

# Log lỗi SD (thường là RBAC)
kubectl logs -n observability deploy/prometheus | grep -i forbidden
```

```promql
up                                     # 1 = scrape được, 0 = target có nhưng scrape lỗi
count by (job) (up)                    # số target mỗi job
sum by (pod) (process_resident_memory_bytes{app="core"})
```

### Lỗi thường gặp

| Triệu chứng                                    | Nguyên nhân                                                                                                                                                                  |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Job không có target nào, log có `forbidden`    | Thiếu RBAC cho namespace/role đó, hoặc `namespaces.names` lệch với RoleBinding.                                                                                              |
| Job không có target nào, không có lỗi          | Relabel `keep` loại hết: sai tên annotation, giá trị `"true"` không có dấu nháy trong YAML (thành boolean), hoặc annotation đặt ở Deployment thay vì pod template.           |
| Một Pod có thêm target `down` ở port lạ        | Container khai báo nhiều port, role `pod` sinh một target mỗi port. Ghi đè `__address__` bằng annotation port, hoặc `keep` theo `__meta_kubernetes_pod_container_port_name`. |
| Target `down`, `connection refused`            | Port sai, app chỉ listen `127.0.0.1`, hoặc NetworkPolicy chặn từ namespace `observability`.                                                                                  |
| Target `down` với node-exporter                | Quên đổi port 10250 → 9100 (đang scrape kubelet, cần TLS + auth).                                                                                                            |
| Series cũ của Pod đã chết vẫn hiện trong Graph | Bình thường: series ngừng cập nhật và thành "stale" sau 5 phút; dữ liệu cũ vẫn ở trong TSDB.                                                                                 |
| Sửa ConfigMap không có tác dụng                | Mount bằng `subPath`, chưa đợi kubelet sync, hoặc chưa gọi `/-/reload`.                                                                                                      |

## Đặc điểm cần lưu ý

- **Label quyết định khả năng truy vấn.** `namespace`, `pod`, `node`, `app` gắn ở đây là thứ cho phép `sum by (pod)`, lọc theo service, join với metrics của kube-state-metrics. Thiếu chúng thì metrics từ 5 Pod chỉ phân biệt được bằng IP.
- **Label `pod` có cardinality tăng theo số lần deploy.** Mỗi rollout sinh tên Pod mới, tức series mới. Với retention ngắn thì ổn; với lưu trữ dài hạn, nên gộp bỏ `pod` bằng recording rule.
- **Annotation là opt-in đơn giản nhưng không kiểm soát được.** Bất kỳ ai sửa được Deployment đều tự đưa Pod vào Prometheus (kèm cardinality của họ). ServiceMonitor/PodMonitor của Prometheus Operator cho phép đội platform kiểm soát qua RBAC trên CRD và `namespaceSelector`.
- **Tự viết config vs Prometheus Operator / kube-prometheus-stack.** Viết tay giúp hiểu rõ SD và relabel, đủ dùng cho vài job. Operator đổi config thành CRD, tự reload, có sẵn dashboard và alert cho cluster, nhưng thêm một lớp trừu tượng và hàng chục CRD phải hiểu khi có sự cố.
- **Prometheus vẫn là single point.** Một replica, `emptyDir`: Pod bị xoá là mất dữ liệu. PVC, HA (hai replica scrape giống nhau) và lưu trữ dài hạn (Thanos, Mimir) là những bước tiếp theo.
