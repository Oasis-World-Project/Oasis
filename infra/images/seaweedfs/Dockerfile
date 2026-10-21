# oasis/seaweedfs：官方镜像 + 用环境变量生成 S3 凭据的启动脚本
FROM chrislusf/seaweedfs:4.47
COPY --chmod=755 start.sh /usr/local/bin/oasis-seaweedfs-start
ENTRYPOINT ["/usr/local/bin/oasis-seaweedfs-start"]
