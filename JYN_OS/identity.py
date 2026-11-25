"""Independent local identity; not an SSH or model-provider credential."""
from dataclasses import dataclass
from pathlib import Path
import json
import os
import tempfile
import uuid

@dataclass(frozen=True)
class JynIdentity:
    account_id: str
    channel_id: str

def load_identity() -> JynIdentity:
    root = Path(os.environ.get("XDG_STATE_HOME") or Path.home() / ".local" / "state")
    path = Path(os.environ.get("JYN_OS_IDENTITY_PATH") or root / "jyn_os" / "identity-20261125.json")
    path.parent.mkdir(parents=True, exist_ok=True)
    def read():
        raw = json.loads(path.read_text(encoding="utf-8"))
        account, channel = raw["account_id"], raw["channel_id"]
        if not account.startswith("jyn-os-ai-") or not channel.startswith("jyn-os-chat-"):
            raise ValueError("Invalid JYN_OS identity")
        return JynIdentity(account, channel)
    try:
        return read()
    except FileNotFoundError:
        identity = JynIdentity("jyn-os-ai-" + uuid.uuid4().hex, "jyn-os-chat-" + uuid.uuid4().hex)
        fd, tmp = tempfile.mkstemp(prefix=".identity-", dir=path.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                json.dump({"account_id": identity.account_id, "channel_id": identity.channel_id}, stream)
            try:
                os.link(tmp, path)
            except FileExistsError:
                return read()
            return identity
        finally:
            os.unlink(tmp)
