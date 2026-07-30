---
name: homelab-deploy
description: Deploy/verify workflow for homelab-gateway — pushing to main, the ArgoCD sync-before-CI-tag-rewrite race this repo has hit repeatedly, and confirming a rollout actually landed.
---

# homelab-deploy

## When to Apply

Any time you push a commit to `main` in this repo and expect the live gateway at
`http://gateway.home` to reflect it.

## Expected Behavior

### Pushing to main: expect a rejected push, it's not an error

`.github/workflows/docker-publish.yml` builds the image on every push to `main` that isn't
docs-only (`k8s/**`, `docs/**`, `**.md` are ignored) and **commits the new tag back into
`k8s/deployment.yaml` on `main`**. If that workflow's commit lands between your last
`git fetch` and your `git push`, the push is rejected with:

```
! [rejected]  main -> main (fetch first)
```

Resolve it the same way every time:

```bash
git fetch origin
git log --oneline main..origin/main   # sanity check: should only be a "chore: deploy <sha>" commit
git pull --rebase origin main
git push origin main
```

### Confirming the build (and test job) actually ran

```bash
gh run list --limit 1
```

`docker-publish.yml` has a `test` job (`npm test`) that `build-and-publish` depends on — wait
for `status: completed` / `conclusion: success` on the whole run before assuming an image
exists in GHCR. A separate `e2e.yml` workflow also runs the same suite on every push/PR (for
an accurate CI badge, see the READMEs) — don't confuse the two when checking status.

### The real gotcha: ArgoCD can sync the code-push commit before CI's tag-rewrite commit lands

Hit repeatedly while building this repo's call-log feature (2026-07-30, see
`docs/adr/0001-mongodb-call-log.md`): ArgoCD's automated poll-sync can grab your **code-push**
commit — which still has the *old* image tag in `k8s/deployment.yaml` at that point — before
`docker-publish.yml`'s follow-up `chore: deploy <sha>` commit (the one that actually rewrites
the tag) lands. The result: new config (env vars, manifests) briefly runs against the *old*
image, which doesn't contain the corresponding code yet.

**Don't trust the first "Synced" status after a push.** Confirm the pod's actual image tag
matches the latest commit on `origin/main` before declaring a deploy done:

```bash
git log origin/main -1 --oneline
sudo microk8s kubectl get pod -n homelab-gateway -l app=homelab-gateway -o jsonpath='{.spec.containers[0].image}'
```

If they don't match (pod still on the old tag after CI finished), force a hard refresh instead
of waiting for the next ~3 min poll:

```bash
sudo microk8s kubectl -n argocd annotate application homelab-gateway argocd.argoproj.io/refresh=hard --overwrite
```

### Confirming the pod actually rolled out

```bash
sudo microk8s kubectl get pods -n homelab-gateway -o wide
```

Expect exactly one `Running` pod on the new ReplicaSet (`homelab-gateway`) plus the
single-replica `homelab-gateway-mongo` pod, unaffected by app deploys. Check the new pod's
logs for `call-log: connected to ...` to confirm it reached Mongo:

```bash
sudo microk8s kubectl logs -n homelab-gateway -l app=homelab-gateway --tail=10
```

### Sanity-checking the deployed gateway

```bash
curl -s --resolve gateway.home:80:192.168.1.243 http://gateway.home/healthz
```

To inspect real traffic that just went through it (useful after any change touching routing
or the call-log):

```bash
sudo microk8s kubectl exec -n homelab-gateway deploy/homelab-gateway-mongo -- mongosh --quiet --eval '
db.getSiblingDB("homelab_gateway").call_log.find().sort({timestamp:-1}).limit(10)
'
```

## Constraints

- `kubectl` is not installed bare — always `sudo microk8s kubectl`.
- Don't force-push or reset to work around the rejected-push case — always rebase onto the CI
  commit; it's always safe to fast-forward through.
- Don't assume a push deployed just because `git push` succeeded — check the CI run, then the
  pod's actual image tag (not just ArgoCD's sync status), then the pod, in that order.
- `gateway.home` has no dedicated MetalLB IP — it's only reachable via `ingress-nginx` at
  `192.168.1.243`, hence `--resolve` in the health-check `curl` above instead of a direct IP.

## References

- `docs/adr/0001-mongodb-call-log.md` — full writeup of the ArgoCD-sync-race incident
- `docs/deployment.md` — the pipeline diagram
- `gitops-homelab`'s `docs/runbook.md` — this incident is also logged there as a general
  "git-source app" gotcha, not specific to this repo
- `.github/workflows/docker-publish.yml` and `.github/workflows/e2e.yml` — exact trigger/
  paths-ignore rules
