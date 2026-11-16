"""Deduplikacja pamięci długotrwałej agentów (fakty/decyzje nie mogą się dublować)."""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from agents_runtime import SVLAgentOrchestrator
from spherical_bus import SphericalEventBus
from svl_core import SVLSystemKernel

TOKEN = "test_operator_token_with_more_than_32_chars_abcdef"


class AgentMemoryDedupTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        kernel = SVLSystemKernel(db_path=str(Path(self._tmp.name) / "mem.sqlite3"), operator_token=TOKEN)
        self.kernel = kernel
        self.orchestrator = SVLAgentOrchestrator(kernel, SphericalEventBus())

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _contents(self, kind: str) -> list[str]:
        return [m["content"] for m in self.orchestrator.get_agent_memories("Bielik", limit=100) if m["kind"] == kind]

    def test_same_fact_is_stored_once_and_reported_as_duplicate(self) -> None:
        first = self.orchestrator.add_agent_memory("Bielik", "Reaktor ma pracować na 80%", kind="fact")
        revision_after_first = self.kernel.get_server_revision()
        second = self.orchestrator.add_agent_memory("Bielik", "  reaktor ma pracować  na 80%. ", kind="fact")

        self.assertFalse(first.get("deduplicated"))
        self.assertTrue(second["deduplicated"])
        self.assertEqual(second["id"], first["id"])
        self.assertIsNone(second["event"])
        self.assertEqual(self.kernel.get_server_revision(), revision_after_first)
        self.assertEqual(self._contents("fact"), ["Reaktor ma pracować na 80%"])

    def test_same_text_with_different_kind_is_kept(self) -> None:
        self.orchestrator.add_agent_memory("Bielik", "Kalibracja tarcz", kind="fact")
        self.orchestrator.add_agent_memory("Bielik", "Kalibracja tarcz", kind="task")
        self.assertEqual(self._contents("fact"), ["Kalibracja tarcz"])
        self.assertEqual(self._contents("task"), ["Kalibracja tarcz"])

    def test_episodes_are_never_deduplicated(self) -> None:
        self.orchestrator.add_agent_memory("Bielik", "Czat: ok", kind="episode")
        self.orchestrator.add_agent_memory("Bielik", "Czat: ok", kind="episode")
        self.assertEqual(len(self._contents("episode")), 2)


if __name__ == "__main__":
    unittest.main()
