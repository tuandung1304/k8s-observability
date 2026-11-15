# ServiceAccount & RBAC

## Khái niệm

Mọi request tới API server đi qua ba bước:

```text
request ──> Authentication ──> Authorization ──> Admission ──> etcd
            "bạn là ai?"       "bạn được làm     "request có hợp lệ /
                                việc này không?"  cần sửa gì không?"
```

- **ServiceAccount (SA)** là danh tính cho **process chạy trong Pod** (Prometheus, controller, CI runner). Người dùng thật (User/Group) không phải object Kubernetes; họ đến từ certificate, OIDC, cloud IAM.
- **RBAC** (Role-Based Access Control) là cơ chế authorization: định nghĩa **được làm gì** (Role) rồi **gán cho ai** (Binding).

RBAC chỉ có **allow**, không có deny. Mặc định không ai được làm gì; quyền là hợp (union) của mọi binding áp dụng cho subject đó.

## Cách hoạt động

### ServiceAccount và token

```text
Pod (serviceAccountName: prometheus)
 └── /var/run/secrets/kubernetes.io/serviceaccount/
       ├── token       # JWT ngắn hạn, kubelet tự xoay vòng (projected volume)
       ├── ca.crt      # để xác minh certificate của API server
       └── namespace
```

- Mỗi namespace tự có SA `default`. Pod không ghi `serviceAccountName` sẽ dùng nó.
- Token là **bound token**: gắn với Pod cụ thể, có hạn (mặc định ~1 giờ, kubelet làm mới), hết hiệu lực khi Pod bị xoá. Từ 1.24 Kubernetes không còn tự sinh Secret chứa token vĩnh viễn.
- Client library (client-go, Prometheus) tự đọc thư mục này khi chạy "in-cluster". Không cần cấu hình gì.
- API server nhìn thấy SA dưới tên `system:serviceaccount:<namespace>:<name>`, thuộc group `system:serviceaccounts` và `system:serviceaccounts:<namespace>`.
- `serviceAccountName` của Pod là **bất biến**. Đổi SA nghĩa là tạo Pod mới, nên dùng Deployment để việc này thành một rollout.

Pod không cần gọi API server thì nên tắt mount token: `automountServiceAccountToken: false`. Token bị lộ qua lỗ hổng ứng dụng là đường leo thang phổ biến.

### Bốn object RBAC

| Object                 | Phạm vi       | Vai trò                                                                             |
| ---------------------- | ------------- | ----------------------------------------------------------------------------------- |
| **Role**               | Một namespace | Danh sách quyền trên object trong namespace đó.                                     |
| **ClusterRole**        | Toàn cluster  | Danh sách quyền, dùng được cho object cluster-scoped và cho mọi namespace.          |
| **RoleBinding**        | Một namespace | Gán Role **hoặc ClusterRole** cho subject, **chỉ có hiệu lực trong namespace này**. |
| **ClusterRoleBinding** | Toàn cluster  | Gán ClusterRole cho subject trên **mọi namespace** và object cluster-scoped.        |

Một rule gồm ba phần:

```yaml
rules:
  - apiGroups: [""] # "" = core group (pods, nodes, services...); "apps" cho deployments
    resources: ["pods"] # có thể là subresource: "pods/log", "pods/exec"
    verbs: ["list", "watch"] # get, list, watch, create, update, patch, delete, deletecollection
    # resourceNames: ["my-config"]   # giới hạn theo tên (không áp dụng được cho list/watch/create)
```

### Ba kiểu kết hợp

```text
Role         + RoleBinding         → quyền trong một namespace
ClusterRole  + RoleBinding         → định nghĩa dùng chung, nhưng hiệu lực chỉ trong namespace của binding
ClusterRole  + ClusterRoleBinding  → quyền trên toàn cluster
```

Không có "Role + ClusterRoleBinding". Kiểu thứ hai rất hay dùng: ClusterRole có sẵn `view`, `edit`, `admin` được gán cho từng team qua RoleBinding trong namespace của họ.

### Subject ở namespace khác

RoleBinding nằm ở namespace **nơi quyền được áp dụng**, còn subject có thể ở bất kỳ đâu. Trong repo này, SA `prometheus` sống ở `observability` nhưng RoleBinding nằm ở `apps`:

```yaml
kind: RoleBinding
metadata:
  namespace: apps # quyền có hiệu lực ở đây
subjects:
  - kind: ServiceAccount
    name: prometheus
    namespace: observability # danh tính đến từ đây
```

Ai quản lý namespace `apps` sẽ thấy rõ "có những ai được đọc Pod của tôi" bằng `kubectl get rolebinding -n apps`.

## Áp dụng cho Prometheus

`kubernetes_sd_configs` gọi API server để **list** rồi **watch** danh sách Pod/Node. Quyền tối thiểu (`k8s/observability/prometheus-rbac.yaml`):

| Cần                         | Object                           | Vì sao                                                              |
| --------------------------- | -------------------------------- | ------------------------------------------------------------------- |
| `list, watch` nodes         | ClusterRole + ClusterRoleBinding | Node là cluster-scoped, Role không chứa được.                       |
| `list, watch` pods ở `apps` | Role + RoleBinding trong `apps`  | Chỉ scrape namespace đã cho phép, không đọc được Pod `kube-system`. |

So với các ví dụ trên mạng (một ClusterRole `get/list/watch` cho nodes, pods, services, endpoints, cộng `nonResourceURLs: /metrics`), cách này hẹp hơn nhiều. Đổi lại, mỗi namespace mới muốn được scrape phải thêm một cặp Role/RoleBinding **và** thêm tên vào `namespaces.names` trong config Prometheus. Hai danh sách này phải khớp nhau: config có namespace mà RBAC không cho thì Prometheus log lỗi `forbidden` và target đó trống.

`get` không cần: informer chỉ `list` một lần rồi `watch` thay đổi.

## Mặc định có sẵn

| ClusterRole     | Cho phép                                                     |
| --------------- | ------------------------------------------------------------ |
| `cluster-admin` | Mọi thứ. Gán bằng ClusterRoleBinding = root của cluster.     |
| `admin`         | Gần như mọi thứ trong namespace, kể cả tạo Role/RoleBinding. |
| `edit`          | Đọc/ghi workload, Secret; không sửa RBAC.                    |
| `view`          | Đọc hầu hết object, **trừ Secret**.                          |

`edit` đọc được Secret và tạo được Pod, nên thực tế có thể mount mọi Secret và dùng mọi SA trong namespace. Không coi `edit` là "quyền thấp".

## Quyền nguy hiểm

Một số quyền tương đương leo thang thành admin, dù trông vô hại:

| Quyền                                     | Vì sao nguy hiểm                                                                          |
| ----------------------------------------- | ----------------------------------------------------------------------------------------- |
| `create pods` (hoặc deployments, jobs...) | Tạo Pod dùng SA mạnh hơn, mount Secret bất kỳ trong namespace, hostPath nếu PSA cho phép. |
| `get/list secrets`                        | Đọc token, mật khẩu. `list` trả về cả nội dung, không chỉ tên.                            |
| `create pods/exec`                        | Chạy lệnh trong container đang có token/secret.                                           |
| `bind`, `escalate` trên roles             | Tự gán cho mình quyền chưa có.                                                            |
| `impersonate`                             | Hành động dưới danh nghĩa user/SA khác.                                                   |
| `*` trên `*`                              | Bao gồm cả những resource sẽ được thêm vào tương lai.                                     |

API server có cơ chế chống leo thang: bạn chỉ tạo được Role/Binding chứa những quyền **chính bạn đang có**, trừ khi có verb `escalate`/`bind`.

## CLI phổ biến

```bash
SA=system:serviceaccount:observability:prometheus

# Kiểm tra một quyền cụ thể (cần quyền impersonate, admin của kind có sẵn)
kubectl auth can-i list pods -n apps --as=$SA          # yes
kubectl auth can-i list pods -n kube-system --as=$SA   # no
kubectl auth can-i --list -n apps --as=$SA             # liệt kê mọi quyền trong namespace

kubectl get sa -n observability
kubectl get role,rolebinding -n apps
kubectl get clusterrole,clusterrolebinding | grep prometheus
kubectl describe clusterrole view                      # xem rule của role có sẵn

# Ai đang có ClusterRoleBinding tới cluster-admin?
kubectl get clusterrolebinding -o json \
  | jq -r '.items[] | select(.roleRef.name=="cluster-admin") | .metadata.name, .subjects'

# Token thử nghiệm ngắn hạn cho SA (dùng với curl/kubectl --token)
kubectl create token prometheus -n observability --duration=10m
```

### Lỗi thường gặp

| Triệu chứng                                                                                                | Nguyên nhân                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `pods is forbidden: User "system:serviceaccount:..." cannot list resource "pods" ... in the namespace "x"` | Thiếu RoleBinding ở namespace `x`, hoặc Role thiếu verb `list`.                                                               |
| `... at the cluster scope`                                                                                 | Client list **mọi namespace** nhưng chỉ có Role theo namespace. Giới hạn namespace phía client, hoặc dùng ClusterRoleBinding. |
| Sửa Role nhưng vẫn forbidden                                                                               | Binding trỏ sai `roleRef.kind` (Role vs ClusterRole) hoặc sai namespace của subject.                                          |
| Không đổi được `roleRef` của binding                                                                       | `roleRef` bất biến; xoá và tạo lại binding.                                                                                   |
| Pod vẫn dùng SA `default`                                                                                  | Quên `serviceAccountName`, hoặc SA tạo sau Pod (Pod bị từ chối) / Pod chưa được tạo lại.                                      |
| `apiGroups` sai                                                                                            | Deployment ở `apps`, Ingress ở `networking.k8s.io`, EndpointSlice ở `discovery.k8s.io`. Tra bằng `kubectl api-resources`.     |

## Đặc điểm cần lưu ý

- **Namespace + RBAC mới là ranh giới quản trị thật.** Namespace chỉ đặt tên; RBAC biến nó thành ranh giới quyền.
- **Least privilege có chi phí vận hành.** Role theo từng namespace an toàn hơn nhưng phải đồng bộ với config (ở đây: danh sách namespace của Prometheus). Ở quy mô lớn, cách này cần GitOps/template, nếu không người ta sẽ quay về ClusterRole rộng cho đỡ phiền.
- **Một SA cho mỗi workload cần gọi API.** Dùng chung SA `default` với quyền đã mở rộng nghĩa là mọi Pod trong namespace thừa hưởng quyền đó.
- **Quyền "đọc" chưa chắc vô hại.** Đọc Secret, đọc Pod (env có thể chứa mật khẩu), `pods/log` đều có thể làm lộ dữ liệu.
- **RBAC chỉ bảo vệ API server.** Nó không chặn Pod gọi nhau qua mạng (cần NetworkPolicy), không giới hạn Pod chạy gì (cần PSA).
- **Ngoài Kubernetes**: trên cloud, SA còn được ánh xạ sang IAM (EKS IRSA/Pod Identity, GKE Workload Identity) để Pod gọi S3, Cloud SQL mà không cần access key tĩnh. Cùng một tư duy: danh tính theo workload, quyền tối thiểu, token ngắn hạn.
