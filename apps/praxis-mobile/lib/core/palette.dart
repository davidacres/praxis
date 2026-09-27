import 'dart:math';
import 'dart:ui';

// The phone palette derived from the desktop's theme, and the motif helpers.
// Port of `renderer/mobileTheme.ts`.

class Motif {
  const Motif({required this.opacity, required this.layers, this.viewport});
  final double opacity;
  final List<MotifLayer> layers;
  final Size? viewport;
}

class MotifLayer {
  const MotifLayer({required this.svg, required this.width, required this.height, required this.anchor, required this.repeat});
  final String svg;
  final double width;
  final double height;
  final String anchor;
  final bool repeat;
}

class Appearance {
  const Appearance({required this.themeId, required this.themeName, required this.mode, required this.colors, this.motif, required this.raw});
  final String themeId;
  final String themeName;
  final String mode;
  final Map<String, String> colors;
  final Motif? motif;

  /// As received, so it can be saved and compared.
  final Map<String, dynamic> raw;
}

const colorKeys = [
  'bg',
  'bgElevated',
  'bgSunken',
  'bgInput',
  'border',
  'borderStrong',
  'text',
  'textSecondary',
  'textTertiary',
  'accent',
  'accentContrast',
  'success',
  'warning',
  'danger',
];
final _hex = RegExp(r'^#[0-9a-f]{6}$');
const _anchors = ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center'];

/// A well-formed desktop appearance, or null — anything else is dropped rather than painted.
Appearance? readMobileAppearance(Object? value) {
  if (value is! Map<String, dynamic>) return null;
  final themeId = value['themeId'];
  final mode = value['mode'];
  if (themeId is! String || themeId.isEmpty) return null;
  if (mode != 'light' && mode != 'dark') return null;
  final colors = value['colors'];
  if (colors is! Map) return null;
  final picked = <String, String>{};
  for (final key in colorKeys) {
    final color = colors[key];
    if (color is! String || !_hex.hasMatch(color)) return null;
    picked[key] = color;
  }
  final themeName = value['themeName'];
  return Appearance(
    themeId: themeId,
    themeName: themeName is String && themeName.isNotEmpty ? themeName : themeId,
    mode: mode as String,
    colors: picked,
    motif: _readMotif(value['motif']),
    raw: value,
  );
}

Motif? _readMotif(Object? value) {
  if (value is! Map) return null;
  final opacity = value['opacity'];
  final layers = value['layers'];
  if (opacity is! num || !(opacity > 0) || layers is! List) return null;
  bool size(Object? n) => n is num && n.isFinite && n >= 1 && n <= 4000;
  final read = <MotifLayer>[];
  for (final layer in layers.take(4)) {
    if (layer is! Map) return null;
    final svg = layer['svg'];
    if (svg is! String || !svg.startsWith('<svg') || svg.length > 200000) return null;
    if (!_anchors.contains(layer['anchor']) || !size(layer['width']) || !size(layer['height'])) return null;
    read.add(
      MotifLayer(
        svg: svg,
        width: (layer['width'] as num).toDouble(),
        height: (layer['height'] as num).toDouble(),
        anchor: layer['anchor'] as String,
        repeat: layer['repeat'] == true,
      ),
    );
  }
  final viewport = value['viewport'];
  Size? fits;
  if (viewport is Map) {
    final w = viewport['width'];
    final h = viewport['height'];
    if (w is num && h is num && w >= 100 && w <= 10000 && h >= 100 && h <= 10000) fits = Size(w.toDouble(), h.toDouble());
  }
  return read.isEmpty ? null : Motif(opacity: min(1, opacity.toDouble()), layers: read, viewport: fits);
}

/// How far to shrink a corner motif's spread on a screen of [width] × [height].
double motifSpreadScale(Motif motif, double width, double height) {
  final viewport = motif.viewport;
  if (viewport == null || width <= 0 || height <= 0) return 1;
  final ratio = (width + height) / (viewport.width + viewport.height);
  return min(1, max(0.2, ratio));
}

String _num(double value) => value == value.roundToDouble() ? value.toInt().toString() : value.toString();

/// A corner layer redrawn with a smaller spread; the repeating cell keeps its size.
({String svg, double size}) fitCornerMotifSvg(MotifLayer layer, double scale) {
  final size = (layer.width * scale).roundToDouble();
  if (scale >= 1) return (svg: layer.svg, size: layer.width);
  final s = _num(size);
  if (!layer.svg.contains('id="sp"')) {
    return (
      svg: layer.svg.replaceFirstMapped(RegExp(r'^<svg([^>]*?) width="[\d.]+" height="[\d.]+"'), (m) => '<svg${m[1]} width="$s" height="$s"'),
      size: size,
    );
  }
  final spread = _num(layer.width);
  final svg = layer.svg
      .replaceAll('viewBox="0 0 $spread $spread"', 'viewBox="0 0 $s $s"')
      .split('width="$spread" height="$spread"')
      .join('width="$s" height="$s"');
  return (svg: svg, size: size);
}

/// A repeating layer as one SVG covering [width] × [height].
String tiledMotifSvg(MotifLayer layer, double width, double height) {
  final inner = layer.svg.replaceFirst(RegExp(r'^<svg[^>]*>'), '').replaceFirst(RegExp(r'</svg>\s*$'), '');
  final w = _num(width);
  final h = _num(height);
  return '<svg xmlns="http://www.w3.org/2000/svg" width="$w" height="$h">'
      '<defs><pattern id="mt" width="${_num(layer.width)}" height="${_num(layer.height)}" patternUnits="userSpaceOnUse">$inner</pattern></defs>'
      '<rect width="$w" height="$h" fill="url(#mt)"/></svg>';
}

Color hexColor(String hex) => Color(int.parse('ff${hex.substring(1)}', radix: 16));

List<int> _channels(String hex) => [
  int.parse(hex.substring(1, 3), radix: 16),
  int.parse(hex.substring(3, 5), radix: 16),
  int.parse(hex.substring(5, 7), radix: 16),
];

/// [amount] of [top] over [base], as `#rrggbb`.
String mixHex(String base, String top, double amount) {
  final a = _channels(base);
  final b = _channels(top);
  return '#${List.generate(3, (i) => (a[i] + (b[i] - a[i]) * amount).round().toRadixString(16).padLeft(2, '0')).join()}';
}

Color _withAlpha(String hex, double alpha) {
  final c = _channels(hex);
  return Color.fromRGBO(c[0], c[1], c[2], alpha);
}

/// Every colour the phone paints with. The desktop's theme is mapped onto these names.
class Palette {
  const Palette({
    required this.dark,
    required this.bg,
    required this.bgSunken,
    required this.surface,
    required this.surfaceRaised,
    required this.input,
    required this.userMessage,
    required this.assistantMessage,
    required this.border,
    required this.borderStrong,
    required this.text,
    required this.textSecondary,
    required this.textDim,
    required this.accent,
    required this.accentSoft,
    required this.accentMuted,
    required this.ok,
    required this.warn,
    required this.danger,
    required this.chrome,
    required this.hexShade,
    required this.scrim,
    required this.warnSoft,
    required this.dangerSoft,
    required this.camera,
    required this.onAccent,
  });

  final bool dark;
  final Color bg, bgSunken, surface, surfaceRaised, input, userMessage, assistantMessage, border, borderStrong;
  final Color text, textSecondary, textDim, accent, accentSoft, accentMuted, ok, warn, danger;
  final Color chrome, hexShade, scrim, warnSoft, dangerSoft, camera, onAccent;

  factory Palette.fromColors(Map<String, String> c, {required bool light}) => Palette(
    dark: !light,
    bg: hexColor(c['bg']!),
    bgSunken: hexColor(c['bgSunken']!),
    surface: hexColor(c['bgElevated']!),
    surfaceRaised: hexColor(mixHex(c['bgElevated']!, c['text']!, light ? 0.05 : 0.07)),
    input: hexColor(c['bgInput']!),
    userMessage: hexColor(mixHex(c['bgElevated']!, c['accent']!, light ? 0.12 : 0.2)),
    assistantMessage: hexColor(c['bgElevated']!),
    border: hexColor(c['border']!),
    borderStrong: hexColor(c['borderStrong']!),
    text: hexColor(c['text']!),
    textSecondary: hexColor(c['textSecondary']!),
    textDim: hexColor(c['textTertiary']!),
    accent: hexColor(c['accent']!),
    accentSoft: hexColor(mixHex(c['bg']!, c['accent']!, light ? 0.12 : 0.2)),
    accentMuted: hexColor(mixHex(c['bg']!, c['accent']!, light ? 0.3 : 0.5)),
    ok: hexColor(c['success']!),
    warn: hexColor(c['warning']!),
    danger: hexColor(c['danger']!),
    chrome: _withAlpha(c['bgSunken']!, 0.95),
    hexShade: _withAlpha(c['bgSunken']!, light ? 0.35 : 0.18),
    scrim: light ? const Color.fromRGBO(0, 0, 0, 0.38) : const Color.fromRGBO(0, 0, 0, 0.62),
    warnSoft: hexColor(mixHex(c['bg']!, c['warning']!, light ? 0.14 : 0.2)),
    dangerSoft: hexColor(mixHex(c['bg']!, c['danger']!, light ? 0.12 : 0.2)),
    camera: const Color(0xff000000),
    onAccent: hexColor(c['accentContrast']!),
  );

  factory Palette.fromAppearance(Appearance appearance) => Palette.fromColors(appearance.colors, light: appearance.mode == 'light');

  /// What the phone wears before it has ever heard from a desktop: Praxis Dark.
  static final Palette praxisDark = Palette.fromColors(const {
    'bg': '#100e0b',
    'bgElevated': '#2c2620',
    'bgSunken': '#0b0907',
    'bgInput': '#211c17',
    'border': '#443a30',
    'borderStrong': '#6c5b4a',
    'text': '#f0e7d8',
    'textSecondary': '#cdbfae',
    'textTertiary': '#958878',
    'accent': '#c6431f',
    'accentContrast': '#fffdf8',
    'success': '#3fb950',
    'warning': '#d29922',
    'danger': '#e2766d',
  }, light: false);
}
