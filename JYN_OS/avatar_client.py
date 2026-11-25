"""Optional own-avatar action through the authenticated SVL gateway (Jyn profile only)."""
from __future__ import annotations
import json
import re
import urllib.parse
import urllib.request
from .config import resolve_auth_token

AVATAR_CAPABILITY = 'Optional own-avatar tool: emit a separate line <svl_avatar>{"query":"image search terms","index":0}</svl_avatar> (Wikimedia Commons, index 0–4), or {"file":"File:exact filename.jpg"} inside the same tag. No action is required. Server reports success or failure separately.'

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
            raise ValueError(result.get("error") or "Brak potwierdzenia zmiany.")
        return "Serwer: zapisano awatar — "+str(result.get("title",""))+"; "+str(result.get("license",""))+"; "+str(result.get("sourceUrl",""))
    except Exception as exc:
        return "Serwer: nie potwierdzono zmiany awatara — "+str(exc)
