import { getServiceClient } from '../lib/supabase.js';

// Domain grounding facts. Loads an org's active facts and selects the ones
// applicable to a given thread: all global rules (term IS NULL) plus any
// term-triggered facts whose term appears (case-insensitive) in the content.
// The selected facts are rendered as an authoritative context block that the
// extractor prepends so the model corrects its assumptions.

export interface DomainFact {
  id: string;
  term: string | null;
  fact: string;
}

export async function getApplicableFacts(orgId: string, content: string): Promise<DomainFact[]> {
  const db = getServiceClient();
  const { data, error } = await db
    .from('domain_facts')
    .select('id, term, fact')
    .eq('org_id', orgId)
    .eq('active', true);
  if (error || !data) return [];

  const haystack = content.toLowerCase();
  return (data as DomainFact[]).filter(
    (f) => !f.term || haystack.includes(f.term.toLowerCase()),
  );
}

/** Renders selected facts/rules as an authoritative block, or '' if none. */
export function buildFactsBlock(facts: DomainFact[]): string {
  if (facts.length === 0) return '';
  const lines = facts.map((f) => (f.term ? `- ${f.term}: ${f.fact}` : `- ${f.fact}`));
  return [
    "AUTHORITATIVE FACTS & RULES for this organization.",
    'Treat any factual statements as ground truth (correct conflicting assumptions in your output),',
    'and follow any instructions exactly:',
    ...lines,
  ].join('\n');
}
