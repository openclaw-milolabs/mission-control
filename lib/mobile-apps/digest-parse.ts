export type ParsedDigest = {
  sentiment: string;
  /** Approximate sentiment score in [-1, 1], or null if the model didn't give one. */
  score: number | null;
  complaints: string[];
  praise: string[];
  themes: string[];
};

type Section = { heading: string; body: string };

function splitSections(md: string): Section[] {
  const out: Section[] = [];
  const re = /^##+\s*(.+?)\s*$/gm;
  const matches = [...md.matchAll(re)];
  if (matches.length === 0) return [{ heading: "", body: md.trim() }];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index! + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index! : md.length;
    out.push({ heading: matches[i][1].toLowerCase(), body: md.slice(start, end).trim() });
  }
  return out;
}

function bullets(body: string): string[] {
  return body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^[-*•]\s+/.test(l))
    .map((l) => l.replace(/^[-*•]\s+/, "").trim())
    .filter(Boolean);
}

function findSection(sections: Section[], ...keywords: string[]): Section | undefined {
  return sections.find((s) => keywords.some((k) => s.heading.includes(k)));
}

/** Pure: parse the agent's Markdown digest into structured insight for the UI. */
export function parseDigest(md: string): ParsedDigest {
  const text = (md || "").trim();
  if (!text) return { sentiment: "", score: null, complaints: [], praise: [], themes: [] };

  const sections = splitSections(text);
  const overall = findSection(sections, "sentiment", "overall") ?? sections[0];
  const sentimentBody = (overall?.body ?? text).trim();

  // Score: a signed decimal in [-1, 1], typically "Score: -0.3".
  let score: number | null = null;
  const scoreMatch = sentimentBody.match(/-?\d(?:\.\d+)?/g);
  if (scoreMatch) {
    for (const m of scoreMatch) {
      const n = Number(m);
      if (Number.isFinite(n) && n >= -1 && n <= 1 && /[.\-]/.test(m)) {
        score = n;
        break;
      }
    }
  }
  // The sentiment line without the trailing "Score: x" tail.
  const sentiment = sentimentBody.replace(/score\s*[:=]?\s*-?\d(?:\.\d+)?.*$/im, "").trim() || sentimentBody;

  const complaints = bullets(findSection(sections, "complaint", "negative", "issue")?.body ?? "");
  const praise = bullets(findSection(sections, "praise", "positive", "love")?.body ?? "");

  const themesBody = findSection(sections, "theme", "tag")?.body ?? "";
  const themes = themesBody
    .replace(/^[-*•]\s+/gm, "")
    .split(/[,\n]/)
    .map((t) => t.trim().replace(/^#/, ""))
    .filter(Boolean)
    .slice(0, 12);

  return { sentiment, score, complaints, praise, themes };
}
