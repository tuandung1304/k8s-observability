# Kubernetes & Observability Lab

A hands-on lab for mastering Kubernetes, Docker, Kind, Prometheus, and Grafana — with notes captured in `docs/`.

The goal isn't just "knowing the concepts" but understanding **how things work under the hood** and, just as important, **why you'd choose them** — the trade-offs, failure modes, and design decisions a **Solutions Architect** needs to defend to a team or a client. Every topic here is practiced locally first, then documented with that architectural lens: not just "how do I configure this" but "when is this the right call, and what does it cost."

---

## 🎯 Goals

By the end of this repo, I should be able to:

- **Kubernetes** — explain the architecture and core objects (Pods, Deployments, Services, ConfigMaps/Secrets, RBAC, namespaces), operate workloads (scaling, rolling updates/rollbacks, Jobs/CronJobs), reason about networking/storage/resource management, and debug real cluster issues.
- **Docker** — build optimized, multi-stage images; understand container lifecycle, networking, and volumes; know where Docker's responsibilities end and Kubernetes' begin.
- **Observability** — stand up Prometheus + Grafana; understand metrics vs. logs vs. traces, PromQL, service discovery, dashboards, and alerting — and be able to argue _what_ to observe and _why_, not just how to wire it up.
- **Architectural judgment** — for each topic, be able to compare alternatives, articulate trade-offs (cost, complexity, reliability, scalability), and make a defensible recommendation — the core skill of a Solutions Architect.

---

## 🗂 Repository Structure

```text
.
├── docs/
│   ├── kubernetes/       # architecture, workloads, networking, RBAC, troubleshooting...
│   ├── docker/           # images, networking, volumes, multi-stage builds
│   ├── kind/             # local cluster setup and workflows
│   └── observability/    # metrics, PromQL, Grafana, alerting, logs, tracing
│
├── k8s/                  # manifests: namespaces, deployments, services, ingress, storage...
├── docker/               # Dockerfile, docker-compose.yml
├── examples/             # sample apps (simple-app, api, worker)
└── scripts/              # cluster-create.sh, cluster-delete.sh, load-test.sh
```
