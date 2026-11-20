import os
import tempfile
import unittest
from pathlib import Path

from backend.svl_core import SVLSystemKernel
from backend.svl_file_logger import (
    MASTER_LOG_FILE,
    PYTHON_LOG_FILE,
    append_python_log,
    ensure_log_files,
    scrub_log_text,
)


class SvlFileLoggerTests(unittest.TestCase):
    def test_creates_logi_txt_files_and_scrubs_secrets(self) -> None:
        secret = "SuperTajnyTokenOperatora1234567890ABCDEF"
        with tempfile.TemporaryDirectory() as tmp:
            log_dir = Path(tmp) / "logi"
            ensure_log_files(log_dir)

            self.assertTrue((log_dir / MASTER_LOG_FILE).is_file())
            self.assertTrue((log_dir / PYTHON_LOG_FILE).is_file())

            append_python_log(
                "http_api",
                f"POST /api/py/kernel/report Bearer {secret}",
                level="INFO",
                correlation_id="corr-py-1",
                details={"operatorToken": secret, "status": 200},
                extra_secrets=[secret],
                log_dir=log_dir,
            )

            master_text = (log_dir / MASTER_LOG_FILE).read_text(encoding="utf-8")
            py_text = (log_dir / PYTHON_LOG_FILE).read_text(encoding="utf-8")

            self.assertIn("POST /api/py/kernel/report", py_text)
            self.assertIn("[corr=corr-py-1]", py_text)
            self.assertNotIn(secret, py_text)
            self.assertNotIn(secret, master_text)
            self.assertIn('"operatorToken": "[REDACTED]"', py_text)

    def test_scrub_log_text_redacts_keys_and_private_blocks(self) -> None:
        raw = "token=abcdef123456 svl-auth.ZmFrZQ==\n-----BEGIN RSA PRIVATE KEY-----secret-----END RSA PRIVATE KEY-----"
        cleaned = scrub_log_text(raw)
        self.assertNotIn("abcdef123456", cleaned)
        self.assertNotIn("ZmFrZQ==", cleaned)
        self.assertNotIn("RSA PRIVATE KEY", cleaned)
        self.assertIn("[REDACTED_PRIVATE_KEY]", cleaned)

    def test_kernel_audit_and_sync_events_propagate_to_python_txt_logs(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "svl_test.sqlite3"
            log_dir = Path(tmp) / "logi"
            old_env = os.environ.get("SVL_LOG_DIR")
            os.environ["SVL_LOG_DIR"] = str(log_dir)
            try:
                kernel = SVLSystemKernel(db_path=str(db_path))
                kernel.record_audit("operator", "TEST_AUDIT_ACTION", "unit-target", "OK", "Szczegóły audytu")
                kernel.record_terminal_entry("ssh", "stdout", "uid=0(root)", command="id")

                py_text = (log_dir / PYTHON_LOG_FILE).read_text(encoding="utf-8")
                master_text = (log_dir / MASTER_LOG_FILE).read_text(encoding="utf-8")
                self.assertIn("TEST_AUDIT_ACTION", py_text)
                self.assertIn("terminal.entry_logged", py_text)
                self.assertIn("TEST_AUDIT_ACTION", master_text)
            finally:
                if old_env is None:
                    os.environ.pop("SVL_LOG_DIR", None)
                else:
                    os.environ["SVL_LOG_DIR"] = old_env


if __name__ == "__main__":
    unittest.main()
