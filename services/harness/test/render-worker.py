"""Real image regression: invalid requests recover, kernel isolation, CPU reference render."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, "/opt/oasis")
import worker


class WorkerChecks(unittest.TestCase):
    def test_failure_diagnostic_is_bounded_and_never_returns_child_output(self):
        with tempfile.TemporaryDirectory(prefix="render-", dir="/jobs") as directory:
            root = Path(directory)
            for marker, stage in [("Landlock ABI >=3 required", "landlock_unsupported"),
                                  ("isolation identity/path", "identity_or_path"),
                                  ("Required GPU unavailable; CPU fallback forbidden", "gpu_unavailable"),
                                  ("unexpected secret canary", "unclassified_child_failure")]:
                (root / "process.txt").write_text(marker + "\nhttps://private.invalid/?key=secret-canary")
                result = worker.failure_reason(root, 78)
                self.assertIn("stage=" + stage + "; exit=78", result)
                self.assertNotIn("private.invalid", result)
                self.assertNotIn("secret", result)
            (root / "process.txt").write_text("x" * 16384 + "Landlock ABI >=3 required")
            self.assertIn("unclassified_child_failure", worker.failure_reason(root, 78))
            for value, expected in [("init_999", "init_999"), ("devices_1", "devices_1"),
                                    ("secret-canary", "not_recorded"), ("init_" + "1" * 100, "not_recorded")]:
                (root / "cuda.txt").write_text(value)
                result = worker.failure_reason(root, 1, "library_unavailable")
                self.assertIn("cuda_before=library_unavailable; cuda_after=" + expected, result)
                self.assertNotIn("secret", result)

    def test_rejects_untrusted_transfers_and_options(self):
        os.environ["RENDER_STAGING_HOST"] = "a" * 32 + ".r2.cloudflarestorage.com"
        os.environ["RENDER_STAGING_BUCKET"] = "fixture"
        transfer = "b" * 32
        url = "https://" + os.environ["RENDER_STAGING_HOST"] + "/fixture/jobs/" + transfer + "/image.png?X-Amz-Signature=fake&X-Amz-Expires=3600&X-Amz-Credential=fake"
        self.assertEqual(worker.signed_url(url, transfer), url)
        for bad in [url.replace("https:", "http:"), url.replace("image.png", "../image.png"),
                    url.replace("3600", "3601"), url.replace(transfer, "c" * 32),
                    url.replace("image.png", "%252e%252e/image.png"), url.replace(".com/", ".com.evil/"),
                    url.replace("image.png", "image.png#")]:
            with self.assertRaises(ValueError):
                worker.signed_url(bad, transfer)
        for bad in [{}, {"width": True, "height": 64, "samples": 1, "backend": "CUDA"},
                    {"width": 64, "height": 64, "samples": 1, "backend": "CPU"}]:
            with self.assertRaises(ValueError):
                worker.render_settings(bad)
        with self.assertRaises(ValueError):
            worker.handler({"input": {"version": 1, "operation": "shell", "command": "anything"}})

    def test_real_render_and_boundary(self):
        worker.self_test()
        output = Path(os.environ["RENDER_TEST_OUTPUT"])
        device = json.loads((output / "device.json").read_text())
        self.assertTrue(device["blender"].startswith("4.5.3"))
        self.assertFalse(device["gpuUsed"])
        boundary = json.loads((output / "boundary.json").read_text())
        self.assertTrue(all(boundary.values()))

    def test_no_silent_cpu_fallback_and_cleanup(self):
        worker.canary()
        with tempfile.TemporaryDirectory(prefix="render-", dir="/jobs") as directory:
            root = Path(directory)
            (root / "scene.json").write_text(json.dumps(worker.fixture()))
            (root / "render.json").write_text(json.dumps({"width": 64, "height": 64, "samples": 1, "backend": "CUDA"}))
            with self.assertRaises(ValueError):
                worker.execute(root, "probe")
            self.assertFalse((root / "device.json").exists())
            self.assertIn("Required GPU unavailable; CPU fallback forbidden", (root / "process.txt").read_text())
            self.assertEqual((root / "cuda.txt").read_text(), "library_unavailable")
            self.assertIn("cuda_before=library_unavailable; cuda_after=library_unavailable",
                          worker.failure_reason(root, 1, worker.cuda_status()))
        self.assertFalse(root.exists())

    def test_sdk_entrypoint(self):
        # Real SDK invokes the registered handler; invalid input fails before network/GPU.
        result = subprocess.run(["python", "/opt/oasis/worker.py", "--test_input", '{"input":{"operation":"shell","signedUrl":"canary-signed-url"}}'],
            capture_output=True, timeout=45, env={"PATH": os.environ["PATH"], "PYTHONDONTWRITEBYTECODE": "1"})
        text = (result.stdout + result.stderr).decode("utf8", "replace")
        self.assertIn("Unknown scene fields", text)
        self.assertNotIn("canary-not-real-key", text)
        self.assertNotIn("canary-signed-url", text)


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[2] == "cpu-test":
        # Mounted at the launcher's fixed script path in the loader regression only.
        import ctypes
        ctypes.CDLL("oasis-driver-probe.so")
        assert worker.cuda_status() == "symbols_unavailable"
        assert os.environ["LD_LIBRARY_PATH"] == "/usr/local/nvidia/lib:/usr/local/nvidia/lib64"
        assert "LD_PRELOAD" not in os.environ and "RUNPOD_API_KEY" not in os.environ
        import threading
        stop = threading.Event()
        thread = threading.Thread(target=lambda: stop.wait(5))
        thread.start()
        try:
            # glibc names another live thread through /proc/self/task/<tid>/comm.
            status = ctypes.CDLL(None).pthread_setname_np(ctypes.c_ulong(thread.ident), ctypes.c_char_p(b"oasis-cuda"))
            assert status == 0, "Thread naming denied: errno=" + str(status)
            assert Path("/proc/self/task/" + str(thread.native_id) + "/comm").read_text().strip() == "oasis-cuda"
            try:
                fd = os.open("/proc/" + str(os.getppid()) + "/task/" + str(os.getppid()) + "/comm", os.O_RDWR)
            except PermissionError:
                pass
            else:
                os.close(fd)
                raise AssertionError("Parent thread name accessible")
        finally:
            stop.set()
            thread.join()
        print("Isolated driver loader/thread naming passed; no GPU simulated")
    elif sys.argv[1:] == ["--driver-loader-test"]:
        # A real DSO outside ld.so.cache: proves lookup in the injected driver mount.
        Path("/usr/local/nvidia/lib64/oasis-driver-probe.so").symlink_to("/lib/x86_64-linux-gnu/libm.so.6")
        Path("/usr/local/nvidia/lib64/libcuda.so.1").symlink_to("/lib/x86_64-linux-gnu/libm.so.6")
        with tempfile.TemporaryDirectory(prefix="render-", dir="/jobs") as directory:
            subprocess.run(["/opt/oasis/isolate", directory, "cpu-test", str(os.getpid())], check=True,
                           env={"LD_LIBRARY_PATH": directory, "RUNPOD_API_KEY": "canary-not-real-key"}, timeout=30)
    else:
        unittest.main(verbosity=2)
