# URL Shortener — End-to-End DevOps Pipeline

A URL shortener with click analytics, built primarily as a vehicle to demonstrate a complete, production-style DevOps pipeline: **Infrastructure as Code, configuration management, container orchestration, GitOps, and observability — all wired together and working end to end.**

The app itself is intentionally simple. The infrastructure is the point.

---

## What this project demonstrates

- **Terraform** — provisions all AWS infrastructure (EC2 instances, security groups, networking, EBS storage) as code
- **Ansible** — bootstraps a **self-managed Kubernetes cluster** from bare EC2 instances using `kubeadm` (not EKS — chosen deliberately so Ansible has real, meaningful work to do)
- **Docker** — containerizes the application
- **Kubernetes** — orchestrates the app (Deployment, Service, persistent storage for the database) across a 3-node cluster
- **GitHub Actions** — automated CI: every push to `main` builds a new image, pushes it to Docker Hub, and commits the new image tag back to the repo
- **Argo CD** — GitOps continuous delivery: watches the repo and syncs the cluster to match it automatically, with self-healing and auto-pruning
- **Prometheus + Grafana** — cluster and node-level observability, deployed via the `kube-prometheus-stack` Helm chart

---

## Architecture

![Architecture diagram](./architecture-diagram.png)

**Deployment flow:**
1. Developer pushes code to GitHub
2. GitHub Actions builds a Docker image, tags it with the commit SHA, and pushes it to Docker Hub
3. GitHub Actions edits the image tag inside `gitops/app-deployment.yml` and commits that change back to the repo — **the pipeline never touches the cluster directly, and holds no cluster credentials**
4. Argo CD continuously watches the `/gitops` folder and automatically syncs any change to the live cluster

**Request flow (once deployed):** an external request hits any node's public IP on the NodePort (`:30080`) → routed by `kube-proxy` to one of two app pod replicas → app pod queries Postgres via its internal Kubernetes Service DNS name (`postgres-service`) → response returned.

**Cluster layout (3× AWS EC2, `t3.small`, self-managed via `kubeadm`):**

| Node | Role |
|---|---|
| Control Plane | Kubernetes control plane only (etcd, API server, scheduler, controller-manager) |
| Worker 1 (App) | App pods + Postgres |
| Worker 2 (Platform) | Argo CD, Prometheus, Grafana |

Workloads are pinned to specific nodes via `nodeSelector` so application traffic and platform tooling never compete for resources on the same node.

---

## Application features

- `POST /shorten` — creates a short link from a long URL, with input validation (rejects malformed URLs), optional custom alias
- `GET /:shortCode` — redirects to the original URL; **responds immediately** and logs the click **asynchronously** (fire-and-forget) so analytics logging never adds latency to the redirect
- `GET /stats/:shortCode` — returns total clicks, the 10 most recent clicks (with user-agent/referrer), and a 7-day clicks-per-day time series
- `GET /health` — liveness/readiness endpoint, used by Kubernetes to detect and recover from unhealthy pods automatically

Click data is stored as **individual rows** (timestamp, user-agent, referrer) rather than a simple counter, specifically so the analytics endpoint can produce a real time series, not just a total.

---

## Infrastructure details

| Layer | Choice | Why |
|---|---|---|
| Cloud | AWS (`ap-south-1`) | — |
| IAM | Dedicated `terraform-deployer` user, scoped to EC2 | Not using root credentials for infra changes |
| Compute | 3× EC2 `t3.small` (1 control plane, 2 workers) | `t3.micro`'s 1GB RAM is below kubeadm's 1.7GB minimum; a third node was added to isolate platform tooling (Argo CD/monitoring) from the app node |
| Container runtime | containerd | What Kubernetes actually runs under the hood (Docker is used for local image builds only) |
| Kubernetes | Self-managed via `kubeadm`, not EKS | A managed control plane would make Ansible and much of Terraform redundant — self-managing gives every tool in the stack a genuine job |
| CNI (pod networking) | Calico | Standard, well-documented choice for kubeadm clusters |
| Storage | `local-path-provisioner` + PersistentVolumeClaim | Bare kubeadm clusters have no default StorageClass; this provisions local-disk-backed persistent volumes for Postgres. Explicitly set as the cluster's default StorageClass and tracked in git so it survives a full cluster rebuild |
| Image registry | Docker Hub | Simple, free, sufficient for a project this size |
| Exposure | Kubernetes `NodePort` (app `:30080`, Argo CD `:31320`, Grafana `:30090`) | No cloud load balancer to keep cost at zero; a straightforward next step if this were extended |

---

## CI/CD Pipeline

On every push to `main`:

1. **Build job** — checks out code, builds the Docker image, tags it with the Git commit SHA (not `latest` — every deploy is traceable to an exact commit), and pushes to Docker Hub
2. **Deploy job** — edits the image tag inside `gitops/app-deployment.yml` and pushes that change to the repo as an automated commit (`github-actions[bot]`)

Argo CD then detects the change and rolls it out to the cluster on its own. **This pipeline holds no cluster credentials and never runs `kubectl` against the live cluster** — a deliberate change from an earlier version of this project, which used `kubectl set image` directly. Moving to a git-mediated deploy step removed the need for a `KUBE_CONFIG` secret entirely and reduced the pipeline's attack surface.

---

## GitOps with Argo CD

- Argo CD watches the `/gitops` folder on `main` and continuously reconciles the live cluster to match it (`prune: true`, `selfHeal: true`)
- The Argo CD `Application` resource itself lives in a separate `/argocd` folder rather than inside `/gitops` — an early mistake put it inside `/gitops`, which caused Argo CD to misinterpret the whole folder as an "app-of-apps" and only ever sync itself
- **Self-healing is proven, not just configured**: manually deleting a live resource (a Service) resulted in Argo CD recreating it automatically within its reconciliation window, with no manual intervention
- **Disaster-recovery proven, not theoretical**: after a resource-exhaustion incident corrupted the control plane's cluster state (see below), the entire control plane was rebuilt from scratch with `kubeadm reset`/`kubeadm init`. Reapplying a single Argo CD `Application` manifest was enough to fully reconstruct the running application — namespace, Deployments, Services, PVC — directly from git, with zero manual redeployment of the app itself

---

## Observability

- **Prometheus** scrapes cluster and node-level metrics (CPU, memory, filesystem, pod health) via `node-exporter` (running on every node) and `kube-state-metrics`
- **Grafana** is connected to Prometheus as a live data source, queryable directly via Grafana's Explore view and dashboards
- Both are deployed via the `kube-prometheus-stack` Helm chart, with resource requests/limits explicitly reduced from the chart's defaults, a shortened metrics retention window (1 day), and Alertmanager disabled — all to fit a resource-constrained, free-tier-sized cluster rather than the large clusters the chart assumes by default

---

## Notable engineering problems solved along the way

**Cross-node pod networking failure (Calico / security groups).** After deploying the app, pods scheduled on the worker node were completely unreachable from the control plane — `curl` to both the NodePort and the ClusterIP hung indefinitely, despite `kubectl get pods`, `kube-proxy` logs, and `calico-node` status all looking healthy. Root cause: the security group's inter-node rule only allowed TCP, but Calico's default encapsulation (IP-in-IP) uses a different IP protocol (protocol 4) entirely — invisible to a rule scoped to TCP only. Fixed by opening all protocols (`protocol = "-1"`) between cluster nodes.

**TLS certificate scope mismatch for remote CI/CD access.** `kubeadm init` generates the API server's certificate valid only for addresses known at bootstrap time (the private IP and internal cluster IP) — GitHub Actions, running on GitHub's infrastructure, needed to reach the cluster over its **public** IP, which wasn't a valid certificate SAN. Fixed by regenerating the API server certificate with `kubeadm init phase certs apiserver --apiserver-cert-extra-sans=<public-ip>` and restarting kubelet to pick up the new cert. (This class of problem was later eliminated entirely for deploys by moving CI/CD to a GitOps model — the pipeline no longer talks to the API server at all.)

**RAM undersizing for kubeadm.** Initial `t3.micro` nodes (1GB RAM) failed `kubeadm init`'s preflight check (1.7GB minimum). Resized to `t3.small` via Terraform — confirmed as a safe in-place update (not a destroy/recreate), preserving all existing Ansible-installed configuration on disk.

**Local storage tied to node identity.** `local-path-provisioner` binds a PersistentVolume's data to whatever node it was first created on — not to a `nodeSelector`. After pinning the Postgres pod to a specific worker via `nodeSelector`, its existing PVC (created before the pin, on a different node) conflicted with the new placement and left the pod permanently `Pending`. Fixed by deleting and recreating the PVC so it was provisioned fresh on the correct node.

**Resource exhaustion cascade on the control plane.** Running a full control plane (etcd, API server, scheduler, controller-manager) on a single `t3.small` eventually triggered a cascading failure: the OOM killer began repeatedly killing `kube-controller-manager`, the node's root disk filled from accumulated container images, and the `t3` instance's CPU burst credits were exhausted under the resulting thrashing — compounding into a control plane that was completely unresponsive. Diagnosed and resolved in stages: resized EBS volumes live via `aws ec2 modify-volume` plus in-place partition/filesystem growth (no downtime), switched the instances to `CpuCredits=unlimited`, and — once cluster state was confirmed unrecoverable — performed a full `kubeadm reset`/`kubeadm init` rebuild of the control plane and rejoined both workers. The application itself was restored with a single Argo CD manifest re-apply, directly proving the GitOps recovery model works under real failure conditions, not just in theory.

**Kubelet's swap incompatibility.** Adding swap space as a memory-pressure mitigation caused kubelet to refuse to start entirely (`running with swap on is not supported`) on the next restart — a hard requirement in this Kubernetes version, not a configurable warning. The fix was to remove swap rather than fight it, and rely on right-sized EBS/CPU credit settings instead.

---

## Repository structure

```
.
├── .github/workflows/deploy.yml   # CI pipeline: build+push image, update gitops/ tag
├── terraform/                     # Infrastructure as Code (EC2, security groups, EBS sizing)
├── ansible/                       # Cluster bootstrap playbooks (kubeadm, Calico, join)
├── k8s-manifests/                 # Original manifests (historical/reference)
├── gitops/                        # Source of truth Argo CD watches and syncs
├── argocd/                        # Argo CD Application resource (kept out of /gitops
│                                     to avoid app-of-apps misdetection)
├── Dockerfile
├── index.js / db.js / schema.sql  # Application code
└── package.json
```

---

## Running this yourself

> Requires: AWS account, Terraform, Ansible (control node), `kubectl`, Helm, Docker Hub account.

1. **Provision infrastructure**
   ```bash
   cd terraform
   cp terraform.tfvars.example terraform.tfvars   # fill in your AMI ID, key pair name, IP
   terraform init
   terraform apply
   ```
2. **Bootstrap the cluster** — SSH into the control-plane node, install Ansible, then from `ansible/`:
   ```bash
   ansible-playbook -i inventory.ini common.yml
   ansible-playbook -i inventory.ini init-control-plane.yml
   ansible-playbook -i inventory.ini install-calico.yml
   ansible-playbook -i inventory.ini join-worker.yml
   ```
3. **Install Argo CD**
   ```bash
   kubectl create namespace argocd
   kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml
   kubectl apply -f argocd/argocd-application.yml
   ```
   Argo CD will then deploy the application itself from `/gitops` — no manual `kubectl apply` of the app's manifests is needed.
4. **Install observability**
   ```bash
   helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
   helm install monitoring prometheus-community/kube-prometheus-stack \
     --namespace monitoring --create-namespace \
     -f prometheus-values.yaml
   ```
5. **Set up CI** — add `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` as GitHub repository secrets, and grant the workflow `contents: write` permission. From then on, every push to `main` builds, pushes, and — via Argo CD — deploys automatically.

---

## Known trade-offs (honest, on purpose)

This is a learning/portfolio project, and a few choices reflect that rather than production best practice:

- SSH and the Kubernetes API port are open to `0.0.0.0/0` rather than a restricted CIDR, due to a highly dynamic home ISP IP — in production this would use a static IP allowlist or AWS Systems Manager Session Manager instead of open SSH
- Database credentials are stored as a Kubernetes Secret with a plain-text value in a public repo — fine for a disposable local-dev password, not a pattern to replicate for real credentials (a real setup would use a secrets manager or Sealed Secrets)
- The app is exposed via NodePort rather than an Ingress controller or cloud load balancer, to keep AWS costs at zero
- No automated test suite runs in CI before deploy — for a project this size that was a deliberate scope cut, not an oversight
- Grafana runs without persistent storage — dashboards do not survive a pod restart
- The cluster deliberately runs on `t3.small` instances rather than larger types to stay within AWS free-tier limits; the resource-exhaustion incident documented above is a direct, honest consequence of that choice, not something papered over

---

## Stack summary

`Node.js` `Express` `PostgreSQL` `Docker` `Terraform` `Ansible` `Kubernetes (kubeadm)` `Calico` `Argo CD` `Prometheus` `Grafana` `GitHub Actions` `AWS EC2` `Docker Hub`
