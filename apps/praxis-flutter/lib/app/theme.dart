import 'dart:convert';

import 'package:flutter/widgets.dart';

import '../core/palette.dart';

/// The live theme: Praxis Dark until the paired desktop's appearance arrives,
/// then the desktop's, following it as it changes. Port of `app/theme.ts`.
class ThemeController extends ChangeNotifier {
  Appearance? _appearance;
  Palette _palette = Palette.praxisDark;
  String _displayMode = 'compact';

  Appearance? get appearance => _appearance;
  Palette get palette => _palette;
  String get displayMode => _displayMode;

  /// Wears [next] (or Praxis Dark for null); returns whether anything changed.
  bool applyAppearance(Appearance? next) {
    if (jsonEncode(next?.raw) == jsonEncode(_appearance?.raw)) return false;
    _appearance = next;
    _palette = next == null ? Palette.praxisDark : Palette.fromAppearance(next);
    notifyListeners();
    return true;
  }

  /// The person's preferred reading/control size; compact is the default.
  bool applyDisplayMode(String next) {
    if (_displayMode == next) return false;
    _displayMode = next;
    notifyListeners();
    return true;
  }

  PraxisThemeData get data => PraxisThemeData(
    palette: _palette,
    appearance: _appearance,
    displayMode: _displayMode,
    scale: _displayMode == 'large' ? 1.16 : 1,
    space: _displayMode == 'large' ? 20 : 16,
    radius: _displayMode == 'large' ? 12 : 10,
  );
}

@immutable
class PraxisThemeData {
  const PraxisThemeData({
    required this.palette,
    required this.appearance,
    required this.displayMode,
    required this.scale,
    required this.space,
    required this.radius,
  });
  final Palette palette;
  final Appearance? appearance;
  final String displayMode;
  final double scale;
  final double space;
  final double radius;

  /// Scales a dimension or type size for the large display mode.
  double s(double value) => (value * scale).roundToDouble();
}

class PraxisTheme extends InheritedWidget {
  const PraxisTheme({super.key, required this.data, required super.child});
  final PraxisThemeData data;

  static PraxisThemeData of(BuildContext context) => context.dependOnInheritedWidgetOfExactType<PraxisTheme>()!.data;

  @override
  bool updateShouldNotify(PraxisTheme oldWidget) =>
      oldWidget.data.palette != data.palette || oldWidget.data.scale != data.scale || oldWidget.data.appearance != data.appearance;
}

extension PraxisThemeContext on BuildContext {
  PraxisThemeData get t => PraxisTheme.of(this);
  Palette get p => PraxisTheme.of(this).palette;
}
