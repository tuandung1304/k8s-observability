# ConfigMap & Secret

## Khái niệm

**ConfigMap** là một Kubernetes object dùng để lưu trữ dữ liệu cấu hình dạng không nhạy cảm (key-value hoặc file text), tách biệt khỏi image của container. Việc thay đổi cấu hình không đòi hỏi build lại image.

**Secret** có cơ chế hoạt động giống hệt ConfigMap, nhưng dùng để lưu dữ liệu nhạy cảm: password, token, API key, certificate.

Cả hai đều không cấu hình cho container runtime (image, resource limit, port...) — những thứ đó thuộc về Pod spec. ConfigMap/Secret chỉ cung cấp dữ liệu cho ứng dụng bên trong container sử dụng.

## Cách hoạt động

Container lấy dữ liệu từ ConfigMap/Secret theo 3 cách:

1. **Mount thành file** trong volume — dùng khi ứng dụng đọc cấu hình từ file.
   ```yaml
   volumeMounts:
     - name: config-volume
       mountPath: /etc/app/config.yaml
       subPath: config.yaml
   volumes:
     - name: config-volume
       configMap:
         name: app-config
   ```
2. **Biến môi trường** — `envFrom` để bơm toàn bộ key thành các biến env, hoặc `env.valueFrom.configMapKeyRef` / `secretKeyRef` để chọn từng key.
3. **Command-line args** — đọc giá trị từ biến môi trường rồi truyền vào `args` của container.

Kubernetes chỉ chịu trách nhiệm đưa dữ liệu vào đúng vị trí (file hoặc biến env) khi Pod được tạo. Việc đọc và parse nội dung đó là do ứng dụng trong container thực hiện.

## Đặc điểm cần lưu ý

- **Không tự động reload**: cập nhật ConfigMap/Secret không tự động restart Pod hoặc khiến ứng dụng nạp lại cấu hình. Một số ứng dụng hỗ trợ reload thủ công qua signal hoặc API riêng; phần lớn thì không, và cần restart Pod để áp dụng thay đổi.
- **Secret không được mã hóa mặc định**: giá trị trong Secret chỉ được encode bằng base64, không phải mã hóa — bất kỳ ai có quyền đọc object đều decode được nội dung gốc. Bảo mật thực sự phụ thuộc vào RBAC (giới hạn ai được đọc Secret) và tính năng encryption at rest của etcd.
- **Giới hạn dung lượng**: mỗi ConfigMap/Secret có giới hạn kích thước khoảng 1MiB.

## So sánh ConfigMap và Secret

|                        | ConfigMap                  | Secret                                        |
| ---------------------- | -------------------------- | --------------------------------------------- |
| Loại dữ liệu           | Cấu hình thông thường      | Dữ liệu nhạy cảm (password, token, cert)      |
| Cách lưu trữ           | Plaintext                  | Base64-encoded, có thể bật encryption at rest |
| Cách sử dụng trong Pod | Mount file, biến env, args | Giống ConfigMap                               |

## Ứng dụng thực tế

Việc tách cấu hình khỏi image cho phép cùng một image container chạy được ở nhiều môi trường khác nhau (dev, staging, production) chỉ bằng cách thay đổi ConfigMap/Secret tương ứng, không cần build lại image cho từng môi trường. Đây là nguyên tắc "config qua environment, không qua build" được mô tả trong [12-factor app](https://12factor.net/config).
