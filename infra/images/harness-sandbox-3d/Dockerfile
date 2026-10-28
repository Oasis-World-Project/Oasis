# CPU authoring/check environment only; cloud GPU worker is a separate, later deployment.
ARG BASE_IMAGE=oasis/harness-sandbox-base:0.2.1-rc.2
FROM ${BASE_IMAGE}
USER root
RUN apt-get -o Acquire::Retries=3 update \
 && apt-get install -y --no-install-recommends blender=4.3.2+dfsg-2 \
 && rm -rf /var/lib/apt/lists/* \
 && printf '\n3D software (CPU authoring, not cloud GPU):\n' >> /opt/oasis/software.txt \
 && dpkg-query -W -f='${Package} ${Version}\n' blender >> /opt/oasis/software.txt
COPY services/harness/sandbox/geometry.py /opt/oasis/geometry.py
RUN printf '#!/bin/sh\nexec python3 /opt/oasis/geometry.py "$@"\n' > /usr/local/bin/oasis-3d \
 && chmod 755 /usr/local/bin/oasis-3d \
 && printf '\noasis-3d build scene.json --out <new-project-dir>; inspect <project-dir>; pack <project-dir> --out <new.zip>\nScene protocol: version=1, units=m, objects (box/sphere/cylinder/embedded GLB asset), camera, lights. See /opt/oasis/geometry.py for validated fields. CPU authoring only; no cloud rendering.\n' >> /opt/oasis/software.txt
USER node
WORKDIR /workspace
