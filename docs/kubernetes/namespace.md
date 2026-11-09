# Namespace

## Khái niệm

**Namespace** chia một cluster thành nhiều **không gian tên** độc lập. Hai Deployment cùng tên có thể tồn tại song song nếu nằm ở hai namespace khác nhau.

Namespace chủ yếu là **ranh giới quản trị**, không phải ranh giới bảo mật hay mạng:

- **Tên**: tên object chỉ cần duy nhất trong một namespace.
- **Phân quyền**: RBAC Role/RoleBinding cấp quyền theo namespace.
- **Tài nguyên**: ResourceQuota và LimitRange giới hạn theo namespace.
- **Chính sách**: NetworkPolicy, Pod Security Admission gắn vào namespace.

```text
cluster
├── kube-system      # thành phần hệ thống: CoreDNS, kube-proxy, CNI...
├── kube-public      # đọc được bởi mọi người, kể cả chưa xác thực (cluster-info)
├── kube-node-lease  # Lease heartbeat của từng node
├── default          # nơi object rơi vào khi không chỉ định namespace
├── team-a           # namespace tự tạo
└── team-b
```

## Cách hoạt động

### Namespaced và cluster-scoped

Không phải object nào cũng thuộc về một namespace:

| Namespaced                                            | Cluster-scoped                                           |
| ----------------------------------------------------- | -------------------------------------------------------- |
| Pod, Deployment, ReplicaSet, StatefulSet, DaemonSet   | Node                                                     |
| Service, EndpointSlice, Ingress                       | Namespace                                                |
| ConfigMap, Secret, ServiceAccount                     | PersistentVolume, StorageClass                           |
| PersistentVolumeClaim                                 | ClusterRole, ClusterRoleBinding                          |
| Role, RoleBinding                                     | CustomResourceDefinition                                 |
| ResourceQuota, LimitRange, NetworkPolicy              | IngressClass, PriorityClass, ValidatingWebhookConfig...  |

```bash
kubectl api-resources --namespaced=true    # danh sách object namespaced
kubectl api-resources --namespaced=false   # danh sách object cluster-scoped
```

Hệ quả:

- Quyền trên object cluster-scoped (Node, PV, CRD) **không giới hạn được bằng namespace**. Ai cần chúng thì phải có ClusterRole.
- Một Pod chỉ tham chiếu được ConfigMap, Secret, PVC, ServiceAccount **cùng namespace**. Không mount được Secret từ namespace khác.

### Namespace được đặt vào object thế nào

- Trong manifest: `metadata.namespace: my-ns`.
- Nếu manifest không ghi, kubectl dùng `-n my-ns`, hoặc namespace của context hiện tại (mặc định `default`).
- Manifest ghi namespace A mà chạy `kubectl apply -n B` thì báo lỗi, không lặng lẽ ghi đè.

Ghi `namespace` rõ ràng trong manifest giúp tránh apply nhầm. Ngược lại, bỏ trống cho phép tái sử dụng cùng manifest cho nhiều namespace (Kustomize, Helm sẽ điền vào).

### DNS liên namespace

CoreDNS đặt tên Service theo dạng `<service>.<namespace>.svc.cluster.local`. Pod có `search` domain bắt đầu bằng **namespace của chính nó**:

```text
# /etc/resolv.conf của Pod trong namespace "web"
search web.svc.cluster.local svc.cluster.local cluster.local
options ndots:5
```

| Gọi từ Pod trong `web`   | Phân giải thành                     | Kết quả                         |
| ------------------------ | ----------------------------------- | ------------------------------- |
| `api`                    | `api.web.svc.cluster.local`         | Chỉ đúng nếu `api` nằm ở `web`  |
| `api.backend`            | `api.backend.svc.cluster.local`     | Gọi sang namespace `backend`    |
| `api.backend.svc`        | `api.backend.svc.cluster.local`     | Rõ ràng hơn, ít bị nhầm         |

Lỗi kinh điển khi tách namespace: code gọi bằng tên ngắn `api`, chạy tốt khi mọi thứ chung namespace, rồi `bad address` sau khi tách. Cấu hình địa chỉ service khác namespace bằng `<svc>.<ns>` hoặc FQDN.

### Object tự sinh trong mỗi namespace

Khi tạo namespace, controller tự tạo:

- **ServiceAccount `default`**: Pod không chỉ định `serviceAccountName` sẽ chạy bằng nó.
- **ConfigMap `kube-root-ca.crt`**: CA của apiserver, để Pod xác thực khi gọi API. Nó **được tính vào quota `configmaps`**.

### Xoá namespace

`kubectl delete namespace my-ns` xoá **toàn bộ** object bên trong, không hỏi lại, không thể hoàn tác.

Quá trình xoá:

1. Namespace chuyển sang `Terminating`, không nhận object mới.
2. Namespace controller xoá lần lượt mọi object namespaced bên trong.
3. Khi không còn gì, finalizer `kubernetes` được gỡ và namespace biến mất.

**Kẹt ở `Terminating`** thường do một object bên trong có finalizer mà controller xử lý nó không còn chạy (CRD của operator đã gỡ, APIService không phản hồi). Xem `kubectl get ns my-ns -o yaml` → `status.conditions` để biết object nào đang chặn. Sửa đúng gốc (cài lại controller, hoặc gỡ finalizer của **object đó**) thay vì ép xoá finalizer của namespace, vì cách sau để lại tài nguyên mồ côi trong etcd và bên ngoài (load balancer, disk).

## Những gì namespace KHÔNG cô lập

Đây là phần dễ hiểu sai nhất:

| Khía cạnh      | Mặc định                                                                  | Cần thêm gì để cô lập                         |
| -------------- | ------------------------------------------------------------------------- | --------------------------------------------- |
| Mạng           | Pod mọi namespace gọi nhau thoải mái                                      | NetworkPolicy (CNI phải hỗ trợ)               |
| Node           | Pod các namespace chạy chung node, chung kernel                           | Taint/toleration, nodeSelector, node pool     |
| Tài nguyên     | Một namespace có thể chiếm hết CPU/RAM cluster                            | ResourceQuota, LimitRange                     |
| Quyền          | Ai có ClusterRole thì thấy mọi namespace                                  | RBAC Role/RoleBinding theo namespace          |
| Object cluster | CRD, ClusterRole, StorageClass, webhook dùng chung                        | Không cô lập được, cần cluster riêng          |
| Đặc quyền Pod  | Pod `privileged`/`hostPath` ở bất kỳ namespace nào đều chạm được tới node | Pod Security Admission                        |

Kết luận: namespace là **soft multi-tenancy**. Hợp với nhiều team **tin tưởng nhau** trong một tổ chức. Với tenant không tin tưởng nhau (khách hàng khác nhau, code chưa kiểm duyệt), cần cluster riêng hoặc giải pháp như vCluster, Kata/gVisor.

## Chính sách gắn theo namespace

### ResourceQuota

Giới hạn **tổng** tài nguyên một namespace được dùng:

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: compute
  namespace: my-ns
spec:
  hard:
    requests.cpu: "4"
    requests.memory: 8Gi
    limits.cpu: "8"
    limits.memory: 16Gi
    pods: "50"
    services.loadbalancers: "0" # cấm tạo LB tính tiền
    services.nodeports: "0"
    persistentvolumeclaims: "10"
    count/deployments.apps: "20" # đếm object bất kỳ: count/<resource>.<group>
```

- Kiểm tra tại **admission**: object vượt quota bị từ chối ngay lúc tạo (`exceeded quota`). Pod đang chạy không bị đuổi khi hạ quota.
- **Khi quota theo dõi `requests.cpu`/`limits.memory`..., mọi Pod mới phải khai báo các giá trị đó**, nếu không bị từ chối (`must specify limits.memory`). Đây là lý do thường đi kèm LimitRange.
- Với Deployment, Pod bị từ chối **không làm `kubectl apply` báo lỗi**: Deployment vẫn tạo được, chỉ ReplicaSet không sinh được Pod. Lỗi nằm ở `kubectl describe rs` (Events: `FailedCreate`). Nhớ tính cả Pod surge khi rolling update vào quota.
- `scopes`/`scopeSelector` giới hạn quota cho một nhóm Pod (theo PriorityClass, `BestEffort`, `Terminating`...).

### LimitRange

Định hình **từng** container/Pod/PVC trong namespace:

```yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: container-defaults
  namespace: my-ns
spec:
  limits:
    - type: Container
      defaultRequest: { cpu: 100m, memory: 128Mi } # điền khi thiếu requests
      default: { cpu: 500m, memory: 512Mi } # điền khi thiếu limits
      max: { cpu: "2", memory: 2Gi } # từ chối nếu vượt
      min: { cpu: 10m, memory: 16Mi }
```

- Giá trị default được **ghi thẳng vào Pod spec lúc admission**. Sửa LimitRange không ảnh hưởng Pod đã tạo.
- Default chỉ là lưới an toàn. Mỗi app nên tự khai báo requests/limits dựa trên số đo thực tế; default quá cao thì lãng phí, quá thấp thì OOMKill/throttle.

| | ResourceQuota | LimitRange |
| --- | --- | --- |
| Phạm vi | Tổng cả namespace | Từng container / Pod / PVC |
| Trả lời câu hỏi | "Namespace được dùng bao nhiêu?" | "Một container được xin bao nhiêu? Quên khai báo thì lấy gì?" |
| Thay đổi Pod spec | Không, chỉ chấp nhận/từ chối | Có, điền default |

### Pod Security Admission (PSA)

Admission controller có sẵn, cấu hình bằng **label trên namespace**:

```yaml
metadata:
  labels:
    pod-security.kubernetes.io/enforce: baseline # từ chối Pod vi phạm
    pod-security.kubernetes.io/warn: restricted # chấp nhận, nhưng in cảnh báo
    pod-security.kubernetes.io/audit: restricted # chấp nhận, ghi audit log
```

| Level        | Cho phép                                                                                        |
| ------------ | ----------------------------------------------------------------------------------------------- |
| `privileged` | Mọi thứ. Dành cho agent hệ thống cần `hostNetwork`, `hostPID`, `hostPath` (CNI, node exporter). |
| `baseline`   | Chặn các đặc quyền leo thang đã biết: privileged, host namespace, hostPath, hostPort...         |
| `restricted` | Thêm: bắt buộc `runAsNonRoot`, drop ALL capabilities, `allowPrivilegeEscalation: false`, seccomp `RuntimeDefault`. |

- Cách nâng cấp an toàn: `enforce` level hiện tại, `warn`/`audit` level mục tiêu, sửa dần các Pod cho tới khi hết cảnh báo, rồi nâng `enforce`.
- `kubectl label --dry-run=server --overwrite ns my-ns pod-security.kubernetes.io/enforce=restricted` cho biết Pod đang chạy nào sẽ vi phạm, trước khi thực sự áp.
- PSA kiểm tra Pod, nhưng cảnh báo hiện cả khi apply Deployment/DaemonSet (kiểm tra Pod template).
- Tách workload cần đặc quyền (agent giám sát, CNI) vào namespace riêng mang nhãn `privileged`, để namespace ứng dụng giữ được `baseline`/`restricted`.

### RBAC và NetworkPolicy

- **Role + RoleBinding**: quyền chỉ có hiệu lực trong một namespace. Cho team A `edit` trên namespace `team-a` là mẫu phổ biến nhất. ClusterRole có thể được **bind bằng RoleBinding** để tái sử dụng định nghĩa quyền nhưng giới hạn trong một namespace.
- **NetworkPolicy**: mặc định mọi Pod nhận traffic từ mọi nơi. Mẫu thường gặp là mỗi namespace có một policy "default deny ingress", rồi mở có chọn lọc bằng `namespaceSelector` (dùng label tự động `kubernetes.io/metadata.name: <ns>`).

## Chiến lược chia namespace

| Cách chia                                        | Ưu                                                         | Nhược                                                                             |
| ------------------------------------------------ | ---------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Theo **team** (`payments`, `search`)             | Khớp với RBAC và quota theo người sở hữu                   | Team có nhiều service thì namespace lớn, khó phân quyền chi tiết                  |
| Theo **app/service** (`checkout`, `cart`)        | Ranh giới hẹp, NetworkPolicy/quota chính xác               | Nhiều namespace, nhiều RoleBinding/quota phải quản lý (cần GitOps/template)       |
| Theo **chức năng** (`apps`, `observability`, `ingress`) | Tách workload đặc quyền khỏi ứng dụng, đơn giản        | Không thể hiện ai sở hữu gì                                                       |
| Theo **môi trường** (`dev`, `staging`, `prod`)   | Rẻ: một cluster cho mọi môi trường                         | Prod chung control plane, CRD, node với dev; một lỗi ở dev có thể ảnh hưởng prod |

Khuyến nghị chung:

- **Không trộn prod với non-prod trong một cluster** nếu có thể: upgrade cluster, CRD, admission webhook, noisy neighbor đều là rủi ro dùng chung. Namespace theo môi trường hợp cho dev/preview (namespace tạm theo từng PR).
- Trong một môi trường, chia theo **team hoặc app**, cộng thêm namespace chức năng cho hạ tầng (giám sát, ingress controller, cert-manager).
- **Không deploy vào `default`**. Nó không có quota, không có policy, là nơi đổ rác của mọi lệnh quên `-n`.
- Mỗi namespace mới nên đi kèm một **bộ chuẩn**: ResourceQuota, LimitRange, RoleBinding, NetworkPolicy default-deny, nhãn PSA, nhãn chủ sở hữu (`team`, `cost-center`). Dùng template (Kustomize/Helm/Kyverno generate) để không namespace nào bị thiếu.

## CLI phổ biến

```bash
kubectl get ns --show-labels
kubectl create ns my-ns --dry-run=client -o yaml          # sinh manifest mẫu

kubectl get pods -n my-ns
kubectl get pods -A                                         # mọi namespace
kubectl config set-context --current --namespace=my-ns      # đổi namespace mặc định của context
kubectl config view --minify -o jsonpath='{..namespace}'    # namespace hiện tại

kubectl describe resourcequota -n my-ns                     # Used / Hard
kubectl describe limitrange -n my-ns
kubectl get all -n my-ns                                    # "all" KHÔNG gồm ConfigMap, Secret, Ingress, PVC...
kubectl api-resources --verbs=list --namespaced -o name \
  | xargs -n1 kubectl get -n my-ns --ignore-not-found --show-kind   # liệt kê thật sự mọi thứ

kubectl label --dry-run=server --overwrite ns my-ns \
  pod-security.kubernetes.io/enforce=restricted             # thử nâng PSA
kubectl get ns my-ns -o jsonpath='{.status.conditions}'     # vì sao kẹt Terminating
```

### Lỗi thường gặp

| Triệu chứng                                             | Nguyên nhân hay gặp                                               | Kiểm tra                                              |
| ------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------- |
| `kubectl get pods` trống dù app đang chạy               | Đang xem nhầm namespace                                           | `-A`, kiểm tra namespace của context                  |
| `namespaces "my-ns" not found` khi apply                | Apply workload trước khi tạo namespace                            | Apply file Namespace trước                            |
| `bad address` / `could not resolve host` sau khi tách   | Gọi Service khác namespace bằng tên ngắn                          | Dùng `<svc>.<ns>`                                     |
| Pod không mount được Secret/ConfigMap                   | Secret nằm ở namespace khác                                       | Tạo bản sao trong namespace của Pod                   |
| Deployment tạo xong nhưng 0 Pod                         | Pod bị quota/LimitRange/PSA từ chối                               | `describe rs` → Events `FailedCreate`                 |
| `must specify limits.cpu`                               | Quota theo dõi limits nhưng Pod không khai báo, không có LimitRange | Thêm resources hoặc LimitRange                        |
| Rollout kẹt giữa chừng, Pod surge không tạo được        | Quota vừa khít số replica, không chừa chỗ cho `maxSurge`          | `describe resourcequota`, tăng quota hoặc giảm surge  |
| `violates PodSecurity "baseline"`                       | Pod cần hostNetwork/hostPath ở namespace `baseline`               | Chuyển sang namespace `privileged` riêng              |
| Namespace kẹt `Terminating`                             | Object bên trong còn finalizer mà controller đã mất               | `status.conditions` của namespace                     |

## Đặc điểm cần lưu ý

- **Namespace không cô lập mạng.** Tách namespace mà không có NetworkPolicy thì mọi Pod vẫn gọi được nhau. Đừng trình bày namespace như một biện pháp bảo mật khi chưa có NetworkPolicy, RBAC và PSA đi kèm.
- **Không lồng nhau được.** Namespace là phẳng; muốn phân cấp (org → team → app) phải dùng quy ước đặt tên + label, hoặc công cụ ngoài (Capsule, HNC).
- **Đổi namespace của một object là xoá và tạo lại.** `metadata.namespace` bất biến. Di chuyển app sang namespace mới nghĩa là tạo bản mới, chuyển traffic/DNS, rồi xoá bản cũ; PVC không mang theo được (PV phải bind lại thủ công).
- **Xoá namespace là thao tác nguy hiểm nhất** với một lệnh ngắn: mọi Deployment, Secret, PVC (và có thể cả disk thật nếu `reclaimPolicy: Delete`) biến mất. Giới hạn quyền `delete` trên Namespace, và cân nhắc admission policy chặn xoá namespace prod.
- **Quota là hợp đồng, không phải gợi ý.** Đặt quá chặt thì rollout và autoscaling bị chặn đúng lúc cần; đặt quá lỏng thì không bảo vệ được gì. Giám sát `Used/Hard` (metric `kube_resourcequota` từ kube-state-metrics) và cảnh báo trước khi chạm trần.
- **Namespace là đơn vị tự nhiên cho chi phí và quan sát.** Gần như mọi metric/log trong Kubernetes đều có nhãn `namespace`, nên đặt ranh giới namespace trùng với ranh giới sở hữu thì việc tính chi phí, phân quyền dashboard và định tuyến cảnh báo theo team trở nên đơn giản.
