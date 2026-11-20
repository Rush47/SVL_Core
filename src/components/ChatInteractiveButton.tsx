import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Copy,
  CornerDownRight,
  Cpu,
  FileText,
  Image as ImageIcon,
  Loader2,
  MessageCircle,
  Radio,
  RefreshCw,
  Rocket,
  Send,
  Server,
  ShieldCheck,
  Terminal,
  Users,
  Zap,
} from 'lucide-react';
import { Button } from '@vector-im/compound-web';

interface ChatInteractiveButtonProps {
  label: string;
  action: string;
  onAction?: (actionValue: string, label?: string) => void | Promise<void>;
  disabled?: boolean;
}

export const ChatInteractiveButton: React.FC<ChatInteractiveButtonProps> = ({
  label,
  action,
  onAction,
  disabled = false,
}) => {
  const [phase, setPhase] = useState<'idle' | 'running' | 'done'>('idle');
  const resetTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (resetTimerRef.current !== null && typeof window !== 'undefined') {
        window.clearTimeout(resetTimerRef.current);
      }
    };
  }, []);

  const normalizedAction = action.trim().toLowerCase();
  const baseIcon = normalizedAction.startsWith('tab:apex') || normalizedAction.startsWith('nav:apex')
    ? <Zap className="w-3.5 h-3.5" aria-hidden="true" />
    : normalizedAction.startsWith('tab:svl364') || normalizedAction.startsWith('nav:svl364')
      ? <Rocket className="w-3.5 h-3.5" aria-hidden="true" />
      : normalizedAction.startsWith('tab:infrastructure') || normalizedAction.startsWith('nav:infrastructure')
        ? <Server className="w-3.5 h-3.5" aria-hidden="true" />
        : normalizedAction.startsWith('tab:terminals') || normalizedAction.startsWith('nav:terminals')
          ? <Terminal className="w-3.5 h-3.5" aria-hidden="true" />
          : normalizedAction.startsWith('tab:agents') || normalizedAction.startsWith('nav:agents')
            ? <Users className="w-3.5 h-3.5" aria-hidden="true" />
            : normalizedAction.startsWith('tab:kernel') || normalizedAction.startsWith('nav:kernel')
              ? <Cpu className="w-3.5 h-3.5" aria-hidden="true" />
              : normalizedAction.startsWith('tab:linux') || normalizedAction.startsWith('nav:linux')
                ? <Terminal className="w-3.5 h-3.5" aria-hidden="true" />
                : normalizedAction.startsWith('copy:')
                  ? <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                  : normalizedAction === 'action:sync' || normalizedAction === 'sync'
                    ? <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
                    : normalizedAction === 'action:scan' || normalizedAction === 'action:antivirus'
                      ? <ShieldCheck className="w-3.5 h-3.5" aria-hidden="true" />
                      : normalizedAction === 'action:report'
                        ? <FileText className="w-3.5 h-3.5" aria-hidden="true" />
                        : normalizedAction.startsWith('action:image') || normalizedAction === 'action:vision'
                          ? <ImageIcon className="w-3.5 h-3.5" aria-hidden="true" />
                          : normalizedAction === 'action:duplex'
                            ? <Radio className="w-3.5 h-3.5" aria-hidden="true" />
                            : normalizedAction.startsWith('ask:')
                              ? <MessageCircle className="w-3.5 h-3.5" aria-hidden="true" />
                              : normalizedAction.startsWith('send:')
                                ? <Send className="w-3.5 h-3.5" aria-hidden="true" />
                                : disabled
                                  ? <AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" />
                                  : <CornerDownRight className="w-3.5 h-3.5" aria-hidden="true" />;

  const icon = phase === 'running'
    ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
    : phase === 'done'
      ? <Check className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" />
      : baseIcon;

  const handleClick = async () => {
    if (disabled || phase === 'running' || !onAction) return;
    setPhase('running');
    try {
      await onAction(action, label);
      if (!mountedRef.current) return;
      setPhase('done');
      if (typeof window !== 'undefined') {
        if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
        resetTimerRef.current = window.setTimeout(() => {
          if (mountedRef.current) setPhase('idle');
        }, 1600);
      }
    } catch {
      if (mountedRef.current) setPhase('idle');
    }
  };

  return (
    <Button
      type="button"
      kind="secondary"
      size="md"
      onClick={() => void handleClick()}
      disabled={disabled || phase === 'running'}
      title={disabled ? 'Przyciski czatu nie mogą uruchamiać poleceń powłoki.' : `Akcja: ${action}`}
      className="my-1 mr-2 active:scale-95 cursor-pointer"
    >
      {icon}
      {label}
    </Button>
  );
};
