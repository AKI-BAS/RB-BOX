import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

/**
 * Uploaded file → summarized categorization suggestion using Anthropic's API.
 *
 * MVP: reads the file as base64 and sends it directly to Claude
 * (Claude can read PDFs natively). Returns suggested categories, tags,
 * and a short IS/EN summary the admin can accept or override in the form.
 *
 * If ANTHROPIC_API_KEY is not set, returns a stub so the UI still works.
 */
export async function POST(request: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const { data: caller } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();
  if (caller?.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const formData = await request.formData();
  const file = formData.get('file') as File | null;
  if (!file) return NextResponse.json({ error: 'No file' }, { status: 400 });

  // Get the current category taxonomy so the model picks from real categories
  const { data: categories } = await supabase
    .from('categories')
    .select('id, slug, name, name_en');
  const taxonomy = (categories || [])
    .map((c) => `- ${c.slug}: ${c.name}${c.name_en ? ` (${c.name_en})` : ''}`)
    .join('\n');

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({
      title: file.name.replace(/\.[^.]+$/, ''),
      summary: 'AI kategorización óvirk — bættu ANTHROPIC_API_KEY við .env til að virkja.',
      categories: ['annad'],
      category_ids: [],
      tags: [],
      confidence: 0,
    });
  }

  // Convert file to base64
  const buf = Buffer.from(await file.arrayBuffer());
  const base64 = buf.toString('base64');

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: {
                type: 'base64',
                media_type: file.type || 'application/pdf',
                data: base64,
              },
            },
            {
              type: 'text',
              text:
                `You are categorizing an Icelandic AEC industry document for RB-BOX.
Return ONLY valid JSON, no preamble, no code fences.

Available categories (slug: Icelandic (English)):
${taxonomy}

Return this shape:
{
  "title": "short Icelandic title of the document",
  "summary": "one-sentence Icelandic summary of what the document covers",
  "categories": ["slug1","slug2"],
  "tags": ["max 5 lowercase Icelandic keywords"],
  "confidence": 0.0
}`,
            },
          ],
        },
      ],
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    return NextResponse.json({ error: 'AI request failed', details: err }, { status: 500 });
  }
  const data = await resp.json();
  const text = data.content
    ?.filter((b: any) => b.type === 'text')
    .map((b: any) => b.text)
    .join('\n') || '';

  let parsed: any;
  try {
    parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch {
    return NextResponse.json({
      title: '',
      summary: text.slice(0, 200),
      categories: [],
      category_ids: [],
      tags: [],
      confidence: 0,
    });
  }

  // Map suggested slugs back to real category IDs
  const category_ids = (parsed.categories || [])
    .map((slug: string) => categories?.find((c) => c.slug === slug)?.id)
    .filter(Boolean);

  return NextResponse.json({ ...parsed, category_ids });
}
