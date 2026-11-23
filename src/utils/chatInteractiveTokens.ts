// Czyste parsery zaawansowanych elementów interaktywnych czatu (styl Copilot / ChatGPT Work).
// Wydzielone bez zależności React/DOM, aby były testowalne w Node.js i współdzielone z UI.

export interface ParsedStepToken {
  label: string;
  status: 'done' | 'running' | 'pending' | 'error';
  detail?: string;
}

export function parseStepToken(token: string): ParsedStepToken | null {
  const match = token.trim().match(/^\[(?:step|krok):([^\]\n]+)\]$/i);
  if (!match) return null;
  const parts = match[1].split('|').map((p) => p.trim());
  if (!parts[0]) return null;
  const rawStatus = (parts[1] || 'done').toLowerCase();
  const status: ParsedStepToken['status'] =
    rawStatus === 'running' || rawStatus === 'active' || rawStatus === 'in_progress'
      ? 'running'
      : rawStatus === 'pending' || rawStatus === 'todo' || rawStatus === 'wait'
        ? 'pending'
        : rawStatus === 'error' || rawStatus === 'failed' || rawStatus === 'err'
          ? 'error'
          : 'done';
  return {
    label: parts[0],
    status,
    ...(parts[2] ? { detail: parts.slice(2).join(' | ') } : {}),
  };
}

export interface ParsedToggleToken {
  label: string;
  enabled: boolean;
  onAction: string;
  offAction: string;
}

export function parseToggleToken(token: string): ParsedToggleToken | null {
  const match = token.trim().match(/^\[(?:toggle|przelacznik|przełącznik):([^\]\n]+)\]$/i);
  if (!match) return null;
  const parts = match[1].split('|').map((p) => p.trim());
  if (parts.length < 4 || !parts[0] || !parts[2] || !parts[3]) return null;
  const enabled = /^(1|on|true|yes|tak|active|włączony|wlaczony)$/i.test(parts[1] || '');
  return {
    label: parts[0],
    enabled,
    onAction: parts[2],
    offAction: parts[3],
  };
}

export interface ParsedFormField {
  name: string;
  label: string;
  defaultValue: string;
}

export interface ParsedFormToken {
  title: string;
  fields: ParsedFormField[];
  commandTemplate: string;
}

export function parseFormToken(token: string): ParsedFormToken | null {
  const match = token.trim().match(/^\[(?:form|formularz):([^\]\n]+)\]$/i);
  if (!match) return null;
  const body = match[1];
  const firstPipe = body.indexOf('|');
  const secondPipe = firstPipe !== -1 ? body.indexOf('|', firstPipe + 1) : -1;
  if (firstPipe === -1 || secondPipe === -1) return null;
  const title = body.slice(0, firstPipe).trim();
  const fieldsRaw = body.slice(firstPipe + 1, secondPipe).trim();
  const commandTemplate = body.slice(secondPipe + 1).trim();
  if (!title || !fieldsRaw || !commandTemplate) return null;
  const fields: ParsedFormField[] = fieldsRaw
    .split(';')
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((entry) => {
      const [namePart, rest = ''] = entry.split('=');
      const [labelPart, defaultPart = ''] = rest.split(':');
      const name = (namePart || '').trim().replace(/[^a-zA-Z0-9_-]/g, '');
      const label = (labelPart || name).trim();
      return { name, label, defaultValue: defaultPart.trim() };
    })
    .filter((f) => Boolean(f.name));
  if (fields.length === 0) return null;
  return {
    title,
    fields,
    commandTemplate,
  };
}

export function renderFormTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{([a-zA-Z0-9_-]+)\}/g, (_m, key) => String(values[key] ?? '').trim());
}

export type InteractiveTone = 'ok' | 'warn' | 'err' | 'info';

function normalizeTone(raw?: string): InteractiveTone {
  const t = (raw || 'info').toLowerCase().trim();
  if (t === 'ok' || t === 'success' || t === 'online' || t === 'done') return 'ok';
  if (t === 'warn' || t === 'warning' || t === 'caution') return 'warn';
  if (t === 'err' || t === 'error' || t === 'alert' || t === 'danger' || t === 'fail') return 'err';
  return 'info';
}

export interface ParsedKpiToken {
  label: string;
  value: string;
  delta?: string;
  tone: InteractiveTone;
}

export function parseKpiToken(token: string): ParsedKpiToken | null {
  const match = token.trim().match(/^\[(?:kpi|metrics|metryka):([^\]\n]+)\]$/i);
  if (!match) return null;
  const parts = match[1].split('|').map((p) => p.trim());
  if (parts.length < 2 || !parts[0] || !parts[1]) return null;
  return {
    label: parts[0],
    value: parts[1],
    ...(parts[2] ? { delta: parts[2] } : {}),
    tone: normalizeTone(parts[3]),
  };
}

export interface ParsedAlertToken {
  tone: InteractiveTone;
  title: string;
  body: string;
}

export function parseAlertToken(token: string): ParsedAlertToken | null {
  const match = token.trim().match(/^\[(?:alert|callout|banner|komunikat):([^\]\n]+)\]$/i);
  if (!match) return null;
  const parts = match[1].split('|').map((p) => p.trim());
  if (parts.length < 2 || !parts[0] || !parts[1]) return null;
  if (parts.length === 2) {
    return { tone: 'info', title: parts[0], body: parts[1] };
  }
  return {
    tone: normalizeTone(parts[0]),
    title: parts[1],
    body: parts.slice(2).join(' | '),
  };
}

export interface ParsedChecklistItemEntry {
  text: string;
  checked: boolean;
}

export interface ParsedChecklistToken {
  title: string;
  items: ParsedChecklistItemEntry[];
}

export function parseChecklistToken(token: string): ParsedChecklistToken | null {
  const match = token.trim().match(/^\[(?:checklist|lista):([^\]\n]+)\]$/i);
  if (!match) return null;
  const parts = match[1].split('|').map((p) => p.trim());
  if (parts.length < 2 || !parts[0] || !parts[1]) return null;
  const items: ParsedChecklistItemEntry[] = parts
    .slice(1)
    .join('|')
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const m = entry.match(/^([xX✓✅ ])?:\s*(.*)$/);
      if (m) {
        return {
          checked: Boolean(m[1] && /[xX✓✅]/.test(m[1])),
          text: m[2].trim(),
        };
      }
      return { checked: false, text: entry };
    })
    .filter((i) => Boolean(i.text));
  if (items.length === 0) return null;
  return { title: parts[0], items };
}

export interface ParsedTabEntry {
  label: string;
  content: string;
}

export interface ParsedTabsToken {
  tabs: ParsedTabEntry[];
}

export function parseTabsToken(token: string): ParsedTabsToken | null {
  const match = token.trim().match(/^\[(?:tabs|zakladki|zakładki):([^\]\n]+)\]$/i);
  if (!match) return null;
  const tabs: ParsedTabEntry[] = match[1]
    .split('|')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((entry) => {
      const eq = entry.indexOf('=');
      if (eq === -1) return null;
      const label = entry.slice(0, eq).trim();
      const content = entry.slice(eq + 1).trim();
      return label && content ? { label, content } : null;
    })
    .filter((t): t is ParsedTabEntry => t !== null);
  if (tabs.length === 0) return null;
  return { tabs };
}

export interface ParsedConfirmToken {
  title: string;
  description: string;
  confirmLabel: string;
  confirmAction: string;
  cancelLabel: string;
}

export function parseConfirmToken(token: string): ParsedConfirmToken | null {
  const match = token.trim().match(/^\[(?:confirm|potwierdz|potwierdź):([^\]\n]+)\]$/i);
  if (!match) return null;
  const parts = match[1].split('|').map((p) => p.trim());
  if (parts.length < 4 || !parts[0] || !parts[1] || !parts[2] || !parts[3]) return null;
  return {
    title: parts[0],
    description: parts[1],
    confirmLabel: parts[2],
    confirmAction: parts[3],
    cancelLabel: parts[4] || 'Anuluj',
  };
}

export interface ParsedChipOption {
  label: string;
  action: string;
}

export interface ParsedChipsToken {
  label: string;
  options: ParsedChipOption[];
}

export function parseChipsToken(token: string): ParsedChipsToken | null {
  const match = token.trim().match(/^\[(?:chips|select|opcje):([^\]\n]+)\]$/i);
  if (!match) return null;
  const parts = match[1].split('|').map((p) => p.trim());
  if (parts.length < 2 || !parts[0] || !parts[1]) return null;
  const options: ParsedChipOption[] = parts
    .slice(1)
    .join('|')
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const eq = entry.indexOf('=');
      if (eq === -1) {
        return { label: entry, action: `send:${entry}` };
      }
      const label = entry.slice(0, eq).trim();
      const rawAct = entry.slice(eq + 1).trim();
      const action = /^(send|ask|text|copy|tab|action):/i.test(rawAct) ? rawAct : `send:${rawAct}`;
      return label ? { label, action } : null;
    })
    .filter((o): o is ParsedChipOption => o !== null);
  if (options.length === 0) return null;
  return { label: parts[0], options };
}

export interface ParsedTimelineEntry {
  title: string;
  meta: string;
}

export interface ParsedTimelineToken {
  entries: ParsedTimelineEntry[];
}

export function parseTimelineToken(token: string): ParsedTimelineToken | null {
  const match = token.trim().match(/^\[(?:timeline|os|oś):([^\]\n]+)\]$/i);
  if (!match) return null;
  const entries: ParsedTimelineEntry[] = match[1]
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((entry) => {
      const eq = entry.indexOf('=');
      if (eq === -1) return { title: entry, meta: '' };
      return { title: entry.slice(0, eq).trim(), meta: entry.slice(eq + 1).trim() };
    })
    .filter((e) => Boolean(e.title));
  if (entries.length === 0) return null;
  return { entries };
}

export interface ParsedTerminalToken {
  title: string;
  command: string;
  output?: string;
}

export function parseTerminalToken(token: string): ParsedTerminalToken | null {
  const match = token.trim().match(/^\[(?:terminal|cmd):([^\]\n]+)\]$/i);
  if (!match) return null;
  const parts = match[1].split('|').map((p) => p.trim());
  if (parts.length < 2 || !parts[0] || !parts[1]) return null;
  return {
    title: parts[0],
    command: parts[1],
    ...(parts[2] ? { output: parts.slice(2).join(' | ') } : {}),
  };
}

export interface ParsedBadgeToken {
  text: string;
  tone: InteractiveTone;
}

export function parseBadgeToken(token: string): ParsedBadgeToken | null {
  const match = token.trim().match(/^\[(?:badge|znacznik):([^\]\n]+)\]$/i);
  if (!match) return null;
  const parts = match[1].split('|').map((p) => p.trim());
  if (!parts[0]) return null;
  return {
    text: parts[0],
    tone: normalizeTone(parts[1]),
  };
}

export interface ParsedDiffToken {
  file: string;
  before: string;
  after: string;
}

export function parseDiffToken(token: string): ParsedDiffToken | null {
  const match = token.trim().match(/^\[(?:diff|roznica|różnica):([^\]\n]+)\]$/i);
  if (!match) return null;
  const parts = match[1].split('|').map((p) => p.trim());
  if (parts.length < 3 || !parts[0]) return null;
  return {
    file: parts[0],
    before: parts[1],
    after: parts.slice(2).join(' | '),
  };
}

export interface ParsedBarEntry {
  label: string;
  value: number;
}

export interface ParsedBarsToken {
  title: string;
  items: ParsedBarEntry[];
}

export function parseBarsToken(token: string): ParsedBarsToken | null {
  const match = token.trim().match(/^\[(?:bars|chart|wykres):([^\]\n]+)\]$/i);
  if (!match) return null;
  const parts = match[1].split('|').map((p) => p.trim());
  if (parts.length < 2 || !parts[0] || !parts[1]) return null;
  const items: ParsedBarEntry[] = parts
    .slice(1)
    .join('|')
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const eq = entry.indexOf('=');
      if (eq === -1) return null;
      const label = entry.slice(0, eq).trim();
      const num = Number(entry.slice(eq + 1).replace(/%/g, '').replace(',', '.').trim());
      if (!label || !Number.isFinite(num)) return null;
      return { label, value: Math.max(0, num) };
    })
    .filter((i): i is ParsedBarEntry => i !== null);
  if (items.length === 0) return null;
  return { title: parts[0], items };
}

export interface ParsedGaugeToken {
  label: string;
  percent: number;
  unit: string;
  tone: InteractiveTone;
}

export function parseGaugeToken(token: string): ParsedGaugeToken | null {
  const match = token.trim().match(/^\[(?:gauge|meter|miernik):([^\]\n]+)\]$/i);
  if (!match) return null;
  const parts = match[1].split('|').map((p) => p.trim());
  if (parts.length < 2 || !parts[0]) return null;
  const num = Number(parts[1].replace(/%/g, '').replace(',', '.'));
  if (!Number.isFinite(num)) return null;
  return {
    label: parts[0],
    percent: Math.max(0, Math.min(100, Math.round(num))),
    unit: parts[2] || '%',
    tone: normalizeTone(parts[3]),
  };
}

export interface ParsedJsonToken {
  title: string;
  rawJson: string;
}

export function parseJsonToken(token: string): ParsedJsonToken | null {
  const match = token.trim().match(/^\[json:([^\]\n]+)\]$/i);
  if (!match) return null;
  const firstPipe = match[1].indexOf('|');
  if (firstPipe === -1) return null;
  const title = match[1].slice(0, firstPipe).trim();
  const rawJson = match[1].slice(firstPipe + 1).trim();
  if (!title || !rawJson) return null;
  return { title, rawJson };
}


