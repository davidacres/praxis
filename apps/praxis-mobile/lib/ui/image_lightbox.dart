import 'dart:typed_data';
import 'dart:ui';

import 'package:flutter/material.dart';

import '../app/theme.dart';
import 'kit.dart';

/// Shows an image expanded in a lightbox dialog with pinch-to-zoom,
/// double-tap zoom/reset, and accessible controls.
Future<void> showImageLightbox(
  BuildContext context, {
  required Uint8List bytes,
  String? caption,
  String? semanticLabel,
}) {
  final themeData = PraxisTheme.maybeOf(context);
  return showGeneralDialog<void>(
    context: context,
    barrierDismissible: true,
    barrierLabel: 'Dismiss',
    barrierColor: Colors.black.withValues(alpha: 0.8),
    transitionDuration: const Duration(milliseconds: 180),
    pageBuilder: (dialogContext, animation, secondaryAnimation) {
      Widget content = ImageLightbox(
        bytes: bytes,
        caption: caption,
        semanticLabel: semanticLabel,
      );
      if (themeData != null) {
        content = PraxisTheme(data: themeData, child: content);
      }
      return content;
    },
    transitionBuilder: (context, animation, secondaryAnimation, child) {
      final curved = CurvedAnimation(parent: animation, curve: Curves.easeOut);
      return FadeTransition(
        opacity: curved,
        child: ScaleTransition(
          scale: Tween<double>(begin: 0.96, end: 1.0).animate(curved),
          child: child,
        ),
      );
    },
  );
}

class ImageLightbox extends StatefulWidget {
  const ImageLightbox({
    super.key,
    required this.bytes,
    this.caption,
    this.semanticLabel,
  });

  final Uint8List bytes;
  final String? caption;
  final String? semanticLabel;

  @override
  State<ImageLightbox> createState() => _ImageLightboxState();
}

class _ImageLightboxState extends State<ImageLightbox> {
  final TransformationController _controller = TransformationController();
  double _scale = 1.0;
  Offset? _doubleTapPosition;

  @override
  void initState() {
    super.initState();
    _controller.addListener(_onTransformChanged);
  }

  @override
  void dispose() {
    _controller.removeListener(_onTransformChanged);
    _controller.dispose();
    super.dispose();
  }

  void _onTransformChanged() {
    final scale = _controller.value.getMaxScaleOnAxis();
    if ((scale - _scale).abs() > 0.05) {
      setState(() => _scale = scale);
    }
  }

  void _resetZoom() {
    setState(() {
      _controller.value = Matrix4.identity();
      _scale = 1.0;
    });
  }

  void _handleDoubleTap() {
    if (_scale > 1.05) {
      _resetZoom();
    } else {
      final size = MediaQuery.of(context).size;
      final center = _doubleTapPosition ?? Offset(size.width / 2, size.height / 2);
      final matrix = Matrix4.identity()
        ..translateByDouble(-center.dx * 1.5, -center.dy * 1.5, 0.0, 1.0)
        ..scaleByDouble(2.5, 2.5, 1.0, 1.0);
      setState(() {
        _controller.value = matrix;
        _scale = 2.5;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final p = context.p;
    final captionText = widget.caption?.trim();

    return Material(
      type: MaterialType.transparency,
      child: Stack(
        fit: StackFit.expand,
        children: [
          // Blurred, theme-tinted backdrop
          Positioned.fill(
            child: BackdropFilter(
              filter: ImageFilter.blur(sigmaX: 14, sigmaY: 14),
              child: ColoredBox(
                color: p.bg.withValues(alpha: 0.90),
              ),
            ),
          ),

          // Interactive viewer for zoom and pan
          Positioned.fill(
            child: GestureDetector(
              behavior: HitTestBehavior.translucent,
              onDoubleTapDown: (details) => _doubleTapPosition = details.localPosition,
              onDoubleTap: _handleDoubleTap,
              child: InteractiveViewer(
                transformationController: _controller,
                minScale: 0.5,
                maxScale: 6.0,
                boundaryMargin: EdgeInsets.all(t.s(60)),
                clipBehavior: Clip.none,
                child: Center(
                  child: Padding(
                    padding: EdgeInsets.symmetric(
                      horizontal: t.s(20),
                      vertical: t.s(64),
                    ),
                    child: ClipRRect(
                      borderRadius: BorderRadius.circular(t.s(8)),
                      child: DecoratedBox(
                        decoration: BoxDecoration(
                          border: Border.all(color: p.borderStrong),
                          borderRadius: BorderRadius.circular(t.s(8)),
                        ),
                        child: Image.memory(
                          widget.bytes,
                          fit: BoxFit.contain,
                          semanticLabel: widget.semanticLabel ?? captionText ?? 'Expanded image',
                          gaplessPlayback: true,
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),

          // Top bar: zoom reset (when zoomed) and close button
          Positioned(
            top: 0,
            left: 0,
            right: 0,
            child: SafeArea(
              bottom: false,
              child: Padding(
                padding: EdgeInsets.symmetric(horizontal: t.s(16), vertical: t.s(10)),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    if (_scale > 1.05)
                      Pressable(
                        label: 'Reset zoom',
                        onTap: _resetZoom,
                        builder: (context, pressed) => Container(
                          padding: EdgeInsets.symmetric(horizontal: t.s(12), vertical: t.s(6)),
                          decoration: BoxDecoration(
                            color: pressed ? p.surfaceRaised : p.surface,
                            borderRadius: BorderRadius.circular(t.s(16)),
                            border: Border.all(color: p.borderStrong),
                          ),
                          child: Text(
                            '${(_scale * 100).round()}% · Reset',
                            style: ts(context, 12, weight: FontWeight.w600, color: p.text),
                          ),
                        ),
                      )
                    else
                      const SizedBox.shrink(),
                    SquareIconButton(
                      label: 'Close image',
                      glyph: '×',
                      onTap: () => Navigator.of(context).pop(),
                    ),
                  ],
                ),
              ),
            ),
          ),

          // Bottom bar: caption/alt text if present
          if (captionText != null && captionText.isNotEmpty)
            Positioned(
              bottom: 0,
              left: 0,
              right: 0,
              child: SafeArea(
                top: false,
                child: Align(
                  alignment: Alignment.bottomCenter,
                  child: Padding(
                    padding: EdgeInsets.all(t.s(16)),
                    child: Container(
                      padding: EdgeInsets.symmetric(horizontal: t.s(14), vertical: t.s(8)),
                      decoration: BoxDecoration(
                        color: p.surface.withValues(alpha: 0.9),
                        borderRadius: BorderRadius.circular(t.s(8)),
                        border: Border.all(color: p.borderStrong),
                      ),
                      child: Text(
                        captionText,
                        maxLines: 3,
                        overflow: TextOverflow.ellipsis,
                        textAlign: TextAlign.center,
                        style: ts(context, 13, lineHeight: 18, color: p.text),
                      ),
                    ),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}
