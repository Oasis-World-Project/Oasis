# Oasis cloud render worker

Runpod Queue Serverless candidate. Blender Foundation `bpy==4.5.3`, Python 3.11,
Runpod SDK 1.10.1; all 105 Python distributions are version and SHA-256 locked.
This is a separate image from the CPU authoring sandbox. It has no dsh, model
credentials, business-service credentials, user files, or long-lived S3 keys.

## Build and local verification

From the Oasis repository, with Docker Desktop running:

```powershell
pnpm render:build
pnpm render:check
pnpm render:tag
```

The last command adds this **local** tag, without uploading:

`ghcr.io/kong-yikai/oasis/harness-render:0.1.0-blender4.5.3`

The release allowlist is `infra/render-release.json`. Build, source and test
receipts are in `out/render-worker-20261028/`; `release-plan.json` records the
allowed immutable digest. A source/image change invalidates the local receipt.
Do not use the CPU sandbox digest or Docker configuration ID as a registry
manifest digest. Publication is a later, explicit operation: recheck repository,
digest and private visibility, use the push PAT only through credential stdin,
then read back the remote digest and verify the separate read-only pull PAT.
No generic push command bypassing those checks is provided.

`render:check` uses no network, 2 CPUs, 4 GiB, 256 PIDs, no Linux capabilities and
no-new-privileges. It actually renders a CPU reference PNG, checks the editable
Blender/embedded GLB ZIP, exercises the kernel boundary, rejects invalid requests,
and confirms a GPU request cannot silently fall back to CPU. This is **not GPU
or Runpod acceptance**. The explicit internal CPU test is not a queue operation.

## Proposed Runpod handoff — not deployed

Use a private registry credential with only `read:packages`. Use the immutable
GHCR digest from the release receipt, after successful publication/read-back.
Queue endpoint: zero active/minimum workers, maximum one worker, one GPU and
one job at a time. Candidate RTX 4090 24 GiB; CUDA host floor 12.8; container disk
10 GiB; execution 600 s, queue 900 s, TTL 1800 s, idle 5 s. These are proposed
bounds, not guarantees about cost or compatibility. No ports, persistent volume,
warm worker, model download, or runtime software installation is required.

Runtime configuration, outside the image:

- `RENDER_STAGING_HOST`: the exact `<account-id>.r2.cloudflarestorage.com` host.
- `RENDER_STAGING_BUCKET`: the dedicated private exchange bucket name.
- Runpod's own queue credentials: injected by Runpod, never passed to Blender.

Do not set the project's R2 access/secret keys, GHCR push PAT or model API keys
on this worker. The future gateway signs individual transfer objects. Private R2
resources and lifecycle policies still require verification.

The image uses UID/GID 10001. The fixed child launcher requires Linux amd64 and
Landlock ABI >=3. It grants read access to runtime libraries/code and GPU device
access, write access only to the current job, denies all new sockets with seccomp,
closes inherited descriptors, strips the environment and sets resource limits.
No privileged container, SYS_ADMIN, host networking or Docker socket is needed.
If the target kernel/driver does not support this boundary, the job fails and
the capability stays unavailable. A real target probe must prove isolated GPU
enumeration/render, output retrieval, worker shutdown and billing before use.

## Job contract v1

Only `render` and `probe` are supported. No Python, shell, URL-fetch instruction,
plugin, archive upload or arbitrary `.blend` is accepted. `render` consumes the
existing bounded Oasis scene JSON v1 (see `services/harness/sandbox/geometry.py`),
including optional authorized embedded GLBs. `probe` renders a fixed test scene.

```json
{
  "input": {
    "version": 1,
    "operation": "probe",
    "transferId": "<random-32-lowercase-hex>",
    "render": {"width": 128, "height": 128, "samples": 8, "backend": "CUDA"},
    "assets": [],
    "outputs": {
      "image": "<presigned-PUT-for-image.png>",
      "project": "<presigned-PUT-for-project.zip>"
    }
  }
}
```

All object paths must start with `<bucket>/jobs/<transferId>/`, signatures expire
within 3600 s, and redirects/proxies are disabled. For `render`, add `scene` and
asset transfers in matching order: `{id,url,size,sha256}`; source scene assets
carry the same id/hash plus origin. The worker assigns local asset paths, checks
sizes/hashes, and validates the scene before invoking Blender. Limits: 20 assets,
100 MiB per asset, 200 MiB aggregate/output, 2048 pixels per side, 128 samples.
Only CUDA/OPTIX; GPU absence is an error. No implicit CPU production fallback.

Output: artifact byte sizes/SHA-256, Blender/device/render metadata and boundary
report. PNG and ZIP go to the signed PUT objects; URLs are not returned/logged.
The caller must HEAD/read/hash, archive to existing private artifact storage, then
remove staging objects. A cancelled or partial upload is not a completed result.
Provider bills, final archive ownership and visual requirements remain unchecked
by this worker. These gateway recovery/billing integrations are still pending.
Oasis users preview authorized results and explicitly download; this worker does
not create a folder or download files on an end user's computer.
