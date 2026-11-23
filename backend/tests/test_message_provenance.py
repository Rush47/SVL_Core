"""Pochodzenie treści wiadomości (provenance) jest zapisywane i ograniczone do znanych wartości."""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from svl_core import SVLSystemKernel


class MessageProvenanceTests(unittest.TestCase):
    def test_provenance_roundtrip_and_allowlist(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            kernel = SVLSystemKernel(db_path=str(Path(tmp) / "p.sqlite3"), operator_token="t" * 40)
            for msg_id, provenance in (("m1", "model_unverified"), ("m2", "web_sources"), ("m3", "made_up_value")):
                kernel.save_chat_message(
                    "conv-test", "Test", "x",
                    {"id": msg_id, "role": "assistant", "sender": "System_SI_1", "content": msg_id,
                     "provenance": provenance, "verificationNote": "notatka"},
                )
            messages = {m["id"]: m for c in kernel.list_conversations_with_messages() for m in c["messages"]}
        self.assertEqual(messages["m1"]["provenance"], "model_unverified")
        self.assertEqual(messages["m2"]["provenance"], "web_sources")
        self.assertIsNone(messages["m3"]["provenance"])
        self.assertEqual(messages["m1"]["verificationNote"], "notatka")


if __name__ == "__main__":
    unittest.main()
