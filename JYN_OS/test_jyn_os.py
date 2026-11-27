#!/usr/bin/env python3
"""Testy jednostkowe i regresyjne systemu klienta oraz nowego modułu czatu JYN_OS v3.0."""

import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

current_dir = Path(__file__).resolve().parent
parent_dir = current_dir.parent
if str(parent_dir) not in sys.path:
    sys.path.insert(0, str(parent_dir))

from JYN_OS.chat_engine import (
    JynChatEngine,
    build_polish_chat_messages,
    clean_polish_response,
    compute_turn_options,
)
from JYN_OS.config import (
    CANONICAL_MODELS_PRIORITY,
    DEFAULT_SYSTEM_PROMPT_PL,
    SHIP_MODELS_CATALOG,
    JynOSConfig,
    resolve_auth_token,
    select_canonical_base_for_host,
)
from JYN_OS.mcp_client import SvlMcpClient
from JYN_OS.ollama_client import SvlOllamaClient
from JYN_OS.shell import JynOSShell
from JYN_OS.ssh_client import Svl364SshClient
from JYN_OS.svl364_standalone_ollama import _merged_ship_models, _select_execution_candidates


class TestJynOSCanonicalModelsSuite(unittest.TestCase):
    def setUp(self):
        self.cfg = JynOSConfig.load_from_env()

    def test_catalog_has_exact_13_canonical_ship_models_and_no_qwen_1_5b(self):
        self.assertEqual(len(SHIP_MODELS_CATALOG), 13)
        names = [m["name"] for m in SHIP_MODELS_CATALOG]
        self.assertIn("svl364-apex-uncensored:latest", names)
        self.assertIn("dolphin-mixtral:8x22b", names)
        self.assertIn("dolphin-llama3:70b", names)
        self.assertIn("wizard-vicuna-uncensored:30b", names)
        self.assertIn("dolphin-mixtral:8x7b", names)
        self.assertIn("dolphin-llama3:8b-v2.9-q2_K", names)
        self.assertIn("llama3.2-vision:90b", names)
        self.assertIn("llama3.2-vision:11b", names)
        self.assertIn("deepseek-r1:7b", names)
        self.assertIn("qwen2.5:7b", names)
        self.assertIn("qwen2.5-coder:7b", names)
        self.assertIn("llama3:8b", names)
        self.assertIn("mistral:7b", names)
        self.assertNotIn("qwen2.5:1.5b", names)
        self.assertNotIn("qwen2.5:1.5b", CANONICAL_MODELS_PRIORITY)
        self.assertEqual(self.cfg.vision_model, "llama3.2-vision:11b")

    def test_hardware_base_selection_uses_only_canonical_models(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("SVL_APEX_BASE_MODEL", None)
            self.assertEqual(select_canonical_base_for_host(8.0), "qwen2.5:7b")
            self.assertEqual(select_canonical_base_for_host(16.0), "llama3.2-vision:11b")
            self.assertEqual(select_canonical_base_for_host(28.0), "wizard-vicuna-uncensored:30b")
            self.assertEqual(select_canonical_base_for_host(36.0), "dolphin-mixtral:8x7b")
            self.assertEqual(select_canonical_base_for_host(64.0), "dolphin-llama3:70b")

    def test_auth_token_resolver_finds_token(self):
        with patch.dict(os.environ, {"SVL_OPERATOR_TOKEN": "test-token"}):
            self.assertEqual(resolve_auth_token("http://127.0.0.1:3000/api/mcp/svl364"), "test-token")

    def test_ssh_client_detects_ship_key_and_target(self):
        with tempfile.TemporaryDirectory() as tmp:
            key = Path(tmp) / "test_key"
            key.touch()
            ssh = Svl364SshClient(JynOSConfig(ssh_key_path=key, ssh_profile="Ship"))
            self.assertTrue(ssh.get_key_status()["private_key_exists"])
            self.assertEqual(ssh.config.ssh_profile, "Ship")

    def test_mcp_client_endpoints_defined(self):
        mcp = SvlMcpClient(self.cfg)
        endpoints = mcp.federated_endpoints
        self.assertIn("Universal MCP Hub (Ship 3334)", endpoints)
        self.assertIn("System MCP Gateway (3000/mcp/svl)", endpoints)
        self.assertIn("Ship MCP Gateway (3000/api/mcp/svl364)", endpoints)
        self.assertIn("Backend Python MCP (8085/mcp)", endpoints)

    def test_ollama_endpoints_and_target_switching(self):
        ollama = SvlOllamaClient(self.cfg)
        self.assertIn("11435", ollama.config.ship_ollama_url)
        self.assertIn("11434", ollama.config.local_ollama_url)
        self.assertFalse(ollama.config.chat_stream_enabled)
        self.assertEqual(ollama.config.get_active_model(), "svl364-apex-uncensored:latest")

        ollama.config.set_active_target("ship")
        self.assertEqual(ollama.config.active_ollama_target, "ship")
        self.assertEqual(ollama.config.get_active_ollama_url(), ollama.config.ship_ollama_url)


class TestRebuiltNonStreamingPolishChatModule(unittest.TestCase):
    def test_nonstreaming_request_without_default_system_prompt(self):
        cfg = JynOSConfig(local_model="svl364-apex-uncensored:latest", active_ollama_target="local", system_prompt="")
        client = SvlOllamaClient(cfg)
        reply = {
            "message": {"content": "Melduję pełną gotowość systemów pokładowych, Mateuszu."},
            "done": True,
            "model": "svl364-apex-uncensored:latest",
            "eval_count": 14,
            "eval_duration": 700_000_000,
        }
        with patch(
            "JYN_OS.ollama_client.urllib.request.urlopen",
            return_value=io.BytesIO(json.dumps(reply, ensure_ascii=False).encode("utf-8")),
        ) as mock:
            result = client.chat("Zamelduj status")

        self.assertTrue(result["success"])
        self.assertEqual(mock.call_count, 1)
        payload = json.loads(mock.call_args.args[0].data.decode("utf-8"))
        self.assertIs(payload["stream"], False)
        self.assertEqual(payload["model"], "svl364-apex-uncensored:latest")
        self.assertEqual(payload["keep_alive"], -1)
        self.assertEqual(payload["messages"], [{"role": "user", "content": "Zamelduj status"}])

    def test_adaptive_fast_turn_options(self):
        cfg = JynOSConfig(chat_num_ctx=2048, chat_num_predict=384)
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("SVL_CHAT_NUM_PREDICT", None)
            short_opts = compute_turn_options("Cześć Jyn!", cfg)
            self.assertLessEqual(short_opts["num_predict"], 192)
            self.assertEqual(short_opts["num_ctx"], 2048)
            self.assertEqual(compute_turn_options("Wyjaśnij jak działa Linux", cfg)["num_predict"], 384)

            detailed_opts = compute_turn_options("Napisz skrypt w Pythonie i podaj szczegółowy raport architektury", cfg)
            self.assertGreaterEqual(detailed_opts["num_predict"], 768)
            self.assertEqual(detailed_opts["num_ctx"], 2048)

    def test_clean_polish_response_preserves_dialogue_content(self):
        raw = "<think>Analyzing in English...</think>\n[Jyn Mitek]: Sprawdziłam telemetrię statku, Mateuszu.\nUser: kolejne pytanie"
        self.assertEqual(clean_polish_response(raw), "Sprawdziłam telemetrię statku, Mateuszu.\nUser: kolejne pytanie")

    def test_chat_engine_slash_commands_and_session_memory(self):
        cfg = JynOSConfig()
        client = SvlOllamaClient(cfg)
        engine = JynChatEngine(config=cfg, ollama=client)

        cat_res = engine.send("/modele")
        self.assertTrue(cat_res.ok)
        self.assertTrue(cat_res.local_command)
        self.assertIn("dolphin-mixtral:8x22b", cat_res.reply)
        self.assertIn("qwen2.5:7b", cat_res.reply)

        reply = {
            "message": {"content": "Wszystkie 13 modeli pokładowych jest aktywnych, Mateuszu."},
            "done": True,
            "model": cfg.get_active_model(),
            "eval_count": 12,
            "eval_duration": 500_000_000,
        }
        with patch(
            "JYN_OS.ollama_client.urllib.request.urlopen",
            return_value=io.BytesIO(json.dumps(reply, ensure_ascii=False).encode("utf-8")),
        ):
            turn = engine.send("Jakie modele działają?")
        self.assertTrue(turn.ok)
        self.assertEqual(len(engine.history), 2)

        clr = engine.send("/wyczysc")
        self.assertTrue(clr.ok)
        self.assertEqual(engine.history, [])

    def test_svl364_ship_catalog_never_substitutes_requested_model(self):
        with patch(
            "JYN_OS.svl364_standalone_ollama._fetch_upstream_models",
            return_value=[{"name": "svl364-apex-uncensored:latest"}, {"name": "qwen2.5:7b"}],
        ):
            merged = _merged_ship_models()
        self.assertEqual(len(merged), 13)
        cands = _select_execution_candidates(
            "dolphin-mixtral:8x22b",
            ["svl364-apex-uncensored:latest", "qwen2.5:7b"],
        )
        self.assertEqual(cands, ["dolphin-mixtral:8x22b"])


class TestRuntimeRegression(unittest.TestCase):
    def test_single_word_chat_and_eof(self):
        shell = JynOSShell(JynOSConfig())
        with patch.object(shell, "_run_complete_chat", return_value=True) as run:
            self.assertIsNone(shell.default("Cześć"))
            run.assert_called_once_with("Cześć")
        self.assertTrue(shell.do_EOF(""))

    def test_chat_interrupt_does_not_exit_shell_or_write_history(self):
        shell = JynOSShell(JynOSConfig())
        with patch.object(shell.chat_engine, "send", side_effect=KeyboardInterrupt):
            self.assertFalse(shell._run_complete_chat("Cześć"))
        self.assertEqual(shell.chat_history, [])

    def test_model_pull_error_not_success(self):
        client = SvlOllamaClient(JynOSConfig())
        with patch("JYN_OS.ollama_client.urllib.request.urlopen", return_value=io.BytesIO(b'{"error":"disk full"}')):
            result = client.pull_model("qwen2.5:7b")
        self.assertFalse(result["success"])
        self.assertIn("disk full", result["error"])

    def test_chat_rejects_partial_and_null(self):
        client = SvlOllamaClient(JynOSConfig())
        for reply in ({"message": {"content": None}, "done": True},
                      {"message": {"content": "partial"}, "done": False}):
            with patch(
                "JYN_OS.ollama_client.urllib.request.urlopen",
                return_value=io.BytesIO(json.dumps(reply).encode()),
            ):
                self.assertFalse(client.chat("test", model="qwen2.5:7b", url="http://127.0.0.1:11434")["success"])

    def test_avatar_action_requires_explicit_own_profile_request(self):
        from JYN_OS.avatar_client import extract_avatar_action
        text, args = extract_avatar_action('Cześć\n<svl_avatar>{"query":"portrait"}</svl_avatar>')
        self.assertEqual(text, "Cześć")
        self.assertEqual(args, {"query": "portrait"})
        _, invalid = extract_avatar_action('<svl_avatar>{"query":"portrait","agent":"Operator"}</svl_avatar>')
        self.assertIsNone(invalid)

    def test_chat_rejects_model_substitution(self):
        client = SvlOllamaClient(JynOSConfig())
        reply = {"message": {"content": "test"}, "done": True, "model": "qwen2.5:7b"}
        with patch("JYN_OS.ollama_client.urllib.request.urlopen", return_value=io.BytesIO(json.dumps(reply).encode())) as request:
            result = client.chat("Test", model="svl364-apex-uncensored:latest")
        self.assertFalse(result["success"])
        self.assertEqual(request.call_count, 1)

    def test_target_alias_normalized(self):
        cfg = JynOSConfig(active_ollama_target=" SVL364 ")
        self.assertEqual(cfg.active_ollama_target, "ship")
        self.assertEqual(cfg.get_active_ollama_url(), cfg.ship_ollama_url)

    def test_build_polish_messages_ignores_legacy_behavior_prompt(self):
        cfg = JynOSConfig(system_prompt="Stara instrukcja")
        messages = build_polish_chat_messages("Cześć", cfg, system_prompt="Niestandardowa instrukcja PL")
        self.assertFalse(any(m.get("role") == "system" for m in messages))
        self.assertEqual(messages[-1]["content"], "Cześć")


    def test_apex_rejects_small_base_without_network(self):
        client = SvlOllamaClient(JynOSConfig())
        with patch("JYN_OS.ollama_client._urlopen_direct") as request:
            result = client.create_apex_model(base_model="qwen2.5:7b")
        self.assertFalse(result["success"])
        request.assert_not_called()

    def test_engine_does_not_failover_to_other_endpoint(self):
        cfg = JynOSConfig(system_prompt="")
        client = SvlOllamaClient(cfg)
        engine = JynChatEngine(cfg, client)
        with patch("JYN_OS.ollama_client.urllib.request.urlopen", side_effect=OSError("offline")) as request:
            result = engine.send("Test")
        self.assertFalse(result.ok)
        self.assertEqual(request.call_count, 1)

    def test_apex_is_not_silently_substituted(self):
        client = SvlOllamaClient(JynOSConfig())
        self.assertEqual(client._candidate_models("svl364-apex-uncensored:latest",
            installed=["qwen2.5:7b"]), ["svl364-apex-uncensored:latest"])

    def test_turn_metrics_separate_generation_from_overhead(self):
        cfg = JynOSConfig()
        client = SvlOllamaClient(cfg)
        engine = JynChatEngine(cfg, client)
        with patch.object(client, "chat", return_value={"success": True, "response": "OK",
                "eval_count": 20, "eval_duration": 2000000000,
                "load_duration": 1000000000, "prompt_eval_duration": 500000000,
                "total_duration": 3500000000}):
            turn = engine.send("Test")
        self.assertEqual((turn.load_sec, turn.prompt_eval_sec, turn.eval_sec, turn.tokens_per_sec),
                         (1.0, 0.5, 2.0, 10.0))

    def test_warmup_rejects_error_json(self):
        client = SvlOllamaClient(JynOSConfig())
        with patch("JYN_OS.ollama_client.urllib.request.urlopen",
                   return_value=io.BytesIO(b'{"error":"out of memory"}')):
            self.assertFalse(client.warm_up()["success"])


class TestGoogleServicesHub1000UsdIntegration(unittest.TestCase):
    def setUp(self):
        self.tmp_dir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmp_dir.name) / "test_google_hub.sqlite3"
        self.cfg = JynOSConfig(google_hub_db_path=self.db_path, google_budget_usd=25000.0)
        self.ollama = SvlOllamaClient(self.cfg)

    def tearDown(self):
        self.tmp_dir.cleanup()

    def test_initial_provisioning_purchases_all_25_modules_and_loads_1000_usd_each(self):
        from JYN_OS.google_services_hub import GOOGLE_SERVICES_CATALOG, GoogleServicesHub

        hub = GoogleServicesHub(config=self.cfg, ollama=self.ollama, db_path=self.db_path)
        rep = hub.get_full_status_report()
        self.assertTrue(rep["ok"])
        self.assertEqual(rep["services_count"], 25)
        self.assertEqual(len(GOOGLE_SERVICES_CATALOG), 25)
        self.assertTrue(rep["all_services_active"])
        self.assertEqual(rep["wallet"]["balance_usd"], 25000.0)
        self.assertEqual(rep["wallet"]["total_topped_up_usd"], 25000.0)
        self.assertEqual(len(rep["ai_channels"]), 25)
        for s in rep["services"]:
            self.assertEqual(s["allocated_budget_usd"], 1000.0)

        service_ids = {s["service_id"] for s in rep["services"]}
        expected_ids = {
            "gemini_ai_studio",
            "vertex_ai_garden",
            "cloud_translation_speech",
            "cloud_vision_docai",
            "custom_search_grounding",
            "workspace_bridge",
            "maps_earth_telemetry",
            "gcs_bigquery_telemetry",
            "interactive_ai_ui_kit",
            "agentic_swarm_adk",
            "vector_rag_engine",
            "security_chronicle_shield",
            "exo_infrastructure_grid",
            "exo_missions_command",
            "exo_botany_biodome",
            "google_static_ip_networking",
            "google_ha_vpn_interconnect",
            "google_beyondcorp_zero_trust",
            "google_cloud_armor_ids",
            "google_scc_kms_hsm_vault",
            "chroma_rich_typography_suite",
            "openai_chatgpt_business_suite",
            "openai_api_secondary_provider",
            "google_ai_ultra_all_subscriptions",
            "google_professional_services_rebuild_github",
        }
        self.assertEqual(service_ids, expected_ids)
        net = rep["static_ip_vpn_security"]
        self.assertEqual(net["jyn_os_static_ip"], "34.118.64.100")
        self.assertEqual(net["ship_svl364_static_ip"], "34.118.64.200")
        self.assertEqual(net["anycast_global_ipv4"], "35.190.88.1")
        self.assertEqual(len(net["nodes"]), 2)

    def test_topup_wallet_and_api_key_vault_management(self):
        from JYN_OS.google_services_hub import GoogleServicesHub

        hub = GoogleServicesHub(config=self.cfg, ollama=self.ollama, db_path=self.db_path)
        w = hub.topup_wallet(1000.0)
        self.assertEqual(w["balance_usd"], 26000.0)
        self.assertEqual(w["total_topped_up_usd"], 26000.0)

        kres = hub.set_api_key("AIzaSyCustomOperatorKey1234567890", service_id="all")
        self.assertTrue(kres["ok"])
        self.assertEqual(len(kres["updated_services"]), 25)

    def test_all_integrated_google_and_offworld_services_execute_and_account_usage(self):
        from JYN_OS.google_services_hub import GoogleServicesHub

        hub = GoogleServicesHub(config=self.cfg, ollama=self.ollama, db_path=self.db_path)
        reply = {
            "model": "svl364-apex-uncensored:latest",
            "message": {"content": "Melduję odpowiedź z mostka Gemini/SVL-364, Mateuszu."},
            "done": True,
            "eval_count": 10,
            "eval_duration": 400_000_000,
        }
        with patch(
            "JYN_OS.ollama_client.urllib.request.urlopen",
            return_value=io.BytesIO(json.dumps(reply, ensure_ascii=False).encode("utf-8")),
        ):
            gem = hub.generate_gemini("Status integracji Gemini 2.5 Pro", model="gemini-2.5-pro")
            self.assertTrue(gem.ok)
            self.assertIn("Melduję", gem.output)

            vtx = hub.generate_gemini("Status Vertex AI", model="vertex/gemini-2.5-pro", use_vertex=True)
            self.assertTrue(vtx.ok)

            trn = hub.translate_text("System ready", target_lang="pl")
            self.assertTrue(trn.ok)

            grd = hub.search_grounding("Specyfikacja statku SVL-364")
            self.assertTrue(grd.ok)

        emb = hub.embed_text("Wektor telemetrii JYN_OS")
        self.assertTrue(emb.ok)
        self.assertEqual(emb.data["dimensions"], 16)

        tts = hub.synthesize_speech_tts("Melduję gotowość systemów Google.")
        self.assertTrue(tts.ok)

        vis = hub.analyze_vision("/tmp/nonexistent_cam.png")
        self.assertTrue(vis.ok)
        self.assertTrue(vis.data["ocr_ready"])

        gen_img = hub.generate_image_from_services("SVL-364 Ebon Apex na orbicie Jowisza")
        self.assertTrue(gen_img.ok)
        self.assertTrue(Path(gen_img.data["file_path"]).is_file())
        self.assertEqual(gen_img.data["metadata"]["width"], 640)
        self.assertEqual(gen_img.data["metadata"]["height"], 360)

        real_vis = hub.analyze_vision(gen_img.data["file_path"], "Zbadaj wygenerowany obraz")
        self.assertTrue(real_vis.ok)
        self.assertEqual(real_vis.data["real_image_metadata"]["width"], 640)

        wks = hub.workspace_status()
        self.assertTrue(wks.ok)
        self.assertIn("gdocs", wks.data["tools"])
        self.assertIn("gdrive", wks.data["tools"])

        mps = hub.maps_telemetry("SVL-364 Sector 1")
        self.assertTrue(mps.ok)
        self.assertEqual(mps.data["navigation_status"], "LOCKED")

        gcs = hub.sync_telemetry_to_gcs_bigquery()
        self.assertTrue(gcs.ok)
        self.assertTrue(gcs.data["gcs_uri"].startswith("gs://"))

        ui_kit = hub.render_interactive_ui_kit("Panel JYN_OS")
        self.assertTrue(ui_kit.ok)
        self.assertGreaterEqual(len(ui_kit.data["buttons"]), 23)

        swarm = hub.deploy_agentic_swarm("Patrol SVL-364")
        self.assertTrue(swarm.ok)

        vrag = hub.query_vector_rag("Pamięć 128D")
        self.assertTrue(vrag.ok)

        sec = hub.audit_security_shield()
        self.assertTrue(sec.ok)

        infra = hub.operate_exo_infrastructure("ALL")
        self.assertTrue(infra.ok)
        self.assertEqual(infra.data["nodes_count"], 5)

        missions = hub.operate_exo_missions()
        self.assertTrue(missions.ok)
        self.assertGreaterEqual(len(missions.data["missions"]), 4)

        botany = hub.operate_exo_botany("BIO-DOME-ALPHA")
        self.assertTrue(botany.ok)
        self.assertEqual(len(botany.data["biodomes"]), 3)

        static_ip = hub.configure_google_static_ip_networking()
        self.assertTrue(static_ip.ok)
        self.assertIn("34.118.64.100", static_ip.output)
        self.assertIn("34.118.64.200", static_ip.output)

        ha_vpn = hub.configure_google_ha_vpn_tunnel()
        self.assertTrue(ha_vpn.ok)
        self.assertIn("10.240.0.1", ha_vpn.output)
        self.assertIn("10.240.0.2", ha_vpn.output)

        beyondcorp = hub.configure_google_beyondcorp_zero_trust()
        self.assertTrue(beyondcorp.ok)

        armor_ids = hub.configure_google_cloud_armor_ids()
        self.assertTrue(armor_ids.ok)

        scc_hsm = hub.configure_google_scc_kms_hsm()
        self.assertTrue(scc_hsm.ok)

        chroma_res = hub.render_chroma_rich_typography(cube_number=364)
        self.assertTrue(chroma_res.ok)
        self.assertEqual(chroma_res.data["glocki_codec"]["nkb"], "000101101100")
        self.assertEqual(chroma_res.data["glocki_codec"]["gray"], "000111011010")
        self.assertEqual(chroma_res.data["glocki_codec"]["bcd"], "0011 0110 0100")
        self.assertEqual(chroma_res.data["glocki_codec"]["xs3"], "0110 1001 0111")

        oa_chatgpt = hub.invoke_openai_business_service("chatgpt", "Analiza floty SVL-364")
        self.assertTrue(oa_chatgpt.ok)
        self.assertIn("ChatGPT Business", oa_chatgpt.output)

        oa_codex = hub.invoke_openai_business_service("codex", "Funkcja telemetrii")
        self.assertTrue(oa_codex.ok)
        self.assertIn("OpenAI Codex", oa_codex.output)

        oa_work = hub.invoke_openai_business_service("chatgpt_work", "Projekt SVL-364")
        self.assertTrue(oa_work.ok)
        self.assertIn("ChatGPT Work", oa_work.output)

        oa_api = hub.invoke_openai_business_service("openai_api", "Ping Secondary API")
        self.assertTrue(oa_api.ok)
        self.assertIn("SECONDARY_PROVIDER", oa_api.output)

        solar = hub.generate_solar_system_telemetry_report("Raport z układu słonecznego")
        self.assertTrue(solar.ok)
        self.assertEqual(len(solar.data["solar_system_bodies"]), 10)

        wallet_after = hub.get_wallet_status()
        self.assertLess(wallet_after["balance_usd"], 25000.0)
        self.assertGreater(wallet_after["total_spent_usd"], 0.0)
        ledger = hub.get_recent_ledger(35)
        self.assertGreaterEqual(len(ledger), 25)

    def test_chat_engine_buttons_channels_vision_and_autonomous_jyn_modules(self):
        from JYN_OS.google_services_hub import GoogleServicesHub

        hub = GoogleServicesHub(config=self.cfg, ollama=self.ollama, db_path=self.db_path)
        engine = JynChatEngine(config=self.cfg, ollama=self.ollama, google_hub=hub)

        # 1. Kliknięcie przycisku Botaniki, Stałego IP, HA VPN, ChromaText i OpenAI w czacie bez wpisywania komendy
        btn_turn = engine.click_button("module:exo_botany_biodome:adjust_climate")
        self.assertTrue(btn_turn.ok)
        self.assertEqual(len(btn_turn.ai_channels), 25)
        self.assertGreaterEqual(len(btn_turn.buttons), 23)
        self.assertGreaterEqual(len(btn_turn.widgets), 5)

        vpn_turn = engine.click_button("module:google_ha_vpn_interconnect:establish_ha_vpn")
        self.assertTrue(vpn_turn.ok)
        self.assertIn("99.99%", vpn_turn.reply)

        ip_cmd = engine.send("/ip")
        self.assertTrue(ip_cmd.ok)
        self.assertIn("34.118.64.100", ip_cmd.reply)
        self.assertIn("34.118.64.200", ip_cmd.reply)

        api_cmd = engine.send("/api")
        self.assertTrue(api_cmd.ok)
        self.assertIn("ZUNIFIKOWANY SELEKTOR", api_cmd.reply)
        self.assertIn("SECONDARY", api_cmd.reply)

        cg_cmd = engine.send("/chatgpt Raport biznesowy SVL-364")
        self.assertTrue(cg_cmd.ok)
        self.assertIn("ChatGPT Business", cg_cmd.reply)

        cx_cmd = engine.send("/codex Skrypt diagnostyczny")
        self.assertTrue(cx_cmd.ok)
        self.assertIn("OpenAI Codex", cx_cmd.reply)

        wk_cmd = engine.send("/work Projekt Aetheria")
        self.assertTrue(wk_cmd.ok)
        self.assertIn("ChatGPT Work", wk_cmd.reply)

        ch_cmd = engine.send("/chroma 364")
        self.assertTrue(ch_cmd.ok)
        self.assertIn("000101101100", ch_cmd.reply)

        # 2. Doładowanie wszystkich 25 modułów przyciskiem
        top_turn = engine.send("module:all:topup_all_1000")
        self.assertTrue(top_turn.ok)
        self.assertIn("$1000.00 USD", top_turn.reply)
        self.assertIn("25000.00", top_turn.reply)

        # 3. Uniwersalny Terminal obsługujący dowolny rozkaz (np. "Raport z układu słonecznego")
        shell = JynOSShell(self.cfg)
        self.assertTrue(shell.execute_universal_terminal_command("Raport z układu słonecznego"))

        # 4. Autonomiczne użycie modułu przez samą Jyn podczas odpowiedzi na czacie (bez wymuszonych promptów)
        reply = {
            "model": "svl364-apex-uncensored:latest",
            "message": {
                "content": "Optymalizuję biokopułę [JYN_MODULE:exo_botany_biodome:adjust_climate] i kamerę [JYN_MODULE:cloud_vision_docai:analyze_camera]."
            },
            "done": True,
            "eval_count": 14,
            "eval_duration": 400_000_000,
        }
        with patch(
            "JYN_OS.ollama_client.urllib.request.urlopen",
            return_value=io.BytesIO(json.dumps(reply, ensure_ascii=False).encode("utf-8")),
        ):
            jyn_turn = engine.send("Sprawdź biokopuły i kamerę mostka")
        self.assertTrue(jyn_turn.ok)
        self.assertEqual(len(jyn_turn.ai_channels), 25)
        self.assertGreaterEqual(len(jyn_turn.invoked_modules), 2)
        self.assertGreaterEqual(len(jyn_turn.inline_tags), 3)

    def test_avatar_catalog_for_ai_and_lucy_fallout_for_operator(self):
        from JYN_OS.avatar_client import (
            AI_AVATAR_CATALOG,
            OPERATOR_AVATAR_LUCY_FALLOUT,
            select_ai_avatar,
            set_operator_lucy_fallout_avatar,
        )
        from JYN_OS.google_services_hub import GoogleServicesHub

        self.assertGreaterEqual(len(AI_AVATAR_CATALOG), 5)
        self.assertIn("Lucy MacLean", OPERATOR_AVATAR_LUCY_FALLOUT["title"])
        self.assertIn("Fallout", OPERATOR_AVATAR_LUCY_FALLOUT["character"])

        op_res = set_operator_lucy_fallout_avatar(self.cfg)
        self.assertTrue(op_res["ok"])
        self.assertEqual(op_res["profile"], "Operator")
        self.assertIn("Lucy MacLean", op_res["summary"])

        ai_res = select_ai_avatar("jyn_neural_core", self.cfg)
        self.assertTrue(ai_res["ok"])
        self.assertEqual(ai_res["selected_avatar"]["avatar_id"], "jyn_neural_core")

        hub = GoogleServicesHub(config=self.cfg, ollama=self.ollama, db_path=self.db_path)
        engine = JynChatEngine(config=self.cfg, ollama=self.ollama, google_hub=hub)
        av_turn = engine.send("/avatar")
        self.assertTrue(av_turn.ok)
        self.assertIn("Lucy MacLean", av_turn.reply)
        self.assertIn("jyn_neural_core", av_turn.reply)

        btn_av = engine.click_button("module:avatar_selector:operator_lucy_fallout")
        self.assertTrue(btn_av.ok)
        self.assertIn("Lucy MacLean", btn_av.reply)


if __name__ == "__main__":
    unittest.main()



