"""Moduł konfiguracji technicznej Cloudflare Zero Trust Tunnel / Workers oraz Google Cloud Run dla JYN_OS."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

from .config import JynOSConfig


@dataclass
class CloudflareTunnelConfig:
    """Parametry konfiguracyjne tunelu Cloudflare Zero Trust (cloudflared) i WAF."""

    tunnel_name: str = "jyn-os-svl364-tunnel"
    tunnel_uuid: str = "36400000-eb0n-4pex-8000-000000000364"
    hostname: str = "jyn-os.svl364.internal"
    local_service_url: str = "http://127.0.0.1:8085"
    ollama_service_url: str = "http://127.0.0.1:11435"
    credentials_file: str = "/etc/cloudflared/jyn-os-svl364-tunnel.json"
    waf_mode: str = "strict"


@dataclass
class CloudRunDeployConfig:
    """Parametry wdrożenia kontenerowego na Google Cloud Run."""

    project_id: str = "svl364-ebon-apex"
    region: str = "europe-central2"
    service_name: str = "jyn-os-core"
    image_tag: str = "gcr.io/svl364-ebon-apex/jyn-os-core:latest"
    port: int = 8085
    cpu: str = "4"
    memory: str = "16Gi"
    max_instances: int = 10
    min_instances: int = 1
    env_vars: Dict[str, str] = field(
        default_factory=lambda: {
            "SVL_OLLAMA_TARGET": "ship",
            "SVL_SHIP_OLLAMA_STANDALONE_PORT": "11435",
            "SVL_GOOGLE_REGION": "europe-central2",
        }
    )


class CloudflareGCloudDeployer:
    """Generator konfiguracji i skryptów wdrożeniowych Cloudflare Tunnel / Workers oraz Google Cloud Run."""

    def __init__(
        self,
        config: Optional[JynOSConfig] = None,
        cf_config: Optional[CloudflareTunnelConfig] = None,
        cr_config: Optional[CloudRunDeployConfig] = None,
    ) -> None:
        self.config = config or JynOSConfig.load_from_env()
        self.cf_config = cf_config or CloudflareTunnelConfig(
            hostname=os.environ.get("CF_TUNNEL_HOSTNAME", "jyn-os.svl364.internal"),
            local_service_url=self.config.backend_url,
            ollama_service_url=self.config.ship_ollama_url,
        )
        self.cr_config = cr_config or CloudRunDeployConfig(
            project_id=self.config.google_project_id,
            region=self.config.google_region,
            image_tag=f"gcr.io/{self.config.google_project_id}/jyn-os-core:latest",
        )

    def generate_cloudflared_config_yaml(self) -> str:
        """Generuje zawartość pliku config.yml dla demona cloudflared."""
        return (
            f"tunnel: {self.cf_config.tunnel_uuid}\n"
            f"credentials-file: {self.cf_config.credentials_file}\n"
            "protocol: quic\n"
            "ingress:\n"
            f"  - hostname: {self.cf_config.hostname}\n"
            "    path: /api/ollama/*\n"
            f"    service: {self.cf_config.ollama_service_url}\n"
            f"  - hostname: {self.cf_config.hostname}\n"
            f"    service: {self.cf_config.local_service_url}\n"
            "  - service: http_status:404\n"
        )

    def generate_cloudflare_worker_js(self) -> str:
        """Generuje kod Cloudflare Worker obsługujący proxy API, nagłówki bezpieczeństwa i CORS."""
        return (
            "export default {\n"
            "  async fetch(request, env) {\n"
            "    const url = new URL(request.url);\n"
            f"    const upstreamHost = env.UPSTREAM_HOST || '{self.cf_config.hostname}';\n"
            "    if (request.method === 'OPTIONS') {\n"
            "      return new Response(null, {\n"
            "        status: 204,\n"
            "        headers: {\n"
            "          'Access-Control-Allow-Origin': '*',\n"
            "          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',\n"
            "          'Access-Control-Allow-Headers': 'Content-Type, Authorization',\n"
            "        },\n"
            "      });\n"
            "    }\n"
            "    url.hostname = upstreamHost;\n"
            "    const proxyReq = new Request(url.toString(), request);\n"
            "    const response = await fetch(proxyReq);\n"
            "    const headers = new Headers(response.headers);\n"
            "    headers.set('X-Protected-By', 'Cloudflare-Zero-Trust-JYN_OS');\n"
            "    return new Response(response.body, { status: response.status, headers });\n"
            "  }\n"
            "};\n"
        )

    def generate_dockerfile(self) -> str:
        """Generuje Dockerfile dla konteneryzacji środowiska JYN_OS pod Google Cloud Run."""
        return (
            "FROM python:3.11-slim\n"
            "WORKDIR /app\n"
            "ENV PYTHONDONTWRITEBYTECODE=1 \\\n"
            "    PYTHONUNBUFFERED=1 \\\n"
            "    PORT=11435\n"
            "COPY . /app/JYN_OS/\n"
            "EXPOSE 11435\n"
            'CMD ["python3", "/app/JYN_OS/svl364_standalone_ollama.py", "11435"]\n'
        )

    def generate_cloudbuild_yaml(self) -> str:
        """Generuje specyfikację Google Cloud Build (cloudbuild.yaml) do budowy i wdrożenia na Cloud Run."""
        return (
            "steps:\n"
            "  - name: 'gcr.io/cloud-builders/docker'\n"
            f"    args: ['build', '-t', '{self.cr_config.image_tag}', '-f', 'JYN_OS/Dockerfile', '.']\n"
            "  - name: 'gcr.io/cloud-builders/docker'\n"
            f"    args: ['push', '{self.cr_config.image_tag}']\n"
            "  - name: 'gcr.io/google.com/cloudsdktool/cloud-sdk'\n"
            "    entrypoint: gcloud\n"
            "    args:\n"
            "      - 'run'\n"
            "      - 'deploy'\n"
            f"      - '{self.cr_config.service_name}'\n"
            f"      - '--image={self.cr_config.image_tag}'\n"
            f"      - '--region={self.cr_config.region}'\n"
            "      - '--platform=managed'\n"
            f"      - '--cpu={self.cr_config.cpu}'\n"
            f"      - '--memory={self.cr_config.memory}'\n"
            f"      - '--min-instances={self.cr_config.min_instances}'\n"
            f"      - '--max-instances={self.cr_config.max_instances}'\n"
            "      - '--allow-unauthenticated'\n"
            "images:\n"
            f"  - '{self.cr_config.image_tag}'\n"
        )

    def get_gcloud_deploy_command(self) -> List[str]:
        """Zwraca listę argumentów CLI dla bezpośredniego wdrożenia przez gcloud run deploy."""
        env_pairs = ",".join(f"{k}={v}" for k, v in sorted(self.cr_config.env_vars.items()))
        return [
            "gcloud",
            "run",
            "deploy",
            self.cr_config.service_name,
            f"--project={self.cr_config.project_id}",
            f"--region={self.cr_config.region}",
            f"--image={self.cr_config.image_tag}",
            "--platform=managed",
            f"--port={self.cr_config.port}",
            f"--cpu={self.cr_config.cpu}",
            f"--memory={self.cr_config.memory}",
            f"--set-env-vars={env_pairs}",
            "--allow-unauthenticated",
        ]

    def write_deployment_artifacts(self, output_dir: Optional[Path] = None) -> Dict[str, Any]:
        """Zapisuje pliki konfiguracyjne (Dockerfile, cloudbuild.yaml, cloudflared.yml, data/deploy/*) na dysku."""
        target_dir = Path(output_dir) if output_dir else Path(__file__).resolve().parent
        target_dir.mkdir(parents=True, exist_ok=True)
        deploy_data_dir = target_dir / "data" / "deploy"
        deploy_data_dir.mkdir(parents=True, exist_ok=True)

        dockerfile_path = target_dir / "Dockerfile"
        cloudbuild_path = target_dir / "cloudbuild.yaml"
        cloudflared_path = target_dir / "cloudflared.yml"
        tunnel_yaml_path = deploy_data_dir / "cloudflared_tunnel.yml"
        worker_js_path = deploy_data_dir / "cloudflare_worker.js"

        cf_yaml = self.generate_cloudflared_config_yaml()
        worker_js = self.generate_cloudflare_worker_js()

        dockerfile_path.write_text(self.generate_dockerfile(), encoding="utf-8")
        cloudbuild_path.write_text(self.generate_cloudbuild_yaml(), encoding="utf-8")
        cloudflared_path.write_text(cf_yaml, encoding="utf-8")
        tunnel_yaml_path.write_text(cf_yaml, encoding="utf-8")
        worker_js_path.write_text(worker_js, encoding="utf-8")

        return {
            "ok": True,
            "files": {
                "dockerfile": str(dockerfile_path),
                "cloudbuild": str(cloudbuild_path),
                "cloudflared": str(cloudflared_path),
                "cloudflared_tunnel": str(tunnel_yaml_path),
                "cloudflare_worker": str(worker_js_path),
            },
            "gcloud_command": " ".join(self.get_gcloud_deploy_command()),
            "tunnel_hostname": self.cf_config.hostname,
            "cloud_run_service": self.cr_config.service_name,
        }
