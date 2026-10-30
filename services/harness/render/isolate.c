// Linux amd64 only. Fail closed: Landlock ABI >=3, no network sockets (CUDA needs AF_UNIX), no inherited FDs.
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <glob.h>
#include <linux/filter.h>
#include <linux/audit.h>
#include <linux/landlock.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

static void fail(const char *message) { perror(message); exit(78); }
static void allow_path(int rules, const char *path, uint64_t access, int optional) {
    int fd = open(path, O_PATH | O_CLOEXEC);
    if (fd < 0) { if (optional && errno == ENOENT) return; fail("isolation path"); }
    struct stat st;
    if (fstat(fd, &st)) fail("isolation stat");
    if (!S_ISDIR(st.st_mode)) access &= (1ULL << 0) | (1ULL << 1) | (1ULL << 2);
    struct landlock_path_beneath_attr rule = {.allowed_access = access, .parent_fd = fd};
    if (syscall(SYS_landlock_add_rule, rules, LANDLOCK_RULE_PATH_BENEATH, &rule, 0)) fail("isolation rule");
    close(fd);
}
#define DENY(n) BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_##n, 0, 1), BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM)
int main(int argc, char **argv) {
    if (argc != 4 || getuid() == 0 || strncmp(argv[1], "/jobs/", 6) || strchr(argv[1] + 6, '/') || strstr(argv[1], "..")) {
        errno = EINVAL; fail("isolation identity/path");
    }
    if (strcmp(argv[2], "probe") && strcmp(argv[2], "render") && strcmp(argv[2], "cpu-test")) {
        errno = EINVAL; fail("isolation mode");
    }
    int abi = syscall(SYS_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
    if (abi < 3) { errno = ENOTSUP; fail("Landlock ABI >=3 required"); }
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) fail("no_new_privs");
    if (prctl(PR_SET_PDEATHSIG, 9) || getppid() != atoi(argv[3])) fail("parent lifecycle");
    const uint64_t read = (1ULL << 0) | (1ULL << 2) | (1ULL << 3);
    const uint64_t all = (1ULL << 15) - 1;
    struct landlock_ruleset_attr attr = {.handled_access_fs = all};
    int rules = syscall(SYS_landlock_create_ruleset, &attr, sizeof(attr), 0);
    if (rules < 0) fail("isolation ruleset");
    const char *system[] = {"/usr", "/lib", "/lib64", "/opt/oasis", "/etc/ld.so.cache", "/etc/fonts", "/etc/localtime", "/proc/driver/nvidia", "/proc/self/maps", "/proc/self/mountinfo", "/proc/mounts",
        // CPU/NUMA facts read by libcuda and Cycles; read-only, no process or secret data.
        "/proc/stat", "/proc/cpuinfo", "/proc/meminfo", "/proc/sys/vm/mmap_min_addr", "/sys/devices/system/cpu", "/sys/devices/system/node"};
    for (unsigned i = 0; i < sizeof(system) / sizeof(*system); i++) allow_path(rules, system[i], read, 1);
    // CUDA names its threads by opening comm files with O_WRONLY|O_TRUNC; this PID survives exec.
    allow_path(rules, "/proc/self/task", LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_WRITE_FILE | (1ULL << 14) /* TRUNCATE, ABI 3 */, 0);
    allow_path(rules, argv[1], all & ~((1ULL << 6) | (1ULL << 9) | (1ULL << 10) | (1ULL << 11)), 0);
    const char *devices[] = {"/dev/null", "/dev/urandom", "/dev/random"};
    for (unsigned i = 0; i < sizeof(devices) / sizeof(*devices); i++) allow_path(rules, devices[i], 6, 0);
    glob_t gpu = {0};
    if (!glob("/dev/nvidia*", 0, NULL, &gpu))
        for (size_t i = 0; i < gpu.gl_pathc; i++) allow_path(rules, gpu.gl_pathv[i], 14, 0);
    globfree(&gpu);
    if (syscall(SYS_landlock_restrict_self, rules, 0)) fail("isolation enforce");
    close(rules);
    struct sock_filter filter[] = {
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
        BPF_JUMP(BPF_JMP | BPF_JGE | BPF_K, 0x40000000, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
        // cuInit opens an AF_UNIX SOCK_SEQPACKET socket; every other address family stays denied.
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_socket, 0, 4),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AF_UNIX, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
        DENY(socketpair), DENY(ptrace), DENY(process_vm_readv), DENY(process_vm_writev),
        DENY(pidfd_getfd), DENY(pidfd_open), DENY(io_uring_setup), DENY(mount), DENY(unshare),
        DENY(setns), DENY(bpf), DENY(perf_event_open), DENY(kill), DENY(tkill),
        DENY(rt_sigqueueinfo), DENY(rt_tgsigqueueinfo), DENY(pidfd_send_signal),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_tgkill, 0, 4),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (uint32_t)getpid(), 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW)
    };
    struct sock_fprog program = {.len = sizeof(filter) / sizeof(*filter), .filter = filter};
    if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program)) fail("isolation seccomp");
    struct rlimit cpu = {580, 580}, file = {256 * 1024 * 1024, 256 * 1024 * 1024}, fds = {128, 128};
    if (setrlimit(RLIMIT_CPU, &cpu) || setrlimit(RLIMIT_FSIZE, &file) || setrlimit(RLIMIT_NOFILE, &fds)) fail("isolation limits");
    if (syscall(SYS_close_range, 3, ~0U, 0)) fail("isolation close fds");
    if (chdir(argv[1])) fail("isolation cwd");
    char home[512], tmp[512];
    snprintf(home, sizeof(home), "HOME=%s", argv[1]);
    snprintf(tmp, sizeof(tmp), "TMPDIR=%s", argv[1]);
    char *env[] = {"PATH=/usr/local/bin:/usr/bin:/bin", "LD_LIBRARY_PATH=/usr/local/nvidia/lib:/usr/local/nvidia/lib64", "PYTHONDONTWRITEBYTECODE=1", "PYTHONUNBUFFERED=1", "OMP_NUM_THREADS=2", "OPENBLAS_NUM_THREADS=2", home, tmp, NULL};
    char *args[] = {"python3", "/opt/oasis/render_child.py", argv[1], argv[2], NULL};
    execve("/usr/local/bin/python3", args, env);
    fail("isolation exec");
}
