# Deployment pipeline

```mermaid
flowchart TD
    A[git push to main] --> B{Touches only<br/>k8s/**, docs/**, **.md?}
    B -- yes --> Z[docker-publish workflow<br/>does not run]
    B -- no --> T[e2e.yml + docker-publish.yml's<br/>test job: npm test]
    T -- fail --> X[build never runs]
    T -- pass --> C[docker-publish.yml:<br/>build image]
    C --> D["push ghcr.io/koydas/homelab-gateway:&lt;sha&gt;"]
    D --> E[workflow commits new tag<br/>into k8s/deployment.yaml]
    E --> F[push commit to main]
    F --> G[ArgoCD polls / gets refreshed]
    G --> H[Applies k8s/ manifests]
    H --> I[New pod pulls the new tag<br/>old pod terminates]
```

Same shape as `ollama-chat`'s pipeline (see that repo's `docs/deployment.md` for the general
mechanics — `paths-ignore`, why the tag-rewrite commit doesn't re-trigger itself). One gotcha
specific to this repo's operating history: ArgoCD's poll-sync can grab the *code-push* commit
before the *tag-rewrite* commit lands, briefly running new config against an old image — see
`gitops-homelab`'s runbook.md for the incident writeup and the hard-refresh fix. `npm test`
(the real e2e suite, `test/gateway.e2e.test.js`) now gates the build entirely — see the
README's Tests section and [ADR-0001](./adr/0001-mongodb-call-log.md) for what it covers and
why it exists.
