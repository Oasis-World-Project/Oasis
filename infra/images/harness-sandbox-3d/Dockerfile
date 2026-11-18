# Default task sandbox: base + CPU Blender for authoring/checks. GPU renders go through oasis-tool 3d.render.
# 3D 工具：oasis-3d snapshot/check、Blender 里可 import 的 oasis_blender、gltf-transform（含 Khronos glTF Validator）、trimesh。
ARG BASE_IMAGE=oasis/harness-sandbox-base:0.2.1-rc.5
FROM ${BASE_IMAGE}
ARG GLTF_TRANSFORM_VERSION=4.5.1
ARG NPM_RETRIES=3
USER root
# 软件源是基础镜像里定好的 Debian 快照（DEBIAN_SNAPSHOT）。Blender 的版本写在镜像标签里，所以这里仍写明版本：
# 快照日期往前挪以后它变了，构建会停在这里，提醒同时改标签
# APT_MIRROR 和基础镜像里的是一回事：只加快下载，装完就删
ARG APT_MIRROR=
RUN if [ -n "$APT_MIRROR" ]; then \
      keyring="$(sed -n 's/^Signed-By: //p' /etc/apt/sources.list.d/debian.sources | head -n 1)"; \
      printf 'Types: deb\nURIs: %s/debian\nSuites: trixie trixie-updates\nComponents: main\nSigned-By: %s\n\nTypes: deb\nURIs: %s/debian-security\nSuites: trixie-security\nComponents: main\nSigned-By: %s\n' \
        "$APT_MIRROR" "$keyring" "$APT_MIRROR" "$keyring" > /etc/apt/sources.list.d/00-oasis-mirror.sources; \
    fi \
 && apt-get -o Acquire::Retries=3 update \
 && apt-get install -y --no-install-recommends blender=4.3.2+dfsg-2 \
 && rm -rf /var/lib/apt/lists/* /etc/apt/sources.list.d/00-oasis-mirror.sources \
 && printf '\n3D software (CPU authoring; cloud GPU via oasis-tool 3d.render):\n' >> /opt/oasis/software.txt \
 && dpkg-query -W -f='${Package} ${Version}\n' blender >> /opt/oasis/software.txt
COPY services/harness/sandbox/requirements-3d.txt /opt/oasis/requirements-3d.txt
RUN --mount=type=secret,id=pip_index \
    if [ -f /run/secrets/pip_index ]; then export PIP_INDEX_URL="$(cat /run/secrets/pip_index)"; fi \
 && /opt/oasis/venv/bin/python -m pip install --no-cache-dir --only-binary=:all: -r /opt/oasis/requirements-3d.txt \
 && /opt/oasis/venv/bin/python -m pip check \
 && chown -R node:node /opt/oasis/venv
RUN --mount=type=secret,id=npm_registry \
    if [ -f /run/secrets/npm_registry ]; then export npm_config_registry="$(cat /run/secrets/npm_registry)"; fi \
 && attempt=0 \
 && until npm install --global --fetch-retries=0 --fetch-timeout=60000 "@gltf-transform/cli@${GLTF_TRANSFORM_VERSION}"; do \
      attempt=$((attempt + 1)); \
      if [ "$attempt" -ge "$NPM_RETRIES" ]; then exit 1; fi; \
    done \
 && npm cache clean --force \
 && gltf-transform --version
COPY services/harness/sandbox/geometry.py /opt/oasis/geometry.py
COPY services/harness/sandbox/oasis_blender.py /opt/oasis/oasis_blender.py
# oasis_blender 放进 Blender 自带的 modules 目录，脚本里直接 import
RUN modules="$(blender --background --factory-startup --python-expr "import bpy,sys; sys.stdout.write('@@' + bpy.utils.system_resource('SCRIPTS', path='modules') + '@@')" 2>/dev/null | sed -n 's/.*@@\(.*\)@@.*/\1/p')" \
 && test -n "$modules" \
 && mkdir -p "$modules" \
 && ln -s /opt/oasis/oasis_blender.py "$modules/oasis_blender.py" \
 && printf '#!/bin/sh\nexec python3 /opt/oasis/geometry.py "$@"\n' > /usr/local/bin/oasis-3d \
 && chmod 755 /usr/local/bin/oasis-3d \
 && printf '\noasis-3d snapshot <model> --out <dir> [--views front3q,side,front,back3q,top] [--size 960x720]: auto-framed views + sheet.png (Cycles CPU, ground and three-point light added for viewing only)\noasis-3d check <model>: size, ground contact, triangles, materials, welded topology counts, canvas preview problems, glTF validator (gltf-transform validate)\nIn Blender scripts: import oasis_blender as ob -> ob.material(name, "#RRGGBB", roughness, metallic), ob.export_glb(path) returns canvas preview problems ([] = previews directly), ob.render_views(folder), ob.survey(); see /opt/oasis/oasis_blender.py\noasis-3d build scene.json --out <new-project-dir>; inspect <project-dir>; pack <project-dir> --out <new.zip>; preview <model.glb> (decimated canvas preview + oasis-model-preview.json, only when over limits)\nScene protocol: version=1, units=m, objects (box/sphere/cylinder/embedded GLB asset), camera, lights. See /opt/oasis/geometry.py for validated fields. Blender here is CPU-only; GPU rendering is also available through: oasis-tool 3d.render --scene <scene.json>.\nAlso installed: gltf-transform %s (inspect/validate/optimize GLB), python trimesh.\n' "${GLTF_TRANSFORM_VERSION}" >> /opt/oasis/software.txt
USER node
WORKDIR /workspace
