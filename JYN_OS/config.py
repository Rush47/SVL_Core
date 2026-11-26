"""Konfiguracja parametrów, 13 modeli pokładowych i węzłów sieciowych systemu JYN_OS / SVL-364."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List


# Domyślny profil SSH oraz klucz kryptograficzny dedykowany dla statku SVL-364
DEFAULT_SSH_PROFILE = os.environ.get("SVL_SSH_TARGET", "Ship").strip() or "Ship"


def resolve_default_ssh_key() -> Path:
    if os.environ.get("SVL_SSH_KEY"):
        return Path(os.environ["SVL_SSH_KEY"])
    for p in (
        Path.home() / ".ssh" / "svl364_ed25519",
        Path("/home/antigravity/.ssh/svl364_ed25519"),
        Path("/root/.ssh/svl364_ed25519"),
    ):
        try:
            if p.is_file():
                return p
        except OSError:
            continue
    return Path.home() / ".ssh" / "svl364_ed25519"


DEFAULT_SSH_PORT = int(os.environ.get("SVL_SSH_PORT", "22"))
DEFAULT_SSH_KEY_PATH = resolve_default_ssh_key()

# Domyślne adresy punktów końcowych MCP (Model Context Protocol JSON-RPC 2.0)
DEFAULT_MCP_UNIVERSAL_HUB = os.environ.get("SVL_MCP_UNIVERSAL_HUB", "http://127.0.0.1:3334/mcp")
DEFAULT_MCP_SYSTEM_GATEWAY = os.environ.get("SVL_MCP_SYSTEM", "http://127.0.0.1:3000/mcp/svl")
DEFAULT_MCP_SHIP_GATEWAY = os.environ.get("SVL_MCP_SHIP", "http://127.0.0.1:3000/api/mcp/svl364")
DEFAULT_MCP_BACKEND = os.environ.get("SVL_MCP_BACKEND", "http://127.0.0.1:8085/api/py/svl364/mcp")


def resolve_auth_token(endpoint_url: str = "") -> str:
    """Dynamicznie rozwiązuje token autoryzacyjny dla wybranego endpointu."""
    if "3334" in endpoint_url:
        token = os.environ.get("SVL_MCP_TOKEN") or os.environ.get("MCP_TOKEN")
        if token:
            return token.strip()
        fpath = Path(__file__).resolve().parent.parent / "data" / "svl_mcp_token.secret"
        try:
            if fpath.is_file():
                return fpath.read_text(encoding="utf-8").strip()
        except Exception:
            pass

    token = os.environ.get("SVL_OPERATOR_TOKEN") or os.environ.get("MCP_TOKEN")
    if token:
        return token.strip()
    fpath = Path(__file__).resolve().parent.parent / "data" / "svl_operator_token.secret"
    try:
        if fpath.is_file():
            return fpath.read_text(encoding="utf-8").strip()
    except Exception:
        pass
    return ""


def _load_project_dotenv() -> None:
    env_file = Path(__file__).resolve().parent.parent / ".env"
    if not env_file.is_file():
        return
    try:
        for raw_line in env_file.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            key = k.strip()
            val = v.strip().strip('"').strip("'")
            if key and key not in os.environ and val:
                os.environ[key] = val
    except Exception:
        pass


_load_project_dotenv()

DEFAULT_SHIP_OLLAMA_URL = os.environ.get("SVL_SHIP_OLLAMA_URL", "http://127.0.0.1:11435")
DEFAULT_LOCAL_OLLAMA_URL = os.environ.get("SVL_LOCAL_OLLAMA_URL", "http://127.0.0.1:11434")
DEFAULT_SHIP_MODEL = os.environ.get("SVL_SHIP_MODEL", "svl364-apex-uncensored:latest")
DEFAULT_VISION_MODEL = os.environ.get("SVL_VISION_MODEL", "llama3.2-vision:11b")
DEFAULT_LOCAL_MODEL = os.environ.get("SVL_LOCAL_MODEL", "svl364-apex-uncensored:latest")
DEFAULT_OLLAMA_TARGET = os.environ.get("SVL_OLLAMA_TARGET", "local")
APEX_MODELFILE_PATH = Path(__file__).resolve().parent.parent / "SVL_CoreOS_2" / "ai_core" / "Modelfile.apex-uncensored"

# Całkowite wyłączenie strumieniowania odpowiedzi czatu (zawsze jedna kompletna odpowiedź JSON)
DEFAULT_CHAT_STREAM: bool = False

# Stały, ultrazwięzły polski prompt systemowy (~45 tokenów) zapewniający 100% trafień w KV-cache Ollamy
DEFAULT_SYSTEM_PROMPT_PL: str = ""


def _env_int(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(os.environ.get(name, str(default)))
    except ValueError:
        return default
    return max(minimum, min(maximum, value))


def _env_bool(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on", "tak")


DEFAULT_CHAT_NUM_CTX = _env_int("SVL_CHAT_NUM_CTX", 2048, 512, 32768)
DEFAULT_CHAT_NUM_PREDICT = _env_int("SVL_CHAT_NUM_PREDICT", 768, 64, 16384)
DEFAULT_CHAT_TIMEOUT = _env_int("SVL_CHAT_TIMEOUT", 300, 10, 3600)
DEFAULT_CHAT_HISTORY_TURNS = _env_int("SVL_CHAT_HISTORY_TURNS", 6, 0, 40)
DEFAULT_CHAT_HISTORY_MAX_CHARS = _env_int("SVL_CHAT_HISTORY_MAX_CHARS", 2000, 256, 32000)

# Brama API telemetrii i stanu SVL CoreOS
DEFAULT_GATEWAY_URL = os.environ.get("SVL_GATEWAY_URL", "http://127.0.0.1:3000")
DEFAULT_BACKEND_URL = os.environ.get("SVL_BACKEND_URL", "http://127.0.0.1:8085")

# Konfiguracja Google Services & Off-World Enterprise Hub ($1000.00 USD budżetu na KAŻDY z 15 modułów = $15000.00 USD)
DEFAULT_MODULE_BUDGET_USD: float = float(os.environ.get("SVL_MODULE_BUDGET_USD", "1000.00"))
DEFAULT_GOOGLE_BUDGET_USD: float = float(os.environ.get("SVL_GOOGLE_BUDGET_USD", "15000.00"))
DEFAULT_GOOGLE_PROJECT_ID: str = os.environ.get("SVL_GOOGLE_PROJECT_ID", "svl364-ebon-apex")
DEFAULT_GOOGLE_REGION: str = os.environ.get("SVL_GOOGLE_REGION", "europe-central2")
DEFAULT_GOOGLE_MODEL: str = os.environ.get("SVL_GOOGLE_MODEL", "gemini-2.5-flash")
DEFAULT_GOOGLE_HUB_DB_PATH: Path = Path(
    os.environ.get(
        "SVL_GOOGLE_HUB_DB",
        str(Path(__file__).resolve().parent.parent / "data" / "jyn_google_hub.sqlite3"),
    )
)

# Kanoniczny katalog 13 modeli pokładowych jednostki obliczeniowej statku SVL-364
SHIP_MODELS_CATALOG: List[Dict[str, Any]] = [
    {
        "name": "svl364-apex-uncensored:latest",
        "role": "Główny model Apex (Kwantyzacja Q4_K_M, niecenzurowany rdzeń Jyn Mitek)",
        "parameter_size": "70B",
        "family": "llama",
        "min_ram_gb": 48.0,
        "primary": True,
    },
    {
        "name": "dolphin-mixtral:8x22b",
        "role": "Wielkoformatowy model mieszaniny ekspertów (MoE, 141B)",
        "parameter_size": "141B",
        "family": "mixtral",
        "min_ram_gb": 84.0,
        "primary": False,
    },
    {
        "name": "dolphin-llama3:70b",
        "role": "Zaawansowany model analityczny i logiczny wysokiego rzędu",
        "parameter_size": "70B",
        "family": "llama",
        "min_ram_gb": 44.0,
        "primary": False,
    },
    {
        "name": "wizard-vicuna-uncensored:30b",
        "role": "Jednostka taktyczno-proceduralna do złożonych instrukcji",
        "parameter_size": "30B",
        "family": "llama",
        "min_ram_gb": 20.0,
        "primary": False,
    },
    {
        "name": "dolphin-mixtral:8x7b",
        "role": "Zbalansowany model MoE do szybkiego wnioskowania wielowątkowego",
        "parameter_size": "47B",
        "family": "mixtral",
        "min_ram_gb": 28.0,
        "primary": False,
    },
    {
        "name": "dolphin-llama3:8b-v2.9-q2_K",
        "role": "Ultralekki i zoptymalizowany model szybkiego reagowania",
        "parameter_size": "8B",
        "family": "llama",
        "min_ram_gb": 4.0,
        "primary": False,
    },
    {
        "name": "llama3.2-vision:90b",
        "role": "Multimodalny model wizyjny o dużej rozdzielczości sensorycznej",
        "parameter_size": "90B",
        "family": "mllama",
        "min_ram_gb": 58.0,
        "primary": False,
    },
    {
        "name": "llama3.2-vision:11b",
        "role": "Kompaktowa jednostka analizy obrazów, kamer i telemetrii optycznej",
        "parameter_size": "11B",
        "family": "mllama",
        "min_ram_gb": 9.5,
        "primary": False,
    },
    {
        "name": "deepseek-r1:7b",
        "role": "Jednostka łańcucha myślowego i głębokiego rozumowania (CoT)",
        "parameter_size": "7B",
        "family": "qwen2",
        "min_ram_gb": 5.5,
        "primary": False,
    },
    {
        "name": "qwen2.5:7b",
        "role": "Uniwersalny model wielojęzyczny do analizy dokumentacji i danych",
        "parameter_size": "7B",
        "family": "qwen2",
        "min_ram_gb": 5.5,
        "primary": False,
    },
    {
        "name": "qwen2.5-coder:7b",
        "role": "Specjalistyczny model do inżynierii oprogramowania i skryptów",
        "parameter_size": "7B",
        "family": "qwen2",
        "min_ram_gb": 5.5,
        "primary": False,
    },
    {
        "name": "llama3:8b",
        "role": "Standardowy zwinny model pomocniczy do zadań ogólnych",
        "parameter_size": "8B",
        "family": "llama",
        "min_ram_gb": 5.5,
        "primary": False,
    },
    {
        "name": "mistral:7b",
        "role": "Odporny silnik instrukcyjny do szybkiego routingu poleceń",
        "parameter_size": "7B",
        "family": "llama",
        "min_ram_gb": 5.0,
        "primary": False,
    },
]

# Wyłącznie kanoniczne modele z katalogu 13 modeli SVL-364 w kolejności priorytetu polszczyzny i szybkości
CANONICAL_MODELS_PRIORITY: List[str] = [
    "svl364-apex-uncensored:latest",
    "qwen2.5:7b",
    "dolphin-llama3:8b-v2.9-q2_K",
    "mistral:7b",
    "llama3:8b",
    "qwen2.5-coder:7b",
    "deepseek-r1:7b",
    "llama3.2-vision:11b",
    "wizard-vicuna-uncensored:30b",
    "dolphin-mixtral:8x7b",
    "dolphin-llama3:70b",
    "llama3.2-vision:90b",
    "dolphin-mixtral:8x22b",
]


def detect_total_ram_gb() -> float:
    """Wykrywa całkowitą pamięć RAM hosta Linux w GiB."""
    try:
        for line in Path("/proc/meminfo").read_text(encoding="utf-8").splitlines():
            if line.startswith("MemTotal:"):
                kb = int(line.split()[1])
                return kb / (1024.0 * 1024.0)
    except Exception:
        pass
    return 8.0


def select_canonical_base_for_host(total_ram_gb: float | None = None) -> str:
    """Wybiera model bazowy z 13 kanonicznych modeli SVL-364 dopasowany do pamięci hosta."""
    override = os.environ.get("SVL_APEX_BASE_MODEL", "").strip()
    if override:
        return override
    ram = detect_total_ram_gb() if total_ram_gb is None else total_ram_gb
    if ram >= 48.0:
        return "dolphin-llama3:70b"
    if ram >= 32.0:
        return "dolphin-mixtral:8x7b"
    if ram >= 24.0:
        return "wizard-vicuna-uncensored:30b"
    if ram >= 12.0:
        return "llama3.2-vision:11b"
    return "qwen2.5:7b"


@dataclass
class JynOSConfig:
    """Struktura parametrów środowiska uruchomieniowego klienta JYN_OS."""

    ssh_profile: str = DEFAULT_SSH_PROFILE
    ssh_port: int = DEFAULT_SSH_PORT
    ssh_key_path: Path = field(default_factory=lambda: DEFAULT_SSH_KEY_PATH)

    mcp_hub_url: str = DEFAULT_MCP_UNIVERSAL_HUB
    mcp_system_url: str = DEFAULT_MCP_SYSTEM_GATEWAY
    mcp_ship_url: str = DEFAULT_MCP_SHIP_GATEWAY
    mcp_backend_url: str = DEFAULT_MCP_BACKEND

    ship_ollama_url: str = DEFAULT_SHIP_OLLAMA_URL
    local_ollama_url: str = DEFAULT_LOCAL_OLLAMA_URL
    ship_model: str = DEFAULT_SHIP_MODEL
    local_model: str = DEFAULT_LOCAL_MODEL
    vision_model: str = DEFAULT_VISION_MODEL
    active_ollama_target: str = DEFAULT_OLLAMA_TARGET

    gateway_url: str = DEFAULT_GATEWAY_URL
    backend_url: str = DEFAULT_BACKEND_URL

    google_budget_usd: float = DEFAULT_GOOGLE_BUDGET_USD
    google_project_id: str = DEFAULT_GOOGLE_PROJECT_ID
    google_region: str = DEFAULT_GOOGLE_REGION
    google_default_model: str = DEFAULT_GOOGLE_MODEL
    google_hub_db_path: Path = field(default_factory=lambda: DEFAULT_GOOGLE_HUB_DB_PATH)

    connect_timeout: float = 3.5
    command_timeout: float = 30.0
    chat_stream_enabled: bool = DEFAULT_CHAT_STREAM
    system_prompt: str = DEFAULT_SYSTEM_PROMPT_PL
    chat_num_ctx: int = DEFAULT_CHAT_NUM_CTX
    chat_num_predict: int = DEFAULT_CHAT_NUM_PREDICT
    chat_timeout: float = DEFAULT_CHAT_TIMEOUT
    chat_history_turns: int = DEFAULT_CHAT_HISTORY_TURNS
    chat_history_max_chars: int = DEFAULT_CHAT_HISTORY_MAX_CHARS
    strict_model: bool = True

    def __post_init__(self) -> None:
        self.chat_stream_enabled = False
        self.set_active_target(self.active_ollama_target)

    def get_active_ollama_url(self) -> str:
        """Zwraca URL aktywnego węzła Ollama (domyślnie lokalny :11434 lub statku :11435)."""
        if self.active_ollama_target.lower() in ("ship", "remote", "11435"):
            return self.ship_ollama_url
        return self.local_ollama_url

    def get_fallback_ollama_url(self, primary_url: str | None = None) -> str:
        """Zwraca zapasowy węzeł Ollama (:11434 <-> :11435), gdy główny węzeł jest offline."""
        current = (primary_url or self.get_active_ollama_url()).rstrip("/")
        loc = self.local_ollama_url.rstrip("/")
        ship = self.ship_ollama_url.rstrip("/")
        return ship if current == loc else loc

    def get_active_model(self) -> str:
        """Zwraca domyślny model dla aktywnego węzła."""
        if self.active_ollama_target.lower() in ("ship", "remote", "11435"):
            return self.ship_model
        return self.local_model

    def set_active_target(self, target: str) -> None:
        """Przełącza aktywny cel Ollama pomiędzy 'local' a 'ship'."""
        cleaned = target.strip().lower()
        if cleaned in ("ship", "remote", "svl364", "11435"):
            self.active_ollama_target = "ship"
        else:
            self.active_ollama_target = "local"

    @classmethod
    def load_from_env(cls) -> "JynOSConfig":
        return cls(
            chat_num_ctx=_env_int("SVL_CHAT_NUM_CTX", 2048, 512, 32768),
            chat_num_predict=_env_int("SVL_CHAT_NUM_PREDICT", 768, 64, 16384),
            chat_timeout=_env_int("SVL_CHAT_TIMEOUT", 300, 10, 3600),
            chat_history_turns=_env_int("SVL_CHAT_HISTORY_TURNS", 6, 0, 40),
            chat_history_max_chars=_env_int("SVL_CHAT_HISTORY_MAX_CHARS", 2000, 256, 32000),
            strict_model=True,
        )

