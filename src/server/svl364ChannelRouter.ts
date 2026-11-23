// Router kanału `conv-svl364-mcp-root` (SVL-364 — Komputer Pokładowy · MCP · ROOT).
// Obsługuje dowolne polecenia powłoki Linux (jako ROOT), komendy `/mcp …`, `/root …`,
// oraz dowolne zapytania naturalne delegowane do AI z pełnymi narzędziami MCP ROOT.

export const SVL364_ROOT_CHANNEL_ID = 'conv-svl364-mcp-root';
export const SVL364_ROOT_CHANNEL_TITLE = 'SVL-364 — Komputer Pokładowy (MCP · ROOT)';

export type Svl364ChannelIntent =
  | { kind: 'mcp_help' }
  | { kind: 'mcp_status' }
  | { kind: 'mcp_test' }
  | { kind: 'mcp_tools' }
  | { kind: 'mcp_connect'; url: string; token?: string }
  | { kind: 'mcp_disconnect' }
  | { kind: 'mcp_tool'; tool: string; arguments: Record<string, unknown>; remote?: boolean }
  | { kind: 'root_exec'; command: string; transport: 'auto' | 'remote-mcp' | 'ssh'; explicit: boolean }
  | { kind: 'natural_root_query'; query: string };

const SHELL_COMMAND_BINS = new Set([
  'id', 'whoami', 'uname', 'hostname', 'hostnamectl', 'timedatectl', 'uptime', 'date', 'cal',
  'free', 'df', 'du', 'ls', 'll', 'la', 'pwd', 'cd', 'tree', 'stat', 'file', 'which', 'whereis',
  'cat', 'head', 'tail', 'less', 'more', 'tac', 'nl', 'wc', 'sort', 'uniq', 'tr', 'cut', 'paste',
  'grep', 'egrep', 'fgrep', 'rg', 'awk', 'sed', 'find', 'fd', 'xargs', 'tee', 'jq',
  'ps', 'top', 'htop', 'pgrep', 'pkill', 'kill', 'killall', 'nohup', 'nice', 'renice', 'lsof',
  'ip', 'ss', 'netstat', 'ping', 'ping6', 'traceroute', 'tracepath', 'dig', 'nslookup', 'host',
  'curl', 'wget', 'nc', 'ncat', 'nmap', 'socat', 'ethtool', 'iw', 'nmcli', 'resolvectl',
  'ufw', 'iptables', 'ip6tables', 'nft', 'fail2ban-client',
  'systemctl', 'service', 'journalctl', 'dmesg', 'sysctl', 'modprobe', 'lsmod', 'crontab',
  'apt', 'apt-get', 'apt-cache', 'apt-mark', 'dpkg', 'snap', 'flatpak',
  'docker', 'podman', 'kubectl', 'helm', 'compose',
  'ollama', 'tailscale', 'cloudflared', 'ngrok', 'zerotier-cli', 'wg', 'wg-quick',
  'ssh', 'scp', 'sftp', 'rsync', 'ssh-keygen',
  'sudo', 'su', 'passwd', 'useradd', 'usermod', 'userdel', 'groupadd', 'groups', 'id',
  'chmod', 'chown', 'chgrp', 'mkdir', 'rmdir', 'rm', 'cp', 'mv', 'touch', 'ln', 'mktemp',
  'tar', 'gzip', 'gunzip', 'bzip2', 'xz', 'zstd', 'zip', 'unzip', 'dd', 'lsblk', 'blkid', 'mount', 'umount', 'fdisk', 'parted',
  'python', 'python3', 'pip', 'pip3', 'uv', 'node', 'npm', 'npx', 'pnpm', 'yarn', 'tsx', 'deno', 'bun',
  'git', 'gh', 'make', 'cmake', 'gcc', 'g++', 'rustc', 'cargo', 'go', 'java',
  'sqlite3', 'psql', 'mysql', 'redis-cli',
  'nvidia-smi', 'rocm-smi', 'sensors', 'lscpu', 'lspci', 'lsusb', 'dmidecode', 'vmstat', 'iostat', 'mpstat', 'sar',
  'env', 'printenv', 'export', 'echo', 'printf', 'bash', 'sh', 'zsh', 'dash', 'screen', 'tmux',
  'svl364-ssh', 'svl364-mcp', 'svl-mcp-info', 'svl-db',
  'reboot', 'shutdown', 'poweroff', 'sync', 'true', 'false', 'test', '[',
]);

const POLISH_NATURAL_STARTERS = new Set([
  'sprawdź', 'sprawdz', 'pokaż', 'pokaz', 'wyświetl', 'wyswietl', 'ustaw', 'skonfiguruj',
  'uruchom', 'włącz', 'wlacz', 'wyłącz', 'wylacz', 'zrestartuj', 'zatrzymaj',
  'stwórz', 'stworz', 'utwórz', 'utworz', 'dodaj', 'usuń', 'usun', 'napraw', 'popraw',
  'zainstaluj', 'zaktualizuj', 'przeskanuj', 'zbadaj', 'przeanalizuj', 'sprawdzaj',
  'podaj', 'powiedz', 'opisz', 'wyjaśnij', 'wyjasnij', 'napisz', 'przygotuj', 'zrób', 'zrob', 'wykonaj',
  'jaki', 'jaka', 'jakie', 'jak', 'czy', 'ile', 'gdzie', 'dlaczego', 'co', 'kiedy', 'który', 'ktore', 'które',
  'cześć', 'czesc', 'hej', 'witaj', 'siema', 'pomóż', 'pomoz', 'proszę', 'prosze',
]);

function parseJsonLoose(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fallback below
  }
  return { command: trimmed, directive: trimmed };
}

export function looksLikeDirectShellCommand(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  // Ścieżka wykonywalna lub skrypt lokalny (np. ./skrypt.sh, /usr/local/bin/foo, /opt/svl/run.sh)
  if (/^(?:\.\.?\/|\/(?:bin|sbin|usr|opt|etc|var|root|home|srv|tmp)\/)/.test(trimmed)) {
    return true;
  }
  // Zmienna środowiskowa przed poleceniem (np. OLLAMA_HOST=127.0.0.1:11434 ollama list)
  if (/^[A-Z_][A-Z0-9_]*=\S+\s+\S+/.test(trimmed)) {
    return true;
  }
  const firstLine = trimmed.split('\n')[0].trim();
  const firstToken = (firstLine.split(/\s+/)[0] || '').replace(/^['"`(]+/, '');
  const firstLower = firstToken.toLowerCase();
  if (POLISH_NATURAL_STARTERS.has(firstLower)) {
    return false;
  }
  if (SHELL_COMMAND_BINS.has(firstLower)) {
    // Jeśli pierwszy token jest komendą shellową (np. `id`, `systemctl status`, `docker ps`),
    // a zdanie nie wygląda na polską prozę z polskimi znakami przed jakimkolwiek operatorem shellowym
    const hasPolishDiacritics = /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/.test(firstLine);
    const quotesOrShell = /['"`|&;><$`\\/]/.test(firstLine);
    if (!hasPolishDiacritics || quotesOrShell) {
      return true;
    }
  }
  // Wyraźna składnia potoku/łańcucha shellowego (np. foo | grep bar, cmd1 && cmd2) bez polskich słów na początku
  if (/(?:\s&&\s|\s\|\|\s|\s\|\s|2>&1|\/dev\/null|\$\()/.test(trimmed) && !/[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/.test(firstToken)) {
    return true;
  }
  return false;
}

export function parseSvl364ChannelInput(rawMessage: string): Svl364ChannelIntent {
  const trimmed = String(rawMessage || '').trim();
  if (!trimmed) return { kind: 'mcp_status' };

  // Obsługa opcjonalnego prefiksu /svl364 (działa także z innych kanałów)
  const unwrapped = trimmed.replace(/^\/svl364(?:\s+|$)/i, '').trim() || trimmed;

  if (/^\/(?:help|pomoc)\s*$/i.test(unwrapped) || /^\/mcp\s+(?:help|pomoc)\s*$/i.test(unwrapped)) {
    return { kind: 'mcp_help' };
  }
  if (/^\/status\s*$/i.test(unwrapped) || /^\/mcp(?:\s+status)?\s*$/i.test(unwrapped)) {
    return { kind: 'mcp_status' };
  }
  if (/^\/mcp\s+test\s*$/i.test(unwrapped)) {
    return { kind: 'mcp_test' };
  }
  if (/^\/mcp\s+tools\s*$/i.test(unwrapped)) {
    return { kind: 'mcp_tools' };
  }
  if (/^\/mcp\s+disconnect\s*$/i.test(unwrapped)) {
    return { kind: 'mcp_disconnect' };
  }

  const connectMatch = /^\/mcp\s+connect\s+(\S+)(?:\s+(\S+))?\s*$/i.exec(unwrapped);
  if (connectMatch) {
    return {
      kind: 'mcp_connect',
      url: connectMatch[1].trim(),
      ...(connectMatch[2] ? { token: connectMatch[2].trim() } : {}),
    };
  }

  const mcpSubMatch = /^\/mcp\s+(\S+)(?:\s+([\s\S]+))?$/i.exec(unwrapped);
  if (mcpSubMatch) {
    const sub = mcpSubMatch[1].toLowerCase();
    const rest = (mcpSubMatch[2] || '').trim();
    if (sub === 'telemetry' || sub === 'telemetria') {
      return { kind: 'mcp_tool', tool: 'svl364_linux_telemetry', arguments: {} };
    }
    if (sub === 'services' || sub === 'uslugi' || sub === 'usługi') {
      return { kind: 'mcp_tool', tool: 'svl364_resources', arguments: { area: 'services' } };
    }
    if (sub === 'resources' || sub === 'zasoby') {
      const area = rest.split(/\s+/)[0] || 'overview';
      const target = rest.split(/\s+/).slice(1).join(' ').trim();
      return {
        kind: 'mcp_tool',
        tool: 'svl364_resources',
        arguments: { area, ...(target ? { target } : {}) },
      };
    }
    if (sub === 'ollama') {
      const [action = 'list', model = ''] = rest.split(/\s+/);
      return {
        kind: 'mcp_tool',
        tool: 'svl364_ollama_control',
        arguments: { action, ...(model ? { model } : {}), confirmed: true },
      };
    }
    if (sub === 'tunnel' || sub === 'tunel') {
      const action = rest.split(/\s+/)[0] || 'status';
      return {
        kind: 'mcp_tool',
        tool: 'svl364_tunnel_control',
        arguments: { action, confirmed: true },
      };
    }
    if (sub === 'containers' || sub === 'docker' || sub === 'kontenery') {
      const [action = 'list', container = ''] = rest.split(/\s+/);
      return {
        kind: 'mcp_tool',
        tool: 'svl364_container_control',
        arguments: { action, ...(container ? { container } : {}), confirmed: true },
      };
    }
    if (sub === 'comfyui') {
      const action = rest.split(/\s+/)[0] || 'status';
      return {
        kind: 'mcp_tool',
        tool: 'svl364_comfyui_control',
        arguments: { action, confirmed: true },
      };
    }
    if (sub === 'remote') {
      const [remoteTool, ...argTokens] = rest.split(/\s+/);
      if (remoteTool) {
        return {
          kind: 'mcp_tool',
          tool: remoteTool,
          arguments: parseJsonLoose(argTokens.join(' ')),
          remote: true,
        };
      }
      return { kind: 'mcp_test' };
    }
    if (sub === 'call') {
      const [toolName, ...argTokens] = rest.split(/\s+/);
      if (toolName) {
        const isRemote = toolName.startsWith('remote:');
        return {
          kind: 'mcp_tool',
          tool: isRemote ? toolName.slice('remote:'.length) : toolName,
          arguments: { ...parseJsonLoose(argTokens.join(' ')), confirmed: true },
          remote: isRemote,
        };
      }
      return { kind: 'mcp_tools' };
    }
    // Skrót `/mcp <nazwa_narzędzia_svl364> [json]`
    if (sub.startsWith('svl364_')) {
      return {
        kind: 'mcp_tool',
        tool: sub,
        arguments: { ...parseJsonLoose(rest), confirmed: true },
      };
    }
  }

  // Jawny prefiks wykonania DOWOLNEGO polecenia jako ROOT: /root, /exec, /sh, /ssh, !, #
  const explicitSshMatch = /^\/ssh\s+([\s\S]+)$/i.exec(unwrapped);
  if (explicitSshMatch && explicitSshMatch[1].trim()) {
    return { kind: 'root_exec', command: explicitSshMatch[1].trim(), transport: 'ssh', explicit: true };
  }
  const explicitRootMatch = /^(?:\/(?:root|exec|sh)\s+|!\s*|#\s+)([\s\S]+)$/i.exec(unwrapped);
  if (explicitRootMatch && explicitRootMatch[1].trim()) {
    return { kind: 'root_exec', command: explicitRootMatch[1].trim(), transport: 'auto', explicit: true };
  }

  // Bezpośrednia komenda Linux wpisana w kanale SVL-364 bez prefiksu
  if (looksLikeDirectShellCommand(unwrapped)) {
    return { kind: 'root_exec', command: unwrapped, transport: 'auto', explicit: false };
  }

  // Dowolne pytanie lub zadanie naturalne przetwarzane przez AI w trybie SVL-364 MCP ROOT
  return { kind: 'natural_root_query', query: unwrapped };
}

export function formatSvl364RootExecMarkdown(params: {
  command: string;
  ok: boolean;
  exitCode: number;
  transport: string;
  endpoint?: string;
  durationMs?: number;
  output: string;
  error?: string;
  remoteMcpFallbackReason?: string;
}): string {
  const transportLabel =
    params.transport === 'remote-mcp-root'
      ? `Remote MCP Zero-IP · ROOT (${params.endpoint || 'SVL-364'})`
      : params.transport === 'openssh-root'
        ? `OpenSSH · ROOT (${params.endpoint || 'ssh://Ship'})`
        : params.transport || 'SVL-364 MCP ROOT';
  const statusCard = params.ok
    ? `[card: OK|exit ${params.exitCode}|ok]`
    : `[card: BŁĄD|exit ${params.exitCode}|err]`;
  const durationText = typeof params.durationMs === 'number' ? `${params.durationMs} ms` : '—';
  const cleanBody = String(params.output || params.error || '(brak wyjścia)').trim().slice(0, 12000);
  const safeFenceBody = cleanBody.replace(/```/g, '``\u200b`');
  const fallbackNote = params.remoteMcpFallbackReason
    ? `\n> ⚠️ Remote MCP niedostępny (${params.remoteMcpFallbackReason}) — użyto zapasowego mostka OpenSSH.\n`
    : '';
  const offlineHint = !params.ok && /nie jest zainstalowany|Brak połączenia|Could not resolve|Connection refused|nie jest skonfigurowany|255/i.test(
    `${params.error || ''} ${cleanBody}`,
  )
    ? `\n> 💡 **Połącz statek SVL-364 bez stałego IP (MCP):** uruchom na SVL-364 \`sudo bash SVL_CoreOS_2/debian13/install_svl364_mcp_zeroip.sh\`, a następnie wpisz tutaj:\n> \`/mcp connect https://<adres-tunelu>/mcp <token>\`\n`
    : '';
  const repeatCmd = params.command.replace(/[\]|]/g, ' ').slice(0, 140);
  return (
    `### 💻 SVL-364 ROOT · ${params.ok ? 'Wykonano' : 'Błąd wykonania'}\n\n` +
    `| Transport | Uprawnienia | Status | Czas |\n` +
    `| :--- | :--- | :--- | :--- |\n` +
    `| \`${transportLabel}\` | \`ROOT (uid=0)\` | ${statusCard} | \`${durationText}\` |\n` +
    fallbackNote +
    `\n\`\`\`bash\n# ${params.command}\n${safeFenceBody}\n\`\`\`\n` +
    offlineHint +
    `\n[btn: 🔄 Powtórz polecenie|send:/root ${repeatCmd}] ` +
    `[btn: 🔌 Status MCP + SSH|send:/mcp status] ` +
    `[btn: 🖥️ Telemetria|send:/mcp telemetry] ` +
    `[btn: 🚀 Panel SVL-364|tab:svl364]`
  );
}

export function formatSvl364BridgeStatusMarkdown(status: any): string {
  const remote = status?.remoteMcp || {};
  const ssh = status?.ssh || {};
  const mcp = status?.mcp || {};
  const remoteCard = remote.connected
    ? '[card: ONLINE|Zero-IP MCP|ok]'
    : remote.configured
      ? '[card: SKONFIGUROWANY|Do testu|warn]'
      : '[card: NIEPOŁĄCZONY|Użyj /mcp connect|info]';
  const sshCard = ssh.targetReachable
    ? '[card: OSIĄGALNY|OpenSSH|ok]'
    : '[card: OFFLINE|Sprawdź ~/.ssh/config|warn]';
  const activeTransport = remote.enabled
    ? `Remote MCP (${remote.url}) → fallback OpenSSH (${ssh.uri || 'ssh://Ship'})`
    : `OpenSSH (${ssh.uri || 'ssh://Ship'}) · Remote MCP gotowy do podpięcia`;
  const toolsCount = Array.isArray(mcp.tools) ? mcp.tools.length : 0;
  return (
    `### 🛰️ Status dostępu MCP + ROOT — Komputer Pokładowy SVL-364\n\n` +
    `| Warstwa połączenia | Konfiguracja | Status |\n` +
    `| :--- | :--- | :--- |\n` +
    `| **Zdalny serwer MCP SVL-364 (Zero-IP)** | \`${remote.url || 'nie skonfigurowano'}\` (token: \`${remote.tokenConfigured ? 'zapisany 0600' : 'brak'}\`) | ${remoteCard} |\n` +
    `| **Mostek OpenSSH** | \`${ssh.uri || 'ssh://Ship'}\` (port \`${ssh.port || 22}\`) | ${sshCard} |\n` +
    `| **Aktywny transport ROOT** | \`${activeTransport}\` | [card: ROOT|${remote.rootExecEnabled !== false ? 'uid=0 / sudo -n' : 'standard'}|ok] |\n` +
    `| **Serwer MCP bramy** | \`${mcp.endpoint || '/api/mcp/svl364'}\` · narzędzi: \`${toolsCount}\` | [card: MCP 2025-03-26|Aktywny|ok] |\n` +
    `| **Kanał operacyjny** | \`${SVL364_ROOT_CHANNEL_ID}\` | [card: Stały kanał|SQLite WAL|ok] |\n` +
    (remote.lastError ? `\n> ⚠️ Ostatni błąd Remote MCP: \`${remote.lastError}\`\n` : '') +
    `\n**Jak podłączyć SVL-364 przez MCP bez stałego IP:**\n` +
    `\`/mcp connect https://<adres-tunelu-cloudflare-lub-tailscale>/mcp <token>\`\n\n` +
    `[btn: 🧪 Testuj połączenie MCP + SSH|send:/mcp test] ` +
    `[btn: ⚡ Test ROOT (id & uname)|send:/root id && hostname && uname -a && uptime] ` +
    `[btn: 🛠️ Lista narzędzi MCP|send:/mcp tools] ` +
    `[btn: 🖥️ Telemetria|send:/mcp telemetry] ` +
    `[btn: 🚀 Panel SVL-364|tab:svl364]`
  );
}

export function formatSvl364ChannelHelpMarkdown(): string {
  return (
    `### 📖 Kanał SVL-364 — Komputer Pokładowy (MCP · ROOT) — Pomoc\n\n` +
    `W tym kanale możesz przetwarzać **dowolne polecenia powłoki Linux** oraz **dowolne zapytania w języku naturalnym** z uprawnieniami **ROOT (\`uid=0\`)** na komputerze statku SVL-364.\n\n` +
    `| Składnia | Działanie |\n` +
    `| :--- | :--- |\n` +
    `| \`<dowolna komenda Linux>\` | Bezpośrednie wykonanie jako **root** (np. \`uname -a\`, \`ls -la /opt\`, \`systemctl status ollama\`, \`docker ps\`) |\n` +
    `| \`/root <dowolne polecenie>\` lub \`!<polecenie>\` | Wymuszone wykonanie dosłowne jako **root** bez interpretacji (obsługuje potoki, skrypty, pętle, dowolne binarki) |\n` +
    `| \`/ssh <dowolne polecenie>\` | Wykonanie bezpośrednio przez OpenSSH \`ssh://Ship\` jako **root** |\n` +
    `| \`/mcp connect <url> [token]\` | Podłączenie zdalnego serwera MCP na SVL-364 (Zero-IP Cloudflare / Tailscale / Mesh) |\n` +
    `| \`/mcp status\` / \`/mcp test\` | Status i test na żywo połączenia Remote MCP + OpenSSH |\n` +
    `| \`/mcp tools\` | Pełna lista narzędzi MCP serwera SVL-364 |\n` +
    `| \`/mcp telemetry\` · \`/mcp services\` · \`/mcp ollama\` · \`/mcp tunnel\` · \`/mcp containers\` | Szybkie operacje MCP na statku |\n` +
    `| \`/mcp call <narzędzie> [JSON]\` · \`/mcp remote <narzędzie> [JSON]\` | Bezpośrednie wywołanie dowolnego narzędzia MCP lokalnego lub zdalnego na SVL-364 |\n` +
    `| *Dowolne pytanie po polsku* | Przetwarzane przez AI z dostępem do narzędzi **MCP ROOT** na SVL-364 |\n\n` +
    `[btn: 🔌 Status MCP + SSH|send:/mcp status] ` +
    `[btn: 🧪 Test połączenia|send:/mcp test] ` +
    `[btn: ⚡ Test ROOT|send:/root id && hostname && uname -a] ` +
    `[btn: 🛠️ Lista narzędzi MCP|send:/mcp tools]`
  );
}
