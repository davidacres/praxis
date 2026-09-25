class MobileAppearance {
  final String name;
  final String mode; // 'light', 'dark'
  final String primaryColor;
  final String backgroundColor;
  final String surfaceColor;
  final String textColor;
  final String secondaryTextColor;

  MobileAppearance({
    required this.name,
    required this.mode,
    required this.primaryColor,
    required this.backgroundColor,
    required this.surfaceColor,
    required this.textColor,
    required this.secondaryTextColor,
  });

  factory MobileAppearance.fromJson(Map<String, dynamic> json) =>
      MobileAppearance(
        name: json['name'] ?? 'default',
        mode: json['mode'] ?? 'light',
        primaryColor: json['primaryColor'] ?? '#007AFF',
        backgroundColor: json['backgroundColor'] ?? '#FFFFFF',
        surfaceColor: json['surfaceColor'] ?? '#F2F2F7',
        textColor: json['textColor'] ?? '#000000',
        secondaryTextColor: json['secondaryTextColor'] ?? '#666666',
      );

  static MobileAppearance defaultLight() => MobileAppearance(
    name: 'default',
    mode: 'light',
    primaryColor: '#007AFF',
    backgroundColor: '#FFFFFF',
    surfaceColor: '#F2F2F7',
    textColor: '#000000',
    secondaryTextColor: '#666666',
  );

  static MobileAppearance defaultDark() => MobileAppearance(
    name: 'default',
    mode: 'dark',
    primaryColor: '#0A84FF',
    backgroundColor: '#000000',
    surfaceColor: '#1C1C1E',
    textColor: '#FFFFFF',
    secondaryTextColor: '#A0A0A0',
  );
}
