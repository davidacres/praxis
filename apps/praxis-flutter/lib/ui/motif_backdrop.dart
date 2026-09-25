import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';

import '../app/theme.dart';
import '../core/palette.dart';
import 'kit.dart';

/// The desktop's motif behind the conversation — the same SVG the desktop
/// paints, at the same size and corners. With no motif on the desktop there is
/// none here; only a desktop too old to send its theme gets the stock
/// hexagons. Port of `MotifBackdrop` in `screens/WorkScreen.tsx`.
class MotifBackdrop extends StatelessWidget {
  const MotifBackdrop({super.key});

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final appearance = t.appearance;
    final motif = appearance?.motif;
    return Positioned.fill(
      child: ExcludeSemantics(
        child: IgnorePointer(
          child: ColoredBox(
            color: t.palette.bg,
            child: ClipRect(
              child: LayoutBuilder(
                builder: (context, box) {
                  if (motif != null) return _Layers(motif: motif, width: box.maxWidth, height: box.maxHeight);
                  if (appearance == null) return const _StockHexagons();
                  return const SizedBox.shrink();
                },
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _Layers extends StatelessWidget {
  const _Layers({required this.motif, required this.width, required this.height});
  final Motif motif;
  final double width;
  final double height;

  @override
  Widget build(BuildContext context) {
    if (width <= 0 || height <= 0) return const SizedBox.shrink();
    final scale = motifSpreadScale(motif, width, height);
    return Opacity(
      opacity: motif.opacity,
      child: Stack(
        children: [
          for (final layer in motif.layers)
            if (layer.anchor == 'center' || layer.repeat)
              Positioned.fill(
                child: SvgPicture.string(tiledMotifSvg(layer, width, height), width: width, height: height, fit: BoxFit.none, alignment: Alignment.topLeft),
              )
            else
              Builder(
                builder: (context) {
                  final corner = fitCornerMotifSvg(layer, scale);
                  final top = layer.anchor.startsWith('top');
                  final left = layer.anchor.endsWith('left');
                  final drawable = flattenMotifSvg(corner.svg);
                  Widget picture = SvgPicture.string(drawable.svg, width: corner.size, height: corner.size);
                  final fade = drawable.fade;
                  if (fade != null) {
                    picture = ShaderMask(blendMode: BlendMode.dstIn, shaderCallback: fade.createShader, child: picture);
                  }
                  return Positioned(
                    top: top ? 0 : null,
                    bottom: top ? null : 0,
                    left: left ? 0 : null,
                    right: left ? null : 0,
                    width: corner.size,
                    height: corner.size,
                    child: picture,
                  );
                },
              ),
        ],
      ),
    );
  }
}

final _pattern = RegExp(r'<pattern id="sp" width="([\d.]+)" height="([\d.]+)"[^>]*>([\s\S]*?)</pattern>');
final _filledRect = RegExp(r'<rect width="([\d.]+)" height="([\d.]+)" fill="url\(#sp\)"[^>]*/>');
final _gradient = RegExp(r'<linearGradient id="sf" x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)"[^>]*>([\s\S]*?)</linearGradient>');
final _stop = RegExp(r'<stop offset="([\d.]+)"[^>]*?stop-opacity="([\d.]+)"');

/// The desktop's corner lattice as flutter_svg can draw it: the `sp` pattern
/// expanded into plain tiles (a pattern is rasterised, so its lines go
/// jagged), and the `sm` fade mask returned as a gradient for a ShaderMask
/// (flutter_svg does not apply masks). An SVG in any other shape is unchanged.
({String svg, LinearGradient? fade}) flattenMotifSvg(String svg) {
  final pattern = _pattern.firstMatch(svg);
  final rect = _filledRect.firstMatch(svg);
  if (pattern == null || rect == null) return (svg: svg, fade: null);
  final tileW = double.parse(pattern.group(1)!);
  final tileH = double.parse(pattern.group(2)!);
  final width = double.parse(rect.group(1)!);
  final height = double.parse(rect.group(2)!);
  if (tileW < 4 || tileH < 4) return (svg: svg, fade: null);
  final tiles = StringBuffer('<g>');
  for (var y = 0.0; y < height; y += tileH) {
    for (var x = 0.0; x < width; x += tileW) {
      tiles.write('<g transform="translate(${x.toStringAsFixed(2)} ${y.toStringAsFixed(2)})">${pattern.group(3)}</g>');
    }
  }
  tiles.write('</g>');
  final flattened = svg
      .replaceFirst(rect.group(0)!, tiles.toString())
      .replaceFirst(pattern.group(0)!, '')
      .replaceAll(RegExp(r'<mask id="sm">[\s\S]*?</mask>'), '');

  LinearGradient? fade;
  final gradient = _gradient.firstMatch(svg);
  if (gradient != null && svg.contains('mask="url(#sm)"')) {
    final stops = _stop.allMatches(gradient.group(5)!).map((m) => (double.parse(m.group(1)!), double.parse(m.group(2)!))).toList();
    if (stops.length >= 2) {
      Alignment at(String x, String y) => Alignment(double.parse(x) * 2 - 1, double.parse(y) * 2 - 1);
      fade = LinearGradient(
        begin: at(gradient.group(1)!, gradient.group(2)!),
        end: at(gradient.group(3)!, gradient.group(4)!),
        colors: [for (final stop in stops) Colors.white.withValues(alpha: stop.$2)],
        stops: [for (final stop in stops) stop.$1],
      );
    }
  }
  return (svg: flattened, fade: fade);
}

/// The phone's own hexagons, for a desktop that predates sending its theme.
class _StockHexagons extends StatelessWidget {
  const _StockHexagons();

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final p = t.palette;
    final style = ts(context, 41, lineHeight: 48, letterSpacing: -3, color: p.accent.withValues(alpha: 0.09));
    return Stack(
      children: [
        OverflowBox(
          alignment: Alignment.topLeft,
          maxWidth: double.infinity,
          maxHeight: double.infinity,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              for (var row = 0; row < 17; row += 1)
                Transform.translate(
                  offset: Offset(row.isOdd ? 1 : -26, -5),
                  child: SizedBox(
                    height: t.s(48),
                    child: Text('⬡  ⬡  ⬡  ⬡  ⬡  ⬡  ⬡  ⬡  ⬡  ⬡  ⬡', maxLines: 1, softWrap: false, style: style),
                  ),
                ),
            ],
          ),
        ),
        Positioned.fill(child: ColoredBox(color: p.hexShade)),
      ],
    );
  }
}
