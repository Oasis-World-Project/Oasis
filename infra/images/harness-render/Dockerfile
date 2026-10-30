# GPU-capable Blender Python distribution; the target GPU/driver remains a live probe.
FROM python:3.11.14-slim-bookworm@sha256:65a93d69fa75478d554f4ad27c85c1e69fa184956261b4301ebaf6dbb0a3543d AS compiler
RUN apt-get -o Acquire::Retries=3 update && apt-get -o Acquire::Retries=3 install -y --no-install-recommends gcc libc6-dev linux-libc-dev \
 && rm -rf /var/lib/apt/lists/*
COPY services/harness/render/isolate.c /src/isolate.c
RUN gcc -O2 -Wall -Wextra -Werror /src/isolate.c -o /isolate

FROM python:3.11.14-slim-bookworm@sha256:65a93d69fa75478d554f4ad27c85c1e69fa184956261b4301ebaf6dbb0a3543d
RUN apt-get -o Acquire::Retries=3 update && apt-get -o Acquire::Retries=3 install -y --no-install-recommends libx11-6 libxi6 libxrender1 libxxf86vm1 libxfixes3 libxkbcommon0 libsm6 libgl1 libegl1 libgomp1 \
 && rm -rf /var/lib/apt/lists/*
COPY services/harness/render/requirements.txt /opt/oasis/requirements.txt
RUN python -m pip install --no-cache-dir --require-hashes -r /opt/oasis/requirements.txt \
 && python -m pip check
COPY --from=compiler /isolate /opt/oasis/isolate
COPY services/harness/sandbox/geometry.py /opt/oasis/geometry.py
COPY services/harness/render/worker.py services/harness/render/render_child.py /opt/oasis/
RUN mkdir /jobs && chown 10001:10001 /jobs
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 NVIDIA_VISIBLE_DEVICES=all NVIDIA_DRIVER_CAPABILITIES=compute,utility LD_LIBRARY_PATH=/usr/local/nvidia/lib:/usr/local/nvidia/lib64
USER 10001:10001
WORKDIR /opt/oasis
CMD ["python", "-u", "/opt/oasis/worker.py"]
