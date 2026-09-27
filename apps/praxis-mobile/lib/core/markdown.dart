// A small, dependency-free markdown reader for agent replies. It covers what
// agents write — headings, paragraphs, fenced code, lists, quotes, tables,
// rules, and inline bold, italic, code, strikethrough and links. Anything it
// does not recognise stays as text. Port of `renderer/mobileMarkdown.ts`.

sealed class MdInline {
  const MdInline();
}

class MdText extends MdInline {
  const MdText(this.text);
  final String text;
}

class MdCode extends MdInline {
  const MdCode(this.text);
  final String text;
}

enum MdStyle { strong, em, strike }

class MdStyled extends MdInline {
  const MdStyled(this.style, this.children);
  final MdStyle style;
  final List<MdInline> children;
}

class MdLink extends MdInline {
  const MdLink(this.href, this.children);
  final String href;
  final List<MdInline> children;
}

class MdListItem {
  MdListItem(this.children, {this.checked, this.sublist});
  final List<MdInline> children;
  final bool? checked;
  final MdList? sublist;
}

sealed class MdBlock {
  const MdBlock();
}

class MdHeading extends MdBlock {
  const MdHeading(this.level, this.children);
  final int level;
  final List<MdInline> children;
}

class MdParagraph extends MdBlock {
  const MdParagraph(this.children);
  final List<MdInline> children;
}

class MdCodeBlock extends MdBlock {
  const MdCodeBlock(this.language, this.text);
  final String? language;
  final String text;
}

class MdList extends MdBlock {
  MdList({required this.ordered, required this.start, required this.items});
  final bool ordered;
  final int start;
  final List<MdListItem> items;
}

class MdQuote extends MdBlock {
  const MdQuote(this.blocks);
  final List<MdBlock> blocks;
}

enum MdAlign { left, center, right }

class MdTable extends MdBlock {
  const MdTable(this.header, this.align, this.rows);
  final List<List<MdInline>> header;
  final List<MdAlign?> align;
  final List<List<List<MdInline>>> rows;
}

class MdRule extends MdBlock {
  const MdRule();
}

final _fenceOpen = RegExp(r'^( {0,3})(`{3,}|~{3,})\s*([\w+#.-]*)[^`]*$');
final _heading = RegExp(r'^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$');
final _rule = RegExp(r'^ {0,3}([-*_])(\s*\1){2,}\s*$');
final _listItem = RegExp(r'^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$');
final _quote = RegExp(r'^ {0,3}>\s?(.*)$');
final _tableDivider = RegExp(r'^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$');
final _task = RegExp(r'^\[([ xX])\]\s+(.*)$');

/// Links an agent may emit; anything else (javascript:, file:, data:) is shown as text.
bool isSafeLink(String href) => RegExp(r'^(https?:|mailto:)', caseSensitive: false).hasMatch(href.trim());

List<String> _splitRow(String line) {
  var row = line.trim();
  if (row.startsWith('|')) row = row.substring(1);
  if (row.endsWith('|') && !row.endsWith(r'\|')) row = row.substring(0, row.length - 1);
  final cells = <String>[];
  final current = StringBuffer();
  var inCode = false;
  for (var index = 0; index < row.length; index += 1) {
    final char = row[index];
    if (char == r'\' && index + 1 < row.length && row[index + 1] == '|') {
      current.write('|');
      index += 1;
      continue;
    }
    if (char == '`') inCode = !inCode;
    if (char == '|' && !inCode) {
      cells.add(current.toString().trim());
      current.clear();
      continue;
    }
    current.write(char);
  }
  cells.add(current.toString().trim());
  return cells;
}

MdAlign? _alignOf(String cell) {
  final trimmed = cell.trim();
  final left = trimmed.startsWith(':');
  final right = trimmed.endsWith(':');
  if (left && right) return MdAlign.center;
  if (right) return MdAlign.right;
  if (left) return MdAlign.left;
  return null;
}

final _escape = RegExp(r'[\\`*_{}[\]()#+\-.!|~>]');
final _codeSpan = RegExp(r'^(`+)([\s\S]*?[^`])\1(?!`)');
final _link = RegExp(r'^\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)');
final _autolink = RegExp(r'^<(https?://[^>\s]+)>');
final _strong = RegExp(r'^(\*\*|__)(?=\S)([\s\S]*?\S)\1');
final _strike = RegExp(r'^~~(?=\S)([\s\S]*?\S)~~');
final _emStar = RegExp(r'^\*(?=\S)([\s\S]*?\S)\*(?!\*)');
final _emUnderscore = RegExp(r'^_(?=\S)([\s\S]*?\S)_(?![\w_])');
final _wordEnd = RegExp(r'\w$');

/// Inline markdown to spans. Unclosed markers are left as the characters they were.
List<MdInline> parseInline(String source) {
  final out = <MdInline>[];
  final text = StringBuffer();
  void flush() {
    if (text.isNotEmpty) out.add(MdText(text.toString()));
    text.clear();
  }

  var index = 0;
  while (index < source.length) {
    final rest = source.substring(index);

    if (rest[0] == r'\' && rest.length > 1 && _escape.hasMatch(rest[1])) {
      text.write(rest[1]);
      index += 2;
      continue;
    }

    final code = _codeSpan.firstMatch(rest);
    if (code != null) {
      flush();
      final body = code.group(2)!;
      final unpadded = RegExp(r'^ (.*) $').firstMatch(body);
      out.add(MdCode(unpadded != null ? unpadded.group(1)! : body));
      index += code.group(0)!.length;
      continue;
    }

    final link = _link.firstMatch(rest);
    if (link != null) {
      flush();
      if (isSafeLink(link.group(2)!)) {
        out.add(MdLink(link.group(2)!, parseInline(link.group(1)!)));
      } else {
        out.addAll(parseInline(link.group(1)!));
      }
      index += link.group(0)!.length;
      continue;
    }

    final autolink = _autolink.firstMatch(rest);
    if (autolink != null) {
      flush();
      out.add(MdLink(autolink.group(1)!, [MdText(autolink.group(1)!)]));
      index += autolink.group(0)!.length;
      continue;
    }

    final strong = _strong.firstMatch(rest);
    if (strong != null) {
      flush();
      out.add(MdStyled(MdStyle.strong, parseInline(strong.group(2)!)));
      index += strong.group(0)!.length;
      continue;
    }

    final strike = _strike.firstMatch(rest);
    if (strike != null) {
      flush();
      out.add(MdStyled(MdStyle.strike, parseInline(strike.group(1)!)));
      index += strike.group(0)!.length;
      continue;
    }

    // `_` emphasis only at a word boundary, so snake_case identifiers stay intact.
    final em = _emStar.firstMatch(rest) ?? (_wordEnd.hasMatch(source.substring(0, index)) ? null : _emUnderscore.firstMatch(rest));
    if (em != null) {
      flush();
      out.add(MdStyled(MdStyle.em, parseInline(em.group(1)!)));
      index += em.group(0)!.length;
      continue;
    }

    text.write(rest[0]);
    index += 1;
  }
  flush();
  return out;
}

int _indentOf(String line) => (RegExp(r'^(\s*)').firstMatch(line)?.group(1) ?? '').replaceAll('\t', '    ').length;

({MdList block, int next}) _parseList(List<String> lines, int start) {
  final first = _listItem.firstMatch(lines[start])!;
  final baseIndent = _indentOf(lines[start]);
  final ordered = RegExp(r'\d').hasMatch(first.group(2)!);
  final block = MdList(ordered: ordered, start: ordered ? int.parse(RegExp(r'\d+').firstMatch(first.group(2)!)!.group(0)!) : 1, items: []);
  var index = start;
  String? currentText;
  List<String>? currentSub;

  void finish() {
    if (currentText == null) return;
    final task = _task.firstMatch(currentText!);
    MdList? sublist;
    if (currentSub!.isNotEmpty) {
      for (final candidate in parseBlocks(currentSub!.join('\n'))) {
        if (candidate is MdList) {
          sublist = candidate;
          break;
        }
      }
    }
    block.items.add(
      MdListItem(
        parseInline(task != null ? task.group(2)! : currentText!),
        checked: task == null ? null : task.group(1)!.toLowerCase() == 'x',
        sublist: sublist,
      ),
    );
    currentText = null;
    currentSub = null;
  }

  while (index < lines.length) {
    final line = lines[index];
    if (line.trim().isEmpty) {
      final following = index + 1 < lines.length ? lines[index + 1] : null;
      if (following != null && _listItem.hasMatch(following) && _indentOf(following) >= baseIndent) {
        index += 1;
        continue;
      }
      break;
    }
    final match = _listItem.firstMatch(line);
    final indent = _indentOf(line);
    if (match != null && indent <= baseIndent + 1 && RegExp(r'\d').hasMatch(match.group(2)!) == ordered) {
      finish();
      currentText = match.group(3)!;
      currentSub = [];
    } else if (match != null && indent > baseIndent + 1 && currentText != null) {
      currentSub!.add(line.substring(indent < baseIndent + 2 ? indent : baseIndent + 2));
    } else if (match != null) {
      break;
    } else if (currentText != null && indent > baseIndent) {
      if (currentSub!.isNotEmpty) {
        currentSub!.add(line.substring(indent < baseIndent + 2 ? indent : baseIndent + 2));
      } else {
        currentText = '$currentText ${line.trim()}';
      }
    } else if (currentText != null && !_heading.hasMatch(line) && !_fenceOpen.hasMatch(line) && !_quote.hasMatch(line)) {
      currentText = '$currentText ${line.trim()}';
    } else {
      break;
    }
    index += 1;
  }
  finish();
  return (block: block, next: index);
}

/// Block-level markdown to blocks.
List<MdBlock> parseBlocks(String source) {
  final lines = source.replaceAll(RegExp(r'\r\n?'), '\n').split('\n');
  final blocks = <MdBlock>[];
  var paragraph = <String>[];
  void flushParagraph() {
    if (paragraph.isNotEmpty) blocks.add(MdParagraph(parseInline(paragraph.join('\n'))));
    paragraph = [];
  }

  var index = 0;
  while (index < lines.length) {
    final line = lines[index];

    final fence = _fenceOpen.firstMatch(line);
    if (fence != null) {
      flushParagraph();
      final marker = fence.group(2)!;
      final close = RegExp('^ {0,3}${RegExp.escape(marker[0])}{${marker.length},}\\s*\$');
      final body = <String>[];
      index += 1;
      while (index < lines.length && !close.hasMatch(lines[index])) {
        body.add(lines[index]);
        index += 1;
      }
      index += 1;
      final language = fence.group(3)!;
      blocks.add(MdCodeBlock(language.isEmpty ? null : language, body.join('\n')));
      continue;
    }

    if (line.trim().isEmpty) {
      flushParagraph();
      index += 1;
      continue;
    }

    final heading = _heading.firstMatch(line);
    if (heading != null) {
      flushParagraph();
      blocks.add(MdHeading(heading.group(1)!.length, parseInline(heading.group(2)!)));
      index += 1;
      continue;
    }

    if (_rule.hasMatch(line) && !(paragraph.isNotEmpty && RegExp(r'^\s*-+\s*$').hasMatch(line))) {
      flushParagraph();
      blocks.add(const MdRule());
      index += 1;
      continue;
    }

    if (_quote.hasMatch(line)) {
      flushParagraph();
      final quoted = <String>[];
      while (index < lines.length && lines[index].trim().isNotEmpty && _quote.hasMatch(lines[index])) {
        quoted.add(_quote.firstMatch(lines[index])!.group(1)!);
        index += 1;
      }
      blocks.add(MdQuote(parseBlocks(quoted.join('\n'))));
      continue;
    }

    if (line.contains('|') && index + 1 < lines.length && _tableDivider.hasMatch(lines[index + 1]) && lines[index + 1].contains('-')) {
      final header = _splitRow(line);
      final divider = _splitRow(lines[index + 1]);
      flushParagraph();
      index += 2;
      final rows = <List<List<MdInline>>>[];
      while (index < lines.length && lines[index].trim().isNotEmpty && lines[index].contains('|')) {
        final cells = _splitRow(lines[index]);
        rows.add([for (var column = 0; column < header.length; column += 1) parseInline(column < cells.length ? cells[column] : '')]);
        index += 1;
      }
      blocks.add(
        MdTable(header.map(parseInline).toList(), [
          for (var column = 0; column < header.length; column += 1) _alignOf(column < divider.length ? divider[column] : ''),
        ], rows),
      );
      continue;
    }

    if (_listItem.hasMatch(line) && (paragraph.isEmpty || _indentOf(line) == 0)) {
      flushParagraph();
      final parsed = _parseList(lines, index);
      blocks.add(parsed.block);
      index = parsed.next;
      continue;
    }

    paragraph.add(line.trim());
    index += 1;
  }
  flushParagraph();
  return blocks;
}

/// The plain text of inline spans — for accessibility labels and copy.
String inlineText(List<MdInline> spans) => spans
    .map(
      (span) => switch (span) {
        MdText(:final text) => text,
        MdCode(:final text) => text,
        MdStyled(:final children) => inlineText(children),
        MdLink(:final children) => inlineText(children),
      },
    )
    .join();

/// Plain text of a message's markdown, for screen readers.
String markdownPlainText(String text) => parseBlocks(text)
    .map(
      (block) => switch (block) {
        MdParagraph(:final children) => inlineText(children),
        MdHeading(:final children) => inlineText(children),
        MdCodeBlock(:final text) => text,
        _ => '',
      },
    )
    .where((line) => line.isNotEmpty)
    .join('\n');
