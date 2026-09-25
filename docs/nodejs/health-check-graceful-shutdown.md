# Health check & Graceful shutdown cho Node.js

## Khái niệm

Hai cơ chế này là "hợp đồng" giữa ứng dụng và nền tảng chạy nó (Kubernetes, ECS, load balancer...):

- **Health check** — app cho nền tảng biết trạng thái của mình: _còn sống không?_ (liveness), _nhận traffic được không?_ (readiness).
- **Graceful shutdown** — khi nền tảng muốn dừng app (deploy phiên bản mới, scale down, drain node), app **hoàn thành các request đang xử lý, giải phóng tài nguyên, rồi mới thoát**, thay vì chết giữa chừng.

Thiếu một trong hai, mỗi lần deploy đều có thể làm rớt request (lỗi 502/503, connection reset), dù code hoàn toàn đúng. Đây là lý do "zero-downtime deployment" không đến từ Kubernetes một mình — **app phải phối hợp**.

## Health check

### Liveness vs Readiness

|                   | Liveness — `/health/live`                           | Readiness — `/health/ready`                                              |
| ----------------- | --------------------------------------------------- | ------------------------------------------------------------------------ |
| Câu hỏi           | Process có đang phản hồi không, hay bị treo?        | Instance này có nên nhận request lúc này không?                          |
| Kiểm tra gì       | **Chỉ chính process**: event loop còn chạy, trả 200 | Những gì bắt buộc để phục vụ request: DB, cache, đang shutdown hay không |
| Fail thì nền tảng | Kill và restart container                           | Ngừng gửi traffic (gỡ khỏi Service/LB), **không** restart                |

Sai lầm phổ biến nhất: **cho liveness kiểm tra database**. Khi DB chậm hoặc chết, mọi Pod đồng loạt fail liveness → bị restart cùng lúc → khi DB hồi phục, toàn bộ Pod đang khởi động lại và đập vào DB cùng lúc (thundering herd). Một sự cố DB biến thành sự cố toàn hệ thống. Restart app không sửa được DB, nên liveness không được phụ thuộc vào DB.

Ngay cả với readiness, cần cân nhắc: nếu **mọi** Pod cùng phụ thuộc một dependency và nó chết, tất cả cùng not-ready → Service không còn endpoint → client nhận lỗi kết nối thay vì một lỗi 503 có ý nghĩa từ app. Nhiều hệ thống chỉ đưa vào readiness những dependency mà thiếu nó app **hoàn toàn** vô dụng, còn lại xử lý bằng degrade (trả cache, tắt tính năng).

### Tại sao liveness thường chỉ cần trả 200

Node.js chạy JavaScript trên **một thread**. Nếu event loop bị block (vòng lặp vô hạn, xử lý CPU nặng đồng bộ, `JSON.parse` một payload khổng lồ), **mọi request đều treo — kể cả `/health/live`**. Vì vậy một handler chỉ `return { status: 'ok' }` đã đủ để phát hiện trạng thái treo — probe timeout = event loop bị block.

### Yêu cầu với endpoint health

- **Nhanh và rẻ**: probe chạy mỗi vài giây trên mọi Pod. Không query nặng, không gọi chuỗi service khác.
- **Không cần auth**, không bị rate limit, không redirect (kubelet coi 200–399 là thành công).
- **Không ghi log mỗi lần gọi** — nếu không, log sẽ ngập bởi request health check.
- **Không public ra internet** nếu readiness lộ thông tin nội bộ (tên dependency, lỗi chi tiết).

## Graceful shutdown

### Signal trong container

Khi dừng container, nền tảng gửi **`SIGTERM`**, chờ một khoảng (Kubernetes: `terminationGracePeriodSeconds`, mặc định 30s; `docker stop`: 10s), rồi gửi **`SIGKILL`** — signal không thể bắt, process chết ngay lập tức.

| Signal    | Gửi bởi                            | Bắt được? |
| --------- | ---------------------------------- | --------- |
| `SIGTERM` | Kubernetes, `docker stop`, systemd | Có        |
| `SIGINT`  | Ctrl+C trong terminal              | Có        |
| `SIGKILL` | Hết grace period, OOM killer       | **Không** |

### Cái bẫy PID 1

Trong container, process được khởi chạy bởi `CMD` là **PID 1**. Linux đối xử đặc biệt với PID 1: **signal nào không có handler sẽ bị bỏ qua** thay vì dùng hành vi mặc định (terminate). Node.js mặc định **không** đăng ký handler cho `SIGTERM`, nên:

- Node chạy làm PID 1 mà không có handler → **`SIGTERM` bị lờ đi** → nền tảng chờ hết 30s → `SIGKILL`. Mỗi lần deploy chậm 30s và mọi request dang dở bị cắt.
- Chạy qua `npm start` / `yarn start` hoặc shell form `CMD node dist/main` → PID 1 là npm/sh, và chúng **không chuyển tiếp signal** đầy đủ cho node → cùng hậu quả.

Cách xử lý:

1. Dùng **exec form** `CMD ["node", "dist/main"]` để node là PID 1.
2. **Đăng ký handler** cho `SIGTERM`/`SIGINT` trong app.
3. Nếu app sinh process con (child_process), cân nhắc dùng init nhỏ như `tini` (`docker run --init`, hoặc `ENTRYPOINT ["/sbin/tini", "--"]`) để chuyển tiếp signal và dọn process zombie.

### Trình tự shutdown đúng

```text
SIGTERM
  │
  ├─ 1. Đánh dấu "đang shutdown" → readiness trả 503
  ├─ 2. (Chờ vài giây để LB/kube-proxy ngừng gửi request mới — xem phần Kubernetes)
  ├─ 3. server.close(): ngừng nhận connection mới, chờ request đang chạy xong
  ├─ 4. Đóng tài nguyên theo thứ tự ngược lúc khởi tạo:
  │      consumer queue → worker/job → DB pool, Redis, broker
  ├─ 5. Flush log / metrics / trace còn trong buffer
  └─ 6. process.exit(0)

  (Toàn bộ phải xong trước khi hết grace period, nếu không sẽ bị SIGKILL)
```

Thứ tự quan trọng: **đóng HTTP server trước, DB sau**. Làm ngược lại thì request đang xử lý sẽ lỗi vì mất kết nối DB.

### Node.js "thuần"

```ts
import http from "node:http";

const server = http.createServer(app);
server.listen(3000);

let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return; // nhận signal lần 2 (Ctrl+C hai lần...) thì bỏ qua
  shuttingDown = true;
  console.log(`${signal} received, shutting down`);

  // Lưới an toàn: nếu cleanup bị treo, tự thoát trước khi bị SIGKILL
  setTimeout(() => {
    console.error("Shutdown timed out, forcing exit");
    process.exit(1);
  }, 25_000).unref();

  // Ngừng nhận connection mới, chờ request đang chạy hoàn thành
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  await db.end(); // đóng tài nguyên sau khi không còn request
  await redis.quit();

  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
```

Những điểm dễ sai:

- **`server.close()` và keep-alive connection.** Từ Node 19, `server.close()` tự đóng các connection keep-alive đang rảnh, và đóng tiếp các connection còn lại ngay khi request trên đó xong. Với Node cũ hơn, connection keep-alive giữ server mở đến hết `keepAliveTimeout` — cần tự gọi `server.closeIdleConnections()`.
- **Connection sống lâu** (WebSocket, SSE, streaming) không bao giờ tự "xong" → `server.close()` treo mãi. Phải chủ động đóng chúng (gửi message báo client reconnect, rồi close), hoặc dựa vào timeout lưới an toàn.
- **Đừng gọi `process.exit()` ngay trong handler** — nó cắt ngang mọi thứ, giống như không có graceful shutdown.
- **`unhandledRejection` / `uncaughtException`**: từ Node 15, promise bị reject không xử lý sẽ làm process crash. Crash như vậy **không** đi qua graceful shutdown. Đừng "nuốt" các lỗi này để giữ process sống — trạng thái có thể đã hỏng; log lại rồi để process chết, nền tảng sẽ khởi động lại.

### Keep-alive timeout và proxy phía trước

Node mặc định `server.keepAliveTimeout = 5000` (5s). Các proxy phía trước (ingress-nginx, AWS ALB, GCP LB) thường giữ connection rảnh tới upstream **60s**. Khi Node đóng connection ở giây thứ 5 đúng lúc proxy vừa gửi request mới vào connection đó → proxy nhận connection reset → trả **502** cho client. Lỗi này xuất hiện ngẫu nhiên, khó tái hiện.

Quy tắc: **`keepAliveTimeout` của app phải lớn hơn idle timeout của proxy**, và `headersTimeout` lớn hơn `keepAliveTimeout` một chút:

```ts
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
```

Giá trị này không làm chậm shutdown, vì `server.close()` đóng connection rảnh ngay lập tức.

## Kết hợp với Kubernetes

### Race condition khi Pod bị xoá

Khi Pod bị xoá, hai việc diễn ra **song song**, không có thứ tự:

```text
                     ┌─► kubelet: chạy preStop → gửi SIGTERM cho container
kubectl delete pod ──┤
                     └─► endpoints controller: gỡ Pod khỏi EndpointSlice
                            → kube-proxy trên từng node cập nhật iptables
                            → ingress controller cập nhật upstream
```

Nhánh dưới cần thời gian (vài trăm ms đến vài giây, tuỳ quy mô cluster) để lan ra mọi node. Nếu app nhận `SIGTERM` và `server.close()` ngay, trong khoảng đó vẫn có request được route tới một Pod đã ngừng nhận connection → **connection refused / 502**.

Giải pháp: **trì hoãn `SIGTERM` vài giây** bằng `preStop`, để routing cập nhật xong trước khi app đóng cửa:

```yaml
spec:
  terminationGracePeriodSeconds: 30 # ngân sách cho CẢ preStop lẫn shutdown của app
  containers:
    - name: app
      lifecycle:
        preStop:
          sleep:
            seconds: 5 # action sleep có sẵn, không cần binary sleep trong image
```

Trước khi có action `sleep` (stable từ Kubernetes 1.34), phải dùng `exec: { command: ["sleep", "5"] }` — không chạy được với image distroless không có `sleep`. Cách khác là để app tự chờ vài giây sau khi nhận `SIGTERM` trước khi `server.close()` — hữu ích khi chạy ở nền tảng không có preStop, nhưng làm logic của app phụ thuộc vào hạ tầng.

Lưu ý: **`terminationGracePeriodSeconds` tính từ lúc bắt đầu preStop**, không phải từ lúc gửi `SIGTERM`. preStop 5s + grace 30s → app chỉ còn 25s để shutdown.

### Readiness trả 503 khi shutdown có cần không?

Trong Kubernetes, Pod ở trạng thái `Terminating` đã tự động bị đánh dấu not-ready trong EndpointSlice, nên readiness 503 là **dư thừa về mặt routing của Service**. Vẫn nên làm vì:

- Load balancer bên ngoài dùng health check riêng (ALB target type IP, NEG của GCP...) chỉ biết qua readiness endpoint.
- Nhất quán khi chạy ở nền tảng khác (ECS, Nomad, VM sau LB).

Điều ngược lại **không** nên làm: trả 503 cho **mọi** request ngay khi nhận `SIGTERM` (option `return503OnClosing` của NestJS). Những request đến trong khoảng routing chưa cập nhật sẽ bị từ chối, trong khi app hoàn toàn có thể phục vụ chúng.

## NestJS

### Shutdown hooks

NestJS không lắng nghe signal nào theo mặc định — phải bật tường minh:

```ts
const app = await NestFactory.create(AppModule);
app.enableShutdownHooks([], { useProcessExit: true });
```

`enableShutdownHooks()` đăng ký handler cho các signal (`SIGTERM`, `SIGINT`...) — giải quyết luôn cái bẫy PID 1. Khi nhận signal, Nest chạy `app.close()` theo thứ tự:

```text
1. onModuleDestroy()              ← mọi provider/module
2. beforeApplicationShutdown(sig) ← nơi bật cờ "đang shutdown" cho readiness
3. HTTP server close              ← ngừng nhận connection mới, chờ request đang chạy
4. onApplicationShutdown(sig)     ← nơi đóng DB pool, Redis, broker
5. thoát process
```

- **Đóng tài nguyên trong `onApplicationShutdown`**, không phải `onModuleDestroy` — `onModuleDestroy` chạy **trước** khi HTTP server đóng, nên request đang xử lý sẽ mất kết nối DB. (Các module chính thức như `TypeOrmModule` đã tự đóng connection trong hook.)
- **`useProcessExit: true`**: mặc định, sau khi cleanup Nest gỡ handler và **gửi lại chính signal đó** cho process để thoát. Nếu node là PID 1, signal gửi lại bị kernel bỏ qua (không còn handler) — process chỉ thoát khi event loop tình cờ trống; một timer hay connection quên đóng là treo tới `SIGKILL`. `useProcessExit` gọi thẳng `process.exit(0)`, và đảm bảo sự kiện `exit` được phát để logger bất đồng bộ (như Pino) flush buffer.
- **`forceCloseConnections`** (option của `NestFactory.create`): theo dõi mọi socket và cắt ngang khi đóng server — chỉ dùng khi chấp nhận mất request đang chạy, hoặc có connection sống lâu không tự đóng.
- **`return503OnClosing`**: trả 503 cho mọi request ngay từ đầu shutdown — thường không nên bật trong Kubernetes (lý do ở phần trên).
- `keepAliveTimeout` / `headersTimeout` đặt qua `app.getHttpServer()` trước `app.listen()`.

### Health check

Pattern tối thiểu khi app chưa có dependency: một provider giữ cờ shutdown, controller đọc cờ đó.

```ts
@Injectable()
export class ShutdownState implements BeforeApplicationShutdown {
  isShuttingDown = false;
  beforeApplicationShutdown() {
    this.isShuttingDown = true;
  }
}

@Controller("health")
export class HealthController {
  constructor(private readonly state: ShutdownState) {}

  @Get("live")
  live() {
    return { status: "ok" };
  }

  @Get("ready")
  ready() {
    if (this.state.isShuttingDown) throw new ServiceUnavailableException();
    return { status: "ok" };
  }
}
```

Khi app có dependency cần kiểm tra, dùng [`@nestjs/terminus`](https://docs.nestjs.com/recipes/terminus): có sẵn health indicator cho TypeORM, Prisma, Mongoose, Redis, HTTP, disk, memory, và format response chuẩn cho biết dependency nào lỗi.

### Kiểm tra

```bash
# Local: gửi SIGTERM, app phải log quá trình shutdown và exit code 0
node dist/main &
kill -TERM %1; wait %1; echo "exit=$?"

# Trong cluster: thời gian xoá Pod ≈ preStop + thời gian drain, không phải bằng grace period
time kubectl delete pod <pod>
```

Nếu xoá Pod luôn mất đúng bằng `terminationGracePeriodSeconds`, app đang không phản ứng với `SIGTERM` và bị `SIGKILL` — kiểm tra `CMD` trong Dockerfile (exec form) và việc đăng ký signal handler.

## Góc nhìn kiến trúc

- **Graceful shutdown là yêu cầu bắt buộc của rolling update**, không phải tính năng tuỳ chọn. Rolling update liên tục tắt Pod cũ; mỗi Pod tắt không đúng cách là một đợt lỗi nhỏ gửi tới người dùng — với deploy vài lần mỗi ngày, error budget bị tiêu hao âm thầm.
- **Client vẫn phải có retry**: graceful shutdown giảm lỗi chứ không loại bỏ hoàn toàn (node chết đột ngột, OOMKill, network partition không cho app cơ hội dọn dẹp). Client/gateway nên retry request idempotent với backoff.
- **Grace period là trade-off**: dài thì deploy và drain node chậm; ngắn thì request dài (upload, báo cáo) bị cắt. Request thực sự dài nên chuyển sang xử lý bất đồng bộ (queue + job) thay vì kéo dài grace period.
- **Health check là nguồn tín hiệu cho observability**: tỉ lệ readiness fail, số lần restart do liveness (`kube_pod_container_status_restarts_total`) là metric đáng alert trong Prometheus — chúng thường báo sự cố sớm hơn lỗi phía người dùng.
