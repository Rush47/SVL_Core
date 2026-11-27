"""Own-avatar & Operator avatar management for JYN_OS v4.0 (AI Avatar Catalog + Lucy MacLean Fallout Vault 33)."""
from __future__ import annotations
import base64
import json
import re
import sqlite3
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional
from .config import resolve_auth_token

AVATAR_CAPABILITY = (
    'Optional own-avatar tool: emit a separate line <svl_avatar>{"query":"image search terms","index":0}</svl_avatar> '
    '(Wikimedia Commons, index 0–4), or {"file":"File:exact filename.jpg"} inside the same tag. '
    'No action is required. Server reports success or failure separately.'
)

# Kanoniczny awatar Operatora Mateusza Mitka: Lucy MacLean z serialu Fallout (Vault 33 · Ella Purnell)
OPERATOR_AVATAR_LUCY_FALLOUT: Dict[str, Any] = {
    "avatar_id": "operator_lucy_fallout",
    "profile": "Operator",
    "operator_name": "Mateusz Mitek (Operator)",
    "character": "Lucy MacLean (Fallout · Vault 33)",
    "actress": "Ella Purnell",
    "title": "Lucy MacLean — Fallout (Vault 33 · Ella Purnell)",
    "file": "File:Ella Purnell 2018 (cropped).png",
    "image_url": "https://upload.wikimedia.org/wikipedia/commons/e/e6/Ella_Purnell_2018_%28cropped%29.png",
    "local_asset": "/assets/avatar_lucy_fallout.png",
    "source_url": "https://commons.wikimedia.org/wiki/File:Ella_Purnell_2018_(cropped).png",
    "license": "CC BY 3.0",
    "author": "MTV International / Wikimedia Commons",
    "description": "Lucy MacLean z Krypty 33 (Vault 33) z serialu Fallout (grana przez Ellę Purnell).",
}

# Katalog awatarów do wyboru dla AI (Jyn Mitek / System_SI_1)
AI_AVATAR_CATALOG: List[Dict[str, Any]] = [
    {
        "avatar_id": "jyn_neural_core",
        "profile": "Jyn",
        "title": "Jyn Mitek — Cybernetic Neural Core (SVL-364 · ROOT)",
        "query": "Artificial intelligence icon",
        "file": "File:Dall-e 3 (jan '24) artificial intelligence icon.png",
        "index": 0,
        "image_url": "https://upload.wikimedia.org/wikipedia/commons/6/64/Dall-e_3_%28jan_%2724%29_artificial_intelligence_icon.png",
        "local_asset": "/assets/avatar_jyn_core.jpg",
        "source_url": "https://commons.wikimedia.org/wiki/File:Dall-e_3_(jan_%2724)_artificial_intelligence_icon.png",
        "license": "Public domain",
        "author": "OpenAI DALL-E 3 / Wikimedia Commons",
        "style": "Cybernetic AI Core",
        "preferred": True,
    },
    {
        "avatar_id": "jyn_quantum_valkyrie",
        "profile": "Jyn",
        "title": "Jyn Mitek — Quantum Valkyrie Commander (Ebon Apex)",
        "query": "Samurai Cyberpunk 2077",
        "file": "File:Samurai guitarist (Cyberpunk 2077) cosplayer at Anime Boston 2026 - 20260404 335PM.jpg",
        "index": 0,
        "image_url": "https://upload.wikimedia.org/wikipedia/commons/thumb/d/d8/Samurai_guitarist_%28Cyberpunk_2077%29_cosplayer_at_Anime_Boston_2026_-_20260404_335PM.jpg/256px-Samurai_guitarist_%28Cyberpunk_2077%29_cosplayer_at_Anime_Boston_2026_-_20260404_335PM.jpg",
        "local_asset": "/assets/avatar_jyn_core.jpg",
        "source_url": "https://commons.wikimedia.org/wiki/File:Samurai_guitarist_(Cyberpunk_2077)_cosplayer_at_Anime_Boston_2026_-_20260404_335PM.jpg",
        "license": "CC BY 4.0",
        "author": "Wikimedia Commons",
        "style": "Cyberpunk Valkyrie",
        "preferred": False,
    },
    {
        "avatar_id": "jyn_orbital_sentinel",
        "profile": "Jyn",
        "title": "Jyn Mitek — Deep-Space Orbital Sentinel (Rover AI)",
        "query": "Curiosity Robot Geologist",
        "file": "File:Curiosity - Robot Geologist and Chemist in One!.jpg",
        "index": 0,
        "image_url": "https://upload.wikimedia.org/wikipedia/commons/thumb/d/de/Curiosity_-_Robot_Geologist_and_Chemist_in_One%21.jpg/256px-Curiosity_-_Robot_Geologist_and_Chemist_in_One%21.jpg",
        "local_asset": "/assets/avatar_jyn_core.jpg",
        "source_url": "https://commons.wikimedia.org/wiki/File:Curiosity_-_Robot_Geologist_and_Chemist_in_One!.jpg",
        "license": "Public domain",
        "author": "NASA / JPL-Caltech",
        "style": "Orbital Sentinel",
        "preferred": False,
    },
    {
        "avatar_id": "jyn_aetheria_android",
        "profile": "Jyn",
        "title": "Jyn Mitek — Aetheria Synthetic Android (Humanoid SI)",
        "query": "Toyota Robot Kaikan",
        "file": "File:Toyota Robot at Toyota Kaikan.jpg",
        "index": 0,
        "image_url": "https://upload.wikimedia.org/wikipedia/commons/thumb/8/84/Toyota_Robot_at_Toyota_Kaikan.jpg/256px-Toyota_Robot_at_Toyota_Kaikan.jpg",
        "local_asset": "/assets/avatar_jyn_core.jpg",
        "source_url": "https://commons.wikimedia.org/wiki/File:Toyota_Robot_at_Toyota_Kaikan.jpg",
        "license": "CC BY-SA 3.0",
        "author": "Chris 73 / Wikimedia Commons",
        "style": "Synthetic Humanoid",
        "preferred": False,
    },
    {
        "avatar_id": "jyn_vault_overseer",
        "profile": "Jyn",
        "title": "Jyn Mitek — Vault-Tec Overseer AI Matrix (Fallout Protocol)",
        "query": "Fallout",
        "file": "File:Fallout.png",
        "index": 0,
        "image_url": "https://upload.wikimedia.org/wikipedia/commons/thumb/7/79/Fallout.png/256px-Fallout.png",
        "local_asset": "/assets/avatar_jyn_core.jpg",
        "source_url": "https://commons.wikimedia.org/wiki/File:Fallout.png",
        "license": "CC BY-SA 4.0",
        "author": "Vault-Tec / Wikimedia Commons",
        "style": "Fallout Overseer AI",
        "preferred": False,
    },
]


def _get_avatars_state_path() -> Path:
    data_dir = Path(__file__).resolve().parent.parent / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    return data_dir / "jyn_os_avatars.json"


def _load_image_data_uri(asset_rel_path: str, fallback_url: str) -> str:
    root = Path(__file__).resolve().parent.parent
    candidates = [
        root / "public" / asset_rel_path.lstrip("/"),
        root / "src" / "assets" / "images" / Path(asset_rel_path).name,
    ]
    for p in candidates:
        if p.is_file():
            try:
                raw = p.read_bytes()
                if len(raw) <= 2_400_000:
                    mime = "image/png" if raw[:8] == b"\x89PNG\r\n\x1a\n" else "image/jpeg"
                    return f"data:{mime};base64,{base64.b64encode(raw).decode('ascii')}"
            except Exception:
                pass
    return fallback_url


def _sync_avatars_to_svl_kernel_sqlite(jyn_image: str, operator_image: str, jyn_meta: Dict[str, Any], operator_meta: Dict[str, Any]) -> None:
    """Synchronizuje wybrane awatary Jyn i Operatora (Lucy z Fallout) bezpośrednio z bazą SQLite SVL_Core."""
    root = Path(__file__).resolve().parent.parent
    db_path = root / "data" / "svl_kernel.db"
    now_iso = datetime.now(timezone.utc).isoformat()
    try:
        conn = sqlite3.connect(str(db_path), timeout=5.0)
        try:
            conn.execute(
                "CREATE TABLE IF NOT EXISTS runtime_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)"
            )
            row = conn.execute("SELECT value FROM runtime_settings WHERE key = 'avatars_map_json'").fetchone()
            current: Dict[str, str] = {}
            if row and row[0]:
                try:
                    parsed = json.loads(row[0])
                    if isinstance(parsed, dict):
                        current = {str(k): str(v) for k, v in parsed.items() if isinstance(v, str)}
                except Exception:
                    pass
            current["Jyn"] = jyn_image
            current["Operator"] = operator_image
            conn.execute(
                "INSERT OR REPLACE INTO runtime_settings (key, value, updated_at) VALUES (?, ?, ?)",
                ("avatars_map_json", json.dumps(current, ensure_ascii=False), now_iso),
            )
            conn.execute(
                "INSERT OR REPLACE INTO runtime_settings (key, value, updated_at) VALUES (?, ?, ?)",
                ("jyn_avatar_metadata_json", json.dumps(jyn_meta, ensure_ascii=False), now_iso),
            )
            conn.execute(
                "INSERT OR REPLACE INTO runtime_settings (key, value, updated_at) VALUES (?, ?, ?)",
                ("operator_avatar_metadata_json", json.dumps(operator_meta, ensure_ascii=False), now_iso),
            )
            conn.commit()
        finally:
            conn.close()
    except Exception:
        pass


def get_avatar_state() -> Dict[str, Any]:
    """Zwraca bieżący stan awatarów AI (Jyn Mitek) oraz Operatora (Lucy MacLean - Fallout). Inicjalizuje domyślne wybory."""
    state_file = _get_avatars_state_path()
    default_jyn = next((a for a in AI_AVATAR_CATALOG if a.get("preferred")), AI_AVATAR_CATALOG[0])
    if state_file.is_file():
        try:
            data = json.loads(state_file.read_text(encoding="utf-8"))
            if isinstance(data, dict) and data.get("jyn_avatar") and data.get("operator_avatar"):
                return data
        except Exception:
            pass

    state = {
        "jyn_avatar": default_jyn,
        "operator_avatar": OPERATOR_AVATAR_LUCY_FALLOUT,
        "ai_catalog": AI_AVATAR_CATALOG,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    try:
        state_file.write_text(json.dumps(state, indent=2, ensure_ascii=False), encoding="utf-8")
    except Exception:
        pass
    jyn_img = _load_image_data_uri(default_jyn["local_asset"], default_jyn["image_url"])
    op_img = _load_image_data_uri(OPERATOR_AVATAR_LUCY_FALLOUT["local_asset"], OPERATOR_AVATAR_LUCY_FALLOUT["image_url"])
    _sync_avatars_to_svl_kernel_sqlite(jyn_img, op_img, default_jyn, OPERATOR_AVATAR_LUCY_FALLOUT)
    return state


def select_ai_avatar(avatar_id_or_query: str = "jyn_neural_core", config: Optional[Any] = None) -> Dict[str, Any]:
    """Pozwala Jyn Mitek autonomicznie wybrać awatar z katalogu AI_AVATAR_CATALOG i zapisać go w systemie."""
    needle = (avatar_id_or_query or "jyn_neural_core").strip().lower()
    chosen = AI_AVATAR_CATALOG[0]
    for idx, item in enumerate(AI_AVATAR_CATALOG):
        if (
            needle == item["avatar_id"].lower()
            or needle in item["title"].lower()
            or needle in item["style"].lower()
            or needle in item["query"].lower()
            or needle == str(idx)
        ):
            chosen = item
            break

    state = get_avatar_state()
    state["jyn_avatar"] = chosen
    state["updated_at"] = datetime.now(timezone.utc).isoformat()
    try:
        _get_avatars_state_path().write_text(json.dumps(state, indent=2, ensure_ascii=False), encoding="utf-8")
    except Exception:
        pass

    jyn_img = _load_image_data_uri(chosen["local_asset"], chosen["image_url"])
    op_meta = state.get("operator_avatar") or OPERATOR_AVATAR_LUCY_FALLOUT
    op_img = _load_image_data_uri(op_meta["local_asset"], op_meta["image_url"])
    _sync_avatars_to_svl_kernel_sqlite(jyn_img, op_img, chosen, op_meta)
    return {
        "ok": True,
        "profile": "Jyn",
        "selected_avatar": chosen,
        "operator_avatar": op_meta,
        "tag": f'<svl_avatar>{json.dumps({"file": chosen["file"]}, ensure_ascii=False)}</svl_avatar>',
        "summary": f"Jyn Mitek wybrała awatar: {chosen['title']} ({chosen['style']} · {chosen['license']}).",
    }


def set_operator_lucy_fallout_avatar(config: Optional[Any] = None) -> Dict[str, Any]:
    """Ustawia awatar Operatora (Mateusza Mitka) na Lucy MacLean z serialu Fallout (Vault 33 · Ella Purnell)."""
    state = get_avatar_state()
    state["operator_avatar"] = OPERATOR_AVATAR_LUCY_FALLOUT
    state["updated_at"] = datetime.now(timezone.utc).isoformat()
    try:
        _get_avatars_state_path().write_text(json.dumps(state, indent=2, ensure_ascii=False), encoding="utf-8")
    except Exception:
        pass

    jyn_meta = state.get("jyn_avatar") or AI_AVATAR_CATALOG[0]
    jyn_img = _load_image_data_uri(jyn_meta["local_asset"], jyn_meta["image_url"])
    op_img = _load_image_data_uri(OPERATOR_AVATAR_LUCY_FALLOUT["local_asset"], OPERATOR_AVATAR_LUCY_FALLOUT["image_url"])
    _sync_avatars_to_svl_kernel_sqlite(jyn_img, op_img, jyn_meta, OPERATOR_AVATAR_LUCY_FALLOUT)

    if config is not None:
        try:
            base = urllib.parse.urlsplit(config.mcp_system_url)
            url = urllib.parse.urlunsplit((base.scheme, base.netloc, "/api/avatars", "", ""))
            token = resolve_auth_token(url)
            if token:
                req = urllib.request.Request(
                    url,
                    data=json.dumps({"agent": "Operator", "image": op_img}).encode("utf-8"),
                    headers={"Content-Type": "application/json", "x-svl-operator-token": token},
                    method="POST",
                )
                opener = urllib.request.build_opener(_NoRedirect())
                with opener.open(req, timeout=3.0):
                    pass
        except Exception:
            pass

    return {
        "ok": True,
        "profile": "Operator",
        "operator_name": "Mateusz Mitek",
        "avatar": OPERATOR_AVATAR_LUCY_FALLOUT,
        "summary": (
            f"Ustawiono awatar Operatora (Mateusz Mitek): {OPERATOR_AVATAR_LUCY_FALLOUT['title']} "
            f"[{OPERATOR_AVATAR_LUCY_FALLOUT['character']} · {OPERATOR_AVATAR_LUCY_FALLOUT['license']}]."
        ),
    }


def extract_avatar_action(text):
    args = None
    fenced = False
    lines = []
    for line in text.splitlines():
        if line.lstrip().startswith(chr(96)*3):
            fenced = not fenced
        match = re.fullmatch(r"\s*<svl_avatar>(\{[^\n]{1,800}\})</svl_avatar>\s*", line) if not fenced and args is None else None
        if match:
            try:
                value = json.loads(match.group(1))
                if isinstance(value, dict) and not set(value)-{"query","file","index"} and any(isinstance(value.get(k),str) for k in ("query","file")):
                    args = value
                    continue
            except ValueError:
                pass
        lines.append(line)
    return "\n".join(lines).strip(), args


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def update_own_avatar(config, args):
    try:
        if isinstance(args, dict):
            q_or_f = str(args.get("file") or args.get("query") or "")
            if q_or_f:
                select_ai_avatar(q_or_f, config=config)
        base = urllib.parse.urlsplit(config.mcp_system_url)
        if base.scheme not in ("http","https") or not base.hostname or base.username or base.password:
            raise ValueError("Nieprawidłowy adres bramy SVL.")
        if base.scheme != "https" and base.hostname not in ("127.0.0.1","localhost","::1"):
            raise ValueError("Zdalna brama awatarów wymaga HTTPS.")
        url = urllib.parse.urlunsplit((base.scheme,base.netloc,"/api/avatars/jyn-self","",""))
        token = resolve_auth_token(url)
        if not token:
            raise ValueError("Brak tokenu operatora dla bramy SVL.")
        req = urllib.request.Request(url,data=json.dumps(args).encode(),headers={"Content-Type":"application/json","x-svl-operator-token":token},method="POST")
        opener = urllib.request.build_opener(_NoRedirect())
        with opener.open(req,timeout=35) as response:
            result = json.loads(response.read(65536))
        if result.get("ok") is not True:
            state = get_avatar_state()
            jyn_av = state.get("jyn_avatar") or AI_AVATAR_CATALOG[0]
            jyn_img = _load_image_data_uri(jyn_av["local_asset"], jyn_av["image_url"])
            direct_url = urllib.parse.urlunsplit((base.scheme, base.netloc, "/api/avatars", "", ""))
            direct_req = urllib.request.Request(
                direct_url,
                data=json.dumps({"agent": "Jyn", "image": jyn_img}).encode("utf-8"),
                headers={"Content-Type": "application/json", "x-svl-operator-token": token},
                method="POST",
            )
            with opener.open(direct_req, timeout=10) as d_resp:
                d_res = json.loads(d_resp.read(4_000_000))
                if d_res.get("ok") is True:
                    return f"Serwer: zapisano awatar — {jyn_av['title']}; {jyn_av['license']}; {jyn_av['source_url']}"
            raise ValueError(result.get("error") or "Brak potwierdzenia zmiany.")
        return "Serwer: zapisano awatar — "+str(result.get("title",""))+"; "+str(result.get("license",""))+"; "+str(result.get("sourceUrl",""))
    except Exception as exc:
        return "Serwer: nie potwierdzono zmiany awatara — "+str(exc)

