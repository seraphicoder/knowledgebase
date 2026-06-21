import type { TicketSource } from '../lib/api';

// Small badge showing where a ticket came from (Zendesk vs Email, with the
// source's label on hover). Keeps the lists honest about mixed-source ingestion.
export function SourceBadge({ source }: { source?: TicketSource | null }) {
  if (!source) return null;
  const isZendesk = source.type === 'zendesk';
  const label = isZendesk ? 'Zendesk' : source.type === 'imap' ? 'Email' : source.type;
  const cls = isZendesk
    ? 'bg-emerald-100 text-emerald-800'
    : source.type === 'imap'
      ? 'bg-sky-100 text-sky-800'
      : 'bg-gray-100 text-gray-700';
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${cls}`} title={source.label ?? label}>
      {label}
    </span>
  );
}
