# Deployment

## Khái niệm

**Deployment** là controller dùng để chạy app **stateless**. Mình chỉ khai báo trạng thái mong muốn ("chạy 3 bản sao của Pod template này, image `v2`"), còn Deployment lo phần còn lại: tạo Pod, thay Pod chết, scale, rolling update và rollback.

Deployment không trực tiếp quản lý Pod mà đi qua một tầng trung gian là **ReplicaSet**:

```text
Deployment ──quản lý──> ReplicaSet (mỗi phiên bản template một cái) ──quản lý──> Pod
```

- **ReplicaSet** chỉ làm một việc: giữ đúng `N` Pod khớp với selector. Nó không biết gì về update.
- **Deployment** quản lý _nhiều_ ReplicaSet. Mỗi lần Pod template thay đổi thì nó tạo ReplicaSet mới, rồi tăng dần số Pod bên mới, giảm dần bên cũ. ReplicaSet cũ được giữ lại (scale về 0) để phục vụ rollback.

Gần như không bao giờ cần tạo ReplicaSet bằng tay.

## Cách hoạt động

### Reconcile loop

Mọi controller trong Kubernetes đều chạy cùng một vòng lặp: **quan sát trạng thái thực tế → so với trạng thái mong muốn → hành động để kéo hai bên về bằng nhau**. Deployment controller và ReplicaSet controller đều chạy trong `kube-controller-manager`.

```text
kubectl apply → apiserver lưu Deployment
  → Deployment controller: template hash = abc → tạo ReplicaSet "app-abc" (replicas: 3)
  → ReplicaSet controller: thấy 0/3 Pod → tạo 3 Pod
  → scheduler gán node → kubelet chạy Pod
```

Vì là vòng lặp liên tục chứ không phải lệnh một lần, nên:

- Xoá một Pod thì ReplicaSet tạo ngay Pod thay thế.
- Node chết thì Pod trên node đó bị đánh dấu xoá, và ReplicaSet tạo Pod mới trên node khác.
- Sửa trực tiếp ReplicaSet do Deployment quản lý thì Deployment sẽ ghi đè lại.

### Liên kết bằng label và ownerReference

- **`spec.selector`** quyết định Pod nào thuộc về Deployment. Nó **phải khớp** label trong `spec.template.metadata.labels`, và **không sửa được** sau khi tạo.
- Deployment tự thêm label **`pod-template-hash`** vào ReplicaSet và Pod để các ReplicaSet của cùng một Deployment không "giành" Pod của nhau. Tên ReplicaSet và Pod cũng chứa hash này: `app-<hash>-<random>`.
- Mỗi Pod có `metadata.ownerReferences` trỏ về ReplicaSet, ReplicaSet trỏ về Deployment. Xoá Deployment thì garbage collector xoá dây chuyền xuống ReplicaSet và Pod.

**Cạm bẫy**: nếu trong namespace đã có Pod trần mang label khớp selector, ReplicaSet có thể "nhận nuôi" Pod đó và tính vào số replica. Selector nên đủ cụ thể, và không dùng chung label giữa các app.

## Rolling update

### Cái gì kích hoạt rollout

**Chỉ thay đổi trong `spec.template`** mới tạo ReplicaSet mới (revision mới): image, env, resource, probe, label của Pod... Còn thay `replicas` hoặc `strategy` thì không tạo revision, chỉ scale ReplicaSet hiện tại.

Hệ quả hay gặp: cập nhật nội dung ConfigMap/Secret **không** kích hoạt rollout vì template không đổi. Muốn Pod nhận config mới thì dùng `kubectl rollout restart` (thực chất là thêm annotation timestamp vào template), hoặc đưa hash của config vào annotation của template (cách Helm/Kustomize hay làm).

### Strategy

| Strategy                   | Cách làm                                                    | Dùng khi                                                                                           |
| -------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `RollingUpdate` (mặc định) | Thay dần Pod cũ bằng Pod mới, hai phiên bản chạy song song. | Hầu hết app stateless. App phải chịu được việc v1 và v2 cùng chạy một lúc.                         |
| `Recreate`                 | Xoá hết Pod cũ rồi mới tạo Pod mới.                         | Hai phiên bản không được chạy cùng lúc (migration DB không tương thích, lock). Chấp nhận downtime. |

`RollingUpdate` được điều khiển bởi hai tham số (số tuyệt đối hoặc phần trăm của `replicas`):

| Tham số          | Ý nghĩa                                                               | Mặc định |
| ---------------- | --------------------------------------------------------------------- | -------- |
| `maxSurge`       | Được tạo **dư** tối đa bao nhiêu Pod so với `replicas`.               | 25%      |
| `maxUnavailable` | Được phép **thiếu** tối đa bao nhiêu Pod available so với `replicas`. | 25%      |

Một số tổ hợp thường dùng:

| Tổ hợp                              | Hành vi                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------- |
| `maxSurge: 1, maxUnavailable: 0`    | An toàn nhất: luôn đủ capacity, cần thêm tài nguyên cho 1 Pod dư. Rollout chậm. |
| `maxSurge: 0, maxUnavailable: 1`    | Không cần tài nguyên dư (cluster chật), nhưng tạm thời mất 1 Pod capacity.      |
| `maxSurge: 100%, maxUnavailable: 0` | Gần giống blue/green: dựng đủ bộ mới rồi mới tắt bộ cũ. Tốn gấp đôi tài nguyên. |

### Readiness quyết định tốc độ rollout

Deployment chỉ coi Pod mới là **available** khi Pod đó `Ready` và giữ `Ready` liên tục ít nhất `minReadySeconds` (mặc định 0). Chỉ khi có Pod available, nó mới được xoá thêm Pod cũ.

Vì vậy **readinessProbe là chốt chặn của rollout**:

- Không có readinessProbe thì Pod được coi là ready ngay khi container start, kể cả khi app chưa nghe port. Rollout chạy rất nhanh và có thể thay hết Pod tốt bằng Pod hỏng.
- Có readinessProbe tốt + `maxUnavailable: 0` thì phiên bản hỏng sẽ kẹt ở Pod mới đầu tiên, các Pod cũ vẫn phục vụ traffic bình thường.
- `minReadySeconds` chặn trường hợp app ready vài giây rồi crash.

### Rollout kẹt và rollback

- **`progressDeadlineSeconds`** (mặc định 600): nếu rollout không tiến triển trong khoảng này, Deployment gắn condition `Progressing=False, reason=ProgressDeadlineExceeded`. `kubectl rollout status` trả exit code khác 0, CI/CD dựa vào đó để báo fail.
- **Kubernetes không tự rollback.** Deadline chỉ là tín hiệu; rollback phải do người hoặc công cụ (Argo Rollouts, Flagger, pipeline CI) thực hiện.
- **`kubectl rollout undo`** thực chất là copy template của ReplicaSet cũ vào Deployment, tạo ra một **revision mới** (số revision tăng lên chứ không quay về số cũ).
- **`revisionHistoryLimit`** (mặc định 10) là số ReplicaSet cũ được giữ lại. Đặt 0 thì không rollback được.
- Nếu Deployment được quản lý bằng GitOps/manifest, sau khi `rollout undo` phải sửa lại cả Git. Nếu không, lần apply tiếp theo sẽ đưa phiên bản hỏng quay lại.

### Pause / resume

`kubectl rollout pause` cho phép sửa nhiều chỗ trong template (image, env, resource) mà không kích hoạt rollout sau mỗi lần sửa. `resume` thì gộp tất cả thành một rollout.

## Scale

- **`replicas`** đặt số Pod mong muốn. `kubectl scale` chỉ là đường tắt để sửa field này.
- **HorizontalPodAutoscaler (HPA)** tự điều chỉnh `replicas` theo metric (CPU, memory, custom metric). Khi dùng HPA thì **bỏ `replicas` khỏi manifest**, nếu không mỗi lần apply sẽ reset số replica về giá trị cố định, đè lên quyết định của HPA.
- Khi scale down, ReplicaSet ưu tiên xoá Pod chưa schedule, Pod chưa ready, Pod mới tạo trước Pod chạy lâu. Có thể gợi ý thứ tự bằng annotation `controller.kubernetes.io/pod-deletion-cost`.

## Tính sẵn sàng (availability)

`replicas > 1` chưa đủ để chịu lỗi. Vài thứ cần đi kèm:

- **Rải Pod ra nhiều node/zone**: dùng `topologySpreadConstraints` hoặc `podAntiAffinity`. Nếu không, scheduler có thể đặt tất cả replica lên cùng một node và node chết là mất hết.
- **PodDisruptionBudget (PDB)**: giới hạn số Pod bị xoá cùng lúc bởi các _disruption tự nguyện_ (drain node, nâng cấp cluster). PDB **không** áp dụng cho rolling update của chính Deployment (cái đó do `maxUnavailable` lo) và không bảo vệ khỏi node crash.
- **Graceful shutdown** (xem [Pod](pod.md#graceful-shutdown)): mỗi rollout là một lần xoá Pod hàng loạt. App không xử lý `SIGTERM` đúng cách thì mỗi lần deploy sẽ làm rơi request.

## Deployment và các controller khác

|                | Deployment                 | StatefulSet                                 | DaemonSet                              |
| -------------- | -------------------------- | ------------------------------------------- | -------------------------------------- |
| Danh tính Pod  | Ngẫu nhiên, thay thế được  | Cố định: `name-0`, `name-1`...              | Mỗi node một Pod                       |
| Storage        | Dùng chung hoặc không có   | Mỗi Pod một PVC riêng, theo Pod khi tạo lại | Thường là hostPath                     |
| Thứ tự tạo/xoá | Song song                  | Tuần tự (mặc định)                          | Theo node                              |
| Số lượng       | `replicas`                 | `replicas`                                  | Theo số node (lọc bằng selector/taint) |
| Dùng cho       | API, web, worker stateless | DB, queue, hệ thống có leader/cluster       | Agent trên node: log, metrics, CNI     |

Câu hỏi để chọn: _"Pod này mất đi, Pod khác thay vào với tên và IP khác thì có sao không?"_ Không sao thì dùng Deployment.

## CLI phổ biến

```bash
kubectl create deployment my-app --image=my-app:1.0 --replicas=3 --dry-run=client -o yaml  # sinh manifest mẫu
kubectl get deploy,rs,pods -l app=my-app -o wide
kubectl describe deploy my-app                 # Conditions, Events, ReplicaSet cũ/mới

kubectl scale deploy my-app --replicas=5
kubectl set image deploy/my-app app=my-app:1.1  # "app" là tên container
kubectl rollout restart deploy/my-app           # tạo Pod mới với cùng template

kubectl rollout status deploy/my-app --timeout=5m   # chặn đến khi xong, exit != 0 nếu fail
kubectl rollout history deploy/my-app
kubectl rollout history deploy/my-app --revision=2  # xem template của revision
kubectl rollout undo deploy/my-app [--to-revision=2]
kubectl rollout pause|resume deploy/my-app

kubectl annotate deploy/my-app kubernetes.io/change-cause="bump to 1.1"  # hiện trong history
```

### Đọc output

```text
NAME     READY   UP-TO-DATE   AVAILABLE
my-app   2/3     3            2
```

| Cột          | Ý nghĩa                                                       |
| ------------ | ------------------------------------------------------------- |
| `READY`      | Số Pod ready / `replicas` mong muốn.                          |
| `UP-TO-DATE` | Số Pod đang chạy template mới nhất.                           |
| `AVAILABLE`  | Số Pod ready đủ `minReadySeconds`, được tính là phục vụ được. |

### Lỗi thường gặp

| Triệu chứng                                                | Nguyên nhân hay gặp                                     | Kiểm tra                                     |
| ---------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------- |
| Rollout kẹt, Pod mới `ImagePullBackOff`/`CrashLoopBackOff` | Sai image tag, app lỗi ở phiên bản mới                  | `get pods`, `describe pod` của Pod mới       |
| Rollout kẹt, Pod mới `Running` nhưng `0/1`                 | readinessProbe fail ở phiên bản mới                     | `describe pod` → Events                      |
| Rollout kẹt, Pod mới `Pending`                             | `maxSurge` cần thêm tài nguyên nhưng cluster không đủ   | `describe pod` → Events (`Insufficient cpu`) |
| Apply nhưng không có Pod mới                               | Không đổi gì trong `template` (ví dụ chỉ sửa ConfigMap) | `rollout history`, dùng `rollout restart`    |
| `field is immutable` khi apply                             | Đổi `spec.selector`                                     | Xoá và tạo lại Deployment                    |
| Số replica tự nhảy sau mỗi lần apply                       | Manifest có `replicas` trong khi HPA đang quản lý       | Bỏ `replicas` khỏi manifest                  |
| Tất cả replica chết cùng lúc                               | Mọi Pod nằm chung một node                              | `get pods -o wide`, thêm topology spread     |

## Đặc điểm cần lưu ý

- **Deployment là lựa chọn mặc định** cho app stateless. Pod trần chỉ dùng để học hoặc debug.
- **Template hash quyết định mọi thứ**: hai lần apply cùng template thì không có rollout; đổi một ký tự trong template thì có rollout.
- **Rolling update nghĩa là hai phiên bản chạy cùng lúc.** API, schema DB và message format phải tương thích ngược ít nhất một phiên bản. Migration phá vỡ tương thích nên chia làm nhiều bước (expand → migrate → contract).
- **Không dùng tag mutable** (`:latest`, `:main`): đổi nội dung image mà không đổi tag thì template không đổi, không có rollout, và rollback về "revision cũ" cũng chẳng quay về code cũ. Dùng tag theo version hoặc digest (`image@sha256:...`).
- **Rollout là thời điểm rủi ro nhất** của một service. Theo dõi error rate và latency theo phiên bản (label `version` hoặc `pod-template-hash` trên metric) để phát hiện phiên bản lỗi sớm; canary/blue-green nâng cao thì dùng Argo Rollouts hoặc Flagger.
