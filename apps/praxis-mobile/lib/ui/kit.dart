import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../app/diagnostics.dart';
import '../app/store.dart';
import '../app/theme.dart';
import '../core/workflow_runs.dart';

/// Text in the app's scale. [lineHeight] is in points, as React Native writes it.
TextStyle ts(
  BuildContext context,
  double size, {
  Color? color,
  FontWeight weight = FontWeight.w400,
  double? lineHeight,
  double? letterSpacing,
  FontStyle? style,
  bool scaled = true,
  String? family,
  TextDecoration? decoration,
  List<FontFeature>? features,
}) {
  final t = context.t;
  final fontSize = scaled ? size * t.scale : size;
  return TextStyle(
    fontSize: fontSize,
    color: color ?? t.palette.text,
    fontWeight: weight,
    // With no lineHeight, CoreText's line box for SF: ascent + descent, no leading.
    height: lineHeight == null ? 1.1777 : (scaled ? lineHeight * t.scale : lineHeight) / fontSize,
    letterSpacing: letterSpacing ?? sfTracking(fontSize, weight),
    fontStyle: style,
    fontFamily: family,
    decoration: decoration,
    decorationColor: color ?? t.palette.text,
    fontFeatures: features,
  );
}

/// SF's size-specific tracking, which CoreText applies to the system font and
/// Flutter does not: measured on the simulator as CoreText width minus Flutter
/// width per glyph (points), regular and bold. React Native's letterSpacing
/// replaces it, so an explicit letterSpacing is used as-is.
const _trackingRegular = [0.203, 0.167, 0.117, 0.064, 0.0, -0.076, -0.150, -0.234, -0.312, -0.432, -0.484, -0.540, -0.708, -0.799, -0.894, -0.950, -1.007];
const _trackingBold = [0.203, 0.167, 0.117, 0.064, 0.0, -0.076, -0.150, -0.234, -0.312, -0.432, -0.480, -0.532, -0.686, -0.761, -0.839, -0.876, -0.913];

double sfTracking(double size, FontWeight weight) {
  double at(List<double> table) {
    final position = (size - 8).clamp(0, table.length - 1).toDouble();
    final low = position.floor();
    final high = (low + 1).clamp(0, table.length - 1);
    return table[low] + (table[high] - table[low]) * (position - low);
  }

  final boldness = ((weight.value - 400) / 300).clamp(0.0, 1.0);
  return at(_trackingRegular) * (1 - boldness) + at(_trackingBold) * boldness;
}

const monospace = 'Menlo';
const tabular = [FontFeature.tabularFigures()];

/// A tappable area with a pressed state and an accessibility label — React Native's Pressable.
class Pressable extends StatefulWidget {
  const Pressable({
    super.key,
    required this.builder,
    this.onTap,
    this.label,
    this.hint,
    this.button = true,
    this.selected,
    this.enabled = true,
    this.excludeChildSemantics = false,
  });

  final Widget Function(BuildContext context, bool pressed) builder;
  final VoidCallback? onTap;
  final String? label;
  final String? hint;
  final bool button;
  final bool? selected;
  final bool enabled;
  final bool excludeChildSemantics;

  @override
  State<Pressable> createState() => _PressableState();
}

class _PressableState extends State<Pressable> {
  bool _pressed = false;

  void _set(bool value) {
    if (_pressed != value && mounted) setState(() => _pressed = value);
  }

  @override
  Widget build(BuildContext context) {
    final active = widget.enabled && widget.onTap != null;
    return Semantics(
      container: true,
      button: widget.button,
      enabled: active,
      selected: widget.selected,
      label: widget.label,
      hint: widget.hint,
      excludeSemantics: widget.excludeChildSemantics,
      onTap: active ? widget.onTap : null,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTapDown: active ? (_) => _set(true) : null,
        onTapUp: active ? (_) => _set(false) : null,
        onTapCancel: active ? () => _set(false) : null,
        onTap: active ? widget.onTap : null,
        child: widget.builder(context, _pressed),
      ),
    );
  }
}

class ScreenScroll extends StatelessWidget {
  const ScreenScroll({super.key, required this.children});
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    return ColoredBox(
      color: t.palette.bg,
      child: ListView(
        padding: EdgeInsets.all(t.space),
        children: [
          for (var i = 0; i < children.length; i += 1) ...[if (i > 0) SizedBox(height: t.space), children[i]],
        ],
      ),
    );
  }
}

class PraxisCard extends StatelessWidget {
  const PraxisCard({super.key, required this.children, this.gap = 8, this.borderColor});
  final List<Widget> children;
  final double gap;
  final Color? borderColor;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    return Container(
      width: double.infinity,
      padding: EdgeInsets.all(t.space),
      decoration: BoxDecoration(
        color: t.palette.surface,
        borderRadius: BorderRadius.circular(t.radius),
        border: Border.all(color: borderColor ?? t.palette.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (var i = 0; i < children.length; i += 1) ...[if (i > 0) SizedBox(height: gap), children[i]],
        ],
      ),
    );
  }
}

class H1 extends StatelessWidget {
  const H1(this.text, {super.key, this.align});
  final String text;
  final TextAlign? align;
  @override
  Widget build(BuildContext context) => Text(
    text,
    textAlign: align,
    style: ts(context, 22, weight: FontWeight.w700),
  );
}

class Body extends StatelessWidget {
  const Body(this.text, {super.key, this.dim = false, this.align});
  final String text;
  final bool dim;
  final TextAlign? align;
  @override
  Widget build(BuildContext context) => Text(
    text,
    textAlign: align,
    style: ts(context, 15, lineHeight: 21, color: dim ? context.p.textDim : context.p.text),
  );
}

enum Tone { neutral, ok, warn, danger }

Color toneOf(BuildContext context, Tone tone) => switch (tone) {
  Tone.ok => context.p.ok,
  Tone.warn => context.p.warn,
  Tone.danger => context.p.danger,
  Tone.neutral => context.p.textDim,
};

class Pill extends StatelessWidget {
  const Pill(this.label, {super.key, this.tone = Tone.neutral});
  final String label;
  final Tone tone;
  @override
  Widget build(BuildContext context) {
    final color = toneOf(context, tone);
    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        padding: EdgeInsets.symmetric(horizontal: context.t.s(10), vertical: context.t.s(3)),
        decoration: BoxDecoration(
          border: Border.all(color: color),
          borderRadius: BorderRadius.circular(999),
        ),
        child: Text(
          label,
          style: ts(context, 12, weight: FontWeight.w600, color: color),
        ),
      ),
    );
  }
}

class PraxisButton extends StatelessWidget {
  const PraxisButton({super.key, required this.label, required this.onPressed, this.ghost = false, this.disabled = false, this.expand = true});
  final String label;
  final VoidCallback? onPressed;
  final bool ghost;
  final bool disabled;
  final bool expand;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    return Pressable(
      label: label,
      enabled: !disabled,
      onTap: onPressed,
      excludeChildSemantics: true,
      builder: (context, pressed) => Opacity(
        opacity: disabled
            ? 0.45
            : pressed
            ? 0.7
            : 1,
        child: Container(
          width: expand ? double.infinity : null,
          constraints: BoxConstraints(minHeight: t.s(46)),
          padding: EdgeInsets.symmetric(vertical: t.s(12), horizontal: t.s(16)),
          alignment: expand ? Alignment.center : null,
          decoration: BoxDecoration(
            color: ghost ? Colors.transparent : t.palette.accent,
            borderRadius: BorderRadius.circular(t.s(10)),
            border: ghost ? Border.all(color: t.palette.border) : null,
          ),
          child: expand
              ? Text(
                  label,
                  style: ts(context, 15, weight: FontWeight.w700, color: ghost ? t.palette.text : t.palette.onAccent),
                )
              : Align(
                  widthFactor: 1,
                  child: Text(
                    label,
                    style: ts(context, 15, weight: FontWeight.w700, color: ghost ? t.palette.text : t.palette.onAccent),
                  ),
                ),
        ),
      ),
    );
  }
}

class Spinner extends StatelessWidget {
  const Spinner({super.key, this.color, this.small = true});
  final Color? color;
  final bool small;
  @override
  Widget build(BuildContext context) => SizedBox(
    width: small ? 20 : 36,
    height: small ? 20 : 36,
    child: CupertinoActivityIndicator(color: color ?? context.p.textDim, radius: small ? 9 : 16),
  );
}

/// The real connection state: live, reconnecting, or offline. Tapping retries.
class ConnectionBadge extends StatelessWidget {
  const ConnectionBadge({super.key});

  @override
  Widget build(BuildContext context) {
    final store = context.watch<AppStore>();
    final state = store.connection;
    final p = context.p;
    final tone = state == ShellConnection.ready
        ? p.ok
        : state == ShellConnection.reconnecting
        ? p.warn
        : p.danger;
    final label = state == ShellConnection.ready
        ? 'LIVE'
        : state == ShellConnection.reconnecting
        ? 'RECONNECTING'
        : 'OFFLINE';
    final issue = store.connectionIssue;
    return Pressable(
      label: state == ShellConnection.ready
          ? 'Connected to the desktop'
          : '${label.toLowerCase()}${issue != null ? ': ${issue.message}' : ''}. Tap to retry now.',
      enabled: state != ShellConnection.ready,
      onTap: store.retryConnection,
      excludeChildSemantics: true,
      builder: (context, _) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 6,
              height: 6,
              decoration: BoxDecoration(color: tone, shape: BoxShape.circle),
            ),
            const SizedBox(width: 5),
            Text(
              label,
              style: ts(context, 9, scaled: false, weight: FontWeight.w700, color: p.textDim, letterSpacing: 0.6),
            ),
          ],
        ),
      ),
    );
  }
}

class MenuButton extends StatelessWidget {
  const MenuButton({super.key, required this.onTap, this.size = 32, this.radius = 7, this.glyph = 17});
  final VoidCallback onTap;
  final double size;
  final double radius;
  final double glyph;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    return Pressable(
      label: 'Open navigation',
      onTap: onTap,
      excludeChildSemantics: true,
      builder: (context, pressed) => Opacity(
        opacity: pressed ? 0.7 : 1,
        child: Container(
          width: t.s(size),
          height: t.s(size),
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: t.palette.surface,
            borderRadius: BorderRadius.circular(t.s(radius)),
            border: Border.all(color: t.palette.border),
          ),
          child: Text(
            '☰',
            style: ts(context, glyph, color: t.palette.textSecondary, lineHeight: glyph + 2),
          ),
        ),
      ),
    );
  }
}

/// The Attention and Activity header: menu, title, connection state.
class AppHeader extends StatelessWidget {
  const AppHeader({super.key, required this.title, required this.onOpenSidebar});
  final String title;
  final VoidCallback onOpenSidebar;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    return Container(
      constraints: BoxConstraints(minHeight: t.s(52)),
      padding: EdgeInsets.symmetric(horizontal: t.s(12)),
      decoration: BoxDecoration(
        color: t.palette.bgSunken,
        border: Border(bottom: BorderSide(color: t.palette.border)),
      ),
      child: Row(
        children: [
          MenuButton(onTap: onOpenSidebar),
          SizedBox(width: t.s(10)),
          Expanded(
            child: Semantics(
              header: true,
              child: Text(title, style: ts(context, 15, weight: FontWeight.w700)),
            ),
          ),
          const ConnectionBadge(),
        ],
      ),
    );
  }
}

/// Shown while a background refresh is failing: what is on screen may be out of date.
class StaleBanner extends StatelessWidget {
  const StaleBanner({super.key});

  @override
  Widget build(BuildContext context) {
    final store = context.watch<AppStore>();
    final text = context.watch<Diagnostics>().staleness;
    if (text == null || store.connection != ShellConnection.ready) return const SizedBox.shrink();
    final t = context.t;
    return Pressable(
      label: '$text Tap to reconnect.',
      onTap: store.retryConnection,
      excludeChildSemantics: true,
      builder: (context, _) => Container(
        width: double.infinity,
        padding: EdgeInsets.symmetric(horizontal: t.s(12), vertical: t.s(8)),
        decoration: BoxDecoration(
          color: t.palette.warnSoft,
          border: Border(bottom: BorderSide(color: t.palette.warn)),
        ),
        child: Text('$text Tap to reconnect.', style: ts(context, 12.5, lineHeight: 18)),
      ),
    );
  }
}

Color runToneColor(BuildContext context, RunTone tone) => switch (tone) {
  RunTone.ok => context.p.ok,
  RunTone.warn => context.p.warn,
  RunTone.danger => context.p.danger,
  RunTone.live => context.p.accent,
  RunTone.neutral => context.p.textDim,
};

Color runToneBackground(BuildContext context, RunTone tone) => tone == RunTone.neutral ? context.p.surfaceRaised : runToneColor(context, tone);

class StatusPill extends StatelessWidget {
  const StatusPill({super.key, required this.label, required this.tone});
  final String label;
  final RunTone tone;
  @override
  Widget build(BuildContext context) {
    final color = runToneColor(context, tone);
    return Container(
      padding: EdgeInsets.symmetric(horizontal: context.t.s(8), vertical: context.t.s(2)),
      decoration: BoxDecoration(
        border: Border.all(color: color),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        label,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: ts(context, 10, weight: FontWeight.w700, color: color),
      ),
    );
  }
}

/// A modal sheet with the app's handle, rounded top and scrim.
Future<T?> showPraxisSheet<T>(BuildContext context, {required WidgetBuilder builder, double maxHeightFactor = 0.82}) {
  final p = context.p;
  return showModalBottomSheet<T>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    backgroundColor: Colors.transparent,
    barrierColor: p.scrim,
    constraints: BoxConstraints(maxHeight: MediaQuery.of(context).size.height * maxHeightFactor),
    builder: builder,
  );
}

class SheetFrame extends StatelessWidget {
  const SheetFrame({super.key, required this.child});
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final p = context.p;
    final bottom = MediaQuery.of(context).viewPadding.bottom;
    return Container(
      padding: EdgeInsets.fromLTRB(14, 8, 14, bottom > 16 ? bottom : 16),
      decoration: BoxDecoration(
        color: p.bgSunken,
        borderRadius: const BorderRadius.vertical(top: Radius.circular(18)),
        border: Border(
          top: BorderSide(color: p.borderStrong),
          left: BorderSide(color: p.borderStrong),
          right: BorderSide(color: p.borderStrong),
        ),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Center(
            child: Container(
              width: 42,
              height: 4,
              margin: const EdgeInsets.only(bottom: 12),
              decoration: BoxDecoration(color: p.borderStrong, borderRadius: BorderRadius.circular(2)),
            ),
          ),
          Flexible(child: child),
        ],
      ),
    );
  }
}

class SquareIconButton extends StatelessWidget {
  const SquareIconButton({super.key, required this.label, required this.glyph, required this.onTap, this.size = 34, this.glyphSize = 19});
  final String label;
  final String glyph;
  final VoidCallback onTap;
  final double size;
  final double glyphSize;

  @override
  Widget build(BuildContext context) {
    final p = context.p;
    return Pressable(
      label: label,
      onTap: onTap,
      excludeChildSemantics: true,
      builder: (context, pressed) => Container(
        width: size,
        height: size,
        alignment: Alignment.center,
        decoration: BoxDecoration(color: pressed ? p.surfaceRaised : p.surface, borderRadius: BorderRadius.circular(7)),
        child: Text(
          glyph,
          style: ts(context, glyphSize, scaled: false, weight: FontWeight.w300, color: p.textDim),
        ),
      ),
    );
  }
}
