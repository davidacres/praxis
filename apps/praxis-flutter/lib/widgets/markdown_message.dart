import 'package:flutter/material.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:url_launcher/url_launcher.dart';

/// Renders markdown text with Praxis design styling.
/// Handles bold, italic, links, code blocks, lists, and other markdown elements.
class MarkdownMessage extends StatelessWidget {
  final String text;
  final TextStyle? baseStyle;

  const MarkdownMessage({
    Key? key,
    required this.text,
    this.baseStyle,
  }) : super(key: key);

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final isDark = theme.brightness == Brightness.dark;

    return MarkdownBody(
      data: text,
      selectable: true,
      onTapLink: (text, href, title) async {
        if (href != null) {
          final uri = Uri.tryParse(href);
          if (uri != null && (uri.isScheme('http') || uri.isScheme('https'))) {
            try {
              await launchUrl(uri, mode: LaunchMode.externalApplication);
            } catch (e) {
              if (context.mounted) {
                ScaffoldMessenger.of(context).showSnackBar(
                  SnackBar(content: Text('Could not open link: $href')),
                );
              }
            }
          }
        }
      },
      styleSheet: MarkdownStyleSheet(
        // Block-level styles
        h1: baseStyle?.copyWith(
              fontSize: 20,
              fontWeight: FontWeight.bold,
              color: theme.textTheme.displayMedium?.color,
            ) ??
            TextStyle(
              fontSize: 20,
              fontWeight: FontWeight.bold,
              color: theme.textTheme.displayMedium?.color,
            ),
        h2: baseStyle?.copyWith(
              fontSize: 18,
              fontWeight: FontWeight.bold,
              color: theme.textTheme.displaySmall?.color,
            ) ??
            TextStyle(
              fontSize: 18,
              fontWeight: FontWeight.bold,
              color: theme.textTheme.displaySmall?.color,
            ),
        h3: baseStyle?.copyWith(
              fontSize: 16,
              fontWeight: FontWeight.bold,
            ) ??
            TextStyle(
              fontSize: 16,
              fontWeight: FontWeight.bold,
            ),
        h4: baseStyle?.copyWith(
              fontSize: 15,
              fontWeight: FontWeight.w600,
            ) ??
            TextStyle(
              fontSize: 15,
              fontWeight: FontWeight.w600,
            ),
        h5: baseStyle?.copyWith(
              fontSize: 14,
              fontWeight: FontWeight.w600,
            ) ??
            TextStyle(
              fontSize: 14,
              fontWeight: FontWeight.w600,
            ),
        h6: baseStyle?.copyWith(
              fontSize: 13,
              fontWeight: FontWeight.w600,
            ) ??
            TextStyle(
              fontSize: 13,
              fontWeight: FontWeight.w600,
            ),
        p: baseStyle ??
            TextStyle(
              fontSize: 13,
              height: 1.5,
              color: theme.textTheme.bodyMedium?.color,
            ),
        blockquote: TextStyle(
          color: theme.textTheme.bodySmall?.color,
          fontStyle: FontStyle.italic,
        ),
        blockquoteDecoration: BoxDecoration(
          border: Border(
            left: BorderSide(
              color: theme.colorScheme.outline,
              width: 3,
            ),
          ),
        ),

        // Inline styles
        strong: TextStyle(
          fontWeight: FontWeight.bold,
          color: theme.textTheme.bodyMedium?.color,
        ),
        em: TextStyle(
          fontStyle: FontStyle.italic,
          color: theme.textTheme.bodyMedium?.color,
        ),
        del: TextStyle(
          decoration: TextDecoration.lineThrough,
          color: theme.textTheme.bodySmall?.color,
        ),
        code: TextStyle(
          fontFamily: 'monospace',
          fontSize: 12,
          color: theme.textTheme.bodyMedium?.color,
          backgroundColor: isDark
              ? theme.colorScheme.surfaceContainer
              : theme.colorScheme.surfaceContainerLowest,
        ),

        // Code block
        codeblockDecoration: BoxDecoration(
          color: isDark
              ? theme.colorScheme.surfaceContainer
              : theme.colorScheme.surfaceContainerLowest,
          borderRadius: BorderRadius.circular(8),
          border: Border.all(
            color: theme.colorScheme.outline,
            width: 1,
          ),
        ),
        codeblockPadding: const EdgeInsets.all(12),
        code: TextStyle(
          fontFamily: 'monospace',
          fontSize: 12,
          color: theme.textTheme.bodyMedium?.color,
          height: 1.4,
        ),

        // Lists
        listBullet: TextStyle(
          fontSize: 13,
          color: theme.textTheme.bodySmall?.color,
        ),
        listIndent: 16,

        // Links
        a: TextStyle(
          color: theme.colorScheme.primary,
          decoration: TextDecoration.underline,
        ),

        // Table
        tableBorder: TableBorder.all(
          color: theme.colorScheme.outline,
          borderRadius: BorderRadius.circular(6),
        ),
        tableHead: TextStyle(
          fontWeight: FontWeight.bold,
          color: theme.textTheme.bodyMedium?.color,
        ),
        tableBody: TextStyle(
          fontSize: 12,
          color: theme.textTheme.bodyMedium?.color,
        ),
        tableCellsPadding: const EdgeInsets.symmetric(
          horizontal: 8,
          vertical: 6,
        ),
        tableHeadAlign: TextAlign.left,

        // Spacing
        h1Padding: const EdgeInsets.only(top: 8, bottom: 6),
        h2Padding: const EdgeInsets.only(top: 8, bottom: 6),
        h3Padding: const EdgeInsets.only(top: 6, bottom: 4),
        h4Padding: const EdgeInsets.only(top: 4, bottom: 2),
        h5Padding: const EdgeInsets.only(top: 2, bottom: 0),
        h6Padding: const EdgeInsets.only(top: 2, bottom: 0),
        blockSpacing: 8,
      ),
    );
  }
}
