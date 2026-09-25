import 'package:flutter/material.dart';
import 'models/mobile_appearance.dart';

Color _parseColor(String hexColor) {
  final buffer = StringBuffer();
  if (!hexColor.startsWith('#')) buffer.write('#');
  buffer.write(hexColor);
  return Color(int.parse(buffer.toString().replaceFirst('#', '0xff')));
}

ThemeData buildTheme(MobileAppearance? appearance) {
  appearance ??= appearance?.mode == 'dark'
      ? MobileAppearance.defaultDark()
      : MobileAppearance.defaultLight();

  final isDark = appearance.mode == 'dark';
  final primaryColor = _parseColor(appearance.primaryColor);
  final backgroundColor = _parseColor(appearance.backgroundColor);
  final surfaceColor = _parseColor(appearance.surfaceColor);
  final textColor = _parseColor(appearance.textColor);
  final secondaryTextColor = _parseColor(appearance.secondaryTextColor);

  return ThemeData(
    useMaterial3: true,
    brightness: isDark ? Brightness.dark : Brightness.light,
    primaryColor: primaryColor,
    scaffoldBackgroundColor: backgroundColor,
    canvasColor: backgroundColor,
    cardColor: surfaceColor,
    colorScheme: ColorScheme(
      brightness: isDark ? Brightness.dark : Brightness.light,
      primary: primaryColor,
      onPrimary: isDark ? Colors.black : Colors.white,
      secondary: primaryColor.withAlpha(180),
      onSecondary: isDark ? Colors.black : Colors.white,
      error: isDark ? Colors.red[300]! : Colors.red[700]!,
      onError: Colors.white,
      background: backgroundColor,
      onBackground: textColor,
      surface: surfaceColor,
      onSurface: textColor,
      surfaceVariant: surfaceColor.withAlpha(200),
      onSurfaceVariant: secondaryTextColor,
    ),
    textTheme: TextTheme(
      displayLarge: TextStyle(color: textColor, fontSize: 32, fontWeight: FontWeight.bold),
      displayMedium: TextStyle(color: textColor, fontSize: 28, fontWeight: FontWeight.bold),
      displaySmall: TextStyle(color: textColor, fontSize: 24, fontWeight: FontWeight.bold),
      headlineMedium: TextStyle(color: textColor, fontSize: 22, fontWeight: FontWeight.bold),
      headlineSmall: TextStyle(color: textColor, fontSize: 20, fontWeight: FontWeight.w600),
      titleLarge: TextStyle(color: textColor, fontSize: 18, fontWeight: FontWeight.w600),
      titleMedium: TextStyle(color: textColor, fontSize: 16, fontWeight: FontWeight.w500),
      bodyLarge: TextStyle(color: textColor, fontSize: 16),
      bodyMedium: TextStyle(color: textColor, fontSize: 14),
      bodySmall: TextStyle(color: secondaryTextColor, fontSize: 12),
      labelSmall: TextStyle(color: secondaryTextColor, fontSize: 11),
    ),
    appBarTheme: AppBarTheme(
      backgroundColor: backgroundColor,
      foregroundColor: textColor,
      elevation: 0,
      centerTitle: false,
      titleTextStyle: TextStyle(color: textColor, fontSize: 18, fontWeight: FontWeight.w600),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: surfaceColor,
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(8),
        borderSide: BorderSide(color: secondaryTextColor.withAlpha(100)),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(8),
        borderSide: BorderSide(color: secondaryTextColor.withAlpha(100)),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(8),
        borderSide: BorderSide(color: primaryColor),
      ),
      hintStyle: TextStyle(color: secondaryTextColor),
      contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
    ),
    elevatedButtonTheme: ElevatedButtonThemeData(
      style: ElevatedButton.styleFrom(
        backgroundColor: primaryColor,
        foregroundColor: isDark ? Colors.black : Colors.white,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      ),
    ),
    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(
        foregroundColor: primaryColor,
      ),
    ),
  );
}
