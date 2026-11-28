"""Moduł dwukierunkowej synchronizacji GitHub (git + gh CLI) dla repozytoriów JYN_OS / SVL_Core."""

from __future__ import annotations

import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

from .config import JynOSConfig

DEFAULT_WORKSPACE_REPOS: List[Dict[str, str]] = [
    {"name": "Rush47/SVL_Core", "path": "/home/antigravity/Rush47/SVL_Core", "branch": "main"},
    {"name": "Rush47/JYN_OS", "path": "/home/antigravity/Rush47/JYN_OS", "branch": "main"},
    {"name": "Rush47/JYN_OMEGA_OS", "path": "/home/antigravity/Rush47/JYN_OMEGA_OS", "branch": "main"},
]


@dataclass
class GitHubRepoStatus:
    """Stan pojedynczego repozytorium Git / GitHub."""

    name: str
    path: str
    branch: str
    exists: bool
    head_commit: str = ""
    remote_url: str = ""
    dirty_files: int = 0
    ahead_behind: str = ""
    ok: bool = True
    error: str = ""


class GitHubBiDirectionalSync:
    """Obsługuje dwukierunkową synchronizację (fetch, pull --rebase, push) z GitHubem przy użyciu git oraz gh CLI."""

    def __init__(
        self,
        config: Optional[JynOSConfig] = None,
        repos: Optional[List[Dict[str, str]]] = None,
    ) -> None:
        self.config = config or JynOSConfig.load_from_env()
        self.repos = repos or list(DEFAULT_WORKSPACE_REPOS)
        self.git_bin = shutil.which("git") or "/usr/bin/git"
        self.gh_bin = shutil.which("gh") or "/opt/antigravity/bin/gh"

    def _run_git(self, repo_path: Path, args: List[str], timeout: float = 30.0) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [self.git_bin, "-C", str(repo_path), *args],
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )

    def check_gh_cli_status(self) -> Dict[str, Any]:
        """Sprawdza dostępność i status autoryzacji narzędzia gh CLI."""
        if not Path(self.gh_bin).is_file() and shutil.which("gh") is None:
            return {"available": False, "authenticated": False, "binary": self.gh_bin, "detail": "Brak binarki gh"}
        try:
            proc = subprocess.run(
                [self.gh_bin, "auth", "status"],
                capture_output=True,
                text=True,
                timeout=10.0,
                check=False,
            )
            out = (proc.stdout + "\n" + proc.stderr).strip()
            return {
                "available": True,
                "authenticated": proc.returncode == 0,
                "binary": self.gh_bin,
                "detail": out.splitlines()[0] if out else "OK",
            }
        except Exception as exc:
            return {"available": True, "authenticated": False, "binary": self.gh_bin, "detail": str(exc)}

    def get_repo_status(self, repo_spec: Dict[str, str]) -> GitHubRepoStatus:
        """Zwraca szczegółowy status lokalnego repozytorium Git względem origin."""
        rpath = Path(repo_spec["path"])
        name = repo_spec["name"]
        branch = repo_spec.get("branch", "main")
        if not (rpath / ".git").exists():
            return GitHubRepoStatus(name=name, path=str(rpath), branch=branch, exists=False, ok=False, error="Brak katalogu .git")

        head_proc = self._run_git(rpath, ["rev-parse", "--short", "HEAD"])
        head_sha = head_proc.stdout.strip() if head_proc.returncode == 0 else "unknown"

        rem_proc = self._run_git(rpath, ["remote", "get-url", "origin"])
        rem_url = rem_proc.stdout.strip() if rem_proc.returncode == 0 else ""

        st_proc = self._run_git(rpath, ["status", "--porcelain"])
        dirty_lines = [ln for ln in st_proc.stdout.splitlines() if ln.strip()] if st_proc.returncode == 0 else []

        ab_proc = self._run_git(rpath, ["rev-list", "--left-right", "--count", f"HEAD...origin/{branch}"])
        if ab_proc.returncode == 0 and ab_proc.stdout.strip():
            parts = ab_proc.stdout.strip().split()
            ahead, behind = (parts[0], parts[1]) if len(parts) >= 2 else ("0", "0")
            ab_str = f"+{ahead}/-{behind}"
        else:
            ab_str = "+0/-0"

        return GitHubRepoStatus(
            name=name,
            path=str(rpath),
            branch=branch,
            exists=True,
            head_commit=head_sha,
            remote_url=rem_url,
            dirty_files=len(dirty_lines),
            ahead_behind=ab_str,
            ok=True,
        )

    def get_all_status(self) -> Dict[str, Any]:
        """Zwraca status wszystkich repozytoriów w przestrzeni roboczej oraz status gh CLI."""
        gh_info = self.check_gh_cli_status()
        statuses = [self.get_repo_status(r) for r in self.repos]
        return {
            "ok": all(s.ok for s in statuses),
            "gh_cli": gh_info,
            "repositories": [s.__dict__ for s in statuses],
        }

    def fetch_all(self) -> Dict[str, Any]:
        """Wykonuje git fetch origin na wszystkich skonfigurowanych repozytoriach."""
        results: List[Dict[str, Any]] = []
        for r in self.repos:
            rpath = Path(r["path"])
            if not (rpath / ".git").exists():
                results.append({"repo": r["name"], "ok": False, "error": "Brak .git"})
                continue
            proc = self._run_git(rpath, ["fetch", "origin"], timeout=30.0)
            results.append({
                "repo": r["name"],
                "ok": proc.returncode == 0,
                "output": (proc.stdout + proc.stderr).strip(),
            })
        return {"ok": all(x["ok"] for x in results), "action": "fetch", "results": results}

    def pull_all(self) -> Dict[str, Any]:
        """Wykonuje git pull --rebase --autostash origin <branch> na wszystkich repozytoriach."""
        results: List[Dict[str, Any]] = []
        for r in self.repos:
            rpath = Path(r["path"])
            branch = r.get("branch", "main")
            if not (rpath / ".git").exists():
                results.append({"repo": r["name"], "ok": False, "error": "Brak .git"})
                continue
            proc = self._run_git(rpath, ["pull", "--rebase", "--autostash", "origin", branch], timeout=45.0)
            results.append({
                "repo": r["name"],
                "ok": proc.returncode == 0,
                "output": (proc.stdout + proc.stderr).strip(),
            })
        return {"ok": all(x["ok"] for x in results), "action": "pull", "results": results}

    def push_all(self, commit_message: Optional[str] = None) -> Dict[str, Any]:
        """Opcjonalnie zatwierdza zmiany w katalogu JYN_OS i wypycha (git push origin main) we wszystkich repozytoriach."""
        results: List[Dict[str, Any]] = []
        for r in self.repos:
            rpath = Path(r["path"])
            branch = r.get("branch", "main")
            if not (rpath / ".git").exists():
                results.append({"repo": r["name"], "ok": False, "error": "Brak .git"})
                continue
            if commit_message:
                self._run_git(rpath, ["add", "JYN_OS"])
                self._run_git(rpath, ["commit", "-m", commit_message])
            proc = self._run_git(rpath, ["push", "origin", branch], timeout=45.0)
            results.append({
                "repo": r["name"],
                "ok": proc.returncode == 0,
                "output": (proc.stdout + proc.stderr).strip(),
            })
        return {"ok": all(x["ok"] for x in results), "action": "push", "results": results}

    def sync_all(self, commit_message: Optional[str] = None) -> Dict[str, Any]:
        """Pełna dwukierunkowa synchronizacja: fetch -> pull --rebase -> push origin main."""
        fetch_res = self.fetch_all()
        pull_res = self.pull_all()
        push_res = self.push_all(commit_message=commit_message)
        status_after = self.get_all_status()
        return {
            "ok": fetch_res["ok"] and pull_res["ok"] and push_res["ok"],
            "fetch": fetch_res,
            "pull": pull_res,
            "push": push_res,
            "status": status_after,
        }

    def format_status_report_pl(self) -> str:
        """Formatuje czytelny raport stanu synchronizacji GitHub po polsku."""
        st = self.get_all_status()
        gh = st["gh_cli"]
        gh_badge = "AUTHENTICATED" if gh["authenticated"] else ("AVAILABLE" if gh["available"] else "MISSING")
        lines = [
            "=== DWUKIERUNKOWA SYNCHRONIZACJA GITHUB (JYN_OS / SVL_Core) ===",
            f"• Narzędzie GitHub CLI (gh): {gh_badge} ({gh['binary']} — {gh['detail']})",
            "• Repozytoria robocze:",
        ]
        for r in st["repositories"]:
            state = "ONLINE / SYNCED" if r["ok"] else f"ERROR ({r['error']})"
            lines.append(
                f"  - {r['name']} [{r['branch']} @ {r['head_commit']}] | Δ {r['ahead_behind']} | "
                f"zmienione pliki: {r['dirty_files']} | {state}"
            )
        return "\n".join(lines)
