/**
 * AI analysis for scraped documents.
 *
 * Uses the same Anthropic Messages API as /api/admin/categorize, but adapted
 * for the scraper pipeline:
 *   • Accepts either PDF bytes or plain HTML/text
 *   • Takes taxonomy as an argument (caller fetches it once per run, not per doc)
 *   • Returns null on API failure — the runner treats that as "import without
 *     categorization" so the doc still lands and Sveinn can categorize by hand
 */

type Category = { id: string; slug: string; name: string; name_en: string | null };

export interface AnalyzeResult {
  title: string;
  title_en?: string;
  summary: string;
  language: 'is' | 'en';
  document_type: 'rb_blad' | 'leidbeining' | 'rannsokn' | 'handbok' | 'annad';
  categories: string[];       // slugs the model picked
  category_ids: string[];     // resolved to real UUIDs
  tags: string[];
  confidence: number;
}

interface AnalyzeInput {
  /** PDF bytes if this is a PDF, otherwise omit. */
  pdfBytes?: Buffer;
  /** HTML or plain text if not a PDF. */
  text?: string;
  /** Source URL — helps the model orient itself. */
  sourceUrl: string;
  /** Optional title hint from the listing page. */
  titleHint?: string;
  /** Taxonomy the model chooses from. */
  categories: Category[];
}

function taxonomyString(categories: Category[]): string {
  return categories
    .map((c) => `- ${c.slug}: ${c.name}${c.name_en ? ` (${c.name_en})` : ''}`)
    .join('\n');
}

const SYSTEM_PROMPT = `You are categorizing an Icelandic AEC industry document for RB-BOX, a searchable library for architects, engineers, and contractors.

Return ONLY valid JSON matching the requested shape. No preamble, no code fences, no comments.

Icelandic construction documents typically fall into one of these types:
- rb_blad: RB blað (Rannsóknarráð byggingariðnaðarins technical sheet)
- leidbeining: guideline / instruction document from a regulatory body
- rannsokn: research report
- handbok: handbook / manual
- annad: anything else`;

function buildUserPrompt(input: AnalyzeInput): string {
  return `Source URL: ${input.sourceUrl}
${input.titleHint ? `Listing-page title hint: "${input.titleHint}"\n` : ''}
Available categories (pick 1–3 slugs from this list):
${taxonomyString(input.categories)}

Return this exact shape:
{
  "title": "short Icelandic title of the document",
  "title_en": "English title if easily translatable, otherwise omit",
  "summary": "one-sentence Icelandic summary of what the document covers",
  "language": "is" | "en",
  "document_type": "rb_blad" | "leidbeining" | "rannsokn" | "handbok" | "annad",
  "categories": ["slug1", "slug2"],
  "tags": ["max 5 lowercase Icelandic keywords"],
  "confidence": 0.0-1.0
}`;
}

export async function analyzeDocument(input: AnalyzeInput): Promise<AnalyzeResult | null> {
  if (!process.env.ANTHROPIC_API_KEY) {
    // No API key → fall back to a minimal result so the doc still imports.
    return {
      title: input.titleHint || new URL(input.sourceUrl).pathname.split('/').pop() || 'Untitled',
      summary: '',
      language: 'is',
      document_type: 'annad',
      categories: [],
      category_ids: [],
      tags: [],
      confidence: 0,
    };
  }

  const content: any[] = [];
  if (input.pdfBytes) {
    content.push({
      type: 'document',
      source: {
        type: 'base64',
        media_type: 'application/pdf',
        data: input.pdfBytes.toString('base64'),
      },
    });
  } else if (input.text) {
    // Truncate raw HTML/text so we don't blow the context window.
    // Claude handles ~200k tokens but the useful signal in AEC docs is at the top.
    content.push({
      type: 'text',
      text: `Document content (may be HTML — extract meaning, ignore tags):\n\n${input.text.slice(0, 40_000)}`,
    });
  }
  content.push({ type: 'text', text: buildUserPrompt(input) });

  let response: Response;
  try {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content }],
      }),
    });
  } catch {
    return null;
  }

  if (!response.ok) return null;

  const data = await response.json();
  const rawText: string = (data.content || [])
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text)
    .join('\n');

  let parsed: any;
  try {
    parsed = JSON.parse(rawText.replace(/```json|```/g, '').trim());
  } catch {
    return null;
  }

  // Map slugs → UUIDs
  const category_ids: string[] = (parsed.categories || [])
    .map((slug: string) => input.categories.find((c) => c.slug === slug)?.id)
    .filter(Boolean);

  return {
    title: String(parsed.title || input.titleHint || 'Untitled').slice(0, 500),
    title_en: parsed.title_en ? String(parsed.title_en).slice(0, 500) : undefined,
    summary: String(parsed.summary || '').slice(0, 2000),
    language: parsed.language === 'en' ? 'en' : 'is',
    document_type: [
      'rb_blad', 'leidbeining', 'rannsokn', 'handbok', 'annad',
    ].includes(parsed.document_type) ? parsed.document_type : 'annad',
    categories: Array.isArray(parsed.categories) ? parsed.categories : [],
    category_ids,
    tags: Array.isArray(parsed.tags)
      ? parsed.tags.slice(0, 5).map((t: any) => String(t).toLowerCase())
      : [],
    confidence: Number.isFinite(parsed.confidence) ? Number(parsed.confidence) : 0.5,
  };
}
