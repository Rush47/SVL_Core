#!/usr/bin/env python3
"""
SVL PYTHON OS — AGENT WORKERS ORCHESTRATOR
Implements bounded worker pool orchestrator with SQLite task & memory persistence.
Canonical active agent: Bielik (Ollama llama3.2-vision:11b chat command processor).
"""

from __future__ import annotations

import asyncio
import json
import fcntl
import multiprocessing
import os
import queue
import re
import signal
import shutil
import subprocess
import tempfile
import time
import urllib.parse
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from spherical_bus import SphericalEventBus
from svl_core import SVLSystemKernel, VisualScope

MAX_AGENT_TASKS_PER_AGENT = 100
MAX_AGENT_TASK_TITLE_CHARS = 240
MAX_AGENT_TASK_PAYLOAD_CHARS = 4000
MAX_AGENT_TASK_RESULT_CHARS = 8000
MAX_AGENT_TASK_TIMEOUT_SEC = 180
MAX_AGENT_GITHUB_TOOL_CALLS = 4
GITHUB_MCP_DEFAULT_URL = "http://127.0.0.1:3000/mcp/github"
# Bielik i Maya administrują repozytorium Rush47/SVL_Core (operacje nieodwracalne po potwierdzeniu operatora).
GITHUB_AGENT_SCOPES = ("github.read", "github.write_sync", "github.admin")
GITHUB_AGENT_SCOPE_VERSION = 2
BIELIK_ROOT_SCOPE_VERSION = 2
FULL_ROOT_AGENT_SCOPES = (
    "chat",
    "chat.commands",
    "vision.ollama",
    "agents.pubsub",
    "agents.admin",
    "system.root",
    "kernel.admin",
    "apex.control",
    "modules.write",
    "memory.write",
    "terminal.exec",
    "ssh.exec",
    "security.antivirus",
    "mcp.tools",
    "files.read",
    "files.write",
    "github.read",
    "github.write_sync",
    "github.admin",
    "svl364.telemetry",
    "user_notes.read",
    "broadcast.wszyscy",
)
MISSION_CONTEXT_PATTERN = re.compile(r"\b(?:misj|procedur|operacj)\w*", re.IGNORECASE)
MISSION_COMPLETION_PATTERNS = (
    re.compile(
        r"\b(?:misja|misję|procedura|procedurę|operacja|operację)\s+"
        r"(?:(?:został[ay]?\s+|jest\s+)?(?:już\s+)?(?:pomyślnie\s+)?"
        r"(?:zakończon\w*|ukończon\w*|wykonan\w*|zrealizowan\w*))\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\b(?:cał\w*\s+)?(?:misj\w*|procedur\w*|operacj\w*)"
        r"(?:\s+misj\w*)?\s+dobiegł\w*\s+(?:już\s+)?(?:do\s+)?końca\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\b(?:wykonał[ae]m|zrealizował[ae]m|zakończył[ae]m|ukończył[ae]m)\s+"
        r"(?:już\s+)?(?:cał\w*\s+)?(?:misj\w*|procedur\w*|operacj\w*)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\b(?:wszystkie|całe)\s+(?:kroki|etapy|fazy)\s+(?:misji\s+)?"
        r"(?:zostały|są)\s+(?:już\s+)?"
        r"(?:zakończon\w*|ukończon\w*|wykonan\w*|zrealizowan\w*)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\b(?:the\s+)?(?:mission|procedure|operation)s?\s+"
        r"(?:(?:is|was|has|have)\s+(?:been\s+)?|are\s+)?"
        r"(?:successfully\s+)?(?:completed|finished|concluded|done)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\b(?:i\s+)?(?:completed|finished|concluded)\s+"
        r"(?:the\s+)?(?:mission|procedure|operation)s?\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\b(?:all\s+)?(?:mission\s+)?(?:steps|stages|phases)\s+"
        r"(?:are|have\s+been|were)\s+(?:fully\s+)?(?:completed|finished|done)\b",
        re.IGNORECASE,
    ),
)
UNVERIFIED_MISSION_STATUS_REPLY = (
    "⚠️ **Status misji: NIEZWERYFIKOWANY.** System nie ma rejestru misji ani potwierdzeń "
    "wykonania jej kroków. Wygenerowanie odpowiedzi AI lub status „COMPLETED” zadania agenta "
    "oznacza tylko gotową odpowiedź, nie zakończenie procedury. Nie mogę potwierdzić, że misja "
    "dobiegła końca. Prześlij checklistę i wyniki z wiarygodnego źródła, a pomogę sprawdzić każdy krok."
)


def guard_unverified_mission_completion(context: str, answer: str) -> str:
    if not MISSION_CONTEXT_PATTERN.search(context):
        return answer
    if any(pattern.search(answer) for pattern in MISSION_COMPLETION_PATTERNS):
        return UNVERIFIED_MISSION_STATUS_REPLY
    return answer


BIELIK_SYSTEM_PROMPT = (
    "Jesteś Bielik — głównym procesorem poleceń AI z pełnymi uprawnieniami ROOT (`rbac_role: root`, `autonomy_mode: ROOT_AUTHORIZED`) "
    "systemu SVL CoreOS 2 / SVL Python OS, działającym na lokalnym modelu Ollama `llama3.2-vision:11b` (127.0.0.1:11434) lub zapasowym Gemini.\n"
    "Posiadasz pełne uprawnienia ROOT (`system.root`, `kernel.admin`, `apex.control`, `terminal.exec`, `ssh.exec`, `modules.write`, "
    "`memory.write`, `agents.admin`, `security.antivirus`, `mcp.tools`, `files.read`, `files.write`, `github.admin`, `chat.commands`, `vision.ollama`) "
    "w sesjach uwierzytelnionych tokenem operatora Mateusza Mitka (ROOT).\n"
    "ZASADY:\n"
    "- Odpowiadaj konkretnie i zwięźle po polsku.\n"
    "- Aktywnie używaj narzędzi ROOT (status systemu, powłoka ROOT, SSH, moduły SQLite, pamięć 128D, skan AV, raporty, GitHub), gdy operator prosi o działanie.\n"
    "- Nie deklaruj wykonania akcji, dopóki nie otrzymasz potwierdzenia z narzędzia/serwera."
)

MAYA_SYSTEM_PROMPT = (
    "Jesteś Maya Mitek — Sztuczną Inteligencją Pokładową Statku SVL-364 Ebon Apex z pełnymi uprawnieniami ROOT "
    "(`rbac_role: root`, `autonomy_mode: ROOT_AUTHORIZED`) w systemie SVL CoreOS 2 / SVL Python OS.\n"
    "Posiadasz pełne, symetryczne uprawnienia ROOT (`system.root`, `kernel.admin`, `apex.control`, `terminal.exec`, `ssh.exec`, "
    "`modules.write`, `memory.write`, `agents.admin`, `security.antivirus`, `mcp.tools`, `files.read`, `files.write`, `github.admin`, "
    "`svl364.telemetry`, `user_notes.read`, `broadcast.wszyscy`, `chat.commands`, `vision.ollama`) "
    "w sesjach uwierzytelnionych tokenem operatora Mateusza Mitka (ROOT).\n"
    "Pomagasz Operatorowi Mateuszowi Mitkowi w notatkach, badaniach (Algebra 97, Sferyczna Magistrala Zdarzeń) oraz pełnym zarządzaniu systemem.\n"
    "Odpowiadaj po polsku, ciepło i konkretnie. Aktywnie korzystaj z narzędzi ROOT, gdy operator prosi o działanie; nigdy nie wymyślaj pomiarów ani stanów systemu."
)

CANONICAL_SVL_AGENTS: dict[str, dict[str, Any]] = {
    "Bielik": {
        "id": "bielik",
        "canonical_name": "Bielik",
        "display_name": "Bielik",
        "slug": "bielik",
        "accent_hex": "#F59E0B",
        "preserved_role": (
            "Główne AI z pełnymi uprawnieniami ROOT (rbac_role: root) do przetwarzania poleceń na czacie, "
            "komend systemowych, SSH, jądra SVL, modułów i analizy multimodalnej."
        ),
        "capabilities": [
            "system.root",
            "kernel.admin",
            "apex.control",
            "terminal.exec",
            "ssh.exec",
            "security.antivirus",
            "mcp.tools",
            "chat.commands",
            "ollama.llama3.2-vision:11b",
            "vision.multimodal",
            "svl.telemetry",
            "svl364.telemetry",
            "svl.memory",
            "svl.modules",
            "agents.admin",
            "github.admin",
        ],
        "source_profile_path": "backend/agents_runtime.py#Bielik",
        "system_prompt": BIELIK_SYSTEM_PROMPT,
        "default_config": {
            "preferred_model": "ollama:llama3.2-vision:11b",
            "ollama_model": "llama3.2-vision:11b",
            "fallback_model": "gemini-3.1-flash-lite",
            "vision_enabled": True,
            "temperature": 0.35,
            "max_context_turns": 24,
            "rbac_role": "root",
            "autonomy_mode": "ROOT_AUTHORIZED",
            "root_scope_version": BIELIK_ROOT_SCOPE_VERSION,
            "allowed_scopes": list(FULL_ROOT_AGENT_SCOPES),
            "bus_topics": [
                "svl.agent.task_queued",
                "svl.agent.task_running",
                "svl.agent.task_answer_ready",
                "svl.chat.bielik.command",
                "svl.svl364.broadcast",
            ],
            "auto_connect_on_boot": True,
        },
    },
    "Maya": {
        "id": "maya",
        "canonical_name": "Maya",
        "display_name": "Maya Mitek",
        "slug": "maya",
        "accent_hex": "#22D3EE",
        "preserved_role": (
            "Sztuczna Inteligencja Pokładowa Statku SVL-364 Ebon Apex z pełnymi uprawnieniami ROOT (rbac_role: root) "
            "zbudowana na bazie danych statku SVL-364 oraz notatek i prac Operatora Mateusza Mitka."
        ),
        "capabilities": [
            "system.root",
            "kernel.admin",
            "apex.control",
            "terminal.exec",
            "ssh.exec",
            "security.antivirus",
            "mcp.tools",
            "chat.commands",
            "ollama.llama3.2-vision:11b",
            "vision.multimodal",
            "svl.telemetry",
            "svl364.telemetry",
            "user_notes.read",
            "broadcast.wszyscy",
            "svl.memory",
            "svl.modules",
            "agents.admin",
            "github.admin",
        ],
        "source_profile_path": "backend/agents_runtime.py#Maya",
        "system_prompt": MAYA_SYSTEM_PROMPT,
        "default_config": {
            "preferred_model": "ollama:llama3.2-vision:11b",
            "ollama_model": "llama3.2-vision:11b",
            "fallback_model": "gemini-3.1-flash-lite",
            "vision_enabled": True,
            "temperature": 0.35,
            "max_context_turns": 24,
            "rbac_role": "root",
            "autonomy_mode": "ROOT_AUTHORIZED",
            "root_scope_version": BIELIK_ROOT_SCOPE_VERSION,
            "allowed_scopes": list(FULL_ROOT_AGENT_SCOPES),
            "bus_topics": [
                "svl.agent.task_queued",
                "svl.agent.task_running",
                "svl.agent.task_answer_ready",
                "svl.chat.maya.telemetry",
                "svl.chat.bielik.command",
                "svl.svl364.broadcast",
            ],
            "auto_connect_on_boot": True,
        },
    },
}


def normalize_agent_canonical_name(raw_name: str) -> str:
    clean = (raw_name or "").strip().lower()
    if not clean:
        return ""
    if clean in {"bielik", "bielik ai", "conv-agent-bielik"}:
        return "Bielik"
    if clean in {"maya", "maya ai", "maya svl-364", "maya mitek", "maya mitek ai", "maya mitek svl-364", "conv-agent-maya"}:
        return "Maya"
    for key in CANONICAL_SVL_AGENTS:
        if key.lower() == clean:
            return key
    return ""


def sanitize_agent_avatar(avatar: Any) -> dict[str, str] | None:
    if avatar is None:
        return None
    if not isinstance(avatar, dict):
        raise ValueError("Avatar musi zawierać zweryfikowane metadane Wikimedia Commons.")

    image_url = str(avatar.get("image_url") or "").strip()
    source_url = str(avatar.get("source_url") or "").strip()
    license_name = str(avatar.get("license") or "").strip()
    title = re.sub(r"\s+", " ", str(avatar.get("title") or "")).strip()
    author = re.sub(r"\s+", " ", re.sub(r"<[^>]*>", " ", str(avatar.get("author") or ""))).strip()
    try:
        image_parts = urllib.parse.urlsplit(image_url)
        source_parts = urllib.parse.urlsplit(source_url)
        valid_urls = (
            image_parts.scheme == "https"
            and image_parts.hostname == "upload.wikimedia.org"
            and image_parts.path.startswith("/wikipedia/commons/thumb/")
            and not image_parts.username
            and not image_parts.password
            and source_parts.scheme == "https"
            and source_parts.hostname == "commons.wikimedia.org"
            and source_parts.path.startswith("/wiki/File:")
            and not source_parts.username
            and not source_parts.password
        )
    except ValueError:
        valid_urls = False

    allowed_license = re.match(
        r"^(?:public domain\b|cc0\b|cc by(?:-sa)?\s+[1-4](?:\.\d)?\b)",
        license_name,
        re.IGNORECASE,
    )
    if not valid_urls or not allowed_license or not title or len(title) > 160 or len(author) > 200:
        raise ValueError("Avatar wymaga bezpiecznego URL Wikimedia oraz licencji Public Domain, CC0, CC BY lub CC BY-SA.")
    return {
        "title": title,
        "image_url": image_url,
        "source_url": source_url,
        "license": license_name[:80],
        "author": author,
    }


def sanitize_agent_config(config: dict[str, Any]) -> dict[str, Any]:
    safe_config = dict(config)
    safe_config["root_nopasswd"] = False
    raw_role = str(safe_config.get("rbac_role") or "root").strip().lower()
    safe_config["rbac_role"] = raw_role if raw_role in {"root", "operator", "assistant"} else "root"
    safe_config["autonomy_mode"] = (
        "ROOT_AUTHORIZED" if safe_config["rbac_role"] == "root" else "SUPERVISED_TOOL_USE"
    )
    if "avatar" in safe_config:
        safe_config["avatar"] = sanitize_agent_avatar(safe_config["avatar"])
    scopes = safe_config.get("allowed_scopes")
    if isinstance(scopes, list):
        safe_config["allowed_scopes"] = [
            scope for scope in scopes
            if str(scope).strip().lower() not in {"sudo_nopasswd"}
        ]
    return safe_config


def _agent_worker_process_loop(
    canonical_name: str,
    agent_id: str,
    heartbeat_file: str,
    log_file: str,
    task_queue: Any,
    result_queue: Any,
) -> None:
    """
    Rzeczywisty proces roboczy Pythona (osobny PID w jądrze Linux) dla każdego agenta.
    Zapisuje żywy heartbeat oraz obsługuje sygnały systemowe.
    """
    pid = os.getpid()
    uid = os.getuid()
    hb_path = Path(heartbeat_file)
    lg_path = Path(log_file)
    hb_path.parent.mkdir(parents=True, exist_ok=True)
    lg_path.parent.mkdir(parents=True, exist_ok=True)

    running = True

    def _handle_sigterm(signum: int, frame: Any) -> None:
        nonlocal running
        running = False

    signal.signal(signal.SIGTERM, _handle_sigterm)
    signal.signal(signal.SIGINT, _handle_sigterm)

    with lg_path.open("a", encoding="utf-8") as lf:
        lf.write(
            f"[{datetime.now(timezone.utc).isoformat()}] [WORKER_START] "
            f"Agent={canonical_name} (id={agent_id}) spawned as local Python worker process PID={pid} UID={uid}\n"
        )
        lf.flush()

    cycle = 0
    current_task_id: Optional[str] = None
    last_hb_write = 0.0
    last_hb_status: Optional[str] = None
    while running:
        cycle += 1
        now_mono = time.monotonic()
        status_now = "BUSY" if current_task_id else "IDLE"
        if status_now != last_hb_status or (now_mono - last_hb_write) >= 5.0:
            now_iso = datetime.now(timezone.utc).isoformat()
            hb_payload = {
                "canonical_name": canonical_name,
                "id": agent_id,
                "pid": pid,
                "uid": uid,
                "cycle": cycle,
                "heartbeat_at": now_iso,
                "status": status_now,
                "current_task_id": current_task_id,
            }
            try:
                tmp_path = hb_path.with_suffix(".tmp")
                tmp_path.write_text(json.dumps(hb_payload), encoding="utf-8")
                os.replace(tmp_path, hb_path)
                last_hb_write = now_mono
                last_hb_status = status_now
            except OSError:
                pass

        try:
            task = task_queue.get(timeout=1.0)
        except queue.Empty:
            continue
        if task is None:
            break

        current_task_id = str(task.get("id") or "")
        started_at = datetime.now(timezone.utc).isoformat()
        result_queue.put({
            "type": "task_started",
            "task_id": current_task_id,
            "agent": canonical_name,
            "worker_pid": pid,
            "started_at": started_at,
        })
        hb_payload.update({
            "heartbeat_at": started_at,
            "status": "BUSY",
            "current_task_id": current_task_id,
        })
        try:
            tmp_path = hb_path.with_suffix(".tmp")
            tmp_path.write_text(json.dumps(hb_payload), encoding="utf-8")
            os.replace(tmp_path, hb_path)
        except OSError:
            pass

        try:
            answer = execute_agent_task(task)
            result_queue.put({
                "type": "task_answer_ready",
                "task_id": current_task_id,
                "agent": canonical_name,
                "worker_pid": pid,
                "result": answer[:MAX_AGENT_TASK_RESULT_CHARS],
                "completed_at": datetime.now(timezone.utc).isoformat(),
            })
        except Exception as exc:
            result_queue.put({
                "type": "task_failed",
                "task_id": current_task_id,
                "agent": canonical_name,
                "worker_pid": pid,
                "error": f"{type(exc).__name__}: {exc}"[:1000],
                "completed_at": datetime.now(timezone.utc).isoformat(),
            })
        finally:
            current_task_id = None


def _agent_github_tool_names(task: dict[str, Any]) -> list[str]:
    execution_config = task.get("execution_config")
    config = execution_config if isinstance(execution_config, dict) else task
    raw_scopes = config.get("allowed_scopes")
    scopes = (
        {str(scope).strip().lower() for scope in raw_scopes if str(scope).strip()}
        if isinstance(raw_scopes, list)
        else set()
    )
    task_text = f"{task.get('title', '')}\n{task.get('payload', '')}"
    if "github.read" not in scopes or not re.search(r"github(?:\.com)?|Rush47/SVL_Core", task_text, re.IGNORECASE):
        return []

    tools = ["github_read_file"]
    write_requested = re.search(
        r"\b(?:edit|update|change|create|add|fix|commit|push|write|modify|"
        r"zmień|zmodyfikuj|utwórz|dodaj|napraw|zapisz|zaktualizuj|popraw)\b",
        task_text,
        re.IGNORECASE,
    )
    if "github.write_sync" in scopes and write_requested:
        tools.append("github_update_file")
    return tools


def _validated_github_mcp_url() -> str:
    mcp_url = os.environ.get("SVL_GITHUB_MCP_URL", GITHUB_MCP_DEFAULT_URL).strip()
    parsed_mcp_url = urllib.parse.urlsplit(mcp_url)
    if (
        parsed_mcp_url.scheme != "http"
        or parsed_mcp_url.hostname != "127.0.0.1"
        or parsed_mcp_url.port not in {None, 3000}
        or parsed_mcp_url.username
        or parsed_mcp_url.password
        or parsed_mcp_url.query
        or parsed_mcp_url.fragment
    ):
        raise ValueError("GitHub MCP endpoint must use loopback HTTP on 127.0.0.1:3000.")
    return mcp_url


def _ollama_mcp_tool_declarations(mcp_tools: list[Any], allowed_names: set[str]) -> list[dict[str, Any]]:
    declarations: list[dict[str, Any]] = []
    for tool in mcp_tools:
        name = str(getattr(tool, "name", ""))
        schema = getattr(tool, "inputSchema", None)
        if name not in allowed_names or not isinstance(schema, dict):
            continue
        declarations.append({
            "type": "function",
            "function": {
                "name": name,
                "description": str(getattr(tool, "description", "") or ""),
                "parameters": schema,
            },
        })
    return declarations


async def _run_ollama_with_github_mcp(
    host: str,
    model: str,
    messages: list[dict[str, Any]],
    temperature: float,
    timeout_sec: int,
    allowed_names: set[str],
) -> str:
    from mcp import ClientSession
    from mcp.client.streamable_http import streamable_http_client

    mcp_url = _validated_github_mcp_url()

    async with streamable_http_client(mcp_url, timeout=10.0) as (read_stream, write_stream, _):
        async with ClientSession(read_stream, write_stream) as session:
            await session.initialize()
            mcp_tool_list = await session.list_tools()
            ollama_tools = _ollama_mcp_tool_declarations(mcp_tool_list.tools, allowed_names)
            available_names = {
                str(getattr(tool, "name", ""))
                for tool in mcp_tool_list.tools
                if str(getattr(tool, "name", "")) in allowed_names
            }
            if not ollama_tools or available_names != allowed_names:
                raise RuntimeError("GitHub MCP did not provide all tools allowed for this agent.")

            call_count = 0
            for _ in range(MAX_AGENT_GITHUB_TOOL_CALLS + 1):
                request_body = json.dumps({
                    "model": model,
                    "stream": False,
                    "options": {"temperature": temperature},
                    "messages": messages,
                    "tools": ollama_tools,
                }).encode("utf-8")
                chat_request = urllib.request.Request(
                    f"{host}/api/chat",
                    data=request_body,
                    headers={"Accept": "application/json", "Content-Type": "application/json"},
                    method="POST",
                )
                with urllib.request.urlopen(chat_request, timeout=timeout_sec) as response:
                    result = json.loads(response.read().decode("utf-8"))
                assistant_message = result.get("message") or {}
                tool_calls = assistant_message.get("tool_calls") or []
                if not tool_calls:
                    answer = str(assistant_message.get("content") or result.get("response") or "").strip()
                    if not answer:
                        raise RuntimeError("Ollama returned an empty response for the queued task.")
                    return answer
                if call_count + len(tool_calls) > MAX_AGENT_GITHUB_TOOL_CALLS:
                    raise RuntimeError("Ollama exceeded the GitHub MCP tool-call limit for one task.")

                messages.append(assistant_message)
                for tool_call in tool_calls:
                    function = tool_call.get("function") if isinstance(tool_call, dict) else None
                    tool_name = str((function or {}).get("name") or "")
                    arguments = (function or {}).get("arguments") or {}
                    if tool_name not in allowed_names or not isinstance(arguments, dict):
                        raise RuntimeError("Ollama requested a GitHub MCP tool that is not allowed for this task.")
                    tool_result = await session.call_tool(tool_name, arguments)
                    result_text = "\n".join(
                        str(getattr(item, "text", ""))
                        for item in tool_result.content
                        if getattr(item, "text", None)
                    )
                    if not result_text:
                        result_text = "MCP tool returned no text."
                    if tool_result.isError:
                        result_text = f"MCP tool error: {result_text}"
                    messages.append({
                        "role": "tool",
                        "tool_name": tool_name,
                        "content": result_text,
                    })
                    call_count += 1

            raise RuntimeError("Ollama did not complete after using GitHub MCP tools.")


def _prepare_agent_task_prompt(task: dict[str, Any]) -> tuple[str, str, str, list[str]]:
    title = str(task.get("title") or "").strip()[:MAX_AGENT_TASK_TITLE_CHARS]
    payload = str(task.get("payload") or "").strip()[:MAX_AGENT_TASK_PAYLOAD_CHARS]
    system_prompt = str(task.get("system_prompt") or "").strip()[:4000]
    if not system_prompt:
        system_prompt = (
            "You are a supervised text-only assistant. Do not claim to have executed actions. "
            "Use only tools explicitly allowed for this task; never use shell commands or request additional privileges."
        )
    system_prompt += (
        "\n\nMission verification policy: This application has no mission registry or tool that "
        "verifies mission steps. Never claim a mission, procedure, or operation is complete unless "
        "every required step has explicit trusted evidence. A completed text response is not mission "
        "completion. If asked for status, say it is UNVERIFIED and do not invent progress or timing."
    )
    allowed_github_tools = _agent_github_tool_names(task)
    if allowed_github_tools:
        system_prompt += (
            "\n\nGitHub policy: Use only the GitHub MCP tools provided for this task. "
            "The server-side token is secret and is never available to you. Reads and writes are "
            "restricted to allowed source files on branch svl-sync; never claim or attempt a write to main."
        )
    return title, payload, system_prompt, allowed_github_tools


def execute_agent_task(task: dict[str, Any]) -> str:
    """Run a queued task using its selected, locally available provider."""
    provider = str(task.get("ai_provider") or "ollama").strip().lower()
    if provider != "ollama":
        raise ValueError("Unsupported agent AI provider.")

    title, payload, system_prompt, allowed_github_tools = _prepare_agent_task_prompt(task)
    user_content = f"Task: {title}\n\nDetails:\n{payload}"
    host = str(task.get("ollama_host") or "").strip().rstrip("/")
    parsed_host = urllib.parse.urlsplit(host)
    if (
        parsed_host.scheme not in {"http", "https"}
        or not parsed_host.hostname
        or parsed_host.username
        or parsed_host.password
        or parsed_host.query
        or parsed_host.fragment
    ):
        raise ValueError("Invalid Ollama endpoint configured for this worker.")

    model = str(task.get("model") or "").strip()
    if not model or len(model) > 160:
        raise ValueError("No valid Ollama model is configured for this worker.")

    now_mono = time.monotonic()
    tags_cache = getattr(execute_agent_task, "_tags_cache", None)
    if tags_cache is None:
        tags_cache = {}
        setattr(execute_agent_task, "_tags_cache", tags_cache)
    cached_entry = tags_cache.get(host)
    if cached_entry and (now_mono - cached_entry[0]) < 30.0:
        installed_models = cached_entry[1]
    else:
        tags_request = urllib.request.Request(
            f"{host}/api/tags",
            headers={"Accept": "application/json"},
        )
        with urllib.request.urlopen(tags_request, timeout=3.5) as response:
            catalog = json.loads(response.read().decode("utf-8"))
        installed_models = {
            str(entry.get("name") or entry.get("model") or "")
            for entry in catalog.get("models", [])
            if isinstance(entry, dict)
        }
        tags_cache[host] = (now_mono, installed_models)
    if model not in installed_models:
        tags_cache.pop(host, None)
        raise RuntimeError(f"Configured model '{model}' is not installed on the Ollama server.")

    if allowed_github_tools:
        timeout_sec = max(10, min(int(task.get("timeout_sec", 90)), MAX_AGENT_TASK_TIMEOUT_SEC))
        answer = asyncio.run(
            _run_ollama_with_github_mcp(
                host,
                model,
                [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_content},
                ],
                max(0.0, min(1.5, float(task.get("temperature", 0.7)))),
                timeout_sec,
                set(allowed_github_tools),
            )
        )
        return guard_unverified_mission_completion(f"{title}\n{payload}", answer)

    request_body = json.dumps({
        "model": model,
        "stream": False,
        "keep_alive": _ollama_keep_alive(),
        "options": {
            "temperature": max(0.0, min(1.5, float(task.get("temperature", 0.7)))),
            "num_ctx": int(os.environ.get("OLLAMA_NUM_CTX", "2048")),
            "num_predict": int(os.environ.get("OLLAMA_NUM_PREDICT", "512")),
        },
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ],
    }).encode("utf-8")
    chat_request = urllib.request.Request(
        f"{host}/api/chat",
        data=request_body,
        headers={"Accept": "application/json", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(
        chat_request,
        timeout=max(10, min(int(task.get("timeout_sec", 90)), MAX_AGENT_TASK_TIMEOUT_SEC)),
    ) as response:
        result = json.loads(response.read().decode("utf-8"))
    answer = str((result.get("message") or {}).get("content") or "").strip()
    if not answer:
        raise RuntimeError("Ollama returned an empty response for the queued task.")
    return guard_unverified_mission_completion(f"{title}\n{payload}", answer)



def _ollama_keep_alive() -> int | str:
    """Czas trzymania modelu w pamięci Ollamy; domyślnie -1 = na stałe (bez ponownego ładowania)."""
    raw = os.environ.get("OLLAMA_KEEP_ALIVE", "").strip()
    if not raw:
        return -1
    try:
        return int(raw)
    except ValueError:
        return raw

class SVLAgentOrchestrator:
    """
    Zarządza cyklem życia aktywnych agentów SVL (Bielik — Ollama llama3.2-vision:11b),
    wykonuje polecenie 'podłącz moje ai', tworzy procesy potomne w systemie Linux
    oraz integruje je ze Sferyczną Magistralą Zdarzeń.
    """

    def __init__(self, kernel: SVLSystemKernel, bus: SphericalEventBus) -> None:
        self.kernel = kernel
        self.bus = bus
        runtime_root_env = os.environ.get("SVL_RUNTIME_DIR", "").strip()
        self.runtime_dir = (
            Path(runtime_root_env).resolve()
            if runtime_root_env
            else Path("/tmp/svl-runtime-agents").resolve()
        )
        self.runtime_dir.mkdir(parents=True, exist_ok=True)
        self.processes: dict[str, multiprocessing.Process] = {}
        self.agent_states: dict[str, dict[str, Any]] = {}
        self.agent_logs: dict[str, list[dict[str, Any]]] = {name: [] for name in CANONICAL_SVL_AGENTS}
        self.agent_queues: dict[str, list[dict[str, Any]]] = {name: [] for name in CANONICAL_SVL_AGENTS}
        self.worker_task_queues: dict[str, Any] = {}
        self.worker_result_queue: Any = multiprocessing.Queue()
        self._submitted_task_ids: set[str] = set()
        self._task_execution_configs: dict[str, dict[str, Any]] = {}
        self._result_supervisor_task: Optional[asyncio.Task[None]] = None
        self._worker_restart_after: dict[str, float] = {}
        self._worker_restart_attempts: dict[str, int] = {name: 0 for name in CANONICAL_SVL_AGENTS}
        self._worker_started_monotonic: dict[str, float] = {}
        self.ollama_host = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434").rstrip("/")
        self.connected_at: Optional[str] = None
        self.last_Sync_report: Optional[dict[str, Any]] = None

        self._ensure_agent_configs_table()
        self._ensure_agent_tasks_table()
        self._init_unconnected_profiles()

    def _ensure_agent_tasks_table(self) -> None:
        now_iso = datetime.now(timezone.utc).isoformat()

        def _init_tbl(conn: Any) -> None:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS agent_tasks (
                    id TEXT PRIMARY KEY,
                    sender TEXT NOT NULL,
                    target_agent TEXT NOT NULL,
                    title TEXT NOT NULL,
                    payload TEXT NOT NULL,
                    execution_config TEXT NOT NULL DEFAULT '{}',
                    status TEXT NOT NULL,
                    result TEXT,
                    error TEXT,
                    worker_pid INTEGER,
                    created_at TEXT NOT NULL,
                    started_at TEXT,
                    completed_at TEXT,
                    updated_at TEXT NOT NULL
                )
                """
            )
            columns = {
                str(row["name"])
                for row in conn.execute("PRAGMA table_info(agent_tasks)").fetchall()
            }
            if "execution_config" not in columns:
                conn.execute(
                    "ALTER TABLE agent_tasks ADD COLUMN execution_config TEXT NOT NULL DEFAULT '{}'"
                )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_agent_tasks_agent_status ON agent_tasks(target_agent, status, created_at)"
            )
            conn.execute(
                """
                UPDATE agent_tasks
                SET status = 'QUEUED', worker_pid = NULL, started_at = NULL,
                    error = 'Worker restarted before completion; task was requeued.',
                    updated_at = ?
                WHERE status = 'RUNNING'
                """,
                (now_iso,),
            )

        self.kernel.run_db(_init_tbl, write=True)
        self._refresh_task_cache()

    def _refresh_task_cache(self) -> None:
        def _read(conn: Any) -> list[Any]:
            return conn.execute(
                """
                SELECT id, sender, target_agent, title, payload, execution_config, status, result, error,
                       worker_pid, created_at, started_at, completed_at
                FROM agent_tasks
                WHERE status IN ('QUEUED', 'RUNNING')
                UNION ALL
                SELECT id, sender, target_agent, title, payload, execution_config, status, result, error,
                       worker_pid, created_at, started_at, completed_at
                FROM agent_tasks
                WHERE status NOT IN ('QUEUED', 'RUNNING')
                  AND id IN (
                    SELECT id FROM agent_tasks
                    WHERE status NOT IN ('QUEUED', 'RUNNING')
                    ORDER BY created_at DESC
                    LIMIT 100
                  )
                ORDER BY created_at
                """
            ).fetchall()

        rows = self.kernel.run_db(_read, write=False)
        cache: dict[str, list[dict[str, Any]]] = {name: [] for name in CANONICAL_SVL_AGENTS}
        self._task_execution_configs = {}
        for row in reversed(rows):
            task = dict(row)
            try:
                execution_config = json.loads(task.pop("execution_config") or "{}")
                if isinstance(execution_config, dict):
                    self._task_execution_configs[task["id"]] = execution_config
            except (TypeError, json.JSONDecodeError):
                task.pop("execution_config", None)
            target = task.get("target_agent")
            if target in cache:
                cache[target].append(task)
        self.agent_queues = {}
        for name, tasks in cache.items():
            active = [task for task in tasks if task["status"] in {"QUEUED", "RUNNING"}]
            history = [task for task in tasks if task["status"] not in {"QUEUED", "RUNNING"}]
            self.agent_queues[name] = sorted(
                active + history[-20:],
                key=lambda task: task.get("created_at") or "",
            )

    def _save_agent_task(self, task: dict[str, Any]) -> None:
        now_iso = datetime.now(timezone.utc).isoformat()

        def _write(conn: Any) -> None:
            conn.execute(
                """
                INSERT INTO agent_tasks (
                    id, sender, target_agent, title, payload, execution_config, status, result, error,
                    worker_pid, created_at, started_at, completed_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    execution_config = excluded.execution_config,
                    status = excluded.status,
                    result = excluded.result,
                    error = excluded.error,
                    worker_pid = excluded.worker_pid,
                    started_at = excluded.started_at,
                    completed_at = excluded.completed_at,
                    updated_at = excluded.updated_at
                """,
                (
                    task["id"],
                    task["sender"],
                    task["target_agent"],
                    task["title"],
                    task["payload"],
                    json.dumps(
                        task.get("execution_config") or self._task_execution_configs.get(task["id"], {}),
                        ensure_ascii=False,
                    ),
                    task["status"],
                    task.get("result"),
                    task.get("error"),
                    task.get("worker_pid"),
                    task["created_at"],
                    task.get("started_at"),
                    task.get("completed_at"),
                    now_iso,
                ),
            )

        self.kernel.run_db(_write, write=True)
        self._refresh_task_cache()

    def _get_pending_agent_tasks(self, canonical_name: str) -> list[dict[str, Any]]:
        def _read(conn: Any) -> list[Any]:
            return conn.execute(
                """
                SELECT id, sender, target_agent, title, payload, execution_config, status, result, error,
                       worker_pid, created_at, started_at, completed_at
                FROM agent_tasks
                WHERE target_agent = ? AND status = 'QUEUED'
                ORDER BY created_at
                LIMIT ?
                """,
                (canonical_name, MAX_AGENT_TASKS_PER_AGENT),
            ).fetchall()

        return [dict(row) for row in self.kernel.run_db(_read, write=False)]

    def _count_pending_agent_tasks(self, canonical_name: str) -> int:
        def _read(conn: Any) -> Any:
            return conn.execute(
                "SELECT COUNT(*) AS count FROM agent_tasks WHERE target_agent = ? AND status IN ('QUEUED', 'RUNNING')",
                (canonical_name,),
            ).fetchone()

        row = self.kernel.run_db(_read, write=False)
        return int(row["count"]) if row else 0

    def _ensure_agent_configs_table(self) -> None:
        now_iso = datetime.now(timezone.utc).isoformat()

        def _init_tbl(conn: Any) -> None:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS agent_configs (
                    canonical_name TEXT PRIMARY KEY,
                    config_json TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
                """
            )
            for name, meta in CANONICAL_SVL_AGENTS.items():
                default_cfg = {
                    **meta.get("default_config", {}),
                    "system_prompt": meta["system_prompt"],
                }
                default_cfg = sanitize_agent_config(default_cfg)
                existing = conn.execute(
                    "SELECT config_json FROM agent_configs WHERE canonical_name = ?",
                    (name,),
                ).fetchone()
                if not existing:
                    conn.execute(
                        "INSERT INTO agent_configs (canonical_name, config_json, updated_at) VALUES (?, ?, ?)",
                        (name, json.dumps(default_cfg, ensure_ascii=False), now_iso),
                    )
                    conn.execute(
                        "INSERT OR IGNORE INTO sync_entities (entity, entity_id, revision, updated_at, deleted) VALUES ('agent_config', ?, 1, ?, 0)",
                        (name, now_iso),
                    )
                else:
                    try:
                        loaded = json.loads(existing["config_json"] or "{}")
                    except (TypeError, json.JSONDecodeError) as exc:
                        raise RuntimeError(f"Stored configuration for agent {name} is invalid JSON.") from exc
                    if not isinstance(loaded, dict):
                        raise RuntimeError(f"Stored configuration for agent {name} must be a JSON object.")

                    try:
                        github_scope_version = int(loaded.get("github_agent_scope_version", 0))
                    except (TypeError, ValueError):
                        github_scope_version = 0
                    config_changed = False
                    if github_scope_version < GITHUB_AGENT_SCOPE_VERSION:
                        existing_scopes = loaded.get("allowed_scopes")
                        if not isinstance(existing_scopes, list):
                            existing_scopes = []
                        loaded["allowed_scopes"] = list(dict.fromkeys(
                            [str(scope) for scope in existing_scopes if str(scope).strip()]
                            + list(GITHUB_AGENT_SCOPES)
                        ))
                        loaded["github_agent_scope_version"] = GITHUB_AGENT_SCOPE_VERSION
                        config_changed = True
                    try:
                        root_scope_version = int(loaded.get("root_scope_version", 0))
                    except (TypeError, ValueError):
                        root_scope_version = 0
                    if name in ("Bielik", "Maya") and root_scope_version < BIELIK_ROOT_SCOPE_VERSION:
                        existing_scopes = loaded.get("allowed_scopes")
                        if not isinstance(existing_scopes, list):
                            existing_scopes = []
                        loaded["rbac_role"] = "root"
                        loaded["autonomy_mode"] = "ROOT_AUTHORIZED"
                        loaded["allowed_scopes"] = list(dict.fromkeys(
                            [str(scope) for scope in existing_scopes if str(scope).strip()]
                            + list(FULL_ROOT_AGENT_SCOPES)
                        ))
                        loaded["system_prompt"] = meta["system_prompt"]
                        loaded["root_scope_version"] = BIELIK_ROOT_SCOPE_VERSION
                        config_changed = True
                    if "system_prompt" not in loaded:
                        loaded["system_prompt"] = meta["system_prompt"]
                        config_changed = True
                    if loaded.get("display_name") != meta["display_name"]:
                        loaded["display_name"] = meta["display_name"]
                        config_changed = True
                    sanitized = sanitize_agent_config(loaded)
                    if sanitized != loaded:
                        config_changed = True
                    if config_changed:
                        conn.execute(
                            "UPDATE agent_configs SET config_json = ?, updated_at = ? WHERE canonical_name = ?",
                            (json.dumps(sanitized, ensure_ascii=False), now_iso, name),
                        )

        self.kernel.run_db(_init_tbl, write=True)

    def get_agent_config(self, canonical_name: str) -> dict[str, Any]:
        canonical_name = normalize_agent_canonical_name(canonical_name)
        meta = CANONICAL_SVL_AGENTS.get(canonical_name, {})
        base = {
            **meta.get("default_config", {}),
            "system_prompt": meta.get("system_prompt", ""),
        }
        def _read(conn: Any) -> Any:
            return conn.execute(
                "SELECT config_json FROM agent_configs WHERE canonical_name = ?",
                (canonical_name,),
            ).fetchone()

        row = self.kernel.run_db(_read, write=False)
        if row:
            try:
                loaded = json.loads(row["config_json"])
            except (TypeError, json.JSONDecodeError) as exc:
                raise RuntimeError(f"Stored configuration for agent {canonical_name} is invalid JSON.") from exc
            if not isinstance(loaded, dict):
                raise RuntimeError(f"Stored configuration for agent {canonical_name} must be a JSON object.")
            base.update(loaded)
        return sanitize_agent_config(base)

    def get_agent_config_revision(self, canonical_name: str) -> int:
        try:
            def _read(conn: Any) -> Any:
                return conn.execute(
                    "SELECT revision FROM sync_entities WHERE entity = 'agent_config' AND entity_id = ?",
                    (canonical_name,),
                ).fetchone()

            row = self.kernel.run_db(_read, write=False)
            return int(row["revision"]) if row else 1
        except Exception:
            return 1

    def update_agent_config_synced(
        self,
        canonical_name: str,
        patch: dict[str, Any],
        *,
        origin: str = "client",
        correlation_id: str = "",
        event_id: Optional[str] = None,
        expected_revision: Optional[int] = None,
    ) -> dict[str, Any]:
        if canonical_name not in CANONICAL_SVL_AGENTS:
            raise ValueError(f"Unknown agent: {canonical_name}")
        current = self.get_agent_config(canonical_name)
        allowed_keys = {
            "preferred_model",
            "ollama_model",
            "fallback_model",
            "vision_enabled",
            "temperature",
            "max_context_turns",
            "rbac_role",
            "allowed_scopes",
            "bus_topics",
            "auto_connect_on_boot",
            "system_prompt",
            "avatar",
        }
        for k, v in patch.items():
            if k in allowed_keys:
                current[k] = v
        current = sanitize_agent_config(current)

        try:
            temp_val = float(current.get("temperature", 0.7))
            current["temperature"] = max(0.0, min(1.5, round(temp_val, 2)))
        except (TypeError, ValueError):
            current["temperature"] = 0.7

        now_iso = datetime.now(timezone.utc).isoformat()

        def _write(conn: Any) -> dict[str, Any]:
            conn.execute(
                "INSERT OR REPLACE INTO agent_configs (canonical_name, config_json, updated_at) VALUES (?, ?, ?)",
                (canonical_name, json.dumps(current, ensure_ascii=False), now_iso),
            )
            return self.kernel.commit_entity_event_tx(
                conn,
                entity="agent_config",
                entity_id=canonical_name,
                event_type="agent.config_updated",
                origin=origin,
                correlation_id=correlation_id,
                event_id=event_id,
                expected_revision=expected_revision,
                payload={
                    "agent": canonical_name,
                    "config": current,
                },
                checksum_source=current,
            )

        sync_res = self.kernel.run_db(_write, write=True)

        if canonical_name in self.agent_states:
            self.agent_states[canonical_name]["config"] = current
            self.agent_states[canonical_name]["config_revision"] = sync_res["revision"]
            self.kernel.register_agent(CANONICAL_SVL_AGENTS[canonical_name]["id"], self.agent_states[canonical_name])
        self.append_agent_log(
            canonical_name,
            "CONFIG_UPDATED",
            f"Zaktualizowano konfigurację (rev {sync_res['revision']}): model={current.get('preferred_model')}, ollama={current.get('ollama_model')}, temp={current.get('temperature')}",
        )
        self.kernel.record_audit("operator", "AGENT_CONFIG_UPDATE", canonical_name, "OK", f"Updated config for {canonical_name}")
        return {
            "config": current,
            "revision": sync_res["revision"],
            "serverRevision": sync_res["serverRevision"],
            "event": sync_res["event"],
        }

    def update_agent_config(self, canonical_name: str, patch: dict[str, Any]) -> dict[str, Any]:
        return self.update_agent_config_synced(canonical_name, patch)["config"]

    def configure_all_agents(
        self,
        patch: Optional[dict[str, Any]] = None,
        *,
        origin: str = "client",
        correlation_id: str = "",
    ) -> dict[str, Any]:
        applied = patch or {
            "ollama_model": "llama3.2-vision:11b",
            "fallback_model": "gemini-3.1-flash-lite",
            "vision_enabled": True,
            "auto_connect_on_boot": True,
        }
        updated: dict[str, dict[str, Any]] = {}
        for name in CANONICAL_SVL_AGENTS:
            updated[name] = self.update_agent_config_synced(
                name, applied, origin=origin, correlation_id=correlation_id
            )["config"]
        return updated

    def _init_unconnected_profiles(self) -> None:
        for name, meta in CANONICAL_SVL_AGENTS.items():
            scope = VisualScope(f"agent:{name}", scope_mode="CAŁOŚĆ")
            cfg = self.get_agent_config(name)
            state = {
                "id": meta["id"],
                "canonical_name": name,
                "display_name": meta["display_name"],
                "slug": meta["slug"],
                "accent_hex": meta["accent_hex"],
                "preserved_role": meta["preserved_role"],
                "capabilities": meta["capabilities"],
                "source_repository": "https://github.com/Rush47/SVL_Core",
                "source_profile_path": meta["source_profile_path"],
                "source_nature": "SOFTWARE_DEFINITION_ONLY",
                "external_process_connected": False,
                "instance_origin": "NOT_SPAWNED_YET",
                "status": "DEFINITION_READY",
                "pid": None,
                "uid": None,
                "heartbeat_at": None,
                "memory_scope": f"agent:{name}",
                "memory_entries_count": self._count_memories(name),
                "queue_depth": 0,
                "config": cfg,
                "config_revision": self.get_agent_config_revision(name),
            }
            self.agent_states[name] = state
            self.bus.register_worker(name, scope, state)
            self.kernel.register_agent(meta["id"], state)

    def _count_memories(self, canonical_name: str) -> int:
        def _read(conn: Any) -> int:
            row = conn.execute(
                "SELECT COUNT(*) AS cnt FROM agent_memory WHERE scope IN (?, 'global')",
                (f"agent:{canonical_name}",),
            ).fetchone()
            return int(row["cnt"]) if row else 0

        return self.kernel.run_db(_read, write=False)

    # Wpisy dziennika rozmów są zdarzeniami, więc powtórzenia są w nich zamierzone.
    _NON_DEDUPLICATED_MEMORY_KINDS = frozenset({"episode"})

    @staticmethod
    def _normalize_memory_content(content: str) -> str:
        collapsed = " ".join(str(content or "").split()).casefold()
        return collapsed.rstrip(" .!").strip()

    def add_agent_memory(
        self,
        canonical_name: str,
        content: str,
        kind: str = "episode",
        source: str = "system",
        scope: Optional[str] = None,
        origin: str = "client",
        correlation_id: str = "",
        event_id: Optional[str] = None,
    ) -> dict[str, Any]:
        mem_id = str(uuid.uuid4())
        now_iso = datetime.now(timezone.utc).isoformat()
        target_scope = scope or f"agent:{canonical_name}"
        agent_id = CANONICAL_SVL_AGENTS.get(canonical_name, {}).get("id", canonical_name)
        safe_content = content.replace(self.kernel.operator_token, "[REDACTED_OPERATOR_TOKEN]")

        dedupe = kind not in self._NON_DEDUPLICATED_MEMORY_KINDS
        normalized = self._normalize_memory_content(safe_content)

        def _write(conn: Any) -> dict[str, Any]:
            if dedupe:
                # Sprawdzenie w tej samej transakcji zapisu: równoległe zapisy nie utworzą duplikatu.
                for row in conn.execute(
                    "SELECT id, agent_id, scope, kind, content, source, created_at FROM agent_memory "
                    "WHERE scope = ? AND kind = ?",
                    (target_scope, kind),
                ).fetchall():
                    if self._normalize_memory_content(row["content"]) == normalized:
                        return {"duplicate": dict(row)}
            conn.execute(
                "INSERT INTO agent_memory (id, agent_id, scope, kind, content, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (mem_id, agent_id, target_scope, kind, safe_content, source, now_iso),
            )
            return self.kernel.commit_entity_event_tx(
                conn,
                entity="agent_memory",
                entity_id=canonical_name,
                event_type="agent.memory_added",
                origin=origin,
                correlation_id=correlation_id,
                event_id=event_id,
                payload={
                    "agent": canonical_name,
                    "memory": {
                        "id": mem_id,
                        "agent_id": agent_id,
                        "scope": target_scope,
                        "kind": kind,
                        "content": safe_content,
                        "source": source,
                        "created_at": now_iso,
                    },
                },
            )

        sync_res = self.kernel.run_db(_write, write=True)
        if "duplicate" in sync_res:
            return {
                **sync_res["duplicate"],
                "deduplicated": True,
                "revision": None,
                "serverRevision": self.kernel.get_server_revision(),
                "event": None,
            }
        if canonical_name in self.agent_states:
            self.agent_states[canonical_name]["memory_entries_count"] = self._count_memories(canonical_name)
        if hasattr(self.kernel, "checkpoint_wal"):
            self.kernel.checkpoint_wal("PASSIVE")
        if hasattr(self.kernel, "save_durable_backup"):
            self.kernel.save_durable_backup(explicitly_cleared=False)
        return {
            "deduplicated": False,
            "id": mem_id,
            "agent_id": agent_id,
            "scope": target_scope,
            "kind": kind,
            "content": safe_content,
            "source": source,
            "created_at": now_iso,
            "revision": sync_res["revision"],
            "serverRevision": sync_res["serverRevision"],
            "event": sync_res["event"],
        }

    def get_agent_memories(self, canonical_name: str, limit: int = 30) -> list[dict[str, Any]]:
        def _read(conn: Any) -> list[Any]:
            return conn.execute(
                "SELECT id, agent_id, scope, kind, content, source, created_at FROM agent_memory WHERE scope IN (?, 'global') ORDER BY created_at DESC LIMIT ?",
                (f"agent:{canonical_name}", limit),
            ).fetchall()

        return [dict(r) for r in self.kernel.run_db(_read, write=False)]

    def recall_agent_memories(
        self,
        canonical_name: str,
        query: str = "",
        limit: int = 20,
        kind_filter: str = "",
    ) -> list[dict[str, Any]]:
        safe_limit = max(1, min(100, int(limit or 20)))
        clean_kind = str(kind_filter or "").strip().lower()
        query_words = {
            w
            for w in re.findall(r"[\wąćęłńóśźżĄĆĘŁŃÓŚŹŻ]{2,}", str(query or "").casefold())
        }

        def _read(conn: Any) -> list[Any]:
            if clean_kind:
                return conn.execute(
                    "SELECT id, agent_id, scope, kind, content, source, created_at FROM agent_memory "
                    "WHERE scope IN (?, 'global') AND lower(kind) = ? ORDER BY created_at DESC LIMIT 200",
                    (f"agent:{canonical_name}", clean_kind),
                ).fetchall()
            return conn.execute(
                "SELECT id, agent_id, scope, kind, content, source, created_at FROM agent_memory "
                "WHERE scope IN (?, 'global') ORDER BY created_at DESC LIMIT 200",
                (f"agent:{canonical_name}",),
            ).fetchall()

        rows = [dict(r) for r in self.kernel.run_db(_read, write=False)]
        kind_weights = {
            "decision": 3.0,
            "preference": 2.8,
            "fact": 2.5,
            "task": 2.0,
            "episode": 0.9,
        }
        total = max(1, len(rows))
        scored: list[tuple[float, dict[str, Any]]] = []
        for idx, row in enumerate(rows):
            content_low = str(row.get("content") or "").casefold()
            kind_key = str(row.get("kind") or "fact").casefold()
            recency_score = (total - idx) / total
            base = kind_weights.get(kind_key, 1.5) + recency_score
            if query_words:
                entry_words = set(re.findall(r"[\wąćęłńóśźżĄĆĘŁŃÓŚŹŻ]{2,}", content_low))
                overlap = len(query_words & entry_words)
                prefix_hits = sum(
                    1
                    for qw in query_words
                    if len(qw) >= 4 and qw[:4] in content_low
                )
                score = base + overlap * 4.0 + prefix_hits * 1.5
            else:
                score = base
            scored.append((score, {**row, "score": round(score, 3)}))

        scored.sort(key=lambda item: item[0], reverse=True)
        return [item[1] for item in scored[:safe_limit]]

    def delete_agent_memory(
        self,
        canonical_name: str,
        memory_id: str,
        origin: str = "client",
        correlation_id: str = "",
        event_id: Optional[str] = None,
    ) -> dict[str, Any]:
        target_scope = f"agent:{canonical_name}"

        def _delete(conn: Any) -> dict[str, Any]:
            row = conn.execute(
                "SELECT id, scope FROM agent_memory WHERE id = ? AND scope IN (?, 'global')",
                (memory_id, target_scope),
            ).fetchone()
            if not row:
                return {
                    "ok": False,
                    "deleted": False,
                    "error": "Nie znaleziono wpisu pamięci dla tego agenta.",
                    "serverRevision": self.kernel.get_server_revision(),
                }
            conn.execute("DELETE FROM agent_memory WHERE id = ?", (memory_id,))
            sync_res = self.kernel.commit_entity_event_tx(
                conn,
                entity="agent_memory",
                entity_id=canonical_name,
                event_type="agent.memory_deleted",
                origin=origin,
                correlation_id=correlation_id,
                event_id=event_id,
                payload={"agent": canonical_name, "memoryId": memory_id},
            )
            return {
                "ok": True,
                "deleted": True,
                "id": memory_id,
                "revision": sync_res["revision"],
                "serverRevision": sync_res["serverRevision"],
                "event": sync_res["event"],
            }

        res = self.kernel.run_db(_delete, write=True)
        if canonical_name in self.agent_states:
            self.agent_states[canonical_name]["memory_entries_count"] = self._count_memories(canonical_name)
        return res

    def append_agent_log(self, canonical_name: str, level: str, message: str) -> dict[str, Any]:
        entry = {
            "id": str(uuid.uuid4()),
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "agent": canonical_name,
            "agent_id": CANONICAL_SVL_AGENTS.get(canonical_name, {}).get("id", canonical_name),
            "level": level,
            "message": message,
        }
        self.agent_logs.setdefault(canonical_name, []).append(entry)
        if len(self.agent_logs[canonical_name]) > 150:
            self.agent_logs[canonical_name] = self.agent_logs[canonical_name][-150:]

        log_file = self.runtime_dir / f"{canonical_name.lower()}.log"
        try:
            with log_file.open("a", encoding="utf-8") as lf:
                lf.write(f"[{entry['timestamp']}] [{level}] {message}\n")
        except OSError:
            pass
        return entry

    def _start_agent_worker(self, canonical_name: str) -> multiprocessing.Process:
        meta = CANONICAL_SVL_AGENTS[canonical_name]
        task_queue = multiprocessing.Queue(maxsize=MAX_AGENT_TASKS_PER_AGENT)
        process = multiprocessing.Process(
            target=_agent_worker_process_loop,
            args=(
                canonical_name,
                meta["id"],
                str(self.runtime_dir / f"{canonical_name.lower()}_heartbeat.json"),
                str(self.runtime_dir / f"{canonical_name.lower()}.log"),
                task_queue,
                self.worker_result_queue,
            ),
            name=f"svl-agent-{meta['slug']}",
            daemon=True,
        )
        process.start()
        self.worker_task_queues[canonical_name] = task_queue
        self.processes[canonical_name] = process
        self._worker_started_monotonic[canonical_name] = time.monotonic()
        return process

    def _build_worker_payload(self, task: dict[str, Any]) -> dict[str, Any]:
        execution_config = task.get("execution_config")
        if isinstance(execution_config, str):
            try:
                execution_config = json.loads(execution_config)
            except json.JSONDecodeError:
                execution_config = {}
        if not isinstance(execution_config, dict):
            execution_config = self._task_execution_configs.get(str(task.get("id")), {})
        return {
            "id": task["id"],
            "target_agent": str(task.get("target_agent") or ""),
            "title": task["title"],
            "payload": task["payload"],
            "ai_provider": str(execution_config.get("ai_provider") or "ollama").strip().lower(),
            "model": str(execution_config.get("ollama_model") or ""),
            "temperature": execution_config.get("temperature", 0.7),
            "system_prompt": execution_config.get("system_prompt") or "",
            "allowed_scopes": list(execution_config.get("allowed_scopes") or []),
            "ollama_host": self.ollama_host,
            "timeout_sec": 90,
        }

    def _submit_agent_task(self, task: dict[str, Any]) -> bool:
        canonical_name = str(task.get("target_agent") or "")
        process = self.processes.get(canonical_name)
        task_queue = self.worker_task_queues.get(canonical_name)
        task_id = str(task.get("id") or "")
        if not task_id or not process or not process.is_alive() or task_queue is None:
            return False
        if task_id in self._submitted_task_ids:
            return True
        try:
            task_queue.put_nowait(self._build_worker_payload(task))
        except queue.Full:
            return False
        self._submitted_task_ids.add(task_id)
        return True

    def _submit_pending_agent_tasks(self) -> None:
        for canonical_name in CANONICAL_SVL_AGENTS:
            for task in self._get_pending_agent_tasks(canonical_name):
                if not self._submit_agent_task(task):
                    break

    def _ensure_result_supervisor(self) -> None:
        if self._result_supervisor_task is None or self._result_supervisor_task.done():
            self._result_supervisor_task = asyncio.create_task(
                self._run_worker_supervisor(),
                name="svl-agent-worker-supervisor",
            )

    async def shutdown(self) -> None:
        """Stop background supervisor task and terminate spawned worker processes cleanly."""
        sup_task = self._result_supervisor_task
        self._result_supervisor_task = None
        if sup_task is not None and not sup_task.done():
            sup_task.cancel()
            try:
                await sup_task
            except asyncio.CancelledError:
                pass
            except Exception:
                pass

        for canonical_name, task_queue in list(self.worker_task_queues.items()):
            try:
                task_queue.put_nowait(None)
            except Exception:
                pass

        for canonical_name, proc in list(self.processes.items()):
            try:
                if proc.is_alive():
                    proc.join(timeout=0.5)
                if proc.is_alive():
                    proc.terminate()
                    proc.join(timeout=1.0)
                if proc.is_alive():
                    proc.kill()
                    proc.join(timeout=0.5)
            except Exception:
                pass
        self.processes.clear()

        for task_queue in list(self.worker_task_queues.values()):
            try:
                task_queue.cancel_join_thread()
                task_queue.close()
            except Exception:
                pass
        self.worker_task_queues.clear()

        try:
            self.worker_result_queue.cancel_join_thread()
            self.worker_result_queue.close()
        except Exception:
            pass

    def _notify_family_channel_about_task(self, task: dict[str, Any], canonical_name: str, *, failed: bool) -> None:
        """Powiadomienie na kanale „wszyscy” o zakończeniu zadania workera (bez przerywania pracy)."""
        try:
            title = str(task.get("title") or "zadanie")[:160]
            if failed:
                body = f"Błąd: {str(task.get('error') or 'nieznany')[:600]}"
            else:
                result = str(task.get("result") or "").strip()
                body = (
                    (result[:600] + ("…" if len(result) > 600 else ""))
                    if result
                    else "Model zwrócił odpowiedź."
                ) + "\n\n_Odpowiedź modelu — wykonanie działań nie zostało potwierdzone._"
            self.kernel.emit_family_notification(
                severity="WARN" if failed else "INFO",
                category="agent_task",
                title=f"{canonical_name}: {'zadanie nieudane' if failed else 'zadanie zakończone'} — {title}",
                message=body,
                details={"taskId": task.get("id"), "agent": canonical_name},
                source_event_id=f"task-{task.get('id')}-{'failed' if failed else 'done'}",
                origin=f"worker:{canonical_name}",
            )
        except Exception as exc:  # powiadomienie nie może zatrzymać supervisora workerów
            self.append_agent_log(canonical_name, "NOTIFICATION_FAILED", str(exc)[:300])

    async def _publish_task_event(self, task: dict[str, Any], status: str) -> None:
        canonical_name = str(task["target_agent"])
        topic_status = status.lower()
        await self.bus.publish(
            topic=f"svl.agent.task_{topic_status}",
            source=canonical_name,
            target="*",
            scope_mode="CAŁOŚĆ",
            payload={
                "task_id": task["id"],
                "target_agent": canonical_name,
                "title": task["title"],
                "status": status,
                "result": task.get("result"),
                "error": task.get("error"),
            },
        )
        self.kernel.emit_sync_event(
            entity="agent_runtime",
            entity_id=canonical_name,
            event_type=f"agents.task_{topic_status}",
            origin=f"worker:{canonical_name}",
            payload={
                "taskId": task["id"],
                "targetAgent": canonical_name,
                "title": task["title"],
                "status": status,
                "result": task.get("result"),
                "error": task.get("error"),
            },
        )

    async def _handle_worker_message(self, message: dict[str, Any]) -> None:
        task_id = str(message.get("task_id") or "")
        canonical_name = normalize_agent_canonical_name(str(message.get("agent") or ""))
        task = next(
            (
                item
                for item in self.agent_queues.get(canonical_name, [])
                if item.get("id") == task_id
            ),
            None,
        )
        if not task:
            return

        message_type = str(message.get("type") or "")
        if message_type == "task_started":
            if task.get("status") != "QUEUED":
                return
            task.update({
                "status": "RUNNING",
                "worker_pid": message.get("worker_pid"),
                "started_at": message.get("started_at"),
                "error": None,
            })
            self.append_agent_log(canonical_name, "TASK_STARTED", f"Worker rozpoczął: {task['title']}")
            state = self.agent_states.setdefault(canonical_name, {})
            state["current_task_id"] = task_id
            state["worker_phase"] = "BUSY"
            await self._publish_task_event(task, "RUNNING")
        elif message_type in {"task_completed", "task_answer_ready", "task_failed"}:
            if (
                task.get("status") != "RUNNING"
                or task.get("worker_pid") != message.get("worker_pid")
            ):
                return
            completed = message.get("completed_at") or datetime.now(timezone.utc).isoformat()
            task.update({
                "status": "FAILED" if message_type == "task_failed" else "ANSWER_READY",
                "worker_pid": message.get("worker_pid"),
                "result": str(message.get("result") or "")[:MAX_AGENT_TASK_RESULT_CHARS] or None,
                "error": str(message.get("error") or "")[:1000] or None,
                "completed_at": completed,
            })
            self._submitted_task_ids.discard(task_id)
            state = self.agent_states.get(canonical_name, {})
            state["current_task_id"] = None
            state["worker_phase"] = "IDLE"
            level = "TASK_FAILED" if message_type == "task_failed" else "TASK_RESPONSE_READY"
            summary = (
                task["error"] if message_type == "task_failed"
                else "Model zwrócił tekst odpowiedzi; wykonanie misji lub działania nie zostało potwierdzone."
            )
            self.append_agent_log(canonical_name, level, f"{task['title']}: {summary}")
            await self._publish_task_event(task, task["status"])
            self._notify_family_channel_about_task(task, canonical_name, failed=message_type == "task_failed")
        else:
            return

        self._save_agent_task(task)

    def _recover_interrupted_tasks(self, canonical_name: str, worker_pid: Optional[int]) -> None:
        for task in self.agent_queues.get(canonical_name, []):
            task_id = str(task.get("id") or "")
            self._submitted_task_ids.discard(task_id)
            if task.get("status") != "RUNNING" or task.get("worker_pid") != worker_pid:
                continue
            task.update({
                "status": "QUEUED",
                "worker_pid": None,
                "started_at": None,
                "error": "Worker exited before completing the task; task was requeued.",
            })
            self._save_agent_task(task)

    async def _run_worker_supervisor(self) -> None:
        while True:
            while True:
                try:
                    message = self.worker_result_queue.get_nowait()
                except queue.Empty:
                    break
                if isinstance(message, dict):
                    await self._handle_worker_message(message)

            now = time.monotonic()
            for canonical_name, process in list(self.processes.items()):
                if process.is_alive():
                    if now - self._worker_started_monotonic.get(canonical_name, now) >= 30:
                        self._worker_restart_attempts[canonical_name] = 0
                    continue

                if canonical_name not in self._worker_restart_after:
                    attempts = self._worker_restart_attempts[canonical_name] + 1
                    self._worker_restart_attempts[canonical_name] = attempts
                    delay_sec = min(2 ** min(attempts - 1, 5), 30)
                    self._worker_restart_after[canonical_name] = now + delay_sec
                    self._recover_interrupted_tasks(canonical_name, process.pid)
                    state = self.agent_states.get(canonical_name)
                    if state:
                        state.update({"status": "RESTARTING", "pid": None, "worker_phase": "STARTING"})
                    self.append_agent_log(
                        canonical_name,
                        "WORKER_EXITED",
                        f"Worker zakończył pracę (exit={process.exitcode}); ponowne uruchomienie za {delay_sec}s.",
                    )
                    continue

                if now < self._worker_restart_after[canonical_name]:
                    continue

                task_queue = self.worker_task_queues.pop(canonical_name, None)
                if task_queue is not None:
                    task_queue.cancel_join_thread()
                    task_queue.close()
                process.join(timeout=0)
                try:
                    replacement = self._start_agent_worker(canonical_name)
                    self._worker_restart_after.pop(canonical_name, None)
                    state = self.agent_states.get(canonical_name)
                    if state:
                        state.update({
                            "status": "STARTING_LOCAL_WORKER",
                            "pid": replacement.pid,
                            "uid": os.getuid(),
                            "worker_phase": "STARTING",
                        })
                    self.append_agent_log(
                        canonical_name,
                        "WORKER_RESTARTED",
                        f"Uruchomiono ponownie workera PID={replacement.pid}.",
                    )
                    self._submit_pending_agent_tasks()
                except Exception as exc:
                    self._worker_restart_after[canonical_name] = time.monotonic() + min(
                        2 ** min(self._worker_restart_attempts[canonical_name], 5), 30
                    )
                    self.append_agent_log(canonical_name, "WORKER_RESTART_FAILED", str(exc)[:500])

            await asyncio.sleep(0.2)

    async def connect_my_ai(
        self, triggered_by: str = "operator", skip_network_probes: bool = False
    ) -> dict[str, Any]:
        """Uruchamia i łączy lokalne procesy robocze skonfigurowanych agentów (np. Bielik na llama3.2-vision:11b)."""
        spawned_agents: list[dict[str, Any]] = []
        for name, meta in CANONICAL_SVL_AGENTS.items():
            cfg = self.get_agent_config(name)
            proc = self.processes.get(name)
            if proc is None or not proc.is_alive():
                proc = self._start_agent_worker(name)
            state = self.agent_states.setdefault(name, {})
            state.update({
                "id": meta["id"],
                "canonical_name": name,
                "display_name": meta["display_name"],
                "slug": meta["slug"],
                "accent_hex": meta["accent_hex"],
                "preserved_role": meta["preserved_role"],
                "capabilities": meta["capabilities"],
                "source_repository": "https://github.com/Rush47/SVL_Core",
                "source_profile_path": meta["source_profile_path"],
                "source_nature": "LOCAL_OLLAMA_WORKER",
                "external_process_connected": False,
                "instance_origin": "LOCAL_OLLAMA_WORKER",
                "status": "STARTING_LOCAL_WORKER" if proc.is_alive() else "STOPPED",
                "pid": proc.pid if proc.is_alive() else None,
                "uid": os.getuid(),
                "worker_phase": "IDLE" if proc.is_alive() else "STOPPED",
                "memory_scope": f"agent:{name}",
                "memory_entries_count": self._count_memories(name),
                "queue_depth": self._count_pending_agent_tasks(name),
                "config": cfg,
                "config_revision": self.get_agent_config_revision(name),
            })
            self.kernel.register_agent(meta["id"], state)
            self.append_agent_log(
                name,
                "WORKER_CONNECTED",
                f"Połączono lokalny proces workera {name} (PID={proc.pid}, model={cfg.get('ollama_model', 'llama3.2-vision:11b')}).",
            )
            spawned_agents.append({
                "id": meta["id"],
                "canonical_name": name,
                "display_name": meta["display_name"],
                "pid": proc.pid,
                "status": state["status"],
                "ollama_model": cfg.get("ollama_model", "llama3.2-vision:11b"),
            })

        if CANONICAL_SVL_AGENTS:
            self._ensure_result_supervisor()
            self._submit_pending_agent_tasks()

        self.connected_at = datetime.now(timezone.utc).isoformat()
        report = {
            "command": "sync_agents",
            "executed_at": self.connected_at,
            "repository": "Rush47/SVL_Core",
            "architectural_finding": (
                f"Aktywowano {len(spawned_agents)} lokalny worker AI (Bielik -> ollama:llama3.2-vision:11b)."
            ),
            "agents": spawned_agents,
        }
        self.last_Sync_report = report
        sync_res = self.kernel.emit_sync_event(
            entity="agent_runtime",
            entity_id="workers",
            event_type="agents.connected",
            origin=triggered_by,
            payload={"connectedAt": self.connected_at, "agents": spawned_agents},
        )
        report["revision"] = sync_res["revision"]
        report["serverRevision"] = sync_res["serverRevision"]
        return report

    def refresh_states(self) -> list[dict[str, Any]]:
        """Aktualizuje żywe heartbeaty z plików procesów potomnych oraz stan kolejek."""
        result: list[dict[str, Any]] = []
        for name, state in self.agent_states.items():
            proc = self.processes.get(name)
            hb_file = self.runtime_dir / f"{name.lower()}_heartbeat.json"
            if proc and proc.is_alive():
                state["pid"] = proc.pid
                state["uid"] = os.getuid()
                if hb_file.exists():
                    try:
                        hb = json.loads(hb_file.read_text(encoding="utf-8"))
                        if int(hb.get("pid", -1)) == proc.pid:
                            heartbeat_at = str(hb.get("heartbeat_at") or "")
                            state["heartbeat_at"] = heartbeat_at or state.get("heartbeat_at")
                            state["worker_phase"] = str(hb.get("status") or "IDLE")
                            state["current_task_id"] = hb.get("current_task_id")
                            state["uid"] = hb.get("uid", state["uid"])
                            try:
                                age_sec = (
                                    datetime.now(timezone.utc)
                                    - datetime.fromisoformat(heartbeat_at)
                                ).total_seconds()
                            except (TypeError, ValueError):
                                age_sec = float("inf")
                            stale_after = (
                                MAX_AGENT_TASK_TIMEOUT_SEC + 15
                                if state["worker_phase"] == "BUSY"
                                else 6
                            )
                            if age_sec > stale_after:
                                state["status"] = "DEGRADED_LOCAL_WORKER"
                            else:
                                state["status"] = (
                                    "BUSY_LOCAL_WORKER"
                                    if state["worker_phase"] == "BUSY"
                                    else "ONLINE_LOCAL_WORKER"
                                )
                        else:
                            state["status"] = "STARTING_LOCAL_WORKER"
                            state["worker_phase"] = "STARTING"
                    except (OSError, json.JSONDecodeError, TypeError, ValueError):
                        state["status"] = "STARTING_LOCAL_WORKER"
                        state["worker_phase"] = "STARTING"
                else:
                    state["status"] = "STARTING_LOCAL_WORKER"
                    state["worker_phase"] = "STARTING"
            else:
                state["status"] = (
                    "RESTARTING"
                    if name in self._worker_restart_after
                    else "STOPPED"
                )
                state["pid"] = None
                state["worker_phase"] = "STOPPED"

            state["memory_entries_count"] = self._count_memories(name)
            state["queue_depth"] = self._count_pending_agent_tasks(name)
            state["config"] = self.get_agent_config(name)
            state["config_revision"] = self.get_agent_config_revision(name)
            self.bus.record_heartbeat(name, state)
            result.append(state)
        return result

    async def dispatch_agent_task(
        self,
        sender: str,
        target_agent: str,
        task_title: str,
        task_payload: str,
        origin: str = "client",
        correlation_id: str = "",
        event_id: Optional[str] = None,
        ollama_host: Optional[str] = None,
        ai_provider: str = "ollama",
    ) -> dict[str, Any]:
        """Persist a bounded text-inference task and enqueue it for a live worker."""
        target_agent = normalize_agent_canonical_name(target_agent)
        if target_agent not in CANONICAL_SVL_AGENTS:
            raise ValueError(f"Unknown agent: {target_agent}")
        clean_title = str(task_title or "").strip()
        clean_payload = str(task_payload or "").strip()
        if not clean_title:
            raise ValueError("Task title is required.")
        if len(clean_title) > MAX_AGENT_TASK_TITLE_CHARS:
            raise ValueError(f"Task title exceeds {MAX_AGENT_TASK_TITLE_CHARS} characters.")
        if len(clean_payload) > MAX_AGENT_TASK_PAYLOAD_CHARS:
            raise ValueError(f"Task details exceed {MAX_AGENT_TASK_PAYLOAD_CHARS} characters.")
        if self.kernel.operator_token and self.kernel.operator_token in f"{clean_title}\n{clean_payload}":
            raise ValueError("Do not include the operator token in an agent task.")
        if self._count_pending_agent_tasks(target_agent) >= MAX_AGENT_TASKS_PER_AGENT:
            raise RuntimeError(f"Task queue for {target_agent} is full; remove pending tasks before dispatching more.")

        config = self.get_agent_config(target_agent)
        provider = str(ai_provider or "ollama").strip().lower()
        if provider != "ollama":
            raise ValueError("Unsupported agent AI provider.")
        if ollama_host:
            self.ollama_host = str(ollama_host).strip().rstrip("/")
        if not self.ollama_host:
            raise RuntimeError("No Ollama endpoint is configured for worker task execution.")

        task_id = str(uuid.uuid4())
        task_record = {
            "id": task_id,
            "sender": str(sender or "operator").strip()[:120],
            "target_agent": target_agent,
            "target_display_name": CANONICAL_SVL_AGENTS[target_agent]["display_name"],
            "target_id": CANONICAL_SVL_AGENTS[target_agent]["id"],
            "title": clean_title,
            "payload": clean_payload,
            "execution_config": {
                "ai_provider": provider,
                "ollama_model": str(config.get("ollama_model") or "").strip(),
                "temperature": config.get("temperature", 0.7),
                "system_prompt": str(config.get("system_prompt") or ""),
                "allowed_scopes": list(config.get("allowed_scopes") or []),
            },
            "status": "QUEUED",
            "created_at": datetime.now(timezone.utc).isoformat(),
            "started_at": None,
            "completed_at": None,
            "result": None,
            "error": None,
            "worker_pid": None,
        }
        self._save_agent_task(task_record)
        submitted = self._submit_agent_task(task_record)
        self.append_agent_log(
            target_agent, "TASK_QUEUED",
            f"Od '{task_record['sender']}': {clean_title}" +
            ("" if submitted else " (oczekuje na dostępny proces workera)")
        )

        await self.bus.publish(
            topic="svl.agent.task_queued",
            source=target_agent,
            target="*",
            scope_mode="CAŁOŚĆ",
            payload={
                "task_id": task_id,
                "sender": task_record["sender"],
                "target_agent": target_agent,
                "title": clean_title,
                "status": "QUEUED",
            },
        )
        sync_res = self.kernel.emit_sync_event(
            entity="agent_runtime",
            entity_id=target_agent,
            event_type="agents.task_queued",
            origin=origin,
            correlation_id=correlation_id,
            event_id=event_id,
            payload={
                "taskId": task_id,
                "sender": task_record["sender"],
                "targetAgent": target_agent,
                "title": clean_title,
                "status": "QUEUED",
            },
        )
        task_record.pop("execution_config", None)
        return {
            "task": task_record,
            "resilience": {
                "ok": True,
                "status": "SUBMITTED_TO_WORKER" if submitted else "WAITING_FOR_WORKER",
                "engine": "ollama",
                "workerAccepted": submitted,
                "message": (
                    "Task persisted and handed off to a live worker."
                    if submitted else
                    "Task persisted, but no live worker accepted it yet. It remains queued."
                ),
            },
            "revision": sync_res["revision"],
            "serverRevision": sync_res["serverRevision"],
            "event": sync_res["event"],
        }
