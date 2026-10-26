# Service

## Khái niệm

Pod là thứ **tạm bợ**: mỗi lần rollout, scale hay node chết, Pod cũ biến mất và Pod mới xuất hiện với **IP khác**. Client không thể gọi thẳng vào IP Pod.

**Service** giải quyết việc đó bằng một **địa chỉ ổn định** đứng trước một nhóm Pod:

```text
client ──> my-app.default.svc (ClusterIP 10.96.12.34:80) ──┬──> Pod 10.244.1.5:3000
                                                           ├──> Pod 10.244.2.7:3000
                                                           └──> Pod 10.244.2.9:3000
```

- **Tên DNS và ClusterIP không đổi** trong suốt vòng đời Service, bất kể Pod phía sau thay đổi thế nào.
- Pod nào thuộc Service được quyết định bằng **label selector**, giống cách Deployment chọn Pod.
- Service chỉ là **cấu hình** (một object trong apiserver). Không có process nào tên "Service" nhận traffic; việc chuyển tiếp do `kube-proxy` (hoặc CNI) trên từng node thực hiện.

## Cách hoạt động

### Ba thành phần

```text
Service (selector: app=my-app)
   │  EndpointSlice controller theo dõi Pod khớp selector
   ▼
EndpointSlice (danh sách IP:port của Pod + trạng thái ready/serving/terminating)
   │  kube-proxy trên mọi node theo dõi Service + EndpointSlice
   ▼
Rule iptables / nftables / IPVS trên node: "gói tin tới ClusterIP:80 → DNAT sang một Pod IP:3000"
```

1. **Service**: khai báo selector, port, type. apiserver cấp một **ClusterIP** từ dải `service-cluster-ip-range`.
2. **EndpointSlice**: controller trong `kube-controller-manager` liên tục cập nhật danh sách Pod khớp selector. Mỗi slice chứa tối đa 100 endpoint (mặc định); Service lớn có nhiều slice.
3. **kube-proxy**: DaemonSet chạy trên mỗi node, dịch Service + EndpointSlice thành rule kernel. Một số CNI (Cilium) thay hẳn kube-proxy bằng eBPF.

### ClusterIP là IP ảo

ClusterIP **không gắn vào interface nào**. Không có máy nào "sở hữu" nó, nên:

- `ping` ClusterIP thường không trả lời; chỉ cặp **IP + port + protocol** đã khai báo mới có rule.
- Gói tin đi ra từ Pod bị **DNAT ngay trên node nguồn**, đổi đích từ ClusterIP sang IP một Pod cụ thể, rồi đi như traffic Pod-to-Pod bình thường.

### Cân bằng tải theo connection, không theo request

kube-proxy (iptables/nftables) chọn backend **ngẫu nhiên khi mở connection**. Mọi request đi trên connection đó đều tới cùng một Pod.

Hệ quả quan trọng:

- **HTTP keep-alive, HTTP/2, gRPC, WebSocket, connection pool tới DB** giữ connection lâu → tải dồn vào vài Pod, Pod mới scale lên gần như không nhận traffic.
- Muốn cân bằng theo request thì cần proxy tầng L7: client-side load balancing (gRPC + headless Service), service mesh (Istio, Linkerd), hoặc giới hạn tuổi connection phía server (`max connection age`).

### kube-proxy mode

| Mode       | Cách làm                                            | Ghi chú                                                                       |
| ---------- | --------------------------------------------------- | ----------------------------------------------------------------------------- |
| `iptables` | Chuỗi rule iptables, chọn backend theo xác suất.    | Mặc định lâu năm. Cập nhật rule chậm khi có hàng nghìn Service.               |
| `nftables` | Dùng nftables, tra cứu bằng map thay vì duyệt rule. | Hướng thay thế iptables, hiệu năng tốt hơn ở cluster lớn.                     |
| `ipvs`     | Load balancer L4 trong kernel, nhiều thuật toán.    | Từng là lựa chọn cho cluster lớn, nay không còn được khuyến nghị.             |
| eBPF (CNI) | Cilium/Calico eBPF thay kube-proxy hoàn toàn.       | Nhanh nhất, thêm tính năng (giữ client IP, L7 policy) nhưng gắn chặt với CNI. |

### Readiness quyết định Pod nào nhận traffic

EndpointSlice ghi trạng thái từng endpoint, và kube-proxy chỉ route tới endpoint **ready**:

| Trạng thái Pod                   | `ready` | `serving` | `terminating` | Nhận traffic mới?                         |
| -------------------------------- | ------- | --------- | ------------- | ----------------------------------------- |
| Running, readinessProbe pass     | true    | true      | false         | Có                                        |
| Running, readinessProbe fail     | false   | false     | false         | Không                                     |
| Đang Terminating, probe vẫn pass | false   | true      | true          | Chỉ khi không còn endpoint ready nào khác |

Vì vậy **readinessProbe là công tắc bật/tắt traffic** của Pod. Một Pod quá tải hoặc mất kết nối DB có thể tự fail readiness để tạm rút khỏi Service mà không bị restart.

Việc gỡ Pod khỏi endpoint là **bất đồng bộ**: apiserver → EndpointSlice controller → kube-proxy trên từng node đều cần thời gian. Đó là lý do cần `preStop: sleep` khi shutdown (xem [Pod](pod.md#graceful-shutdown)).

## Port

```yaml
ports:
  - name: http # bắt buộc đặt tên khi Service có nhiều port
    port: 80 # port của Service (client gọi vào)
    targetPort: http # port trên Pod: số hoặc TÊN port của container
    nodePort: 30080 # chỉ với NodePort/LoadBalancer
    protocol: TCP
```

- **Dùng tên cho `targetPort`**: Service trỏ theo tên `containerPort`, nên đổi số port trong container không cần sửa Service. Các Pod khác nhau còn có thể map cùng tên sang số khác nhau.
- `port` và `targetPort` không cần giống nhau. Hay gặp: Service mở `80`, app nghe `3000`/`8080`.
- `appProtocol` (`http`, `h2c`, `kubernetes.io/ws`...) là gợi ý cho Ingress/Gateway/service mesh, kube-proxy không dùng.

## Các loại Service

| Type           | Truy cập từ đâu               | Cách làm                                                                      |
| -------------- | ----------------------------- | ----------------------------------------------------------------------------- |
| `ClusterIP`    | Trong cluster (mặc định)      | IP ảo + DNS nội bộ.                                                           |
| `NodePort`     | `<IP bất kỳ node>:<nodePort>` | ClusterIP + mở một port (30000–32767) trên **mọi** node.                      |
| `LoadBalancer` | IP/hostname public từ cloud   | NodePort + cloud controller tạo load balancer bên ngoài trỏ vào các node.     |
| `ExternalName` | Trong cluster                 | Chỉ là bản ghi DNS `CNAME` tới tên ngoài. Không có ClusterIP, không có proxy. |

Các type **xếp chồng** lên nhau: LoadBalancer bao gồm NodePort, NodePort bao gồm ClusterIP.

- **NodePort** hiếm khi dùng thẳng cho production: port xấu, client phải biết IP node, node bị thay là đổi địa chỉ. Hợp cho lab hoặc làm backend cho load balancer tự quản.
- **LoadBalancer** cần một controller cấp IP. Trên cloud là cloud-controller-manager; trên bare-metal/local là MetalLB, kube-vip, `cloud-provider-kind`... Không có controller thì `EXTERNAL-IP` kẹt ở `<pending>` mãi.
- Mỗi Service `LoadBalancer` là **một load balancer tính tiền riêng**. Nhiều app HTTP nên dùng chung một Ingress/Gateway thay vì mỗi app một LoadBalancer.

### Headless Service

Đặt `clusterIP: None` thì Service **không có IP ảo**, kube-proxy bỏ qua nó. DNS trả về **trực tiếp danh sách IP Pod** (nhiều bản ghi A).

Dùng khi client cần biết từng Pod:

- **StatefulSet**: mỗi Pod có DNS riêng `<pod>.<service>.<ns>.svc.cluster.local` (ví dụ `db-0.db.default.svc...`) để client chọn primary/replica.
- **Client-side load balancing** (gRPC, driver DB cluster): client tự lấy danh sách Pod và tự chia request.
- Service discovery cho hệ thống tự phát hiện peer (Cassandra, Elasticsearch...).

### Service không có selector

Bỏ `selector` thì controller không tạo EndpointSlice. Có thể tự tạo EndpointSlice trỏ tới IP bên ngoài (DB trên VM, service ở cluster khác). Client trong cluster vẫn gọi qua tên Service như bình thường, sau này chuyển backend vào cluster chỉ cần thêm selector.

## Service discovery

### DNS

CoreDNS tạo bản ghi cho mọi Service:

| Bản ghi                                           | Trả về                           |
| ------------------------------------------------- | -------------------------------- |
| `my-svc.my-ns.svc.cluster.local` (A/AAAA)         | ClusterIP (headless: các Pod IP) |
| `_http._tcp.my-svc.my-ns.svc.cluster.local` (SRV) | Port của port tên `http`         |

Nhờ `search` trong `/etc/resolv.conf` của Pod, có thể gọi rút gọn:

- Cùng namespace: `my-svc`
- Khác namespace: `my-svc.my-ns`

**Cạm bẫy `ndots:5`**: tên có ít hơn 5 dấu chấm sẽ được thử ghép với từng search domain trước. Gọi `api.example.com` từ Pod có thể sinh ra 4–5 truy vấn DNS thất bại trước khi ra đúng tên. Với tên ngoài, thêm dấu chấm cuối (`api.example.com.`) hoặc giảm `ndots` qua `dnsConfig`.

### Biến môi trường

kubelet inject `MY_SVC_SERVICE_HOST`, `MY_SVC_SERVICE_PORT`... cho các Service **đã tồn tại lúc Pod được tạo**. Service tạo sau thì Pod không thấy, và namespace nhiều Service sẽ làm env phình to. Nên dùng DNS; tắt cơ chế này bằng `enableServiceLinks: false`.

## Điều hướng traffic

### sessionAffinity

`sessionAffinity: ClientIP` gửi mọi connection từ cùng một IP nguồn tới cùng Pod (timeout mặc định 3 giờ). Nó chỉ là cách chữa cháy cho app giữ state trong memory, và hoạt động kém khi client đứng sau NAT/proxy (mọi người dùng chung một IP). Tốt hơn là đưa session ra Redis/DB.

### externalTrafficPolicy

Áp dụng cho traffic từ ngoài vào qua NodePort/LoadBalancer:

|                   | `Cluster` (mặc định)                 | `Local`                                                            |
| ----------------- | ------------------------------------ | ------------------------------------------------------------------ |
| Node nhận traffic | Chuyển tới Pod ở **bất kỳ node nào** | Chỉ chuyển tới Pod **trên chính node đó**                          |
| Client IP         | Mất (bị SNAT thành IP node)          | **Giữ nguyên**                                                     |
| Hop thêm          | Có thể thêm 1 hop giữa các node      | Không                                                              |
| Phân tải          | Đều theo Pod                         | Đều theo node: node có 1 Pod và node có 5 Pod nhận tải như nhau    |
| Node không có Pod | Vẫn phục vụ                          | Drop; load balancer dựa vào `healthCheckNodePort` để bỏ node đó ra |

Chọn `Local` khi cần client IP thật (rate limit, audit, geo-IP) và chấp nhận phân tải lệch.

### internalTrafficPolicy và trafficDistribution

- **`internalTrafficPolicy: Local`**: traffic trong cluster chỉ tới Pod cùng node. Hợp với agent dạng DaemonSet (log/metrics collector). Node không có Pod thì traffic bị drop.
- **`trafficDistribution: PreferClose`**: ưu tiên Pod cùng zone, hết Pod cùng zone mới đi zone khác. Giảm latency và chi phí traffic cross-zone trên cloud, nhưng có thể làm lệch tải nếu Pod rải không đều giữa các zone.

## CLI phổ biến

```bash
kubectl expose deploy my-app --port=80 --target-port=http --dry-run=client -o yaml  # sinh manifest mẫu
kubectl get svc -o wide                          # TYPE, CLUSTER-IP, PORT(S), SELECTOR
kubectl describe svc my-app                      # Selector, TargetPort, Endpoints
kubectl get endpointslice -l kubernetes.io/service-name=my-app -o wide

kubectl port-forward svc/my-app 8080:80          # gọi thử từ máy local
kubectl run tmp --rm -it --image=busybox --restart=Never -- \
  wget -qO- my-app.default.svc.cluster.local/health   # gọi thử từ trong cluster
kubectl run tmp --rm -it --image=busybox --restart=Never -- nslookup my-app

kubectl get pods -l app=my-app --show-labels     # đối chiếu label với selector
```

**Lưu ý**: `port-forward svc/...` chỉ chọn **một Pod** rồi kết nối thẳng tới Pod đó, không đi qua kube-proxy. Dùng để kiểm tra app, không dùng để kiểm tra load balancing hay Service routing.

### Lỗi thường gặp

| Triệu chứng                                     | Nguyên nhân hay gặp                                         | Kiểm tra                                                     |
| ----------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------ |
| `Endpoints: <none>`, gọi bị timeout/refused     | Selector không khớp label Pod, hoặc không Pod nào ready     | `describe svc`, `get pods --show-labels`, `get pods` (READY) |
| Có Endpoints nhưng `connection refused`         | `targetPort` sai, hoặc app chỉ nghe `127.0.0.1`             | `get endpointslice`, app phải bind `0.0.0.0`                 |
| `could not resolve host`                        | Sai namespace (gọi `my-svc` từ namespace khác), CoreDNS lỗi | Dùng `my-svc.my-ns`, `nslookup` từ Pod                       |
| `ping` ClusterIP không trả lời                  | Bình thường, ClusterIP là IP ảo                             | Thử bằng `curl`/`nc` đúng port                               |
| Tải dồn vào vài Pod, Pod mới không nhận traffic | Connection sống lâu (keep-alive, HTTP/2, gRPC, pool)        | Metric request theo Pod; cân nhắc L7 load balancing          |
| `EXTERNAL-IP <pending>`                         | Không có controller cấp IP cho LoadBalancer                 | Cài MetalLB / cloud-provider-kind, hoặc dùng Ingress         |
| Lỗi 502/connection reset mỗi lần deploy         | Pod nhận `SIGTERM` trước khi bị gỡ khỏi endpoint            | Thêm `preStop: sleep`, kiểm tra xử lý `SIGTERM`              |
| App thấy mọi client cùng một IP                 | `externalTrafficPolicy: Cluster` SNAT                       | Dùng `Local`, hoặc đọc `X-Forwarded-For` từ proxy L7         |

## Đặc điểm cần lưu ý

- **Service là L4.** Nó chỉ biết IP, port, TCP/UDP. Routing theo host/path, TLS termination, retry, chia traffic theo phần trăm là việc của Ingress/Gateway API hoặc service mesh.
- **Selector của Service sửa được**, khác với Deployment. Đổi selector từ `version: blue` sang `version: green` là cách blue/green đơn giản nhất: chuyển toàn bộ traffic tức thì, rollback bằng cách đổi lại.
- **Label phải đủ cụ thể.** Selector `app: web` sẽ gom luôn Pod debug hay Pod của app khác mang cùng label, và Service gửi traffic thật vào đó.
- **Một Service không có Pod ready nào vẫn "tồn tại"**: DNS vẫn phân giải, nhưng mọi connection đều fail. Giám sát số endpoint ready, đừng chỉ giám sát việc Service có tồn tại.
- **Mọi thay đổi Service/EndpointSlice được đẩy tới mọi node.** Cluster lớn với Pod churn cao làm kube-proxy và apiserver bận; đây là lý do có EndpointSlice và mode nftables/eBPF.
- **Readiness, graceful shutdown và Service là một bộ.** Thiếu readinessProbe thì traffic tới Pod chưa sẵn sàng; thiếu `preStop` và xử lý `SIGTERM` thì traffic tới Pod đang tắt. Cả hai đều biểu hiện thành lỗi lẻ tẻ lúc deploy.
