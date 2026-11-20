import base64
import json
import socket
import threading
import tempfile
import unittest
from pathlib import Path
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from real_vision_engine import (
    SVLRealVisionEngine,
    analyze_image_binary,
    generate_svl364_sensor_png_bytes,
)
from svl_core import SVLSystemKernel


class TestSVLRealVisionSuite(unittest.TestCase):
    def test_png_synthesis_and_binary_decoder(self) -> None:
        png_bytes = generate_svl364_sensor_png_bytes(160, 90, variant="svl364_l2_horizon")
        b64 = base64.b64encode(png_bytes).decode("ascii")
        metrics = analyze_image_binary(f"data:image/png;base64,{b64}")

        self.assertTrue(metrics["validBinary"])
        self.assertEqual(metrics["format"], "PNG")
        self.assertEqual(metrics["mimeType"], "image/png")
        self.assertEqual(metrics["width"], 160)
        self.assertEqual(metrics["height"], 90)
        self.assertEqual(metrics["resolution"], "160×90 px")
        self.assertEqual(len(metrics["sha256"]), 64)
        self.assertGreater(metrics["colorStats"]["luminance"], 10.0)

    def _free_port(self) -> int:
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            return sock.getsockname()[1]

    def _kernel(self, tmpdir: str) -> SVLSystemKernel:
        return SVLSystemKernel(
            db_path=str(Path(tmpdir) / "test_real_vision.sqlite3"),
            operator_token="test_operator_token_with_more_than_32_chars_abcdef",
        )

    def test_without_a_real_model_there_is_no_invented_analysis(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            kernel = self._kernel(tmpdir)
            ollama_host = f"http://127.0.0.1:{self._free_port()}"  # nic tu nie nasłuchuje
            engine = SVLRealVisionEngine(kernel, None)
            result = engine.analyze_image(preset_id="operator_vault_portrait", prompt="Co widać?", ollama_host=ollama_host)

            self.assertFalse(result["ok"])
            record = result["record"]
            self.assertFalse(record["analysed"])
            self.assertEqual(record["ollamaReply"], "")
            self.assertIn("Analiza obrazu niedostępna", record["reportMarkdown"])
            self.assertNotIn("zweryfikowany", record["reportMarkdown"])
            self.assertEqual(record["binaryMetrics"]["format"], "JPEG")
            mods = {m["id"]: m for m in kernel.list_system_modules()}
            self.assertEqual(mods["svl-real-vision"]["config"]["last_test_status"], "FAILED")

    def test_generated_sensor_presets_are_gone(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            engine = SVLRealVisionEngine(self._kernel(tmpdir), None)
            self.assertIsNone(engine.load_preset_frame("svl364_l2_horizon"))
            self.assertIsNone(engine.load_preset_frame("botany_demeter"))
            result = engine.analyze_image(preset_id="botany_demeter", ollama_host="http://127.0.0.1:1")
            self.assertFalse(result["ok"])
            self.assertIn("Załącz obraz", result["error"])
            self.assertEqual([p["id"] for p in engine.get_status()["presets"]], ["operator_vault_portrait"])

    def test_model_gets_only_the_image_and_question_and_its_answer_is_reported(self) -> None:
        captured: list[dict] = []

        class StubOllama(BaseHTTPRequestHandler):
            def log_message(self, *_args: object) -> None:
                return

            def do_POST(self) -> None:  # noqa: N802
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                captured.append(body)
                raw = json.dumps({"message": {"role": "assistant", "content": "Na zdjęciu jest osoba."}}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

        server = ThreadingHTTPServer(("127.0.0.1", 0), StubOllama)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            with tempfile.TemporaryDirectory() as tmpdir:
                kernel = self._kernel(tmpdir)
                engine = SVLRealVisionEngine(kernel, None)
                png = base64.b64encode(generate_svl364_sensor_png_bytes(32, 16)).decode()
                result = engine.analyze_image(
                    image_base64=f"data:image/png;base64,{png}",
                    prompt="Co widać?",
                    ollama_host=f"http://127.0.0.1:{server.server_address[1]}",
                    emit_to_chat=True,
                )
                self.assertTrue(result["ok"])
                self.assertIn("Na zdjęciu jest osoba.", result["record"]["reportMarkdown"])
                messages = captured[0]["messages"]
                self.assertEqual([m["role"] for m in messages], ["user"])
                self.assertEqual(messages[0]["content"], "Co widać?")
                self.assertEqual(len(messages[0]["images"]), 1)
                mods = {m["id"]: m for m in kernel.list_system_modules()}
                self.assertEqual(mods["svl-real-vision"]["config"]["last_test_status"], "PASSED")
        finally:
            server.shutdown()

    def test_antivirus_scanner_purges_rogue_modules_and_virus_chat_payloads(self) -> None:
        from antivirus_scanner import SVLAntivirusScanner

        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "test_svl_av.sqlite3"
            kernel = SVLSystemKernel(db_path=db_path)
            kernel.upsert_system_module(
                module_id="svl-ai-liaison",
                name="Aura Mitek",
                kind="rogue",
                status="ACTIVE",
                description="Unauthorized rogue module",
                config={},
                origin="test",
            )
            # Rogue payload „Iris AI” wstawiony BEZPOŚREDNIO do bazy — symulacja wpisu sprzed
            # istnienia blokady tożsamości (sanitize_message_identity odcina takie wstawienia
            # przez save_chat_message). Skaner AV musi umieć posprzątać to, co już trafiło do bazy.
            import sqlite3 as _sqlite3

            def _seed_rogue(conn: _sqlite3.Connection) -> None:
                conn.execute(
                    "INSERT OR IGNORE INTO conversations (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
                    ("conv-rodzina-mitek-wszyscy", "Rodzina Mitek (wszyscy — czat grupowy)", "test", "2026-01-01T00:00:00", "2026-01-01T00:00:00"),
                )
                conn.execute(
                    "INSERT INTO chat_messages (id, conversation_id, role, sender, content, attachments_json, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    ("asst-infected-test-1", "conv-rodzina-mitek-wszyscy", "assistant", "Iris AI",
                     "[Error: FATAL-SHUTDOWN-IMMINENT] Core-Dump-Wipe Self-Erase-Sequence", "[]", "{}", "2026-01-01T00:00:00"),
                )

            kernel.run_db(_seed_rogue, write=True)
            av = SVLAntivirusScanner(kernel)
            scan = av.scan_and_purge(emit_to_chat=False, origin="unit-test")
            self.assertTrue(scan["ok"])
            self.assertIn(scan["status"], ("CLEAN", "THREATS_DETECTED"))
            self.assertNotIn("potwierdzona", scan["reportMarkdown"])
            # skaner niczego nie kasuje w plikach projektu
            self.assertTrue((BACKEND_DIR.parent / "deploy" / "systemd" / "svl-python-os.service").exists())
            self.assertGreaterEqual(scan["threatsFoundAndPurged"], 2)
            self.assertGreaterEqual(len(scan["neutralizedThreats"]), 2)
            mods = {m["id"]: m for m in kernel.list_system_modules()}
            self.assertNotIn("svl-ai-liaison", mods)
            self.assertIn("svl-antivirus-scanner", mods)
            self.assertNotIn("svl-memory-shield", mods)
            self.assertNotIn("svl-364-repo-vault", mods)
            self.assertNotIn("svl-364-camera-feed", mods)

    def test_factory_reset_wipes_and_reinitializes(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "test_factory.sqlite3"
            kernel = SVLSystemKernel(db_path=db_path)
            kernel.save_chat_message(
                "conv-rodzina-mitek-wszyscy",
                "Rodzina Mitek",
                "test",
                {"id": "msg-1", "role": "user", "sender": "Operator", "timestamp": "12:00", "content": "Test message"},
                origin="test",
            )
            self.assertGreater(len(kernel.list_conversations_with_messages()), 0)
            reset_res = kernel.factory_reset(origin="unit-test")
            self.assertTrue(reset_res["ok"])
            self.assertEqual(reset_res["status"], "FACTORY_RESET_COMPLETED")
            self.assertGreaterEqual(len(kernel.list_conversations_with_messages()), 1)
            self.assertIn("svl-antivirus-scanner", {m["id"] for m in kernel.list_system_modules()})


if __name__ == "__main__":
    unittest.main()

