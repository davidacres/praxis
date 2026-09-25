import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../app/theme.dart';
import '../core/markdown.dart';
import 'kit.dart';

/// Agent text as formatted blocks. Port of `app/Markdown.tsx`.
class MarkdownView extends StatefulWidget {
  const MarkdownView(this.text, {super.key});
  final String text;

  @override
  State<MarkdownView> createState() => _MarkdownViewState();
}

class _MarkdownViewState extends State<MarkdownView> {
  late List<MdBlock> _blocks = parseBlocks(widget.text);

  @override
  void didUpdateWidget(MarkdownView oldWidget) {
    super.didUpdateWidget(oldWidget);
    // Re-parse only when the text changes, so a streaming reply re-parses as it grows.
    if (oldWidget.text != widget.text) _blocks = parseBlocks(widget.text);
  }

  @override
  Widget build(BuildContext context) => _Blocks(_blocks, depth: 0);
}

TextStyle _paragraph(BuildContext context) => ts(context, 13, lineHeight: 19);

List<InlineSpan> inlineSpans(BuildContext context, List<MdInline> spans, TextStyle base) {
  final p = context.p;
  return spans.map<InlineSpan>((span) {
    switch (span) {
      case MdText(:final text):
        return TextSpan(text: text, style: base);
      case MdCode(:final text):
        return TextSpan(
          text: text,
          style: base.copyWith(fontFamily: monospace, fontSize: context.t.s(12), backgroundColor: p.bgSunken, color: p.text),
        );
      case MdStyled(:final style, :final children):
        final next = switch (style) {
          MdStyle.strong => base.copyWith(fontWeight: FontWeight.w700),
          MdStyle.em => base.copyWith(fontStyle: FontStyle.italic),
          MdStyle.strike => base.copyWith(decoration: TextDecoration.lineThrough, color: p.textDim, decorationColor: p.textDim),
        };
        return TextSpan(children: inlineSpans(context, children, next));
      case MdLink(:final href, :final children):
        final next = base.copyWith(color: p.accent, decoration: TextDecoration.underline, decorationColor: p.accent);
        return TextSpan(
          children: inlineSpans(context, children, next),
          recognizer: TapGestureRecognizer()
            ..onTap = () {
              if (isSafeLink(href)) launchUrl(Uri.parse(href), mode: LaunchMode.externalApplication);
            },
        );
    }
  }).toList();
}

class _Inline extends StatelessWidget {
  const _Inline(this.spans, this.style, {this.align});
  final List<MdInline> spans;
  final TextStyle style;
  final TextAlign? align;

  @override
  Widget build(BuildContext context) => Text.rich(TextSpan(children: inlineSpans(context, spans, style)), textAlign: align);
}

class _Blocks extends StatelessWidget {
  const _Blocks(this.blocks, {required this.depth});
  final List<MdBlock> blocks;
  final int depth;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final children = <Widget>[];
    for (final block in blocks) {
      if (children.isNotEmpty) children.add(SizedBox(height: t.s(8)));
      children.add(switch (block) {
        MdHeading(:final level, :final children) => Padding(
          padding: EdgeInsets.only(top: level <= 2 ? t.s(2) : 0),
          child: Semantics(
            header: true,
            child: _Inline(
              children,
              level <= 2 ? ts(context, 15, lineHeight: 21, weight: FontWeight.w700) : ts(context, 13.5, lineHeight: 19, weight: FontWeight.w700),
            ),
          ),
        ),
        MdParagraph(:final children) => _Inline(children, _paragraph(context)),
        MdCodeBlock() => _CodeBlock(block),
        MdList() => _ListBlock(block, depth: depth),
        MdQuote(:final blocks) => Container(
          padding: EdgeInsets.only(left: t.s(10)),
          decoration: BoxDecoration(
            border: Border(left: BorderSide(color: t.palette.borderStrong, width: 3)),
          ),
          child: _Blocks(blocks, depth: depth),
        ),
        MdTable() => _TableBlock(block),
        MdRule() => Container(
          height: 1,
          margin: EdgeInsets.symmetric(vertical: t.s(4)),
          color: t.palette.border,
        ),
      });
    }
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: children);
  }
}

class _CodeBlock extends StatelessWidget {
  const _CodeBlock(this.block);
  final MdCodeBlock block;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    return Semantics(
      label: '${block.language ?? 'Code'} block',
      child: Container(
        padding: EdgeInsets.symmetric(vertical: t.s(8)),
        decoration: BoxDecoration(
          color: t.palette.bgSunken,
          borderRadius: BorderRadius.circular(t.s(8)),
          border: Border.all(color: t.palette.border),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (block.language != null)
              Padding(
                padding: EdgeInsets.fromLTRB(t.s(10), 0, t.s(10), t.s(4)),
                child: Text(
                  block.language!.toUpperCase(),
                  style: ts(context, 10, weight: FontWeight.w700, letterSpacing: 0.6, color: t.palette.textDim),
                ),
              ),
            SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              padding: EdgeInsets.symmetric(horizontal: t.s(10)),
              child: SelectableText(block.text, style: ts(context, 12, lineHeight: 17, family: monospace)),
            ),
          ],
        ),
      ),
    );
  }
}

class _ListBlock extends StatelessWidget {
  const _ListBlock(this.block, {required this.depth});
  final MdList block;
  final int depth;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final rows = <Widget>[];
    for (var index = 0; index < block.items.length; index += 1) {
      final item = block.items[index];
      final bullet = item.checked != null
          ? (item.checked! ? '☑' : '☐')
          : block.ordered
          ? '${block.start + index}.'
          : depth > 0
          ? '◦'
          : '•';
      if (rows.isNotEmpty) rows.add(SizedBox(height: t.s(4)));
      rows.add(
        Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                ConstrainedBox(
                  constraints: BoxConstraints(minWidth: t.s(14)),
                  child: Text(bullet, style: ts(context, 13, lineHeight: 19, color: t.palette.textDim)),
                ),
                SizedBox(width: t.s(8)),
                Expanded(child: _Inline(item.children, _paragraph(context))),
              ],
            ),
            if (item.sublist != null) _ListBlock(item.sublist!, depth: depth + 1),
          ],
        ),
      );
    }
    return Padding(
      padding: EdgeInsets.only(left: depth > 0 ? t.s(18) : 0, top: depth > 0 ? t.s(4) : 0),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: rows),
    );
  }
}

class _TableBlock extends StatelessWidget {
  const _TableBlock(this.block);
  final MdTable block;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final width = t.s(132);
    TextAlign alignment(int column) => switch (column < block.align.length ? block.align[column] : null) {
      MdAlign.right => TextAlign.right,
      MdAlign.center => TextAlign.center,
      _ => TextAlign.left,
    };
    Widget cell(List<MdInline> spans, int column, {bool header = false}) => SizedBox(
      width: width,
      child: Padding(
        padding: EdgeInsets.symmetric(horizontal: t.s(8), vertical: t.s(6)),
        child: _Inline(spans, ts(context, 12, lineHeight: 17, weight: header ? FontWeight.w700 : FontWeight.w400), align: alignment(column)),
      ),
    );
    Widget row(List<List<MdInline>> cells, {bool header = false}) => Container(
      decoration: BoxDecoration(
        color: header ? t.palette.bgSunken : null,
        border: Border(bottom: BorderSide(color: t.palette.border)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [for (var c = 0; c < cells.length; c += 1) cell(cells[c], c, header: header)],
      ),
    );
    return Align(
      alignment: Alignment.centerLeft,
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: Container(
          decoration: BoxDecoration(
            border: Border.all(color: t.palette.border),
            borderRadius: BorderRadius.circular(t.s(6)),
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [row(block.header, header: true), for (final cells in block.rows) row(cells)],
          ),
        ),
      ),
    );
  }
}
