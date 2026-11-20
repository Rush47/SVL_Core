"""Lightweight Streamable HTTP MCP client fallback for SVL CoreOS 2 Python runtime."""
from __future__ import annotations

import json
import urllib.request
from contextlib import asynccontextmanager
from types import SimpleNamespace
from typing import Any, AsyncIterator, Optional, Tuple


class _StreamableHttpEndpoint:
    def __init__(self, url: str, http_client: Any = None) -> None:
        self.url = url
        self.http_client = http_client

    async def post_jsonrpc(self, method: str, params: Optional[dict[str, Any]] = None) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": method,
        }
        if params is not None:
            payload["params"] = params

        if self.http_client is not None and hasattr(self.http_client, "post"):
            resp = await self.http_client.post(
                self.url,
                json=payload,
                headers={"Accept": "application/json, text/event-stream", "Content-Type": "application/json"},
            )
            text = resp.text.strip()
        else:
            headers = {
                "Accept": "application/json, text/event-stream",
                "Content-Type": "application/json",
            }
            if self.http_client is not None and hasattr(self.http_client, "headers"):
                headers.update(dict(self.http_client.headers))
            req = urllib.request.Request(
                self.url,
                data=json.dumps(payload).encode("utf-8"),
                headers=headers,
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=20) as r:
                text = r.read().decode("utf-8").strip()

        for line in text.splitlines():
            stripped = line.strip()
            if stripped.startswith("data:"):
                stripped = stripped[5:].strip()
            if stripped.startswith("{") and stripped.endswith("}"):
                return json.loads(stripped)
        return json.loads(text) if text else {}


class ClientSession:
    def __init__(self, read_stream: Any = None, write_stream: Any = None) -> None:
        self._read_stream = read_stream
        self._write_stream = write_stream
        self._endpoint: Optional[_StreamableHttpEndpoint] = (
            read_stream if isinstance(read_stream, _StreamableHttpEndpoint) else None
        )

    async def __aenter__(self) -> "ClientSession":
        return self

    async def __aexit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        return None

    async def initialize(self) -> Any:
        if self._endpoint is not None:
            await self._endpoint.post_jsonrpc(
                "initialize",
                {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": {"name": "svl-python-mcp-client", "version": "2.0.0"},
                },
            )
        return SimpleNamespace(protocolVersion="2024-11-05")

    async def list_tools(self) -> Any:
        if self._endpoint is None:
            return SimpleNamespace(tools=[])
        data = await self._endpoint.post_jsonrpc("tools/list", {})
        raw_tools = (data.get("result") or {}).get("tools") or []
        tools = [
            SimpleNamespace(
                name=str(t.get("name") or ""),
                description=str(t.get("description") or ""),
                inputSchema=t.get("inputSchema") if isinstance(t.get("inputSchema"), dict) else {"type": "object", "properties": {}},
            )
            for t in raw_tools
            if isinstance(t, dict)
        ]
        return SimpleNamespace(tools=tools)

    async def call_tool(self, name: str, arguments: Optional[dict[str, Any]] = None) -> Any:
        if self._endpoint is None:
            return SimpleNamespace(content=[SimpleNamespace(text="")], isError=True)
        data = await self._endpoint.post_jsonrpc(
            "tools/call",
            {"name": name, "arguments": arguments or {}},
        )
        if "error" in data:
            err_msg = str((data.get("error") or {}).get("message") or data["error"])
            return SimpleNamespace(content=[SimpleNamespace(text=err_msg)], isError=True)
        res = data.get("result") or {}
        raw_content = res.get("content") or []
        content = [
            SimpleNamespace(text=str(item.get("text") or ""))
            for item in raw_content
            if isinstance(item, dict)
        ]
        return SimpleNamespace(content=content, isError=bool(res.get("isError", False)))


@asynccontextmanager
async def streamable_http_client(
    url: str,
    *,
    http_client: Any = None,
) -> AsyncIterator[Tuple[_StreamableHttpEndpoint, _StreamableHttpEndpoint, None]]:
    endpoint = _StreamableHttpEndpoint(url, http_client=http_client)
    yield endpoint, endpoint, None
