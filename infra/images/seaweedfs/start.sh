#!/bin/sh
# 用环境变量生成 S3 凭据后启动单机 SeaweedFS（master + volume + filer + S3 网关）。
set -eu
: "${S3_ACCESS_KEY:?缺少 S3_ACCESS_KEY}" "${S3_SECRET_KEY:?缺少 S3_SECRET_KEY}"

cat > /tmp/s3.json <<JSON
{"identities":[{"name":"oasis","credentials":[{"accessKey":"${S3_ACCESS_KEY}","secretKey":"${S3_SECRET_KEY}"}],"actions":["Admin","Read","Write","List","Tagging"]}]}
JSON

exec weed server -dir=/data -ip.bind=0.0.0.0 -volume.max=0 -master.volumeSizeLimitMB=1024 \
  -s3 -s3.port=8333 -s3.config=/tmp/s3.json
