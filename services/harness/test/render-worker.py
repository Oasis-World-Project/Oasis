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
    unittest.main(verbosity=2)
