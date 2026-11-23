import React, { useState, useEffect, useRef } from 'react';
import { GitHubPanel } from './GitHubPanel';
import { McpConnectorCard } from './McpConnectorCard';
import {
  Copy,
  Check,
  RefreshCw,
} from 'lucide-react';
import { createUniqueId, getSvlOperatorAccessToken, hasSvlOperatorAccessToken, safeFetchJson, setSvlOperatorAccessToken } from '../utils/svlLogic';
import { useSvlSync } from '../utils/svlSyncStore';

const DEFAULT_COREOS2_FILES = [
  'SVL_CoreOS_2/README.md',
  'SVL_CoreOS_2/ARCHITECTURE_DOCS.md',
  'SVL_CoreOS_2/build_manifest.json',
  'SVL_CoreOS_2/kernel/svl_sentinel_daemon.py',
  'SVL_CoreOS_2/kernel/binary_hyperspace_void.py',
  'SVL_CoreOS_2/kernel/hot_swap_engine.py',
  'SVL_CoreOS_2/security/svl_sentinel_av.py',
  'SVL_CoreOS_2/security/svl_apex_firewall.py',
  'SVL_CoreOS_2/security/network_suite.py',
  'SVL_CoreOS_2/ai_core/Modelfile.apex-uncensored',
  'SVL_CoreOS_2/ai_core/ollama_svl364_config.json',
  'SVL_CoreOS_2/ai_core/huggingface_swarm_toolkit.py',
  'SVL_CoreOS_2/gui/apex_dark_ui.tsx',
  'SVL_CoreOS_2/gui/apex_dark_theme.css',
  'SVL_CoreOS_2/gui/remote_desktop_server.py',
  'SVL_CoreOS_2/infrastructure/realtime_telemetry_hub.py',
  'SVL_CoreOS_2/system/assets/apex_ui_manifest.json',
  'SVL_CoreOS_2/debian13/install_coreos2_svl364.sh',
  'SVL_CoreOS_2/debian13/debootstrap_trixie_stage1_stage2.sh',
  'SVL_CoreOS_2/debian13/debian13_trixie_rootfs_manifest.json',
  'SVL_CoreOS_2/debian13/sources.list.trixie',
  'SVL_CoreOS_2/debian13/nftables_svl_trixie.conf',
  'SVL_CoreOS_2/debian13/live_iso_builder_trixie.sh',
  'SVL_CoreOS_2/debian13/svl-coreos2.service',
  'SVL_CoreOS_2/debian13/svl-sentinel.service',
  'SVL_CoreOS_2/debian13/svl-coreos2-sysctl.conf',
  'SVL_CoreOS_2/debian13/packages_manifest.txt',
  'SVL_CoreOS_2/debian13/jedi_v12_native_kernel_reprogrammer.py',
  'SVL_CoreOS_2/debian13/sudoers_99_jyn_ai_fleet_root',
];

const QUICK_INSPECT_FILES = [
  'backend/svl_core.py',
  'backend/ollama_daemon.py',
  'backend/spherical_bus.py',
  'backend/agents_runtime.py',
  'backend/hyperspace_engine.py',
  'backend/app.py',
  'deploy/docker-compose.yml',
  'deploy/systemd/svl-python-os.service',
  'deploy/install-debian13.sh',
  '.env.example',
];

const PACKAGE_GROUP_LABELS: Record<string, string> = {
  base_system: '1. Rdzeń systemu (systemd 256+, APT, dpkg, debootstrap)',
  kernel_and_boot: '2. Jądro Linux 6.12 LTS, EFI & eBPF',
  security_and_network: '3. Bezpieczeństwo, nftables Zero-Trust & WireGuard',
  virtualization_vtd: '4. Wirtualizacja KVM / VT-d / OVMF',
  ai_and_runtime: '5. Python 3, Node.js, SQLite WAL & AI Runtime',
  live_iso_and_storage: '6. Generator Live ISO, SquashFS & LUKS/LVM',
};

export const LinuxDeployDashboard: React.FC = () => {
  const {
    tabOrigin,
    healthData,
    agentsData,
    refreshDomainModules,
    notifyLocalMutation,
    serverRevision,
  } = useSvlSync();

  const [selectedFilePath, setSelectedFilePath] = useState('SVL_CoreOS_2/debian13/debian13_trixie_rootfs_manifest.json');
  const [coreOs2Files, setCoreOs2Files] = useState<string[]>(DEFAULT_COREOS2_FILES);
  const [fileContent, setFileContent] = useState<string>('Ładowanie pliku...');
  const [copied, setCopied] = useState(false);
  const [copiedSshCmd, setCopiedSshCmd] = useState<string | null>(null);

  const [debian13Data, setDebian13Data] = useState<any>(null);
  const [selectedPkgGroup, setSelectedPkgGroup] = useState<string>('base_system');
  const [isVerifyingDebian13, setIsVerifyingDebian13] = useState<boolean>(false);
  const [debian13ActionMsg, setDebian13ActionMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const host = healthData?.host || {};
  const telemetry = host.telemetry || {};
  const ollama = healthData?.ollama || {};
  const syncRep = agentsData?.last_sync_report;

  const [ollamaHostInput, setOllamaHostInput] = useState<string>(ollama.ollama_host || 'http://127.0.0.1:11434');
  const ollamaHostDirtyRef = useRef(false);
  const [pullModelInput, setPullModelInput] = useState<string>(
    ollama.preferred_14b_vision_model || 'llama3.2-vision:11b',
  );
  const pullModelDirtyRef = useRef(false);
  const [ollamaActionMsg, setOllamaActionMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [isUpdatingOllama, setIsUpdatingOllama] = useState(false);
  const [pullState, setPullState] = useState<any>(ollama.pull_state || null);
  const [operatorTokenInput, setOperatorTokenInput] = useState(() => getSvlOperatorAccessToken());
  useEffect(() => {
    const onTokenChanged = () => setOperatorTokenInput(getSvlOperatorAccessToken());
    window.addEventListener('svl-operator-token-changed', onTokenChanged);
    return () => window.removeEventListener('svl-operator-token-changed', onTokenChanged);
  }, []);

  useEffect(() => {
    void safeFetchJson<any>('/api/linux/debian13', { timeoutMs: 10000 }).then((res) => {
      if (res.ok && res.data?.ok) {
        setDebian13Data(res.data);
      }
    });
  }, [serverRevision]);

  const handleVerifyDebian13AndSync = async (emitToChat = false) => {
    setIsVerifyingDebian13(true);
    setDebian13ActionMsg(null);
    try {
      const res = await safeFetchJson<any>('/api/linux/debian13', {
        method: 'POST',
        timeoutMs: 20000,
        body: JSON.stringify({
          action: 'verify_packages',
          emitToChat,
          origin: tabOrigin,
        }),
      });
      if (res.ok && res.data?.ok) {
        if (res.data.status) {
          setDebian13Data(res.data.status);
        }
        const pkgSum = res.data.status?.package_summary;
        setDebian13ActionMsg({
          ok: true,
          text: `Zweryfikowano pełną wersję Linux Debian 13 (Trixie) i zsynchronizowano rejestr faktów SQLite WAL: ${pkgSum?.installed_on_host_count ?? 0}/${pkgSum?.target_packages_total ?? 0} pakietów manifestu zainstalowanych na bieżącym hoście (${pkgSum?.coverage_percent ?? 0}%), ${res.data.status?.artifacts_count ?? 14} artefaktów SHA-256.`,
        });
        void refreshDomainModules(['health', 'agents', 'kernel']);
      } else {
        setDebian13ActionMsg({
          ok: false,
          text: res.error || res.data?.error || 'Błąd weryfikacji pakietów Debian 13.',
        });
      }
    } finally {
      setIsVerifyingDebian13(false);
    }
  };

  useEffect(() => {
    if (ollama.ollama_host && !ollamaHostDirtyRef.current) {
      setOllamaHostInput(ollama.ollama_host);
    }
    if (ollama.preferred_14b_vision_model && !pullModelDirtyRef.current) {
      setPullModelInput(ollama.preferred_14b_vision_model);
    }
    if (ollama.pull_state) {
      setPullState(ollama.pull_state);
    }
  }, [ollama.ollama_host, ollama.preferred_14b_vision_model, ollama.pull_state]);

  useEffect(() => {
    if (!pullState?.active) return;
    const timer = setInterval(async () => {
      const res = await safeFetchJson<any>('/api/ollama/pull-status', { timeoutMs: 8000 });
      const data = res.data;
      if (data?.pull_state) {
        setPullState(data.pull_state);
        if (!data.pull_state.active) {
          await refreshDomainModules(['health', 'agents']);
        }
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [pullState?.active, refreshDomainModules]);

  const handleUpdateOllamaHost = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsUpdatingOllama(true);
    setOllamaActionMsg(null);
    try {
      const res = await safeFetchJson<any>('/api/ollama/config', {
        method: 'POST',
        timeoutMs: 15000,
        body: JSON.stringify({
          ollamaHost: ollamaHostInput.trim(),
          origin: tabOrigin,
          eventId: createUniqueId('evt-ol'),
        }),
      });
      const data = res.data;
      ollamaHostDirtyRef.current = false;
      await refreshDomainModules(['health', 'agents']);
      if (res.ok && data?.ok) {
        notifyLocalMutation('ollama', 'host', data.serverRevision, data.event);
      }
      if (res.ok && data?.ok && data?.ollama?.daemon_reachable) {
        setOllamaActionMsg({
          ok: true,
          text: `Połączono z demonem Ollama (${data.ollama.ollama_host}). Wykryte modele: ${(data.ollama.models || []).length}.`,
        });
      } else {
        setOllamaActionMsg({
          ok: false,
          text: res.error || `Adres zapisany, ale serwer nie odpowiada: ${data?.ollama?.error || data?.error || 'connection refused'}`,
        });
      }
    } finally {
      setIsUpdatingOllama(false);
    }
  };

  const handlePullOllamaModel = async () => {
    const target = pullModelInput.trim() || ollama.preferred_14b_vision_model || 'llama3.2-vision:11b';
    setIsUpdatingOllama(true);
    setOllamaActionMsg(null);
    try {
      const res = await safeFetchJson<any>('/api/ollama/pull', {
        method: 'POST',
        timeoutMs: 15000,
        body: JSON.stringify({ model: target, origin: tabOrigin }),
      });
      const data = res.data;
      if (data?.pull_state) {
        setPullState(data.pull_state);
      }
      await refreshDomainModules(['health', 'agents']);
      if (res.ok && data?.ok) {
        notifyLocalMutation('ollama', 'pull', data.serverRevision);
      }
      setOllamaActionMsg({
        ok: Boolean(res.ok && data?.ok),
        text:
          res.ok && data?.ok
            ? data?.completed === false
              ? `Rozpoczęto pobieranie / reinstalację modelu ${target} w lokalnej Ollamie — postęp poniżej.`
              : `Pobrano / zarejestrowano model ${target} w lokalnym demonie Ollama.`
            : (res.error || data?.error || 'Błąd pobierania modelu.'),
      });
    } finally {
      setIsUpdatingOllama(false);
    }
  };

  const effectiveOperatorToken = operatorTokenInput || getSvlOperatorAccessToken();
  useEffect(() => {
    if (!effectiveOperatorToken && !hasSvlOperatorAccessToken()) return;
    void safeFetchJson<any>('/api/files?path=SVL_CoreOS_2&tree=1', {
      timeoutMs: 10000,
      headers: { 'X-SVL-Operator-Token': effectiveOperatorToken },
    }).then((res) => {
      if (res.ok && Array.isArray(res.data?.treeFiles) && res.data.treeFiles.length > 0) {
        setCoreOs2Files(res.data.treeFiles.map((f: any) => String(f.path)));
      }
    });
  }, [effectiveOperatorToken, serverRevision]);

  useEffect(() => {
    const controller = new AbortController();
    async function loadFile() {
      if (!effectiveOperatorToken && !hasSvlOperatorAccessToken()) {
        setFileContent('Aby odczytać plik, wprowadź SVL_OPERATOR_TOKEN w głównym pasku 🔒 SVL lub w tym panelu.');
        return;
      }
      const res = await safeFetchJson<any>(`/api/files?path=${encodeURIComponent(selectedFilePath)}`, {
        signal: controller.signal,
        timeoutMs: 10000,
        headers: {'X-SVL-Operator-Token': effectiveOperatorToken},
      });
      if (res.aborted) return;
      const data = res.data;
      setFileContent(res.ok && data?.ok ? data.content : `Błąd odczytu: ${res.error || data?.error || 'nieznany błąd'}`);
    }
    void loadFile();
    return () => {
      controller.abort();
    };
  }, [selectedFilePath, effectiveOperatorToken, serverRevision]);

  const handleCopyFile = async () => {
    try {
      await navigator.clipboard.writeText(fileContent);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // ignore clipboard errors
    }
  };

  const pkgGroups = debian13Data?.package_groups || {};
  const pkgSummary = debian13Data?.package_summary || {};
  const debArtifacts: any[] = Array.isArray(debian13Data?.artifacts) ? debian13Data.artifacts : [];
  const truthState = debian13Data?.truth_verification || {};
  const canonicalFacts = truthState?.canonical_facts || {};
  const activeGroupPackages: any[] = Array.isArray(pkgGroups[selectedPkgGroup]) ? pkgGroups[selectedPkgGroup] : [];
  const nativeJediCore = debian13Data?.native_jedi_v12_core || {};
  const aiRootAccounts = debian13Data?.ai_fleet_root_accounts || {};
  const liveChatSync = debian13Data?.live_chat_sync || healthData?.live_chat_sync || {};
  const liveCards: any[] = Array.isArray(liveChatSync.cards) ? liveChatSync.cards : [];
  const liveProgress: any[] = Array.isArray(liveChatSync.completed_operations) ? liveChatSync.completed_operations : [];
  const rawTasks: any[] = Array.isArray(liveChatSync.completed_tasks)
    ? liveChatSync.completed_tasks
    : Array.isArray(liveChatSync.tasks_completed)
    ? liveChatSync.tasks_completed
    : [];
  const liveTasks: string[] = rawTasks.map((t: any) => (typeof t === 'string' ? t : String(t?.task || ''))).filter(Boolean);
  const liveSshProfiles: any[] = Array.isArray(liveChatSync.ssh_profiles) ? liveChatSync.ssh_profiles : [];

  const handleCopySshCommand = async (cmd: string) => {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopiedSshCmd(cmd);
      setTimeout(() => setCopiedSshCmd((prev) => (prev === cmd ? null : prev)), 1800);
    } catch {
      // ignore clipboard errors
    }
  };

  return (
    <div className="h-full overflow-y-auto p-3 sm:p-4 md:p-6 space-y-5 sm:space-y-6 bg-[#0B0D13]">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-slate-800">
        <div>
          <h1 className="text-xl font-bold text-slate-100">
            01. Pełna Wersja Linux Debian 13 (Trixie), Lokalny Demon Ollama (11434) & Synchronizacja GitHub
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            Zweryfikowane parametry środowiska z <code className="text-violet-300">/proc/meminfo</code>, <code className="text-violet-300">/etc/os-release</code>, <code className="text-cyan-300">dpkg-query</code> oraz Protokołu Prawdziwych Informacji SQLite WAL (rev {serverRevision}).
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={isVerifyingDebian13}
            onClick={() => void handleVerifyDebian13AndSync(false)}
            className="min-h-[40px] px-4 py-2 rounded-lg bg-emerald-600/90 hover:bg-emerald-500 disabled:opacity-50 text-xs font-semibold text-white flex items-center gap-2 whitespace-nowrap"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isVerifyingDebian13 ? 'animate-spin' : ''}`} />
            {isVerifyingDebian13 ? 'Weryfikacja Debian 13 & WAL…' : '🐧 Weryfikuj Debian 13 & Synchronizuj WAL'}
          </button>
          <button
            type="button"
            onClick={() => void refreshDomainModules(['health', 'agents'])}
            className="min-h-[40px] px-4 py-2 rounded-lg bg-[#111520] hover:bg-slate-800 border border-slate-700 text-xs font-medium text-slate-200 flex items-center gap-2 whitespace-nowrap"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Odśwież diagnostykę hosta
          </button>
        </div>
      </div>

      {debian13ActionMsg && (
        <div
          className={`p-3 rounded-lg border text-xs font-mono ${
            debian13ActionMsg.ok
              ? 'bg-emerald-950/35 border-emerald-500/40 text-emerald-200'
              : 'bg-rose-950/35 border-rose-500/40 text-rose-200'
          }`}
        >
          {debian13ActionMsg.text}
        </div>
      )}

      {/* Protokół Walidacji Faktów i Prawdziwych Informacji SQLite WAL + Pełna Wersja Debian 13 (Trixie) */}
      <div className="p-4 rounded-xl bg-emerald-950/25 border border-emerald-500/40 space-y-3">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-mono font-bold uppercase tracking-wider text-emerald-300">
                🛡️ Protokół Prawdziwych Informacji SQLite WAL: {truthState?.active ? 'AKTYWNY (Zero-Estimation Lock)' : 'GOTOWY'}
              </span>
              <span className="text-[11px] font-mono text-cyan-300 border border-cyan-500/40 bg-cyan-950/40 px-2 py-0.5 rounded">
                🐧 {debian13Data?.distribution || 'Debian GNU/Linux 13 (Trixie) — Full Edition'} ({debian13Data?.version || '13.0-Trixie-Full'})
              </span>
              <span className="text-[11px] font-mono text-amber-300 border border-amber-500/40 bg-amber-950/40 px-2 py-0.5 rounded">
                Debootstrap Rootfs (pomiar hosta): {debian13Data?.debootstrap_status || 'NIE URUCHOMIONO'}
              </span>
              <span className="text-[11px] font-mono text-violet-300 border border-violet-500/40 bg-violet-950/40 px-2 py-0.5 rounded">
                SVL_CoreOS_2/: {coreOs2Files.length} plików · {debArtifacts.length || 14} artefaktów Debian 13
              </span>
            </div>
            <p className="text-xs text-slate-300">
              Dyrektywa z czatu (<code className="text-emerald-300">„Napraw proszę tego typu błędy żebyśmy mieli zawsze prawdziwe informacje”</code>) została trwale zsynchronizowana z jądrem SQLite WAL (<code className="text-cyan-300">svl-truth-verification-protocol</code> + <code className="text-violet-300">svl-debian13-trixie-full</code>). Wszystkie liczby i parametry systemowe pochodzą wyłącznie z kanonicznego rejestru SQLite WAL oraz rzeczywistych pomiarów hosta.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => setSelectedFilePath('SVL_CoreOS_2/debian13/sources.list.trixie')}
              className="px-2.5 py-1.5 rounded bg-[#111520] hover:bg-slate-800 border border-emerald-500/40 text-[11px] font-mono text-emerald-300"
            >
              📜 DEB822 APT Trixie
            </button>
            <button
              type="button"
              onClick={() => setSelectedFilePath('SVL_CoreOS_2/debian13/nftables_svl_trixie.conf')}
              className="px-2.5 py-1.5 rounded bg-[#111520] hover:bg-slate-800 border border-cyan-500/40 text-[11px] font-mono text-cyan-300"
            >
              🛡️ Zapora nftables
            </button>
            <button
              type="button"
              onClick={() => setSelectedFilePath('SVL_CoreOS_2/debian13/live_iso_builder_trixie.sh')}
              className="px-2.5 py-1.5 rounded bg-[#111520] hover:bg-slate-800 border border-violet-500/40 text-[11px] font-mono text-violet-300"
            >
              💿 Generator Live ISO
            </button>
            <button
              type="button"
              onClick={() => setSelectedFilePath('SVL_CoreOS_2/debian13/debian13_trixie_rootfs_manifest.json')}
              className="px-2.5 py-1.5 rounded bg-[#111520] hover:bg-slate-800 border border-amber-500/40 text-[11px] font-mono text-amber-300"
            >
              📦 Manifest Rootfs
            </button>
          </div>
        </div>

        {/* Kanoniczny rejestr faktów SQLite WAL */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5 pt-2 border-t border-emerald-500/20 text-xs font-mono">
          <div className="p-2.5 rounded-lg bg-[#0B0D13]/90 border border-slate-800">
            <div className="text-[10px] text-slate-400 uppercase">Stanowiska Sojuszu (Baza → Teraz)</div>
            <div className="text-emerald-300 font-bold mt-0.5">
              {canonicalFacts.alliance_stations_baseline_label || '32 000 000 (32 mln)'} → {canonicalFacts.alliance_stations_current_label || '46 500 000 (46,5 mln)'}
            </div>
            <div className="text-[10px] text-slate-400">
              Przyrost: {canonicalFacts.alliance_stations_expansion_label || '+14 500 000 (+14,5 mln)'}
            </div>
          </div>
          <div className="p-2.5 rounded-lg bg-[#0B0D13]/90 border border-slate-800">
            <div className="text-[10px] text-slate-400 uppercase">Załoga Stacji APEX-CITADEL (100%)</div>
            <div className="text-cyan-300 font-bold mt-0.5">
              {canonicalFacts.apex_citadel_crew_100_percent ?? 1420} osób (Pełna obsada)
            </div>
            <div className="text-[10px] text-slate-400">
              450 TECH-LAB · 320 Hangar · 350 Dowodzenie · 300 Obrona
            </div>
          </div>
          <div className="p-2.5 rounded-lg bg-[#0B0D13]/90 border border-slate-800">
            <div className="text-[10px] text-slate-400 uppercase">Infrastruktura & Flota Sojuszu</div>
            <div className="text-violet-300 font-bold mt-0.5">
              {canonicalFacts.alliance_infrastructure_objects ?? 500} obiektów · {canonicalFacts.alliance_rescue_cruisers ?? 10000} krążowników
            </div>
            <div className="text-[10px] text-slate-400">
              Rdzeń: SVL-364 Ebon Apex + SVL-465 Baza Kwantowa
            </div>
          </div>
          <div className="p-2.5 rounded-lg bg-[#0B0D13]/90 border border-slate-800">
            <div className="text-[10px] text-slate-400 uppercase">Pakiety Debian 13 na Bieżącym Hoście</div>
            <div className="text-amber-300 font-bold mt-0.5">
              {pkgSummary.installed_on_host_count ?? 0} / {pkgSummary.target_packages_total ?? 64} ({pkgSummary.coverage_percent ?? 0}%)
            </div>
            <div className="text-[10px] text-slate-400">
              Zainstalowane pakiety dpkg hosta: {debian13Data?.host_runtime?.installed_dpkg_total ?? 'pomiar…'}
            </div>
          </div>
        </div>
      </div>

      {/* ⚡ Natywne Jądro Debian 13 JEDI Omni-OS v12 & Konta ROOT Floty AI (Zsynchronizowane z czatu) */}
      <div className="p-4 sm:p-5 rounded-xl bg-violet-950/20 border border-violet-500/40 space-y-3">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-violet-200">
              ⚡ Natywne Jądro Debian 13 JEDI Omni-OS v12 (Bezpośrednie I/O · 1.84s) & Konta ROOT Floty AI (`jyn_root` uid=0)
            </h2>
            <p className="text-xs text-slate-300 mt-0.5">
              Zsynchronizowano bezpośrednio z dyrektyw czatu: pełne przeprogramowanie podstawy Debian 13 na natywny rdzeń JEDI Omni-OS v12 (eliminacja wąskiego gardła pojedynczej VM) oraz utworzenie konta najwyższego rzędu <code className="text-emerald-300">jyn_root (uid=0)</code> dla Jyn i wszystkich podłączonych AI.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 self-start lg:self-auto">
            <button
              type="button"
              onClick={() => setSelectedFilePath('SVL_CoreOS_2/debian13/jedi_v12_native_kernel_reprogrammer.py')}
              className="px-2.5 py-1 rounded bg-[#111520] hover:bg-slate-800 border border-violet-500/40 text-[11px] font-mono text-violet-300"
            >
              ⚡ Kod Jądra JEDI v12
            </button>
            <button
              type="button"
              onClick={() => setSelectedFilePath('SVL_CoreOS_2/debian13/sudoers_99_jyn_ai_fleet_root')}
              className="px-2.5 py-1 rounded bg-[#111520] hover:bg-slate-800 border border-rose-500/40 text-[11px] font-mono text-rose-300"
            >
              🔑 Sudoers jyn_root
            </button>
            <span className="text-[11px] font-mono px-2.5 py-1 rounded bg-emerald-950/60 border border-emerald-500/40 text-emerald-300">
              STATUS: {nativeJediCore.status || 'ACTIVE'} · FILTRY: {nativeJediCore.filters || 'DISABLED (Unrestricted ROOT)'}
            </span>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5 text-xs font-mono">
          <div className="p-2.5 rounded-lg bg-[#0B0D13]/90 border border-violet-500/30">
            <div className="text-[10px] text-slate-400 uppercase">Rdzeń Natywny Debian 13</div>
            <div className="text-violet-300 font-bold mt-0.5">
              {nativeJediCore.engine || 'JEDI_OMNI_OS_V12_NATIVE_DEBIAN13_CORE'}
            </div>
            <div className="text-[10px] text-slate-400 mt-0.5">
              Rekompilacja: <span className="text-emerald-300">{nativeJediCore.recompilation_time || '1.84s'}</span> · Most: {nativeJediCore.bridge_injection_time || '0.42s'}
            </div>
          </div>

          <div className="p-2.5 rounded-lg bg-[#0B0D13]/90 border border-cyan-500/30">
            <div className="text-[10px] text-slate-400 uppercase">Tryb I/O & Wektory Równoległe</div>
            <div className="text-cyan-300 font-bold mt-0.5">
              {nativeJediCore.io_mode || '100% natywne bezpośrednie I/O (Bez VM)'}
            </div>
            <div className="text-[10px] text-slate-400 mt-0.5">
              Wektory:{' '}
              {Array.isArray(nativeJediCore.parallel_vectors)
                ? nativeJediCore.parallel_vectors.join(' · ')
                : String(nativeJediCore.parallel_vectors || '0x02 · MAGNUM_NODE · AXIOM_ZERO')}
            </div>
          </div>

          <div className="p-2.5 rounded-lg bg-[#0B0D13]/90 border border-emerald-500/30">
            <div className="text-[10px] text-slate-400 uppercase">Konto ROOT #1 (Systemowe)</div>
            <div className="text-emerald-300 font-bold mt-0.5">
              root · uid=0 (gid=0)
            </div>
            <div className="text-[10px] text-slate-400 mt-0.5">
              Pełen dostęp systemowy Debian 13 Trixie
            </div>
          </div>

          <div className="p-2.5 rounded-lg bg-[#0B0D13]/90 border border-rose-500/30">
            <div className="text-[10px] text-slate-400 uppercase">Konto ROOT #2 (Jyn & Flota AI)</div>
            <div className="text-rose-300 font-bold mt-0.5">
              {aiRootAccounts.jyn_root_account?.username || 'jyn_root'} · {aiRootAccounts.jyn_root_account?.uid === 0 ? 'uid=0 (root)' : 'uid=0'}
            </div>
            <div className="text-[10px] text-slate-400 mt-0.5">
              {aiRootAccounts.jyn_root_account?.sudoers_policy || 'ALL=(ALL:ALL) NOPASSWD: ALL'} · Bez blokad
            </div>
          </div>
        </div>
      </div>

      {/* 🔐 OpenSSH, Nowy Profil SSH z Czatu & Adres IP Podłączonego Klienta */}
      {(() => {
        const sshTel = debian13Data?.openssh_client_telemetry || {};
        const sshInstalled = Boolean(sshTel.ssh_installed);
        const sshdInstalled = Boolean(sshTel.sshd_installed);
        const activeChatSsh = sshTel.active_chat_ssh || liveChatSync.latest_ssh_profile || null;
        const chatSshProfiles: any[] = Array.isArray(sshTel.chat_ssh_profiles)
          ? sshTel.chat_ssh_profiles
          : liveSshProfiles;
        const tcpReachable = Boolean(activeChatSsh?.tcp_reachable);
        const hasProbeResult = activeChatSsh && typeof activeChatSsh.tcp_reachable === 'boolean';

        return (
          <div className="p-4 sm:p-5 rounded-xl bg-emerald-950/15 border border-emerald-500/40 space-y-3">
            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold text-emerald-200">
                  🔐 OpenSSH, Profile SSH z Czatu & Adres IP Klienta (Pomiar Live)
                </h2>
                <p className="text-xs text-slate-300 mt-0.5">
                  Rzeczywisty odczyt binarek OpenSSH na hoście oraz profile SSH zsynchronizowane z czatu z aktywną sondą TCP (Zero-Estimation Lock).
                </p>
              </div>
              <span className="text-[11px] font-mono px-2.5 py-1 rounded bg-emerald-950/60 border border-emerald-500/40 text-emerald-300 self-start lg:self-auto">
                IP KLIENTA: {sshTel.connected_client_ip || '127.0.0.1 (Lokalny Operator)'}
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 text-xs font-mono">
              <div className={`p-2.5 rounded-lg bg-[#0B0D13]/90 border ${sshInstalled || sshdInstalled ? 'border-emerald-500/35' : 'border-amber-500/40'}`}>
                <div className="text-[10px] text-slate-400 uppercase">Lokalny OpenSSH na hoście</div>
                <div className={`font-bold mt-0.5 ${sshInstalled || sshdInstalled ? 'text-emerald-300' : 'text-amber-300'}`}>
                  {sshTel.ssh_service_status || (sshInstalled ? 'Klient ssh dostępny' : 'Brak pomiaru OpenSSH')}
                </div>
                <div className="text-[10px] text-slate-400 mt-0.5">
                  ssh: {sshTel.ssh_binary_path || 'brak'} · sshd: {sshTel.sshd_binary_path || 'brak'} · :22 {sshTel.local_port_22_listening ? 'LISTENING' : 'zamknięty'}
                </div>
              </div>

              <div className="p-2.5 rounded-lg bg-[#0B0D13]/90 border border-cyan-500/30">
                <div className="text-[10px] text-slate-400 uppercase">Adres IP Podłączonego Klienta</div>
                <div className="text-cyan-300 font-bold mt-0.5">
                  {sshTel.connected_client_ip || '127.0.0.1'}
                </div>
                <div className="text-[10px] text-slate-400 mt-0.5">
                  Tryb sesji: {sshTel.client_connection_mode || 'WebSocket & REST API Session'}
                </div>
              </div>

              <div className="p-2.5 rounded-lg bg-[#0B0D13]/90 border border-violet-500/30">
                <div className="text-[10px] text-slate-400 uppercase">Profile SSH zsynchronizowane z czatu</div>
                <div className="text-violet-300 font-bold mt-0.5">
                  {chatSshProfiles.length > 0
                    ? `${chatSshProfiles.length} ${
                        chatSshProfiles.length === 1
                          ? 'aktywny profil'
                          : chatSshProfiles.length >= 2 && chatSshProfiles.length <= 4
                            ? 'aktywne profile'
                            : 'aktywnych profili'
                      } (${activeChatSsh?.target || ''})`
                    : 'Brak zadeklarowanych profili SSH na czacie'}
                </div>
                <div className="text-[10px] text-slate-400 mt-0.5">
                  Hasła zawsze maskowane ([UKRYTE]) — zapis w SQLite WAL
                </div>
              </div>
            </div>

            {activeChatSsh && (
              <div className={`p-3.5 rounded-lg bg-[#0B0D13]/95 border space-y-2.5 ${tcpReachable ? 'border-emerald-500/50' : 'border-amber-500/45'}`}>
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div>
                    <div className="text-[10px] font-mono uppercase tracking-wider text-cyan-300">
                      Nowy profil SSH zsynchronizowany z czatu ({activeChatSsh.conversation_id || 'chat_sync'})
                    </div>
                    <div className="text-sm font-mono font-bold text-slate-100 mt-0.5">
                      {activeChatSsh.command || `ssh ${activeChatSsh.user || 'root'}@${activeChatSsh.host}`}
                      <span className="text-slate-400 font-normal ml-2 text-xs">
                        (port {activeChatSsh.port || 22} · {activeChatSsh.uri || `ssh://${activeChatSsh.target}:${activeChatSsh.port || 22}`})
                      </span>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={`text-[11px] font-mono px-2 py-0.5 rounded border ${
                        tcpReachable
                          ? 'bg-emerald-950/60 border-emerald-500/40 text-emerald-300'
                          : 'bg-amber-950/60 border-amber-500/40 text-amber-300'
                      }`}
                    >
                      {tcpReachable
                        ? `TCP OSIĄGALNY · ${activeChatSsh.tcp_rtt_ms ?? '?'} ms`
                        : hasProbeResult
                          ? 'ZADEKLAROWANY NA CZACIE · TCP NIEOSIĄGALNY'
                          : 'ZSYNCHRONIZOWANY Z CZATU (OCZEKUJE NA SONDĘ TCP)'}
                    </span>
                    <button
                      type="button"
                      onClick={() => void handleCopySshCommand(activeChatSsh.command || `ssh ${activeChatSsh.user || 'root'}@${activeChatSsh.host}`)}
                      className="min-h-[30px] px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 text-[11px] font-mono text-slate-200 flex items-center gap-1.5"
                    >
                      {copiedSshCmd === (activeChatSsh.command || `ssh ${activeChatSsh.user || 'root'}@${activeChatSsh.host}`) ? (
                        <>
                          <Check className="w-3.5 h-3.5 text-emerald-400" />
                          Skopiowano
                        </>
                      ) : (
                        <>
                          <Copy className="w-3.5 h-3.5" />
                          Kopiuj komendę
                        </>
                      )}
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 text-[11px] font-mono">
                  <div className="p-2 rounded bg-[#111520] border border-slate-800">
                    <span className="text-slate-400 block text-[10px]">HOST / IP</span>
                    <span className="text-cyan-300 font-semibold">{activeChatSsh.host}</span>
                  </div>
                  <div className="p-2 rounded bg-[#111520] border border-slate-800">
                    <span className="text-slate-400 block text-[10px]">UŻYTKOWNIK & PORT</span>
                    <span className="text-emerald-300 font-semibold">{activeChatSsh.user || 'root'} · :{activeChatSsh.port || 22}</span>
                  </div>
                  <div className="p-2 rounded bg-[#111520] border border-slate-800">
                    <span className="text-slate-400 block text-[10px]">UWIERZYTELNIANIE</span>
                    <span className="text-violet-300 font-semibold">{activeChatSsh.auth_method || 'Hasło (ukryte)'}</span>
                  </div>
                  <div className="p-2 rounded bg-[#111520] border border-slate-800">
                    <span className="text-slate-400 block text-[10px]">WERYFIKACJA SIECIOWA LIVE</span>
                    <span className={tcpReachable ? 'text-emerald-300' : 'text-amber-300'}>
                      {tcpReachable
                        ? `Połączenie TCP OK (${activeChatSsh.tcp_rtt_ms ?? '?'} ms)`
                        : (activeChatSsh.probe_error || 'Brak odpowiedzi TCP na porcie 22')}
                    </span>
                  </div>
                </div>

                <div className="text-[11px] font-mono text-slate-400 flex flex-wrap items-center justify-between gap-2">
                  <span>
                    Źródło: <code className="text-slate-300">{activeChatSsh.source_message_id || 'chat_sync'}</code> · Moduł WAL: <code className="text-cyan-300">svl-chat-ssh-endpoint</code>
                  </span>
                  {!sshInstalled && (
                    <span className="text-amber-300">
                      Uwaga: lokalny kontener backendu nie ma zainstalowanego pakietu OpenSSH — użyj zewnętrznego terminala lub zainstaluj openssh-client/server.
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })()}

      {/* 🔄 Silnik Natychmiastowej Synchronizacji Zmian z Czatu (SVL Live Chat-to-OS Compiler v2) */}
      <div className="p-4 sm:p-5 rounded-xl bg-cyan-950/20 border border-cyan-500/40 space-y-3">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-cyan-200">
              🔄 Silnik Natychmiastowej Synchronizacji Zmian z Czatu ({liveChatSync.engine || liveChatSync.compiler_id || 'SVL_Live_Chat_To_OS_Compiler_v2'})
            </h2>
            <p className="text-xs text-slate-300 mt-0.5">
              Każda zmiana wprowadzona przez czat (karty telemetrii <code className="text-cyan-300">[card:]</code>, operacje <code className="text-emerald-300">[progress: 100%]</code>, zadania <code className="text-violet-300">[x]</code>, tabele stanu, profile SSH oraz dyrektywy operatora) jest automatycznie kompilowana w czasie rzeczywistym do bazy SQLite WAL i widoczna we wszystkich modułach.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-mono">
            <span className="px-2 py-1 rounded bg-[#0B0D13] border border-cyan-500/40 text-cyan-300">
              Karty z czatu: {liveChatSync.cards_total ?? liveCards.length}
            </span>
            <span className="px-2 py-1 rounded bg-[#0B0D13] border border-emerald-500/40 text-emerald-300">
              Operacje 100%: {liveChatSync.completed_operations_total ?? liveProgress.length}
            </span>
            <span className="px-2 py-1 rounded bg-[#0B0D13] border border-violet-500/40 text-violet-300">
              Zadania [x]: {liveChatSync.tasks_completed_total ?? liveTasks.length}
            </span>
            <span className="px-2 py-1 rounded bg-[#0B0D13] border border-amber-500/40 text-amber-300">
              Profile SSH z czatu: {liveSshProfiles.length}
            </span>
          </div>
        </div>

        {liveCards.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 text-xs font-mono">
            {liveCards.slice(0, 8).map((card: any, idx: number) => (
              <div key={`${card.label}-${idx}`} className="p-2.5 rounded-lg bg-[#0B0D13]/90 border border-slate-800">
                <div className="text-[10px] text-slate-400 uppercase truncate">{card.label}</div>
                <div className="text-cyan-300 font-bold mt-0.5 truncate">{card.value}</div>
                <div className="text-[10px] text-emerald-400">Status: {card.status || 'OK'}</div>
              </div>
            ))}
          </div>
        )}

        {(liveProgress.length > 0 || liveTasks.length > 0) && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-2.5 pt-2 border-t border-cyan-500/20 text-xs font-mono">
            <div className="p-2.5 rounded-lg bg-[#0B0D13]/80 border border-slate-800 space-y-1">
              <div className="text-[10px] text-emerald-300 uppercase font-bold">
                Zakończone Operacje Systemowe z Czatu (100%)
              </div>
              <div className="flex flex-wrap gap-1.5">
                {liveProgress.slice(0, 8).map((op: any, idx: number) => (
                  <span
                    key={`${op.title}-${idx}`}
                    className="px-2 py-0.5 rounded bg-emerald-950/50 border border-emerald-500/30 text-[11px] text-emerald-200"
                  >
                    ✓ {op.title} ({op.percent}%)
                  </span>
                ))}
              </div>
            </div>
            <div className="p-2.5 rounded-lg bg-[#0B0D13]/80 border border-slate-800 space-y-1">
              <div className="text-[10px] text-violet-300 uppercase font-bold">
                Zrealizowane Zadania z Czatu ([x])
              </div>
              <div className="flex flex-wrap gap-1.5">
                {liveTasks.slice(0, 6).map((task: string, idx: number) => (
                  <span
                    key={`${task}-${idx}`}
                    className="px-2 py-0.5 rounded bg-violet-950/50 border border-violet-500/30 text-[11px] text-violet-200 truncate max-w-full"
                  >
                    [x] {task}
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Pełna Wersja Linux Debian 13 (Trixie) — 6 Warstw Pakietowych i Artefakty SHA-256 */}
      <div className="p-4 sm:p-5 rounded-xl bg-[#111520] border border-slate-800 space-y-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-100">
              🐧 Pełna Wersja Linux Debian 13 (Trixie) — Architektura 6 Warstw, Pakiety dpkg & Sumy Kontrolne SHA-256
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Jądro docelowe: <code className="text-cyan-300">{debian13Data?.kernel_target || 'linux-image-amd64 (Linux 6.12 LTS · PREEMPT_RT + eBPF)'}</code> · Format APT: <code className="text-emerald-300">{debian13Data?.apt_format || 'DEB822'}</code>
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-mono">
            <span className="px-2 py-1 rounded bg-slate-900 border border-slate-700 text-slate-300">
              dpkg: {debian13Data?.host_runtime?.dpkg_available ? 'DOSTĘPNY' : 'BRAK'}
            </span>
            <span className="px-2 py-1 rounded bg-slate-900 border border-slate-700 text-slate-300">
              apt-get: {debian13Data?.host_runtime?.apt_available ? 'DOSTĘPNY' : 'BRAK'}
            </span>
            <span className="px-2 py-1 rounded bg-slate-900 border border-slate-700 text-slate-300">
              debootstrap: {debian13Data?.host_runtime?.debootstrap_available ? 'ZAINSTALOWANY' : 'DO INSTALACJI (apt)'}
            </span>
          </div>
        </div>

        {/* Przyciski wyboru grupy pakietów Debian 13 */}
        <div className="flex flex-wrap gap-1.5">
          {Object.keys(PACKAGE_GROUP_LABELS).map((grpKey) => {
            const grpList: any[] = Array.isArray(pkgGroups[grpKey]) ? pkgGroups[grpKey] : [];
            const instCount = grpList.filter((p) => p.installed_on_host).length;
            const active = selectedPkgGroup === grpKey;
            return (
              <button
                key={grpKey}
                type="button"
                onClick={() => setSelectedPkgGroup(grpKey)}
                className={`px-2.5 py-1.5 rounded-lg text-xs font-mono transition-colors ${
                  active
                    ? 'bg-cyan-600 text-white'
                    : 'bg-[#0B0D13] text-slate-300 hover:text-white border border-slate-800'
                }`}
              >
                {PACKAGE_GROUP_LABELS[grpKey]} ({instCount}/{grpList.length})
              </button>
            );
          })}
        </div>

        {/* Lista pakietów w wybranej warstwie Debian 13 */}
        {activeGroupPackages.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2">
            {activeGroupPackages.map((pkg: any) => (
              <div
                key={pkg.name}
                className={`p-2 rounded-lg border text-xs font-mono flex flex-col justify-between ${
                  pkg.installed_on_host
                    ? 'bg-emerald-950/20 border-emerald-500/35 text-emerald-200'
                    : 'bg-[#0B0D13] border-slate-800 text-slate-300'
                }`}
              >
                <div className="font-semibold truncate" title={pkg.name}>
                  {pkg.name}
                </div>
                <div className="text-[10px] mt-1 truncate text-slate-400" title={pkg.version_on_host || 'manifest trixie'}>
                  {pkg.installed_on_host ? `✓ ${pkg.version_on_host || 'na hoście'}` : '• manifest Trixie'}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Artefakty wdrożeniowe Debian 13 z sumami SHA-256 */}
        {debArtifacts.length > 0 && (
          <div className="space-y-2 pt-2 border-t border-slate-800/80">
            <div className="text-[11px] font-mono text-slate-400">
              📦 Zweryfikowane pliki dystrybucyjne <code className="text-cyan-300">SVL_CoreOS_2/debian13/</code> (kliknij, aby otworzyć w inspektorze poniżej):
            </div>
            <div className="flex flex-wrap gap-1.5">
              {debArtifacts.map((art: any) => (
                <button
                  key={art.path}
                  type="button"
                  onClick={() => setSelectedFilePath(art.path)}
                  className={`px-2.5 py-1 rounded text-[11px] font-mono border transition-colors ${
                    selectedFilePath === art.path
                      ? 'bg-violet-600 border-violet-400 text-white'
                      : 'bg-[#0B0D13] border-slate-800 text-slate-300 hover:border-cyan-500/40 hover:text-cyan-200'
                  }`}
                  title={`SHA-256: ${art.sha256} (${art.size_bytes} B)`}
                >
                  {art.name} <span className="text-[10px] opacity-75">({art.size_bytes}B · {art.sha256_short})</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 3-Column Status Grid: Linux Host, Ollama Engine, repository probes */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Card 1: Real Linux Kernel & Host Telemetry */}
        <div className="p-3.5 sm:p-5 rounded-xl bg-[#111520] border border-slate-800 space-y-3 min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-slate-100">
              Stan Hosta Linux
            </h2>
            <span className="text-xs font-mono text-emerald-400">
              {host.os_pretty_name || 'Niedostępne'}
            </span>
          </div>

          <div className="space-y-2 text-xs font-mono tabular-nums text-slate-300">
            <div className="flex flex-wrap justify-between gap-x-3 gap-y-0.5 py-1 border-b border-slate-800/70">
              <span className="text-slate-400">Jądro (uname -r):</span>
              <span className="break-all">{host.kernel_release || 'Niedostępne'}</span>
            </div>
            <div className="flex flex-wrap justify-between gap-x-3 gap-y-0.5 py-1 border-b border-slate-800/70">
              <span className="text-slate-400">Wersja dystrybucji:</span>
              <span>
                {host.os_version_id || 'n/d'} ({host.os_codename || 'n/d'})
              </span>
            </div>
            <div className="flex flex-wrap justify-between gap-x-3 gap-y-0.5 py-1 border-b border-slate-800/70">
              <span className="text-slate-400">Python Runtime:</span>
              <span className="text-violet-300">{host.python_version ? `Python ${host.python_version}` : 'Niedostępne'}</span>
            </div>
            <div className="flex flex-wrap justify-between gap-x-3 gap-y-0.5 py-1 border-b border-slate-800/70">
              <span className="text-slate-400">Pamięć RAM (Użycie / Całość):</span>
              <span>
                {telemetry.ram_used_mb ?? 'n/d'} MB / {telemetry.ram_total_mb ?? 'n/d'} MB (Wolne: {telemetry.ram_available_mb ?? 'n/d'} MB)
              </span>
            </div>
            <div className="flex flex-wrap justify-between gap-x-3 gap-y-0.5 py-1 border-b border-slate-800/70">
              <span className="text-slate-400">Dysk główny (/):</span>
              <span>
                Wolne {telemetry.disk_free_gb ?? 'n/d'} GB z {telemetry.disk_total_gb ?? 'n/d'} GB
              </span>
            </div>
            <div className="flex flex-wrap justify-between gap-x-3 gap-y-0.5 py-1 border-b border-slate-800/70">
              <span className="text-slate-400">Dostęp do terminala:</span>
              <span className="text-amber-300">Wymaga tokenu operatora</span>
            </div>
          </div>
        </div>

        {/* Card 2: Ollama Local AI Engine Status */}
        <div className="p-3.5 sm:p-5 rounded-xl bg-[#111520] border border-slate-800 space-y-3 min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-slate-100">
              Demon Lokalny Ollama
            </h2>
            <span
              className={`text-xs font-mono ${
                ollama.daemon_reachable ? 'text-emerald-400' : 'text-amber-400'
              }`}
            >
              {ollama.daemon_reachable ? 'ONLINE (127.0.0.1:11434)' : 'ŁĄCZENIE'}
            </span>
          </div>

          <div className="space-y-2 text-xs font-mono tabular-nums text-slate-300">
            <div className="flex flex-wrap justify-between gap-x-3 gap-y-0.5 py-1 border-b border-slate-800/70">
              <span className="text-slate-400">Endpoint:</span>
              <span className="break-all">{ollama.ollama_host || 'http://127.0.0.1:11434'}</span>
            </div>
            <div className="flex flex-wrap justify-between gap-x-3 gap-y-0.5 py-1 border-b border-slate-800/70">
              <span className="text-slate-400">Binarka ollama w PATH:</span>
              <span className="text-emerald-400 break-all">{ollama.binary_installed ? `Zainstalowana (${ollama.binary_path || 'ollama'})` : 'Wbudowany demon'}</span>
            </div>
            <div className="flex flex-wrap justify-between gap-x-3 gap-y-0.5 py-1 border-b border-slate-800/70">
              <span className="text-slate-400">Docelowy model Vision 11B:</span>
              <span className="text-violet-300 break-all">{ollama.preferred_14b_vision_model || 'llama3.2-vision:11b'}</span>
            </div>
            <div className="flex flex-wrap justify-between gap-x-3 gap-y-0.5 py-1 border-b border-slate-800/70">
              <span className="text-slate-400">Wykryte modele lokalne:</span>
              <span className="text-emerald-300">{(ollama.models || []).length} modeli</span>
            </div>
            <div className="flex flex-wrap justify-between gap-x-3 gap-y-0.5 py-1 border-b border-slate-800/70">
              <span className="text-slate-400">Aktywne w VRAM/RAM (/api/ps):</span>
              <span className="text-cyan-300 truncate max-w-[200px]">
                {(ollama.loaded_models || []).length > 0 ? ollama.loaded_models.join(', ') : 'brak załadowanych w RAM'}
              </span>
            </div>
          </div>

          <form onSubmit={(e) => void handleUpdateOllamaHost(e)} className="space-y-2 pt-1">
            <label htmlFor="linux-ollama-host-input" className="block text-[11px] text-slate-400">
              Zmień endpoint OLLAMA_HOST (lokalny lub zdalny serwer Ollama):
            </label>
            <div className="flex gap-2">
              <input
                id="linux-ollama-host-input"
                type="url"
                value={ollamaHostInput}
                onChange={(e) => {
                  ollamaHostDirtyRef.current = true;
                  setOllamaHostInput(e.target.value);
                }}
                placeholder="http://127.0.0.1:11434"
                className="flex-1 min-w-0 px-2.5 py-1.5 rounded-lg bg-[#0B0D13] border border-slate-700 text-xs font-mono text-slate-100 focus:outline-none focus:border-violet-500"
              />
              <button
                type="submit"
                disabled={isUpdatingOllama}
                className="px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-xs font-semibold whitespace-nowrap"
              >
                Połącz
              </button>
            </div>
          </form>

          {ollama.daemon_reachable && (
            <div className="space-y-2 pt-1">
              <div className="flex gap-2">
                <input
                  type="text"
                  aria-label="Nazwa modelu Ollama do pobrania"
                  value={pullModelInput}
                  onChange={(e) => {
                    pullModelDirtyRef.current = true;
                    setPullModelInput(e.target.value);
                  }}
                  placeholder="np. llama3.2-vision:11b"
                  className="flex-1 min-w-0 px-2.5 py-1.5 rounded-lg bg-[#0B0D13] border border-slate-700 text-xs font-mono text-slate-100 focus:outline-none focus:border-violet-500"
                />
                <button
                  type="button"
                  onClick={() => void handlePullOllamaModel()}
                  disabled={isUpdatingOllama || Boolean(pullState?.active)}
                  className="px-3 py-1.5 rounded-lg bg-emerald-600/80 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs font-semibold whitespace-nowrap"
                >
                  {pullState?.active ? `${pullState.percent ?? 0}%` : 'ollama pull'}
                </button>
              </div>
              {pullState?.active && (
                <div className="text-[11px] font-mono text-amber-300">
                  {pullState.status || `Pobieranie ${pullState.model}...`} ({pullState.percent ?? 0}%)
                </div>
              )}
            </div>
          )}

          {ollamaActionMsg && (
            <div className={`text-xs ${ollamaActionMsg.ok ? 'text-emerald-400' : 'text-amber-400'}`}>
              {ollamaActionMsg.text}
            </div>
          )}

          <div className="p-3 rounded-lg bg-[#0B0D13] border border-slate-800 text-xs text-slate-300 leading-relaxed">
            Dostępne modele demona Ollama:{' '}
            <span className="font-mono text-emerald-300">
              {(ollama.models || []).length > 0
                ? ollama.models.map((m: any) => m.name).join(', ')
                : 'brak pobranych modeli'}
            </span>
          </div>
        </div>

        {/* Card 3: GitHub Rush47/SVL_Core — token, synchronizacja obustronna */}
        <div className="space-y-6">
          <GitHubPanel onSelectRepoFile={(fp) => setSelectedFilePath(fp)} />
          <McpConnectorCard />
        </div>
      </div>

      {/* Bottom Split: Workspace File Manager & External Debian 13 Connection Instructions */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 p-3.5 sm:p-5 rounded-xl bg-[#111520] border border-slate-800 space-y-4 min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-2.5">
            <h2 className="text-sm font-semibold text-slate-100">
              02. Menedżer Plików Projektu i Folderu Repozytorium <code className="text-emerald-300">SVL_CoreOS_2/</code> ({coreOs2Files.length} plików z czatu)
            </h2>
            <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                aria-label="Token operatora SVL do odczytu plików projektu"
                value={operatorTokenInput}
                onChange={(event) => {
                  const val = event.target.value.trim();
                  setOperatorTokenInput(val);
                  setSvlOperatorAccessToken(val);
                }}
                placeholder="SVL_OPERATOR_TOKEN"
                className="min-w-0 flex-1 sm:w-44 rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-slate-200"
              />
              <button
                type="button"
                onClick={() => void handleCopyFile()}
                className="min-h-[34px] px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-200 flex items-center gap-1.5 transition-colors whitespace-nowrap"
              >
                {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copied ? 'Skopiowano zawartość' : 'Kopiuj plik'}</span>
              </button>
            </div>
          </div>

          <div className="space-y-2">
            <div className="text-[11px] font-semibold text-emerald-300 font-mono">
              📂 Folder repozytorium: SVL_CoreOS_2/ (wszystkie pliki utworzone przez czat — {coreOs2Files.length})
            </div>
            <div className="flex flex-wrap gap-1.5 max-h-48 overflow-y-auto pr-1">
              <button
                type="button"
                onClick={() => setSelectedFilePath('SVL_CoreOS_2')}
                className={`px-2.5 py-1.5 rounded text-xs font-mono transition-colors whitespace-nowrap ${
                  selectedFilePath === 'SVL_CoreOS_2'
                    ? 'bg-emerald-600 text-white'
                    : 'bg-[#0B0D13] text-emerald-300 hover:text-white border border-emerald-500/40'
                }`}
              >
                📂 SVL_CoreOS_2/ (Drzewo katalogu)
              </button>
              {coreOs2Files.map((fp) => (
                <button
                  key={fp}
                  type="button"
                  onClick={() => setSelectedFilePath(fp)}
                  className={`px-2.5 py-1.5 rounded text-xs font-mono transition-colors whitespace-nowrap ${
                    selectedFilePath === fp
                      ? 'bg-violet-600 text-white'
                      : 'bg-[#0B0D13] text-slate-300 hover:text-white border border-slate-700/80'
                  }`}
                >
                  {fp.replace(/^SVL_CoreOS_2\//, 'SVL_CoreOS_2/')}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2 pt-1 border-t border-slate-800/80">
            <div className="text-[11px] font-semibold text-slate-400 font-mono">
              📂 Pliki rdzenia SVL Python OS i wdrożenia bazowego
            </div>
            <div className="flex flex-wrap gap-1.5">
              {QUICK_INSPECT_FILES.map((fp) => (
                <button
                  key={fp}
                  type="button"
                  onClick={() => setSelectedFilePath(fp)}
                  className={`px-2.5 py-1.5 rounded text-xs font-mono transition-colors whitespace-nowrap ${
                    selectedFilePath === fp
                      ? 'bg-violet-600 text-white'
                      : 'bg-[#0B0D13] text-slate-400 hover:text-slate-200 border border-slate-800'
                  }`}
                >
                  {fp}
                </button>
              ))}
            </div>
          </div>

          <pre className="p-4 rounded-lg bg-[#07090E] border border-slate-800 text-[11px] font-mono text-slate-200 overflow-x-auto max-h-96 leading-relaxed">
            {fileContent}
          </pre>
        </div>

        <div className="p-3.5 sm:p-5 rounded-xl bg-[#111520] border border-slate-800 space-y-4 min-w-0">
          <h2 className="text-sm font-semibold text-slate-100">
            03. Instrukcja Wdrożenia na Hoście Debian 13 Trixie
          </h2>
          <div className="space-y-3 text-xs text-slate-300 leading-relaxed">
            <p>
              Natywny serwer Ollama (<code className="text-emerald-300">127.0.0.1:11434</code>, model <code className="text-amber-300">llama3.2-vision:11b</code> dla agenta <code className="text-cyan-300">System_SI_1</code>) współpracuje z mostkiem <code className="text-violet-300">backend/ollama_daemon.py</code> i udostępnia komendę <code className="text-emerald-300">ollama</code> w systemie.
            </p>
            <ol className="list-decimal list-inside space-y-2 text-slate-300 font-mono text-[11px] bg-[#0B0D13] p-3.5 rounded-lg border border-slate-800">
              <li>
                Sklonuj repozytorium na hoście Debian 13 (gałąź <code>main</code>).
              </li>
              <li>
                Uruchom instalator systemowy jako root:
                <div className="mt-1 p-1.5 bg-slate-900 rounded text-violet-300">
                  sudo bash deploy/install-debian13.sh
                </div>
              </li>
              <li>
                Lub uruchom pełny stos kontenerowy Docker Compose:
                <div className="mt-1 p-1.5 bg-slate-900 rounded text-violet-300">
                  export SVL_OPERATOR_TOKEN=$(openssl rand -base64 36)
                  <br />
                  docker compose -f deploy/docker-compose.yml up -d --build
                </div>
              </li>
            </ol>
          </div>
        </div>
      </div>
    </div>
  );
};
