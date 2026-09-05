import type { ReactNode } from 'react';

/**
 * A deliberately small syntax highlighter, shared by every place Praxis shows
 * source text: the diff workspace and the read-only file viewer.
 *
 * This is not a language-aware tokenizer — it is one regex covering comments,
 * strings, numbers, and a fixed keyword list common to the languages this app
 * actually shows (TS/JS, C#, Python, shell). That is a deliberate scope limit,
 * not an oversight: pulling in a real highlighter (Prism, Shiki, highlight.js)
 * would be the honest fix if fidelity across more languages ever matters, but
 * it is not worth the dependency for "read the file once to check the agent's
 * work," which is what this exists for.
 */
export function highlightCode(value: string): ReactNode {
  const pattern = /(\/\/.*$|#.*$|`[^`]*`|'(?:\\.|[^'])*'|"(?:\\.|[^"])*"|\b(?:const|let|var|function|return|if|else|for|while|class|interface|type|export|import|from|async|await|new|true|false|null|undefined|public|private|protected|readonly|extends|implements|using|namespace)\b|\b\d+(?:\.\d+)?\b)/gm;
  return value.split(pattern).map((part, index) => {
    if (!part) return null;
    const className = part.startsWith('//') || part.startsWith('#') ? 'comment'
      : /^['"`]/.test(part) ? 'string'
      : /^\d/.test(part) ? 'number'
      : /^(?:const|let|var|function|return|if|else|for|while|class|interface|type|export|import|from|async|await|new|true|false|null|undefined|public|private|protected|readonly|extends|implements|using|namespace)$/.test(part) ? 'keyword'
      : undefined;
    return className ? <span className={`git-code-${className}`} key={index}>{part}</span> : part;
  });
}

/** A short language label for a file, from its extension — display only. */
export function languageFor(path: string): string {
  const extension = path.split('.').pop()?.toLowerCase();
  return ({ ts: 'TypeScript', tsx: 'TypeScript React', js: 'JavaScript', jsx: 'JavaScript React', css: 'CSS', json: 'JSON', md: 'Markdown', cs: 'C#', py: 'Python', sh: 'Shell', html: 'HTML', yml: 'YAML', yaml: 'YAML' } as Record<string, string>)[extension ?? ''] ?? (extension?.toUpperCase() || 'Text');
}
