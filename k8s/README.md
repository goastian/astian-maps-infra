# k3s deployment baseline

`base/` contains the API deployment, zero-unavailable rolling updates and
liveness/readiness probes. Supply `astian-api-secrets` through SOPS/age or the
cluster's secret operator; never commit it.

The external secret must define `ASTIAN_PHOTON_URL` and
`ASTIAN_VALHALLA_URL`. The API refuses to start in `production` with demo
providers or with the in-memory sync flag enabled.

The foundation manifest deliberately stays at one replica because normalized
place details are still cached in-process and network sync is gated off. A
production overlay must replace that cache with Redis/PostgreSQL, enable OIDC
ownership and durable sync, pin the image by digest, then raise the API to two
or more replicas.

Photon, Valhalla, Martin, PostgreSQL and Redis require persistent volumes,
anti-affinity and topology appropriate to the selected provider. They are kept
out of this generic base deliberately: production overlays must pin dataset
versions, storage classes and resource sizing after the regional benchmarks in
`docs/07-roadmap-y-pruebas.md`.

Render the base without mutating the cluster:

```bash
kubectl kustomize infra/k8s/base
```
