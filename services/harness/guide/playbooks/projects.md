# 接手现成的代码项目

> 适用：用户给了一个现成的项目（压缩包，或公开的 Git 仓库地址），要在它上面装依赖、跑起来、跑测试、改功能。

- **拿到项目**：压缩包在 materials/ 下，解到工作目录里的一个子目录；公开仓库直接 `git clone https://…`（GitHub、GitLab）。私有仓库没有凭据，克隆不了，照实告诉用户（可以让他打成压缩包发来）。
- **先看再动**：读 README、构建文件（package.json、pyproject.toml、go.mod、Cargo.toml、pom.xml、build.gradle、Gemfile、composer.json……）、CI 配置，弄清它用什么语言和版本、怎么装依赖、怎么跑测试；动手改之前先把现有的测试跑一遍，记下原来就没过的。
- **预装的**：Node 24、Python 3（venv 里可以再 `pip install`）、git、make、g++、curl、pkg-config、libssl-dev、libpq-dev、python3-dev；PostgreSQL、MariaDB、Valkey 的程序（不自动启动，见下）。没有 root，`apt` 用不了：缺系统库时换纯代码的替代包，或照实告诉用户。
- **别的工具链用时再装，装进 /cache**（装一次，这个用户以后的每个沙箱里都在；装之前先看 /cache/toolchains 里有没有）。命令连到 /cache/bin 就直接能用（它在 PATH 里）：
  - Go：`curl -fsSL https://go.dev/dl/go<版本>.linux-amd64.tar.gz | tar -xz -C /cache/toolchains && ln -sf /cache/toolchains/go/bin/* /cache/bin/`（先 `mkdir -p /cache/toolchains /cache/bin`；版本看项目的 go.mod 和 CI，最新版本号在 `https://go.dev/VERSION?m=text`；要装第二个版本就解到 /cache/toolchains/go<版本>，一个版本约 250 MB，按需要装）。
  - Rust：`curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --no-modify-path`（装进 /cache/cargo、/cache/rustup，`cargo` 直接能用）；这个地址连不上时，安装程序也在 `https://static.rust-lang.org/rustup/dist/x86_64-unknown-linux-gnu/rustup-init`。
  - JDK：从 `https://api.adoptium.net/v3/binary/latest/<大版本>/ga/linux/x64/jdk/hotspot/normal/eclipse` 下载解到 /cache/toolchains，`export JAVA_HOME=…`，把 `bin/*` 连到 /cache/bin；项目带 `./gradlew`、`./mvnw` 就用它们，没有的话 Maven、Gradle 的压缩包也从官方站下。
  - 各语言下载的包（npm、pip、cargo、Go 模块、Gradle、Maven、Bundler、Composer）已经指到 /cache 里，不用另外配置。
- **数据库**：以当前用户在项目目录里起，数据放在项目目录下（比如 `.db/`，别提交进仓库）：
  - PostgreSQL：`initdb -D .db/pg -U app --auth=trust -E UTF8`，`pg_ctl -D .db/pg -l .db/pg.log -o "-k /tmp -p 5432 -c listen_addresses=127.0.0.1" -w start`；连接串 `postgres://app@127.0.0.1:5432/postgres`（建库 `createdb -h 127.0.0.1 -U app 库名`）。
  - MariaDB（MySQL 兼容）：`mariadb-install-db --no-defaults --datadir=$PWD/.db/maria --auth-root-authentication-method=normal`，`mariadbd --no-defaults --datadir=$PWD/.db/maria --socket=/tmp/mariadb.sock --port=3306 --bind-address=127.0.0.1 > .db/maria.log 2>&1 &`，等 `mariadb-admin --no-defaults --socket=/tmp/mariadb.sock -uroot --wait=30 ping`；root 没有密码。
  - Valkey（Redis 兼容）：`valkey-server --port 6379 --bind 127.0.0.1 --dir .db --daemonize yes`。
  - Docker、docker compose 在沙箱里用不了：compose 文件里的数据库照上面的办法起，别的服务看能不能直接用它的程序跑。
- **oasis-setup.sh**：每一轮开工前，系统会执行工作目录和它下一层目录里的 `oasis-setup.sh`（在脚本所在的目录里跑，最多 5 分钟），退出码和输出的结尾写在用户那句话后面。上一轮起的数据库进程这一轮不在了：把「起数据库、确认依赖在」这类每次都要做的事写进项目根目录的 `oasis-setup.sh`（要能重复执行；留在后台的进程把输出重定向到文件），下一轮就不用再手动起。
- **交付**：改动不会推回用户的仓库。把改了什么说清楚，并在 out/ 里交一份补丁（在项目目录里 `git diff > /workspace/out/<名字>.patch`；新文件先 `git add -N`）或整个项目的压缩包（不带 node_modules、.db、构建产物）。测试跑了哪些、过了几条、哪些原来就没过，照实写。
- 2 核 2 GB：大项目的全量构建可能很慢或内存不够，先跑相关的那部分测试；真跑不动就照实说。
