import React, { useMemo } from 'react';
import { Linking, Platform, ScrollView, StyleSheet, Text, View, type TextStyle } from 'react-native';
import { inlineText, isSafeLink, parseBlocks, type MarkdownBlock, type MarkdownInline } from '../renderer/mobileMarkdown';
import { mobileScale, theme, themedStyles } from './theme';

export const MONOSPACE = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

function Inline({ spans, style }: { spans: readonly MarkdownInline[]; style?: TextStyle }): React.JSX.Element {
  return (
    <>
      {spans.map((span, index) => {
        switch (span.type) {
          case 'text':
            return <Text key={index} style={style}>{span.text}</Text>;
          case 'code':
            return <Text key={index} style={[style, styles.inlineCode]}>{span.text}</Text>;
          case 'strong':
            return <Text key={index} style={[style, styles.strong]}><Inline spans={span.children} /></Text>;
          case 'em':
            return <Text key={index} style={[style, styles.em]}><Inline spans={span.children} /></Text>;
          case 'strike':
            return <Text key={index} style={[style, styles.strike]}><Inline spans={span.children} /></Text>;
          case 'link':
            return (
              <Text
                key={index}
                accessibilityRole="link"
                style={[style, styles.link]}
                onPress={() => { if (isSafeLink(span.href)) void Linking.openURL(span.href); }}
              >
                <Inline spans={span.children} />
              </Text>
            );
        }
      })}
    </>
  );
}

function CodeBlock({ block }: { block: Extract<MarkdownBlock, { type: 'code' }> }): React.JSX.Element {
  return (
    <View style={styles.code} accessibilityLabel={`${block.language ?? 'Code'} block`}>
      {block.language ? <Text style={styles.codeLanguage}>{block.language}</Text> : null}
      <ScrollView horizontal showsHorizontalScrollIndicator nestedScrollEnabled>
        <Text selectable style={styles.codeText}>{block.text}</Text>
      </ScrollView>
    </View>
  );
}

function ListBlock({ block, depth }: { block: Extract<MarkdownBlock, { type: 'list' }>; depth: number }): React.JSX.Element {
  return (
    <View style={[styles.list, depth > 0 && styles.nestedList]}>
      {block.items.map((item, index) => (
        <View key={index}>
          <View style={styles.listRow}>
            <Text style={styles.bullet}>
              {item.checked !== undefined ? (item.checked ? '☑' : '☐') : block.ordered ? `${block.start + index}.` : depth > 0 ? '◦' : '•'}
            </Text>
            <Text selectable style={[styles.paragraph, styles.listText]}><Inline spans={item.children} /></Text>
          </View>
          {item.sublist ? <ListBlock block={item.sublist} depth={depth + 1} /> : null}
        </View>
      ))}
    </View>
  );
}

function TableBlock({ block }: { block: Extract<MarkdownBlock, { type: 'table' }> }): React.JSX.Element {
  const width = mobileScale(132);
  const alignment = (column: number): TextStyle => ({ textAlign: block.align[column] === 'right' ? 'right' : block.align[column] === 'center' ? 'center' : 'left' });
  return (
    <ScrollView horizontal nestedScrollEnabled style={styles.tableScroll}>
      <View style={styles.table}>
        <View style={[styles.tableRow, styles.tableHeader]}>
          {block.header.map((cell, column) => (
            <Text key={column} style={[styles.tableCell, styles.tableHeaderText, { width }, alignment(column)]}><Inline spans={cell} /></Text>
          ))}
        </View>
        {block.rows.map((row, rowIndex) => (
          <View key={rowIndex} style={styles.tableRow}>
            {row.map((cell, column) => (
              <Text key={column} selectable style={[styles.tableCell, { width }, alignment(column)]}><Inline spans={cell} /></Text>
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

function Blocks({ blocks, depth = 0 }: { blocks: readonly MarkdownBlock[]; depth?: number }): React.JSX.Element {
  return (
    <>
      {blocks.map((block, index) => {
        switch (block.type) {
          case 'heading':
            return (
              <Text key={index} accessibilityRole="header" style={[styles.heading, block.level <= 2 ? styles.h2 : styles.h3]}>
                <Inline spans={block.children} />
              </Text>
            );
          case 'paragraph':
            return <Text key={index} selectable style={styles.paragraph}><Inline spans={block.children} /></Text>;
          case 'code':
            return <CodeBlock key={index} block={block} />;
          case 'list':
            return <ListBlock key={index} block={block} depth={depth} />;
          case 'quote':
            return <View key={index} style={styles.quote}><Blocks blocks={block.blocks} depth={depth} /></View>;
          case 'table':
            return <TableBlock key={index} block={block} />;
          case 'rule':
            return <View key={index} style={styles.rule} />;
        }
      })}
    </>
  );
}

/** Agent text as formatted blocks. Parsing is memoised per text, so a streaming reply re-parses only as it grows. */
export function Markdown({ text }: { text: string }): React.JSX.Element {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  return <View style={styles.root}><Blocks blocks={blocks} /></View>;
}

/** Plain text of a message's markdown, for screen readers and previews. */
export function markdownPlainText(text: string): string {
  return parseBlocks(text)
    .map(block => (block.type === 'paragraph' || block.type === 'heading' ? inlineText(block.children) : block.type === 'code' ? block.text : ''))
    .filter(Boolean)
    .join('\n');
}

const styles = themedStyles(() => StyleSheet.create({
  root: { gap: mobileScale(8) },
  paragraph: { color: theme.text, fontSize: mobileScale(13), lineHeight: mobileScale(19) },
  heading: { color: theme.text, fontWeight: '700' },
  h2: { fontSize: mobileScale(15), lineHeight: mobileScale(21), marginTop: mobileScale(2) },
  h3: { fontSize: mobileScale(13.5), lineHeight: mobileScale(19) },
  strong: { fontWeight: '700' },
  em: { fontStyle: 'italic' },
  strike: { textDecorationLine: 'line-through', color: theme.textDim },
  link: { color: theme.accent, textDecorationLine: 'underline' },
  inlineCode: { fontFamily: MONOSPACE, fontSize: mobileScale(12), backgroundColor: theme.bgSunken, color: theme.text },
  code: { backgroundColor: theme.bgSunken, borderRadius: mobileScale(8), borderWidth: 1, borderColor: theme.border, paddingVertical: mobileScale(8) },
  codeLanguage: { color: theme.textDim, fontSize: mobileScale(10), fontWeight: '700', letterSpacing: 0.6, paddingHorizontal: mobileScale(10), paddingBottom: mobileScale(4), textTransform: 'uppercase' },
  codeText: { fontFamily: MONOSPACE, fontSize: mobileScale(12), lineHeight: mobileScale(17), color: theme.text, paddingHorizontal: mobileScale(10) },
  list: { gap: mobileScale(4) },
  nestedList: { marginLeft: mobileScale(18), marginTop: mobileScale(4) },
  listRow: { flexDirection: 'row', gap: mobileScale(8) },
  bullet: { color: theme.textDim, fontSize: mobileScale(13), lineHeight: mobileScale(19), minWidth: mobileScale(14) },
  listText: { flex: 1 },
  quote: { borderLeftWidth: 3, borderLeftColor: theme.borderStrong, paddingLeft: mobileScale(10), gap: mobileScale(6) },
  rule: { height: 1, backgroundColor: theme.border, marginVertical: mobileScale(4) },
  tableScroll: { flexGrow: 0 },
  table: { borderWidth: 1, borderColor: theme.border, borderRadius: mobileScale(6) },
  tableRow: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: theme.border },
  tableHeader: { backgroundColor: theme.bgSunken },
  tableCell: { color: theme.text, fontSize: mobileScale(12), lineHeight: mobileScale(17), paddingHorizontal: mobileScale(8), paddingVertical: mobileScale(6) },
  tableHeaderText: { fontWeight: '700' },
}));
