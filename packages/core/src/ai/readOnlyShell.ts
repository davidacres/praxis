/**
 * Decides whether a shell command an agent asks to run can only read.
 *
 * A read-only session (a workflow's Plan or Review stage) refuses tools that could change files.
 * Refusing a command is not harmless to the session: Copilot CLI ends the whole turn on any
 * refused tool ("Operation cancelled by user"), so a planner that opened with `git status` stopped
 * there and the stage failed with no plan. Commands that only look are let through instead.
 *
 * This is a deliberately small allowlist, not a shell parser: anything it does not recognise — a
 * command substitution, an output redirection, an unknown program, a writing flag — is refused.
 */
export function isReadOnlyShellCommand(command: string): boolean {
  const segments = splitSegments(command);
  if (!segments || segments.length === 0) return false;
  return segments.every(segment => {
    const words = segment.filter(word => word.length > 0);
    // Leading `NAME=value` assignments (`GIT_PAGER=cat git log`) configure the command, not the shell.
    while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) {
      if (/^(PATH|LD_|DYLD_|BASH_ENV|ENV|GIT_(EXTERNAL_DIFF|PAGER_IN_USE|CONFIG|EXEC_PATH|SSH))/.test(words[0])) return false;
      words.shift();
    }
    if (words.length === 0) return false;
    const program = words[0].split('/').pop() ?? '';
    const args = words.slice(1);
    const check = PROGRAMS[program];
    return check ? check(args) : false;
  });
}

/** The command an ACP permission request is for, from the tool call's `rawInput`, when it names one. */
export function shellCommandOf(rawInput: unknown): string | undefined {
  if (!rawInput || typeof rawInput !== 'object') return undefined;
  const value = (rawInput as Record<string, unknown>).command ?? (rawInput as Record<string, unknown>).cmd;
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every(part => typeof part === 'string')) {
    // Codex sends `["bash", "-lc", "<script>"]`.
    const parts = value as string[];
    if (parts.length === 3 && /(^|\/)(ba|z)?sh$/.test(parts[0]) && /^-l?c$/.test(parts[1])) return parts[2];
    return parts.map(part => (/^[\w@%+=:,./-]+$/.test(part) ? part : `'${part.replace(/'/g, `'\\''`)}'`)).join(' ');
  }
  return undefined;
}

type ArgCheck = (args: string[]) => boolean;

const any: ArgCheck = () => true;
const noFlag = (...flags: string[]): ArgCheck => args => !args.some(arg => flags.some(flag => arg === flag || arg.startsWith(`${flag}=`)));
const positional = (args: string[]): string[] => args.filter(arg => !arg.startsWith('-'));

const FIND_ACTIONS = ['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls'];

/** `sed` only to print lines: `sed -n '1,80p' file` or `sed -n '/re/p' file`. */
const sedPrintOnly: ArgCheck = args => {
  if (!args.includes('-n') || args.some(arg => /^-(i|-in-place)/.test(arg) || arg === '-e' || arg === '-f')) return false;
  const script = args.find(arg => !arg.startsWith('-'));
  return !!script && /^((\d+|\$)(,(\d+|\$))?|\/[^/]*\/)p$/.test(script);
};

const GIT_READS: Record<string, ArgCheck> = {
  status: any,
  log: noFlag('--output'),
  show: noFlag('--output'),
  diff: noFlag('--output', '--ext-diff'),
  'ls-files': any,
  'ls-tree': any,
  grep: noFlag('--open-files-in-pager', '-O'),
  'rev-parse': any,
  'rev-list': any,
  blame: any,
  'cat-file': any,
  'merge-base': any,
  describe: any,
  shortlog: any,
  // Listing only: a branch, tag or remote named as an argument would be created or changed.
  branch: args => positional(args).length === 0 && !args.some(arg => /^-(d|D|m|M|c|C|f|u)$|^--(delete|move|copy|force|set-upstream|unset-upstream|edit-description)/.test(arg)),
  tag: args => (args.length === 0 || args.includes('-l') || args.includes('--list')) && !args.some(arg => /^-(d|a|s|f|m|F)$|^--delete/.test(arg)),
  remote: args => args.length === 0 || args.every(arg => arg === '-v' || arg === '--verbose'),
  worktree: args => args[0] === 'list',
  stash: args => args[0] === 'list' || args[0] === 'show',
  config: args => args.some(arg => arg === '--get' || arg === '--get-all' || arg === '--list' || arg === '-l')
};

const git: ArgCheck = args => {
  let i = 0;
  // Global options that only choose where and how to read.
  while (i < args.length && args[i].startsWith('-')) {
    if (args[i] === '-C') i += 2;
    else if (args[i] === '--no-pager' || args[i] === '-P' || args[i] === '--no-optional-locks') i += 1;
    else return false; // `-c`, `--exec-path`, `--git-dir`… can change what git runs.
  }
  const sub = args[i];
  const check = sub ? GIT_READS[sub] : undefined;
  return check ? check(args.slice(i + 1)) : false;
};

const PROGRAMS: Record<string, ArgCheck> = {
  cd: any, pwd: any, ls: any, cat: any, head: any, tail: noFlag('-f', '-F', '--follow'), wc: any,
  grep: any, egrep: any, fgrep: any, rg: noFlag('--pre'), ag: any,
  find: args => !args.some(arg => FIND_ACTIONS.includes(arg)),
  sed: sedPrintOnly,
  sort: noFlag('-o', '--output'), uniq: args => positional(args).length <= 1, cut: any, tr: any, nl: any,
  jq: any, file: any, stat: any, du: any, tree: noFlag('-o'), diff: any, cmp: any,
  basename: any, dirname: any, realpath: any, readlink: any, which: any, echo: any, printf: any,
  true: any, test: any, '[': any, date: any,
  git
};

/**
 * Splits on `|`, `&&`, `||`, `;` and newlines outside quotes, into each command's words.
 * `undefined` when the command does anything this check will not follow: command or process
 * substitution, a heredoc, a background `&`, or writing to anything but /dev/null.
 */
function splitSegments(command: string): string[][] | undefined {
  const segments: string[][] = [];
  let words: string[] = [];
  let word = '';
  let quote: '"' | "'" | undefined;
  const endWord = () => { if (word) words.push(word); word = ''; };
  const endSegment = () => { endWord(); if (words.length) segments.push(words); words = []; };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    const next = command[i + 1];
    if (quote === "'") {
      if (c === "'") quote = undefined; else word += c;
      continue;
    }
    if (c === '`' || (c === '$' && next === '(')) return undefined;
    if (quote === '"') {
      if (c === '"') quote = undefined;
      else if (c === '\\' && next !== undefined) { word += next; i++; }
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === '\\' && next !== undefined) { word += next; i++; continue; }
    if (c === ' ' || c === '\t') { endWord(); continue; }
    if (c === '\n' || c === ';') { endSegment(); continue; }
    if (c === '|') { endSegment(); if (next === '|') i++; continue; }
    if (c === '&') {
      if (next === '&') { endSegment(); i++; continue; }
      if (next === '>') continue; // `&>`: the `>` that follows is checked like any redirection
      return undefined; // backgrounding
    }
    if (c === '<') {
      if (next === '<' || next === '(') return undefined;
      endWord();
      continue;
    }
    if (c === '>') {
      // Only `2>&1`, `>&2` and writes to /dev/null are allowed.
      const rest = command.slice(i + 1);
      const fd = /\d$/.test(word) ? word : '';
      if (fd) word = '';
      endWord();
      const target = /^>?\s*(&\d|\/dev\/null)(?=$|[\s;|&])/.exec(rest);
      if (!target) return undefined;
      i += target[0].length;
      continue;
    }
    word += c;
  }
  if (quote) return undefined;
  endSegment();
  return segments;
}
