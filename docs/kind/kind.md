# Kind (Kubernetes IN Docker)

## Khái niệm

**Kind** là công cụ tạo cluster Kubernetes chạy local, trong đó **mỗi node là một Docker container** (image `kindest/node`). Bên trong mỗi container có đủ những thứ mà một node thật cần: `systemd`, `containerd`, `kubelet`, và các component của control plane (với node `control-plane`). Cluster được dựng bằng `kubeadm` — đúng công cụ dùng để bootstrap cluster thật — nên hành vi của nó gần với Kubernetes "upstream" hơn phần lớn công cụ local khác.

Kind ban đầu được viết để test chính Kubernetes (CI của dự án k8s), nên nó ưu tiên: tạo/xoá nhanh, tái tạo được y hệt nhau, và hỗ trợ multi-node.

### Kiến trúc

```text
Host (Docker Engine)
└── Docker network "kind"  (172.18.0.0/16)
    ├── k8s-observability-control-plane   ← container
    │   ├── containerd  → chạy các Pod
    │   ├── kubelet
    │   ├── kube-apiserver, etcd, scheduler, controller-manager (static Pods)
    │   └── kube-proxy, CoreDNS, kindnet (CNI)
    ├── k8s-observability-worker          ← container
    │   └── containerd, kubelet, kube-proxy, kindnet
    └── k8s-observability-worker2         ← container
```

Những điểm quan trọng rút ra từ kiến trúc này:

- **Có hai lớp container runtime.** Docker trên host chạy các node container; bên trong mỗi node, `containerd` chạy các Pod. Vì vậy image build bằng `docker build` trên host **không tự động có** trong cluster — phải nạp vào bằng `kind load` (xem phần CLI).
- **Node IP là IP container** trong Docker network `kind` (ví dụ `172.18.0.2`). Từ host có thể truy cập trực tiếp IP này trên Linux, nhưng không truy cập được trên macOS/Windows (Docker chạy trong VM) — đó là lý do cần `extraPortMappings`.
- **API server** được publish ra host qua một port ngẫu nhiên (ví dụ `127.0.0.1:38857 -> 6443`) và Kind tự ghi vào `~/.kube/config` với context `kind-<tên-cluster>`.
- **CNI mặc định là `kindnet`** — đơn giản, không hỗ trợ `NetworkPolicy`. Muốn thực hành NetworkPolicy thì tắt CNI mặc định (`disableDefaultCNI: true`) và cài Calico/Cilium.
- **StorageClass mặc định** là `standard` (local-path-provisioner) — PVC được cấp phát bằng thư mục trên node container, mất khi xoá cluster.
- **Không có LoadBalancer thật.** Service `type: LoadBalancer` sẽ `<pending>` mãi, trừ khi cài thêm `cloud-provider-kind` hoặc MetalLB.

**Khi nào chọn Kind:** khi muốn cluster giống production về hành vi Kubernetes, cần multi-node để thực hành scheduling/DaemonSet/drain, hoặc cần chạy trong CI (GitHub Actions có sẵn Docker). **Khi nào không:** khi cần mô phỏng LoadBalancer, storage phân tán, hoặc mạng thật giữa các máy — Kind chạy tất cả trên một host, nên mọi thứ liên quan đến failure domain (mất node vật lý, mất zone) đều không thực tế.

## Cấu hình

Config của repo nằm ở [`kind/cluster.yaml`](../../kind/cluster.yaml). Cấu trúc chung:

```yaml
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
name: k8s-observability # tên cluster → context "kind-k8s-observability"
networking: { ... } # cấu hình mạng cho toàn cluster
nodes: # danh sách node, mỗi phần tử = 1 container
  - role: control-plane
  - role: worker
```

### Các trường thường dùng

| Trường                                   | Ý nghĩa                                                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------------------------ |
| `name`                                   | Tên cluster. Tương đương flag `--name`; flag sẽ ghi đè config.                             |
| `nodes[].role`                           | `control-plane` hoặc `worker`. Nhiều control-plane → Kind tự thêm một load balancer (HA).  |
| `nodes[].image`                          | Image `kindest/node:<version>` — quyết định phiên bản Kubernetes. Nên pin để tái tạo được. |
| `nodes[].extraPortMappings`              | Map port host → port node container. Cách chính để truy cập service từ host.               |
| `nodes[].extraMounts`                    | Mount thư mục host vào node container (ví dụ để dùng `hostPath` với dữ liệu từ host).      |
| `nodes[].labels`                         | Gán label cho node — dùng với `nodeSelector` / affinity.                                   |
| `nodes[].kubeadmConfigPatches`           | Patch cấu hình kubeadm cho node đó (ví dụ thêm label `ingress-ready=true`, extra args).    |
| `networking.apiServerAddress` / `Port`   | Địa chỉ publish API server ra host. Mặc định `127.0.0.1` + port ngẫu nhiên.                |
| `networking.podSubnet` / `serviceSubnet` | Dải IP cho Pod và Service. Đổi khi bị trùng với mạng công ty/VPN.                          |
| `networking.disableDefaultCNI`           | `true` để tự cài CNI khác (Calico, Cilium).                                                |
| `networking.kubeProxyMode`               | `iptables` (mặc định), `ipvs`, `nftables`, hoặc `none` (khi dùng Cilium thay kube-proxy).  |
| `featureGates` / `runtimeConfig`         | Bật feature gate hoặc API alpha/beta cho toàn cluster.                                     |
| `containerdConfigPatches`                | Patch cấu hình containerd — thường dùng để khai báo local registry mirror.                 |

### Topology của repo

Config trong repo dùng **1 control-plane + 2 worker**:

- **2 worker** đủ để thấy DaemonSet chạy trên mỗi node (Node Exporter), thực hành `cordon`/`drain`, `podAntiAffinity`, và quan sát scheduler phân bố Pod. Một node duy nhất che giấu hết những hành vi này.
- **Không dùng HA control-plane**: 3 control-plane trên cùng một máy không tăng độ sẵn sàng thật (cùng chung host), chỉ tốn RAM.
- Control-plane mặc định có taint `node-role.kubernetes.io/control-plane:NoSchedule`, nên workload thường chỉ chạy trên worker. Riêng DaemonSet cần `tolerations` nếu muốn chạy cả trên control-plane.

### Truy cập service từ host

Có ba cách, theo thứ tự từ nhanh-tạm-thời đến gần-production:

1. **`kubectl port-forward`** — không cần config gì, nhưng chỉ sống khi lệnh còn chạy, và đi qua API server (không đi qua Service/kube-proxy thật).
2. **NodePort + `extraPortMappings`** — Service `type: NodePort` với `nodePort` cố định, và port đó được map ra host.

   NodePort được kube-proxy mở trên **mọi node**, nên chỉ cần map port ở một node (control-plane) là đủ.

3. **Ingress** — map port `80`/`443` vào node có label `ingress-ready=true`, cài ingress-nginx, rồi route theo host/path. Đây là cách gần với production nhất.

> ⚠️ `extraPortMappings` chỉ được áp dụng **lúc tạo cluster**. Muốn thêm port phải xoá và tạo lại cluster — vì vậy nên khai báo trước các port sẽ dùng.

Các port được bind vào `127.0.0.1` (`listenAddress`) để không expose ra mạng LAN.

## CLI phổ biến

### Quản lý cluster

```bash
# Tạo cluster từ config của repo
kind create cluster --config kind/cluster.yaml

# Tạo cluster nhanh, 1 node, không cần config
kind create cluster --name demo

# Chọn phiên bản Kubernetes và đợi control-plane sẵn sàng
kind create cluster --config kind/cluster.yaml --image kindest/node:v1.37.0 --wait 2m

# Liệt kê cluster / node
kind get clusters
kind get nodes --name k8s-observability

# Xoá cluster (xoá luôn toàn bộ dữ liệu, PVC)
kind delete cluster --name k8s-observability
```

### Kubeconfig & context

```bash
# Kind tự thêm context "kind-<name>" vào ~/.kube/config khi tạo cluster
kubectl config get-contexts
kubectl config use-context kind-k8s-observability
kubectl cluster-info --context kind-k8s-observability

# Xuất lại kubeconfig nếu bị ghi đè / mất
kind export kubeconfig --name k8s-observability

# In kubeconfig ra stdout (dùng --internal để lấy địa chỉ trong Docker network)
kind get kubeconfig --name k8s-observability
```

### Đưa image vào cluster

Vì node có containerd riêng, image build ở host phải được nạp vào:

```bash
docker build -t nest-server:dev ./nest-server
kind load docker-image nest-server:dev --name k8s-observability

# Kiểm tra image đã có trong node
docker exec k8s-observability-worker crictl images | grep nest-server
```

Hai lỗi hay gặp:

- **Dùng tag `:latest`** → `imagePullPolicy` mặc định thành `Always`, kubelet cố pull từ Docker Hub và báo `ErrImagePull`. Dùng tag cụ thể (`:dev`, `:v1`) hoặc đặt `imagePullPolicy: IfNotPresent`.
- **Build lại với cùng tag** → phải chạy lại `kind load` rồi restart Pod (`kubectl rollout restart deployment/<name>`), vì Pod đang chạy vẫn dùng image cũ.

Khi làm việc lâu dài hoặc với nhiều image, dùng **local registry** (`registry:2`) cấu hình qua `containerdConfigPatches` sẽ tiện hơn `kind load` mỗi lần build.

### Debug

```bash
# Node chỉ là container → exec vào như container thường
docker exec -it k8s-observability-control-plane bash

# Xem container/Pod ở tầng containerd bên trong node
docker exec k8s-observability-worker crictl ps

# Log của kubelet trong node
docker exec k8s-observability-worker journalctl -u kubelet --no-pager | tail -50

# Gom toàn bộ log (kubelet, containerd, Pod) ra thư mục để phân tích
kind export logs ./kind-logs --name k8s-observability

# Xem IP của các node trong Docker network "kind"
docker network inspect kind
```

## Quy trình triển khai ứng dụng lên Kind

Luồng đầy đủ từ source code đến truy cập được từ trình duyệt:

```bash
# 1. Tạo cluster
kind create cluster --config kind/cluster.yaml
kubectl get nodes                          # 3 node, trạng thái Ready

# 2. Build image và nạp vào cluster
docker build -t nest-server:dev ./nest-server
kind load docker-image nest-server:dev --name k8s-observability

# 3. Apply manifest (Deployment + Service NodePort 30080)
kubectl apply -f k8s/

# 4. Theo dõi rollout
kubectl rollout status deployment/nest-server
kubectl get pods -o wide                   # xem Pod nằm trên node nào

# 5. Truy cập
curl http://localhost:30080

# 6. Cập nhật code → build lại → load lại → restart
docker build -t nest-server:dev ./nest-server
kind load docker-image nest-server:dev --name k8s-observability
kubectl rollout restart deployment/nest-server
```

Service tương ứng để khớp với port mapping:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: nest-server
spec:
  type: NodePort
  selector:
    app: nest-server
  ports:
    - port: 3000 # port của Service trong cluster
      targetPort: 3000 # port container đang listen
      nodePort: 30080 # phải khớp containerPort trong extraPortMappings
```

## Đặc điểm cần lưu ý

- **Cluster là tạm thời.** `kind delete cluster` xoá toàn bộ, kể cả dữ liệu PVC. Mọi thứ cần giữ lại phải nằm trong Git dưới dạng manifest — đây cũng là tư duy đúng cho production (cluster là "cattle", không phải "pet").
- **Restart máy / Docker:** node container thường tự khởi động lại, nhưng IP trong Docker network có thể thay đổi. Những chỗ hardcode node IP (như target `192.168.97.2:9100` trong `prometheus-config.yaml`) sẽ bị sai — nên dùng service discovery của Prometheus (`kubernetes_sd_configs`) thay vì IP tĩnh.
- **Tài nguyên:** mỗi node tốn khoảng 500MB–1GB RAM khi rảnh. Trên Linux cần tăng giới hạn inotify nếu tạo nhiều node, nếu không Pod có thể lỗi `too many open files`:
  ```bash
  sudo sysctl fs.inotify.max_user_watches=524288
  sudo sysctl fs.inotify.max_user_instances=512
  ```
