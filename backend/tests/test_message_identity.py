from __future__ import annotations
import sys
import unittest
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from svl_core import sanitize_message_identity


class MessageIdentityGuardTests(unittest.TestCase):
    def test_canonical_ai_senders_pass(self) -> None:
        for name in ("Bielik", "Maya Mitek", "Komputer pokładowy", "Claude (MCP)"):
            sender, reason = sanitize_message_identity("assistant", name)
            self.assertIsNone(reason, name)
            self.assertEqual(sender, name)

    def test_legacy_aliases_relabeled(self) -> None:
        self.assertEqual(sanitize_message_identity("assistant", "Maya")[0], "Maya Mitek")
        self.assertEqual(sanitize_message_identity("assistant", "Maya AI")[0], "Maya Mitek")
        self.assertEqual(sanitize_message_identity("system", "Bielik AI")[0], "Bielik")
        self.assertEqual(sanitize_message_identity("assistant", "KomputerPokladowy")[0], "Komputer pokładowy")
        self.assertEqual(sanitize_message_identity("assistant", "komputer pokladowy")[0], "Komputer pokładowy")
        self.assertEqual(sanitize_message_identity("assistant", "SVL-364 Komputer pokładowy")[0], "Komputer pokładowy")

    def test_impersonation_of_maya_blocked(self) -> None:
        for name in ("Mai", "Mai Mitek", "Maja", "M4i", "M@i"):
            sender, reason = sanitize_message_identity("assistant", name)
            self.assertIsNone(sender, name)
            self.assertIsNotNone(reason, name)

    def test_removed_personas_blocked_any_role(self) -> None:
        for role in ("assistant", "system", "user"):
            for name in ("Iris", "Iris AI", "Agata", "Aria", "Astyria", "Aurelius"):
                sender, reason = sanitize_message_identity(role, name)
                self.assertIsNone(sender, f"{role}:{name}")
                self.assertIsNotNone(reason, f"{role}:{name}")

    def test_unknown_ai_sender_blocked_for_assistant(self) -> None:
        sender, reason = sanitize_message_identity("assistant", "Jakieś Nowe AI")
        self.assertIsNone(sender)
        self.assertIn("nieautoryzowanego nadawcy", reason)

    def test_user_message_cannot_masquerade_as_agent(self) -> None:
        # Wiadomość użytkownika udająca agenta AI → zamieniona na nadawcę Operatora.
        self.assertEqual(sanitize_message_identity("user", "Maya Mitek")[0], "Mateusz Mitek (Operator)")
        self.assertEqual(sanitize_message_identity("user", "Bielik")[0], "Mateusz Mitek (Operator)")
        self.assertEqual(sanitize_message_identity("user", "Komputer pokładowy")[0], "Mateusz Mitek (Operator)")

    def test_operator_user_passes(self) -> None:
        sender, reason = sanitize_message_identity("user", "Mateusz Mitek (Operator)")
        self.assertIsNone(reason)
        self.assertEqual(sender, "Mateusz Mitek (Operator)")

    def test_onboard_channel_report_and_reply_persist_in_sqlite(self) -> None:
        import tempfile
        from svl_core import SVLSystemKernel

        with tempfile.TemporaryDirectory() as tmpdir:
            kernel = SVLSystemKernel(
                db_path=str(Path(tmpdir) / "onboard_test.sqlite3"),
                operator_token="test_operator_token_with_more_than_32_chars_abcdef",
            )
            saved = kernel.save_chat_message(
                "conv-svl364-komputer-pokladowy",
                "SVL-364 Komputer pokładowy (SSH + MCP)",
                "svl-hybrid-router",
                {
                    "id": "asst-onboard-1",
                    "role": "assistant",
                    "sender": "Komputer pokładowy",
                    "agentId": "KomputerPokladowy",
                    "content": "Raport MCP / SSH gotowy.",
                    "timestamp": "16:00",
                },
            )
            self.assertTrue(saved.get("ok"), saved)
            rep = kernel.post_maya_report(
                "Pełny raport SVL_System test",
                model_label="Maya Mitek · raport SVL_System (wynik serwera)",
                message_prefix="msg-report",
                conversation_id="conv-svl364-komputer-pokladowy",
            )
            self.assertTrue(rep.get("ok"), rep)
            convs = {c["id"]: c for c in kernel.list_conversations_with_messages()}
            msgs = convs["conv-svl364-komputer-pokladowy"]["messages"]
            senders = {m["id"]: m["sender"] for m in msgs}
            self.assertEqual(senders.get("asst-onboard-1"), "Komputer pokładowy")
            self.assertTrue(any(m["sender"] == "Komputer pokładowy" and "Pełny raport SVL_System test" in m["content"] for m in msgs))


if __name__ == "__main__":
    unittest.main()
