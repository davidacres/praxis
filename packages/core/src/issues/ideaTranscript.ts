function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/g, '\n');
}

function extractSectionBody(content: string, heading: string): string | undefined {
  const lines = normalizeLineEndings(content).split('\n');
  let index = 0;
  while (index < lines.length) {
    if (lines[index].trim() === `## ${heading}`) {
      index += 1;
      const body: string[] = [];
      while (index < lines.length && !/^## /.test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      const value = body.join('\n').trim();
      return value.length > 0 ? value : undefined;
    }
    index += 1;
  }
  return undefined;
}

export interface IdeaTranscriptSections {
  description?: string;
  ideaTranscript?: string;
}

export function splitIdeaContent(content: string | undefined): IdeaTranscriptSections {
  const trimmed = content?.trim();
  if (!trimmed) {
    return {};
  }

  const description =
    extractSectionBody(trimmed, 'Description') ??
    extractSectionBody(trimmed, 'Idea Details') ??
    trimmed;
  const ideaTranscript =
    extractSectionBody(trimmed, 'Research Transcript') ??
    extractSectionBody(trimmed, 'AI Research Transcript');

  return { description, ideaTranscript };
}

export function composeIdeaContent(
  description: string | undefined,
  ideaTranscript: string | undefined
): string | undefined {
  const details = description?.trim() ?? '';
  const transcript = ideaTranscript?.trim() ?? '';

  if (!details && !transcript) {
    return undefined;
  }

  const lines: string[] = [];
  if (details) {
    lines.push('## Description', details);
  }
  if (transcript) {
    if (lines.length > 0) {
      lines.push('');
    }
    lines.push('## Research Transcript', transcript);
  }
  return lines.join('\n');
}
