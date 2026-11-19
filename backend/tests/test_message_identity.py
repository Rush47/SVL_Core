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
        for name in ("Bielik", "Maya Mitek", "Claude (MCP)"):
            sender, reason = sanitize_message_identity("assistant", name)
            self.assertIsNone(reason, name)
            self.assertEqual(sender, name)

    def test_legacy_aliases_relabeled(self) -> None:
        self.assertEqual(sanitize_message_identity("assistant", "Maya")[0], "Maya Mitek")
        self.assertEqual(sanitize_message_identity("assistant", "Maya AI")[0], "Maya Mitek")
        self.assertEqual(sanitize_message_identity("system", "Bielik AI")[0], "Bielik")

    def test_impersonation_of_maya_blocked(self) -> None:
        for name in ("Mai", "Mai Mitek", "Maja", "M4i", "M@i"):
            sender, reason = sanitize_message_identity("assistant", name)
            self.assertIsNone(sender, name)
            self.assertIsNotNone(reason, name)

    def test_removed_personas_blocked_any_role(self) -> None:
        for role in ("assistant", "system", "user"):
            for name in ("Iris", "Iris AI", "Agata", "Aria", "Astyria", "Aurelius", "si_1"):
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

    def test_operator_user_passes(self) -> None:
        sender, reason = sanitize_message_identity("user", "Mateusz Mitek (Operator)")
        self.assertIsNone(reason)
        self.assertEqual(sender, "Mateusz Mitek (Operator)")


if __name__ == "__main__":
    unittest.main()
