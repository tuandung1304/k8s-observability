# Roadmap

End goal: a complete cluster running several services on top of a database seeded with a large dataset. Load tests simulate meaningful traffic. Logs and metrics feed Grafana dashboards, and alerts go to Slack/Telegram. Failures are injected on purpose to prove the whole observability stack works.

Each phase pairs an observability topic with the Kubernetes concepts it requires.

## ✅ 1. Cluster and workload foundations

- [x] Local cluster with Kind
- [x] Containerize the `core` service (NestJS) with Docker
- [x] Pod with health probes
- [x] Deployment: rolling updates, graceful shutdown
- [x] Service (ClusterIP)
- [x] ConfigMap and Secret

## ✅ 2. Organization and access control

- [x] Namespaces: separate `apps` and `observability`
- [x] ResourceQuota and LimitRange
- [x] ServiceAccount and RBAC (least privilege)

## ✅ 3. Metrics collection

- [x] Prometheus and Node Exporter (DaemonSet)
- [x] Instrument `core`: default metrics and HTTP histogram
- [x] Kubernetes service discovery and relabeling

## 4. Querying and visualization

- [ ] PromQL: rate, aggregation, histogram quantiles
- [ ] Grafana: provisioned datasources and dashboards, RED dashboard

## 5. Storage and database

- [ ] PersistentVolume, PVC, and StorageClass for Prometheus and Grafana
- [ ] Database as a StatefulSet, seeded with a large dataset via a Job
- [ ] Database metrics (exporter)

## 6. Multiple services

- [ ] Add the `notification` service and service-to-service calls
- [ ] NetworkPolicy

## 7. Load testing and external traffic

- [ ] In-cluster load tests with Job/CronJob
- [ ] Ingress/Gateway, load tests from outside the cluster

## 8. Scaling and resilience

- [ ] Cluster-level metrics: cAdvisor, kube-state-metrics
- [ ] HPA, PodDisruptionBudget
- [ ] Scheduling: affinity, taints/tolerations

## 9. Logs

- [ ] Loki and a log collection agent (DaemonSet)
- [ ] Correlate logs with metrics in Grafana

## 10. Alerting and SLOs

- [ ] Recording rules and alerting rules
- [ ] Alertmanager routing to Slack/Telegram
- [ ] SLOs, error budgets, burn-rate alerts

## 11. Chaos and troubleshooting

- [ ] Inject failures on purpose: killed Pods, latency, 5xx, OOM, quota exhaustion
- [ ] Verify alerts fire, write runbooks

## 12. Extensions (optional)

- [ ] Tracing with OpenTelemetry and Tempo
- [ ] Packaging with Kustomize or Helm
