# Default task sandbox: base + CPU Blender for authoring/checks. GPU renders go through oasis-tool 3d.render.
ARG BASE_IMAGE=oasis/harness-sandbox-base:0.2.1-rc.2
FROM ${BASE_IMAGE}
USER root
RUN apt-get -o Acquire::Retries=3 update \
 && apt-get install -y --no-install-recommends blender=4.3.2+dfsg-2 \
 && rm -rf /var/lib/apt/lists/* \
 && printf '\n3D software (CPU authoring; cloud GPU via oasis-tool 3d.render):\n' >> /opt/oasis/software.txt \
 && dpkg-query -W -f='${Package} ${Version}\n' blender >> /opt/oasis/software.txt
COPY services/harness/sandbox/geometry.py /opt/oasis/geometry.py
COPY services/harness/sandbox/blender_draft_limit.py /usr/share/blender/scripts/startup/oasis_draft_limit.py
RUN printf '#!/bin/sh\nexec python3 /opt/oasis/geometry.py "$@"\n' > /usr/local/bin/oasis-3d \
 && chmod 755 /usr/local/bin/oasis-3d \
 && printf '\noasis-3d build scene.json --out <new-project-dir>; inspect <project-dir>; pack <project-dir> --out <new.zip>; preview <model.glb> (decimated canvas preview + oasis-model-preview.json, only when over limits)\nScene protocol: version=1, units=m, objects (box/sphere/cylinder/embedded GLB asset), camera, lights. See /opt/oasis/geometry.py for validated fields. Blender here is CPU-only (drafts/checks; still renders capped at 640x480 and 32 samples); final GPU renders: oasis-tool 3d.render --scene <scene.json>.\n' >> /opt/oasis/software.txt
USER node
WORKDIR /workspace
