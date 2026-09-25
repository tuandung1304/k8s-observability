# Pod

## Khái niệm

**Pod** là đơn vị nhỏ nhất mà Kubernetes tạo, schedule và quản lý. Kubernetes không chạy container trực tiếp — nó chạy Pod, và Pod chứa một hoặc nhiều container.

Có thể hình dung Pod như một **"máy logic"**: các container trong cùng Pod giống như các process chạy trên cùng một máy — dùng chung địa chỉ IP, chung `localhost`, có thể chia sẻ volume — nhưng mỗi container vẫn có filesystem (image) và giới hạn tài nguyên riêng.

Phần lớn Pod chỉ có **một container** chính. Nhiều container trong một Pod chỉ hợp lý khi chúng **gắn chặt với nhau** — phải chạy cùng node, cùng vòng đời, và giao tiếp qua `localhost` hoặc file dùng chung.

## Cách hoạt động

### Pod được tạo ra như thế nào

```text
kubectl apply
   │
   ▼
kube-apiserver ──► etcd            (lưu Pod object, spec.nodeName còn trống)
   │
   ▼
kube-scheduler                     (chọn node phù hợp → ghi spec.nodeName)
   │
   ▼
kubelet trên node đó               (thấy Pod được gán cho mình)
   ├── gọi CRI (containerd) tạo "pause" container → giữ network namespace
   ├── CNI plugin (Calico, Cilium...) cấp IP cho Pod từ podSubnet (10.244.x.x)
   ├── mount volume (ConfigMap, Secret, emptyDir...)
   ├── chạy init containers (tuần tự, lần lượt phải thành công)
   ├── chạy app containers
   └── chạy probe, báo status ngược lại apiserver
```

Điểm mấu chốt: **scheduler chỉ quyết định Pod chạy ở đâu**, còn **kubelet là thứ thực sự chạy nó**. Sau khi một Pod đã được gán node, nó **không bao giờ di chuyển** sang node khác — nếu node chết, Pod đó chết theo; muốn có Pod mới thì phải có controller (Deployment, ReplicaSet...) tạo lại.

### Pause container và network namespace dùng chung

Mỗi Pod có một container ẩn tên `pause` (sandbox). Nó không làm gì ngoài việc giữ **network namespace** (và IPC namespace). Các container của app join vào namespace đó, nên:

- Tất cả container trong Pod dùng chung **một IP** và **một dải port** — hai container không thể cùng listen port `3000`.
- Container A gọi container B qua `localhost:<port>`.
- Nếu container app crash và được restart, IP của Pod **không đổi**, vì namespace do `pause` giữ.

Có thể thấy `pause` container ở tầng container runtime bằng `crictl`, chạy trực tiếp trên node:

```bash
crictl pods --name <pod>      # mỗi Pod sandbox = một pause container
crictl ps --pod <POD_ID>      # các container app thuộc sandbox đó
```

### IP của Pod là tạm thời

Mỗi Pod có IP riêng, routable trong cluster (mô hình mạng "phẳng" của Kubernetes: Pod nói chuyện với Pod không cần NAT). Nhưng IP này **mất khi Pod bị xoá** và Pod mới sẽ có IP khác. Vì vậy không bao giờ hardcode IP Pod — dùng **Service** để có một địa chỉ ổn định (DNS + ClusterIP) đứng trước một nhóm Pod chọn theo label.

## Vòng đời (Lifecycle)

### Pod phase

| Phase       | Ý nghĩa                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------- |
| `Pending`   | Đã được apiserver chấp nhận nhưng chưa chạy: chờ schedule, đang pull image, đang chạy init. |
| `Running`   | Đã gán node, ít nhất một container đang chạy (hoặc đang khởi động/restart).                 |
| `Succeeded` | Mọi container đã exit với code 0 và sẽ không restart (thường gặp ở Job).                    |
| `Failed`    | Mọi container đã dừng, ít nhất một container exit lỗi và không được restart.                |
| `Unknown`   | Không lấy được trạng thái Pod — thường do mất kết nối với kubelet của node.                 |

> ⚠️ `Running` **không có nghĩa là app sẵn sàng**. Cột `READY` (ví dụ `0/1`) và condition `Ready` mới cho biết Pod có đang nhận traffic hay không.

Những trạng thái như `CrashLoopBackOff`, `ImagePullBackOff`, `ErrImagePull`, `OOMKilled` mà `kubectl get pods` hiển thị **không phải phase** — chúng là _reason_ của container state (`Waiting` / `Terminated`), được kubectl gom lên cột `STATUS` cho dễ đọc.

### Container state & restartPolicy

Mỗi container có state riêng: `Waiting`, `Running`, `Terminated`. Khi container exit, kubelet xử lý theo `spec.restartPolicy` (áp dụng cho cả Pod):

- `Always` (mặc định) — luôn restart. Dùng cho service chạy lâu dài.
- `OnFailure` — chỉ restart khi exit code ≠ 0. Dùng cho Job.
- `Never` — không restart.

Restart được thực hiện **tại chỗ, trên cùng node**, với **exponential backoff** (10s, 20s, 40s... tối đa 5 phút) — đó chính là `CrashLoopBackOff`. Restart container ≠ tạo Pod mới: IP, volume `emptyDir`, và tên Pod vẫn giữ nguyên.

### Probe

Kubelet dùng probe để biết trạng thái bên trong app — thứ mà "process còn sống" không nói lên được:

| Probe            | Câu hỏi                          | Khi fail                                                               |
| ---------------- | -------------------------------- | ---------------------------------------------------------------------- |
| `startupProbe`   | App đã khởi động xong chưa?      | Kill và restart container. Trong lúc chạy, 2 probe còn lại bị tạm tắt. |
| `readinessProbe` | App có sẵn sàng nhận request?    | Gỡ Pod khỏi endpoint của Service — **không restart**.                  |
| `livenessProbe`  | App có bị treo (deadlock) không? | Kill và restart container.                                             |

Mỗi probe có thể là `httpGet`, `tcpSocket`, `exec` (chạy lệnh, exit 0 = ok) hoặc `grpc`.

Nguyên tắc thiết kế probe:

- **Liveness phải "ngu"**: chỉ kiểm tra chính process đó còn phản hồi. **Không** kiểm tra database hay service phụ thuộc — nếu DB chết, liveness fail sẽ khiến mọi Pod restart liên tục, biến sự cố một thành phần thành sự cố toàn hệ thống (cascading failure).
- **Readiness có thể kiểm tra dependency** ở mức cần thiết để phục vụ request, vì fail readiness chỉ ngừng gửi traffic chứ không giết Pod.
- **Dùng startupProbe cho app khởi động chậm** thay vì đặt `initialDelaySeconds` lớn cho liveness — vừa không bị kill oan lúc khởi động, vừa phát hiện treo nhanh khi đã chạy.

### Tắt Pod (graceful shutdown)

Khi Pod bị xoá (scale down, rolling update, drain node...):

1. Pod chuyển sang `Terminating`, đồng thời **bị gỡ khỏi endpoint của Service**.
2. Chạy hook `preStop` (nếu có).
3. Kubelet gửi **`SIGTERM`** cho process PID 1 của mỗi container.
4. Chờ tối đa `terminationGracePeriodSeconds` (mặc định **30s**).
5. Hết thời gian mà vẫn chưa thoát → **`SIGKILL`**.

Bước 1 và bước 2–3 diễn ra **song song**, nên có một khoảng ngắn Pod đã nhận `SIGTERM` nhưng kube-proxy/ingress ở các node khác chưa cập nhật và vẫn gửi request tới. Dùng `preStop: sleep` vài giây để trì hoãn `SIGTERM` cho đến khi routing cập nhật xong. Lưu ý grace period được tính **từ lúc bắt đầu preStop**.

Hai điều kiện để graceful shutdown hoạt động:

- **Process app phải nhận được signal.** Kubelet chỉ gửi `SIGTERM` cho PID 1 của container. Dùng exec form trong Dockerfile (`CMD ["./app"]`); shell form (`CMD ./app`) hoặc chạy qua script/package manager khiến PID 1 là shell, và signal có thể không tới được app.
- **App phải xử lý `SIGTERM`.** Linux **bỏ qua** signal gửi tới PID 1 nếu process đó không đăng ký handler. Nhiều runtime (Node.js, Python...) mặc định không đăng ký — Pod sẽ nằm `Terminating` hết grace period rồi bị `SIGKILL`. Dấu hiệu dễ nhận biết: xoá Pod luôn mất đúng ~30s.

Kubernetes chỉ gửi signal và đếm giờ; việc ngừng nhận request, xử lý nốt request dang dở, đóng kết nối DB là **trách nhiệm của ứng dụng**. Cách làm cụ thể cho Node.js: [Health check & Graceful shutdown](../nodejs/health-check-graceful-shutdown.md).

## Multi-container Pod

| Loại                | Cách khai báo                                     | Dùng khi                                                                            |
| ------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **Init container**  | `spec.initContainers`                             | Việc phải xong **trước** khi app chạy: chờ DB sẵn sàng, chạy migration, tải config. |
| **Sidecar**         | `spec.initContainers` với `restartPolicy: Always` | Tiến trình phụ trợ chạy **suốt** vòng đời app: log shipper, proxy (Envoy), agent.   |
| **Multi-container** | Nhiều phần tử trong `spec.containers`             | Các container ngang hàng cùng vòng đời (cách viết sidecar cũ).                      |

Sidecar "native" (init container có `restartPolicy: Always`, stable từ Kubernetes 1.33) giải quyết hai vấn đề của cách viết cũ: sidecar **khởi động trước** app, và **tắt sau** app — nên proxy không chết trước khi app xử lý xong request cuối, và Job không bị treo vì sidecar không bao giờ exit.

Ví dụ init container chờ một Service khác trước khi app khởi động:

```yaml
spec:
  initContainers:
    - name: wait-for-db
      image: busybox:1.37
      command: ["sh", "-c", "until nc -z postgres 5432; do sleep 2; done"]
  containers:
    - name: app
      image: my-app:1.0
```

**Khi nào không nên gộp vào một Pod:** app và database, frontend và backend — những thứ cần **scale độc lập** hoặc có vòng đời khác nhau. Mọi container trong Pod luôn scale cùng nhau (1 replica = 1 bản của tất cả container).

## Tài nguyên và QoS

```yaml
resources:
  requests: # scheduler dùng để chọn node; đảm bảo tối thiểu
    cpu: 100m
    memory: 128Mi
  limits: # trần cứng khi chạy
    memory: 256Mi
```

- **`requests`** quyết định **scheduling**: scheduler chỉ đặt Pod vào node còn đủ tài nguyên _chưa được request_. Không đặt requests → scheduler coi Pod như tốn 0, dẫn đến nhồi quá nhiều Pod vào một node.
- **CPU limit** là tài nguyên _nén được_: vượt limit thì bị **throttle** (chạy chậm), không bị kill.
- **Memory limit** là tài nguyên _không nén được_: vượt limit thì bị kernel **OOMKill** (exit code 137).

Kubernetes xếp Pod vào 3 lớp **QoS**, quyết định thứ tự bị đuổi (evict) khi node thiếu tài nguyên:

| QoS class    | Điều kiện                                               | Bị evict |
| ------------ | ------------------------------------------------------- | -------- |
| `Guaranteed` | Mọi container có requests = limits cho cả CPU và memory | Sau cùng |
| `Burstable`  | Có ít nhất một request/limit nhưng không đạt Guaranteed | Ở giữa   |
| `BestEffort` | Không có request/limit nào                              | Đầu tiên |

Pattern phổ biến: **đặt memory limit, không đặt CPU limit**. Memory limit ngăn một Pod rò rỉ bộ nhớ ăn hết node; bỏ CPU limit để app tận dụng CPU rảnh thay vì bị throttle vô ích — CPU requests vẫn đảm bảo phần chia công bằng khi node bận.

Các runtime có heap được quản lý (JVM, V8, .NET) tự chọn kích thước heap tối đa; nếu giá trị đó lớn hơn memory limit, process bị OOMKill thay vì GC kịp. Cần cấu hình heap theo limit của container (ví dụ `-XX:MaxRAMPercentage` cho JVM, `--max-old-space-size` cho Node.js), chừa phần còn lại cho bộ nhớ ngoài heap.

## Pod "trần" và controller

Tạo trực tiếp **Pod trần** (`kind: Pod`) hữu ích để học và debug, nhưng **không dùng cho workload thật**:

- Node chết → Pod mất, **không ai tạo lại**.
- Không thể scale, không có rolling update. Phần lớn trường của `spec` là **immutable** — muốn đổi image phải xoá và tạo lại Pod (downtime).

Trong thực tế, Pod gần như luôn được tạo **gián tiếp** qua controller, bằng cách khai báo `template` (chính là Pod spec):

| Controller      | Dùng cho                                                                          |
| --------------- | --------------------------------------------------------------------------------- |
| `Deployment`    | App stateless (API, web) — scale, rolling update, rollback.                       |
| `StatefulSet`   | App có trạng thái cần danh tính ổn định (DB, Kafka) — tên Pod cố định, PVC riêng. |
| `DaemonSet`     | Mỗi node một Pod (log agent, node exporter, CNI).                                 |
| `Job`/`CronJob` | Tác vụ chạy xong rồi dừng, hoặc chạy theo lịch.                                   |

Ngoại lệ duy nhất là **static Pod**: file manifest đặt trong `/etc/kubernetes/manifests/` của node, do kubelet chạy trực tiếp mà không qua scheduler. Cluster dựng bằng kubeadm chạy chính control plane (`kube-apiserver`, `etcd`, `kube-scheduler`, `kube-controller-manager`) dưới dạng static Pod. Apiserver chỉ hiển thị "mirror Pod" của chúng — xoá bằng `kubectl` không có tác dụng, phải sửa/xoá file trên node.

## Manifest mẫu

Một Pod spec đầy đủ các trường hay dùng, kèm lý do của từng lựa chọn:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: my-app
  labels:
    app: my-app # Service / controller tìm Pod qua label
spec:
  terminationGracePeriodSeconds: 30 # ngân sách cho cả preStop lẫn shutdown của app
  containers:
    - name: app
      image: registry.example.com/my-app:1.4.2 # pin tag cụ thể, tránh :latest
      imagePullPolicy: IfNotPresent
      ports:
        - name: http # đặt tên để probe/Service tham chiếu theo tên
          containerPort: 8080
      env:
        - name: PORT
          value: "8080"
      resources:
        requests: { cpu: 100m, memory: 128Mi }
        limits: { memory: 256Mi }
      lifecycle:
        preStop:
          sleep: { seconds: 5 } # chờ routing cập nhật trước khi gửi SIGTERM
      startupProbe:
        httpGet: { path: /health/live, port: http }
        periodSeconds: 2
        failureThreshold: 15 # tối đa 30s để khởi động
      readinessProbe:
        httpGet: { path: /health/ready, port: http }
        periodSeconds: 5
      livenessProbe:
        httpGet: { path: /health/live, port: http }
        periodSeconds: 10
        failureThreshold: 3
```

- **Tag cụ thể + `IfNotPresent`**: với tag `:latest` (hoặc không ghi tag), `imagePullPolicy` mặc định thành `Always` — mỗi lần tạo Pod đều pull, và không biết chắc Pod đang chạy phiên bản nào. Tag bất biến giúp rollback và audit được.
- **Port có tên**: probe và Service tham chiếu `http` thay vì số, đổi port chỉ sửa một chỗ.
- **Tách endpoint health**: liveness/startup chỉ kiểm tra process, readiness kiểm tra khả năng phục vụ (xem phần Probe).
- **`preStop` + `terminationGracePeriodSeconds`**: với cấu hình trên, app có 25s để xử lý nốt request sau khi nhận `SIGTERM`.
- **Requests + memory limit, không CPU limit** → QoS `Burstable`.

## CLI phổ biến

```bash
# Liệt kê / xem chi tiết
kubectl get pods -o wide                    # IP, node đang chạy
kubectl get pods -l app=my-app              # lọc theo label
kubectl get pods -w                         # theo dõi thay đổi realtime
kubectl describe pod my-app                 # events: schedule, pull image, probe fail...
kubectl get pod my-app -o yaml              # spec + status đầy đủ

# Log
kubectl logs my-app
kubectl logs -f my-app                      # follow
kubectl logs my-app --previous              # log của lần chạy trước (khi CrashLoopBackOff)
kubectl logs my-app -c <container>          # chọn container trong Pod nhiều container

# Vào trong Pod
kubectl exec -it my-app -- sh
kubectl port-forward pod/my-app 8080:8080

# Debug Pod có image tối giản (không có shell): gắn ephemeral container
kubectl debug -it my-app --image=busybox:1.37 --target=app

# Chạy Pod tạm để test mạng trong cluster
kubectl run tmp --rm -it --image=busybox:1.37 --restart=Never -- wget -qO- http://<POD_IP>:8080

# Tài nguyên thực tế (cần metrics-server)
kubectl top pod

# Xoá
kubectl delete pod my-app
kubectl delete pod my-app --grace-period=0 --force   # chỉ khi Pod kẹt Terminating
```

### Đọc lỗi thường gặp

| STATUS                              | Nguyên nhân hay gặp                                                          | Cách kiểm tra                                      |
| ----------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------- |
| `Pending`                           | Không node nào đủ `requests`, taint không có toleration, PVC chưa bind       | `kubectl describe pod` → phần Events               |
| `ErrImagePull` / `ImagePullBackOff` | Sai tên/tag, dùng `:latest` với image chỉ có local, thiếu `imagePullSecrets` | `describe pod`; `crictl images` trong node         |
| `CrashLoopBackOff`                  | App exit ngay khi khởi động (thiếu env, lỗi config), liveness fail liên tục  | `kubectl logs --previous`                          |
| `OOMKilled` (exit 137)              | Vượt memory limit                                                            | `describe pod` → Last State; tăng limit / sửa leak |
| `Running` nhưng `0/1 READY`         | readinessProbe fail                                                          | `describe pod` → Events "Readiness probe failed"   |
| `CreateContainerConfigError`        | Tham chiếu ConfigMap/Secret hoặc key không tồn tại                           | `describe pod`                                     |

## Đặc điểm cần lưu ý

- **Pod là "cattle", không phải "pet"**: có thể bị xoá, thay thế bất kỳ lúc nào. Đừng lưu dữ liệu quan trọng trong filesystem của container hay `emptyDir` — chúng mất khi Pod bị xoá.
- **Pod spec gần như immutable**: chỉ vài trường đổi được tại chỗ (image, `activeDeadlineSeconds`, tolerations thêm mới, và resources qua in-place resize). Mọi thay đổi khác cần tạo Pod mới.
- **Label là "keo dính"**: Service, Deployment, NetworkPolicy đều tìm Pod qua label selector (`app: my-app`). Đặt label nhất quán ngay từ đầu.
- **Một Pod = một node**: mọi container trong Pod luôn nằm cùng node, nên tổng `requests` của cả Pod phải vừa một node.

## Góc nhìn kiến trúc

- **Tại sao Kubernetes chọn Pod thay vì container làm đơn vị nhỏ nhất?** Vì nhiều ứng dụng thực tế cần các helper process gắn chặt (proxy, log agent, config reloader). Pod cho phép ghép chúng lại với ngữ nghĩa "cùng máy" mà vẫn giữ mỗi thứ là một image riêng, build và version độc lập — thay vì nhồi nhiều process vào một container với supervisord.
- **Sidecar là trade-off**: service mesh dạng sidecar (Istio, Linkerd) cho mTLS, retry, metrics mà không sửa code, nhưng nhân chi phí CPU/RAM theo số Pod và thêm latency mỗi hop. Đó là lý do xuất hiện các mô hình "sidecarless" (Istio ambient, Cilium) — cần cân nhắc theo quy mô.
- **Probe sai còn tệ hơn không có probe**: liveness phụ thuộc DB, timeout quá ngắn dưới tải cao, hay thiếu startupProbe cho app khởi động chậm là những nguyên nhân phổ biến gây restart dây chuyền trong production.
- **Requests/limits là quyết định chi phí**: requests quá cao → lãng phí node (trả tiền cho tài nguyên không dùng); quá thấp → node quá tải, Pod bị evict. Nên đặt dựa trên số liệu thực tế từ Prometheus (`container_memory_working_set_bytes`, `container_cpu_usage_seconds_total`) chứ không đoán.
