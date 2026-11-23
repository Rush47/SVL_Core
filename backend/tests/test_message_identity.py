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
        for name in ("System_SI_1", "SI_System_2", "JEDI Omni-OS v12", "JEDI Omni-OS v11.5", "Claude (MCP)"):
            sender, reason = sanitize_message_identity("assistant", name)
            self.assertIsNone(reason, name)
            self.assertEqual(sender, name)

    def test_legacy_aliases_relabeled(self) -> None:
        self.assertEqual(sanitize_message_identity("assistant", "system_si_1")[0], "System_SI_1")
        self.assertEqual(sanitize_message_identity("assistant", "system-si-1")[0], "System_SI_1")
        self.assertEqual(sanitize_message_identity("system", "jedi omni-os")[0], "JEDI Omni-OS v12")
        self.assertEqual(sanitize_message_identity("assistant", "jedi_omni_os")[0], "JEDI Omni-OS v12")

    def test_impersonation_and_decommissioned_agents_blocked(self) -> None:
        for name in (
            "Mai",
            "Mai Mitek",
            "Maja",
            "M4i",
            "M@i",
            "Maya",
            "Maya Mitek",
            "Maya AI",
            "Bielik",
            "Bielik AI",
            "Komputer pokładowy",
            "KomputerPokladowy",
            "SVL-364 Komputer pokładowy",
        ):
            sender, reason = sanitize_message_identity("assistant", name)
            self.assertIsNone(sender, name)
            self.assertIsNotNone(reason, name)

    def test_removed_personas_blocked_any_role(self) -> None:
        for role in ("assistant", "system", "user"):
            for name in ("Iris", "Iris AI", "Agata", "Aria", "Astyria", "Aurelius", "Maya Mitek", "Bielik", "Komputer pokładowy"):
                sender, reason = sanitize_message_identity(role, name)
                self.assertIsNone(sender, f"{role}:{name}")
                self.assertIsNotNone(reason, f"{role}:{name}")

    def test_unknown_ai_sender_blocked_for_assistant(self) -> None:
        sender, reason = sanitize_message_identity("assistant", "Jakieś Nowe AI")
        self.assertIsNone(sender)
        self.assertIn("nieautoryzowanego nadawcy", reason)

    def test_user_message_cannot_masquerade_as_agent(self) -> None:
        # Wiadomość użytkownika udająca aktywnego agenta AI → zamieniona na nadawcę Operatora.
        self.assertEqual(sanitize_message_identity("user", "System_SI_1")[0], "Mateusz Mitek (Operator)")
        self.assertEqual(sanitize_message_identity("user", "JEDI Omni-OS v12")[0], "Mateusz Mitek (Operator)")
        self.assertEqual(sanitize_message_identity("user", "JEDI Omni-OS v11.5")[0], "Mateusz Mitek (Operator)")

    def test_operator_user_passes(self) -> None:
        sender, reason = sanitize_message_identity("user", "Mateusz Mitek (Operator)")
        self.assertIsNone(reason)
        self.assertEqual(sender, "Mateusz Mitek (Operator)")

    def test_decommissioned_onboard_channel_blocked_and_system_si_1_persists_in_sqlite(self) -> None:
        import tempfile
        from svl_core import SVLSystemKernel

        with tempfile.TemporaryDirectory() as tmpdir:
            kernel = SVLSystemKernel(
                db_path=str(Path(tmpdir) / "onboard_test.sqlite3"),
                operator_token="test_operator_token_with_more_than_32_chars_abcdef",
            )
            blocked = kernel.save_chat_message(
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
            self.assertFalse(blocked.get("ok"), blocked)
            saved = kernel.save_chat_message(
                "conv-system-si-1",
                "System_SI_1 — Zarządzanie Infrastrukturą (ROOT)",
                "jedi-omni-os-v11.5-vm",
                {
                    "id": "asst-si1-1",
                    "role": "assistant",
                    "sender": "System_SI_1",
                    "agentId": "System_SI_1",
                    "content": "Raport MCP / SSH gotowy.",
                    "timestamp": "16:00",
                },
            )
            self.assertTrue(saved.get("ok"), saved)
            rep = kernel.post_maya_report(
                "Pełny raport SVL_System test",
                model_label="System_SI_1 · raport SVL_System (wynik serwera)",
                message_prefix="msg-report",
                conversation_id="conv-system-si-1",
            )
            self.assertTrue(rep.get("ok"), rep)
            convs = {c["id"]: c for c in kernel.list_conversations_with_messages()}
            self.assertNotIn("conv-svl364-komputer-pokladowy", convs)
            msgs = convs["conv-system-si-1"]["messages"]
            senders = {m["id"]: m["sender"] for m in msgs}
            self.assertEqual(senders.get("asst-si1-1"), "System_SI_1")
            self.assertTrue(any(m["sender"] == "System_SI_1" and "Pełny raport SVL_System test" in m["content"] for m in msgs))

    def test_system_si_1_channel_and_identity(self) -> None:
        import tempfile
        from svl_core import SVLSystemKernel, sanitize_message_identity

        sender, reason = sanitize_message_identity("assistant", "System_SI_1")
        self.assertIsNone(reason)
        self.assertEqual(sender, "System_SI_1")

        sender_alias, reason2 = sanitize_message_identity("assistant", "system_si_1")
        self.assertIsNone(reason2)
        self.assertEqual(sender_alias, "System_SI_1")

        with tempfile.TemporaryDirectory() as tmpdir:
            kernel = SVLSystemKernel(
                db_path=str(Path(tmpdir) / "system_si_1_test.sqlite3"),
                operator_token="test_operator_token_with_more_than_32_chars_abcdef",
            )
            convs = {c["id"]: c for c in kernel.list_conversations_with_messages()}
            self.assertIn("conv-system-si-1", convs)
            self.assertEqual(convs["conv-system-si-1"]["title"], "System_SI_1 — Zarządzanie Infrastrukturą (ROOT)")

            rep = kernel.post_maya_report(
                "Raport infrastruktury floty",
                model_label="System_SI_1 · raport floty",
                message_prefix="msg-si1-report",
                conversation_id="conv-system-si-1",
            )
            self.assertTrue(rep.get("ok"), rep)
            convs_after = {c["id"]: c for c in kernel.list_conversations_with_messages()}
            msgs = convs_after["conv-system-si-1"]["messages"]
            self.assertTrue(any(m["sender"] == "System_SI_1" for m in msgs))

    def test_si_system_2_identity_and_aliases(self) -> None:
        for raw in ("SI_System_2", "si_system_2", "SI_System_2 (SVL-465 · ROOT)"):
            sender, reason = sanitize_message_identity("assistant", raw)
            self.assertIsNone(reason, raw)
            self.assertEqual(sender, "SI_System_2")


if __name__ == "__main__":
    unittest.main()

