import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';

/// Thin-stroke icon set matching desktop Praxis `Icon.tsx` (VS Code codicon idiom).
/// Every icon is rendered on a 16x16 grid with uniform stroke and clean vector paths.
class AppIcon extends StatelessWidget {
  const AppIcon(
    this.name, {
    super.key,
    this.size = 14,
    this.color,
    this.strokeWidth = 1.3,
  });

  final String name;
  final double size;
  final Color? color;
  final double strokeWidth;

  static const _paths = <String, dynamic>{
    // controls & general
    'play': 'M5.6 3.7 12 8l-6.4 4.3z',
    'chevron-down': 'M4.2 6.3 8 10.1l3.8-3.8',
    'chevron-right': 'M6.3 4.2 10.1 8l-3.8 3.8',
    'chevron-up': 'M4.2 9.7 8 5.9l3.8 3.8',
    'plus': 'M8 3.4v9.2M3.4 8h9.2',
    'close': 'M4.2 4.2 11.8 11.8M11.8 4.2 4.2 11.8',
    'check': 'M3.2 8.4 6.6 11.8 12.8 4.4',
    'warning': ['M8 1.7 14.2 13H1.8z', 'M8 5.3v4.1M8 11.6v.1'],
    'info': ['M8 1.9a6.1 6.1 0 1 0 0 12.2A6.1 6.1 0 0 0 8 1.9z', 'M8 7.2v4M8 4.9v.1'],
    'shield': 'M8 1.9 13 3.7v4c0 3-2.1 5.3-5 6.4-2.9-1.1-5-3.4-5-6.4v-4z',
    'gear': [
      'M8 3a5 5 0 1 0 0 10A5 5 0 0 0 8 3z',
      'M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.42 1.42M11.53 11.53l1.42 1.42M12.95 3.05l-1.42 1.42M4.47 11.53l-1.42 1.42',
      'M8 5.7a2.3 2.3 0 1 0 0 4.6 2.3 2.3 0 0 0 0-4.6z'
    ],
    'server': ['M2.4 2.6h11.2v3.4H2.4zM2.4 10h11.2v3.4H2.4z', 'M4.6 4.3h.1M4.6 11.7h.1'],
    'radio-tower': [
      'M4.3 4.3a5 5 0 0 0 0 7.4M11.7 4.3a5 5 0 0 1 0 7.4',
      'M6 6.1a2.6 2.6 0 0 0 0 3.8M10 6.1a2.6 2.6 0 0 1 0 3.8'
    ],
    'chats': ['M1.9 3.4h8.4v5.6H5.1L2.6 11.1V9H1.9z', 'M6.2 5.3h7.9v5.6h-.7v2.1l-2.5-2.1H8.4'],
    'folder':
        'M1.6 12.4V3.9a1 1 0 0 1 1-1h3.1a1 1 0 0 1 .8.4l.9 1.2a1 1 0 0 0 .8.4h4.2a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H2.6a1 1 0 0 1-1-1z',
    'search': ['M7.2 2.6a4.6 4.6 0 1 0 0 9.2 4.6 4.6 0 0 0 0-9.2z', 'M10.6 10.6 14 14'],
  };

  static const _filled = {'play'};

  @override
  Widget build(BuildContext context) {
    final raw = _paths[name];
    if (raw == null) {
      return SizedBox(width: size, height: size);
    }

    final isFill = _filled.contains(name);
    final effectiveColor = color ?? IconTheme.of(context).color ?? Colors.white;
    final hexColor = '#${(effectiveColor.toARGB32() & 0x00FFFFFF).toRadixString(16).padLeft(6, '0')}';
    final opacity = effectiveColor.a;

    final pathList = raw is List ? raw : [raw];
    final buffer = StringBuffer(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="$size" height="$size" '
      'fill="${isFill ? hexColor : 'none'}" '
      'stroke="${isFill ? 'none' : hexColor}" '
      'stroke-width="$strokeWidth" stroke-linecap="round" stroke-linejoin="round" '
      '${opacity < 1.0 ? 'stroke-opacity="$opacity" fill-opacity="$opacity" ' : ''}>',
    );
    for (final p in pathList) {
      buffer.write('<path d="$p"/>');
    }
    buffer.write('</svg>');

    return SvgPicture.string(
      buffer.toString(),
      width: size,
      height: size,
    );
  }
}
