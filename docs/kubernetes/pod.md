# Pod

## Khái niệm

**Pod** là đơn vị nhỏ nhất mà Kubernetes schedule và quản lý. Kubernetes không chạy container trực tiếp mà chạy Pod, mỗi Pod chứa một hoặc nhiều container.

Các container trong cùng Pod giống các process trên cùng một máy: chung IP, gọi nhau qua `localhost`, có thể chia sẻ volume, nhưng mỗi container vẫn có image và giới hạn tài nguyên riêng. Phần lớn Pod chỉ có một container chính.

## Cách hoạt động

```text
kubectl apply → kube-apiserver → etcd       (lưu Pod, chưa có node)
             → kube-scheduler               (chọn node, ghi spec.nodeName)
             → kubelet trên node đó
                 ├── tạo "pause" container giữ network namespace
                 ├── CNI cấp IP cho Pod
                 ├── mount volume, chạy init containers (tuần tự)
                 └── chạy app containers + probe, báo status về apiserver
```

- **Scheduler chỉ chọn node, kubelet mới là thứ chạy Pod.** Pod đã gán node thì không bao giờ di chuyển: node chết thì Pod chết theo, và phải có controller tạo Pod mới.
- **Container `pause`** giữ network namespace của Pod, nên mọi container dùng chung một IP và một dải port (hai container không thể cùng listen `3000`). Container app restart thì IP vẫn giữ nguyên.
- **IP của Pod là tạm thời**: Pod bị xoá thì mất IP, Pod mới nhận IP khác. Vì vậy cần dùng **Service** để có địa chỉ ổn định.

## Vòng đời

### Phase

| Phase       | Ý nghĩa                                                       |
| ----------- | ------------------------------------------------------------- |
| `Pending`   | Chưa chạy: chờ schedule, đang pull image hoặc chạy init.      |
| `Running`   | Đã gán node, ít nhất một container đang chạy.                 |
| `Succeeded` | Mọi container exit 0, không restart (Job).                    |
| `Failed`    | Mọi container đã dừng, ít nhất một container exit lỗi.        |
| `Unknown`   | Không lấy được trạng thái, thường do mất kết nối với kubelet. |

`Running` **không có nghĩa là app đã sẵn sàng**: phải xem cột `READY`. Các trạng thái như `CrashLoopBackOff`, `ImagePullBackOff`, `OOMKilled` không phải phase mà là _reason_ của container state.

### restartPolicy

`Always` (mặc định, cho service), `OnFailure` (cho Job), `Never`. Kubelet restart container **tại chỗ** với backoff tăng dần (10s → 20s → ... tối đa 5 phút), và đó chính là `CrashLoopBackOff`. Restart container không tạo Pod mới: IP, tên Pod và `emptyDir` được giữ nguyên.

### Probe

| Probe            | Kiểm tra                    | Khi fail                                              |
| ---------------- | --------------------------- | ----------------------------------------------------- |
| `startupProbe`   | Khởi động xong chưa?        | Restart container (tạm tắt 2 probe kia khi đang chạy) |
| `readinessProbe` | Sẵn sàng nhận request chưa? | Gỡ khỏi Service, **không restart**                    |
| `livenessProbe`  | App có bị treo không?       | Restart container                                     |

Loại probe: `httpGet`, `tcpSocket`, `exec`, `grpc`.

- **Liveness chỉ kiểm tra chính process đó**, không kiểm tra DB. Nếu kiểm tra DB thì khi DB chết, mọi Pod sẽ restart dây chuyền.
- **Readiness có thể kiểm tra dependency**, vì fail chỉ làm ngừng gửi traffic.
- **App khởi động chậm thì dùng `startupProbe`** thay cho `initialDelaySeconds` lớn.

### Graceful shutdown

1. Pod chuyển sang `Terminating`, **song song** với việc bị gỡ khỏi endpoint của Service.
2. Chạy `preStop` (nếu có).
3. Gửi `SIGTERM` tới PID 1 của mỗi container.
4. Sau `terminationGracePeriodSeconds` (mặc định 30s, tính từ lúc bắt đầu preStop) mà container chưa thoát thì gửi `SIGKILL`.

Vì bước 1 chạy song song, routing có thể vẫn gửi request tới Pod sau khi Pod đã nhận `SIGTERM`. Đặt `preStop: sleep` vài giây để chờ routing cập nhật xong.

Để shutdown thực sự "graceful":

- **PID 1 phải là app**: dùng exec form `CMD ["./app"]`. Với shell form hoặc chạy qua `npm start`, signal có thể không tới được app.
- **App phải bắt `SIGTERM`**: Linux bỏ qua signal gửi tới PID 1 nếu process không có handler. Dấu hiệu là xoá Pod lần nào cũng mất đúng ~30s.

## Multi-container Pod

| Loại           | Khai báo                                   | Dùng khi                                                                                    |
| -------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Init container | `initContainers`                           | Việc phải xong trước khi app chạy: chờ DB, migration.                                       |
| Sidecar        | `initContainers` + `restartPolicy: Always` | Chạy suốt vòng đời app: log shipper, proxy. Khởi động trước app và tắt sau app (K8s 1.33+). |
| Ngang hàng     | Nhiều phần tử trong `containers`           | Cách viết sidecar cũ.                                                                       |

Chỉ gộp các container **gắn chặt với nhau** vào một Pod. App + DB hay frontend + backend nên tách thành các Pod riêng, vì mọi container trong Pod luôn scale cùng nhau.

## Tài nguyên và QoS

```yaml
resources:
  requests: { cpu: 100m, memory: 128Mi } # scheduler dùng để chọn node
  limits: { memory: 256Mi } # trần cứng khi chạy
```

- **`requests`** quyết định scheduling. Nếu không đặt, scheduler coi Pod tốn 0 và có thể nhồi quá nhiều Pod vào một node.
- **Vượt CPU limit** thì bị throttle. **Vượt memory limit** thì bị OOMKill (exit 137).
- **QoS** quyết định thứ tự bị evict khi node thiếu tài nguyên: `BestEffort` (không đặt gì) bị evict trước, rồi đến `Burstable`, cuối cùng là `Guaranteed` (requests = limits cho cả CPU lẫn memory).
- **Pattern phổ biến**: đặt memory limit, không đặt CPU limit. Cách này chặn được memory leak ăn hết node mà app không bị throttle vô ích.
- **Runtime có heap** (JVM, Node.js) cần cấu hình heap theo memory limit (`-XX:MaxRAMPercentage`, `--max-old-space-size`). Nếu không, process sẽ bị OOMKill trước khi GC kịp chạy.

## Pod trần và controller

Pod tạo trực tiếp (`kind: Pod`) chỉ nên dùng để học hoặc debug: node chết thì không ai tạo lại, không scale được, và phần lớn spec là immutable. Workload thật nên tạo Pod qua controller:

| Controller      | Dùng cho                                                |
| --------------- | ------------------------------------------------------- |
| `Deployment`    | App stateless: scale, rolling update, rollback.         |
| `StatefulSet`   | App cần danh tính ổn định (DB): tên cố định, PVC riêng. |
| `DaemonSet`     | Mỗi node một Pod (log agent, node exporter).            |
| `Job`/`CronJob` | Tác vụ chạy xong rồi dừng, hoặc chạy theo lịch.         |

**Static Pod** là ngoại lệ: manifest đặt trong `/etc/kubernetes/manifests/` trên node và do kubelet chạy trực tiếp (kubeadm dùng cách này cho control plane). Xoá static Pod bằng `kubectl` không có tác dụng mà phải xoá file trên node.

## CLI phổ biến

```bash
kubectl get pods -o wide                 # kèm IP, node
kubectl get pods -l app=my-app -w        # lọc label, theo dõi realtime
kubectl describe pod my-app              # Events: schedule, pull, probe fail
kubectl logs -f my-app [-c <container>]
kubectl logs my-app --previous           # log lần chạy trước (CrashLoopBackOff)
kubectl exec -it my-app -- sh
kubectl port-forward pod/my-app 8080:8080
kubectl debug -it my-app --image=busybox:1.37 --target=app   # image không có shell
kubectl top pod                          # cần metrics-server
kubectl delete pod my-app --grace-period=0 --force           # chỉ khi kẹt Terminating
```

### Lỗi thường gặp

| STATUS                       | Nguyên nhân hay gặp                                  | Kiểm tra                    |
| ---------------------------- | ---------------------------------------------------- | --------------------------- |
| `Pending`                    | Không node nào đủ `requests`, taint, PVC chưa bind   | `describe pod` → Events     |
| `ImagePullBackOff`           | Sai tên/tag, thiếu `imagePullSecrets`                | `describe pod`              |
| `CrashLoopBackOff`           | App exit ngay (thiếu env, sai config), liveness fail | `logs --previous`           |
| `OOMKilled` (137)            | Vượt memory limit                                    | `describe pod` → Last State |
| `Running` nhưng `0/1`        | readinessProbe fail                                  | `describe pod` → Events     |
| `CreateContainerConfigError` | ConfigMap/Secret hoặc key không tồn tại              | `describe pod`              |

## Đặc điểm cần lưu ý

- **Pod là "cattle"**: có thể bị thay thế bất kỳ lúc nào. Không lưu dữ liệu quan trọng trong filesystem của container hay `emptyDir`.
- **Label là "keo dính"**: Service, Deployment và NetworkPolicy đều tìm Pod qua label selector.
- **Pin tag image cụ thể**: dùng `:latest` khiến `imagePullPolicy` mặc định thành `Always` và không biết chắc Pod đang chạy phiên bản nào.
- **Đặt requests/limits theo số liệu thực tế** (Prometheus: `container_memory_working_set_bytes`, `container_cpu_usage_seconds_total`), không đặt theo phỏng đoán. Đặt quá cao thì lãng phí node, quá thấp thì Pod bị evict.
