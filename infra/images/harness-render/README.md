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

`ghcr.io/kong-yikai/oasis/harness-render:0.1.4-blender4.5.3`

Real 0.1.3 diagnostics found one GPU outside isolation but CUDA init error 304
inside. The 0.1.4 source permits read/write of file entries beneath this PID's
`/proc/self/task` for CUDA thread naming. A real pthread naming regression fails
on 0.1.3 and passes on 0.1.4; parent-process access and existing boundaries stay
denied. After an initial unconfirmed submission, an explicitly approved replacement
returned a job ID but still failed with `cuda_before=devices_1; cuda_after=init_304`.
The thread-naming change is insufficient; the remaining denied OS operation needs
trusted syscall tracing. It is not GPU-render validated. All acceptance endpoints
have been deleted; keep the profile disabled. See ADR 0011 §19–20 and the receipts.

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
and confirms a GPU request cannot silently fall back to CPU. A second container
mounts the existing test at the fixed child entrypoint and a temporary driver
directory to test dynamic loading with a real DSO, hostile parent environment,
future-thread naming and denial of parent-thread access;
neither fixture enters the image. This is **not GPU
or Runpod acceptance**. The explicit internal CPU test is not a queue operation.

## Runpod handoff — acceptance endpoint deleted after failure

Acceptance endpoint `1xa57icezdlbgp` and read-only registry credential
`cmvuezprv008mfz3aag8hcy00` were created on 2026-10-30. Private image pull worked;
isolated GPU enumeration did not. The endpoint was deleted and its absence verified;
the registry credential remains. Keep the profile disabled. Runtime later reported
initializing=1 despite max=0 and an empty control-plane list, so shutdown and final
supplier bills must still be audited; a 404 alone does not prove billing has ended.

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
on this worker. The gateway signs individual transfer objects. Private R2
resources and lifecycle policies still require verification.

The image uses UID/GID 10001. The fixed child launcher requires Linux amd64 and
Landlock ABI >=3. It grants read access to runtime libraries/code and GPU device
access, writes to the current job and this PID's thread metadata subtree, denies all new sockets with seccomp,
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
by this worker. The gateway integration below handles ownership and recovery;
supplier billing/worker evidence still needs a trusted operations source.
Oasis users preview authorized results and explicitly download; this worker does
not create a folder or download files on an end user's computer.

## Gateway integration (disabled until target verification)

`oasis-tool 3d.render --scene <scene.json> --out <sandbox-output-dir>` reads the
scene and its relative GLBs in the sandbox, hashes bounded inputs, and uses the
existing run key and tool-job protocol. Optional `--width`, `--height`, `--samples`
and `--backend` are bounded by the contract above. No cloud credentials enter
the sandbox. These paths refer to the task workspace, not an end user's folder.

The run protocol prepares with `POST /run/v1/tools/3d.render`, uploads each
manifest entry with `PUT /run/v1/tools/jobs/:id/inputs/:index` (octet-stream), then
submits with `POST /run/v1/tools/jobs/:id/submit`. Missing/bad inputs cannot reach
the queue. Repeating submit uses the same persistent job and does not resend a
provider POST. A disconnected POST is uncertain, even when no provider id was
received; it must be audited rather than retried as a new generation.

The existing scanner renews unsettled render holds, then archives and verifies
both outputs against the worker receipt digests. Billing is metered per job
(ADR 0011 §21): the user is charged
`(ceil(executionTime s) + min(ceil(delayTime s), RENDER_STARTUP_ALLOWANCE_SECONDS) + RENDER_IDLE_SECONDS) × RENDER_PRICE_MICRO_PER_SECOND`,
capped at the frozen `RENDER_HOLD_MICRO`, and the result is delivered as soon as
that settlement and staging cleanup succeed. A `FAILED`, `CANCELLED` or
`TIMED_OUT` GPU job releases the hold; the GPU time is platform cost. The hourly
Runpod bill is checked by operations only; any difference is platform risk and
is never charged to the user afterwards. A dedicated profile admits one job at a
time, including uncertain jobs. Run cancellation is durably fenced before new
tool admission; cancelling an uploaded-only job cleans up and releases its
unused hold. Provider cancellation is an intent, not proof that billing stopped.

Two cases need a manual close: a disconnected submit (`uncertain`, which also
holds the single GPU admission slot) and a completed receipt without
`executionTime` (`awaiting_cost`). Trusted operations close them with
`POST /internal/v1/tools/jobs/:id/reconcile`, supplying the original ownership
headers and `{costMicro, billId, stopped:true}`. `billId` must identify a unique
bill line/window across jobs. The response acknowledges acceptance; poll the
existing job endpoint for the final state. This route is deliberately
unavailable under `/run` or the public gateway. The caller must verify at
Runpod that the job is absent or stopped and what it cost; the API does not
independently prove that assertion. User charges cannot exceed the saved
approved hold ceiling; the excess is recorded as platform risk.

Service configuration is documented in `services/model-gateway/.env.example`.
`pnpm env:init` adds missing local fields from the existing root keys without
replacing filled values. Keep `RENDER_PROFILE_VERIFIED=false` until private-image
pull, fixed resource/price profile, real isolated GPU and signed R2 exchange
pass (done on 2026-10-30 for endpoint `oasis-render`, see ADR 0011 §21).
`RENDER_PRICE_MICRO_PER_SECOND` is the locked per-second price of the GPU pool;
recheck it when the pool or Runpod pricing changes. Signed-URL and fake-provider
tests do not prove R2 reachability or real GPU execution.
