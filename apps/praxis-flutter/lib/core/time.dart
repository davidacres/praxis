// Times for people, from ISO-8601 instants. Port of `renderer/mobileTime.ts`.

final _iso = RegExp(r'^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})$');
const _months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/// Milliseconds since the epoch for an ISO-8601 instant, or null when it is not one.
int? parseInstant(String? value) {
  if (value == null || value.isEmpty) return null;
  final match = _iso.firstMatch(value.trim());
  if (match == null) return DateTime.tryParse(value)?.millisecondsSinceEpoch;
  final frac = (match.group(7) ?? '0').padRight(3, '0').substring(0, 3);
  var ms = DateTime.utc(
    int.parse(match.group(1)!),
    int.parse(match.group(2)!),
    int.parse(match.group(3)!),
    int.parse(match.group(4)!),
    int.parse(match.group(5)!),
    int.parse(match.group(6) ?? '0'),
    int.parse(frac),
  ).millisecondsSinceEpoch;
  final zone = match.group(8)!;
  if (zone != 'Z') {
    final sign = zone.startsWith('-') ? -1 : 1;
    final digits = zone.substring(1).replaceAll(':', '');
    ms -= sign * (int.parse(digits.substring(0, 2)) * 60 + int.parse(digits.substring(2, 4))) * 60000;
  }
  return ms;
}

String _pad(int n) => n.toString().padLeft(2, '0');

/// "14:05" in the phone's local time; empty when the instant cannot be read.
String formatClock(String? value) {
  final ms = parseInstant(value);
  if (ms == null) return '';
  final date = DateTime.fromMillisecondsSinceEpoch(ms);
  return '${_pad(date.hour)}:${_pad(date.minute)}';
}

/// "Sep 23, 14:05" in the phone's local time; null when the instant cannot be read.
String? formatDayAndClock(String? value) {
  final ms = parseInstant(value);
  if (ms == null) return null;
  final date = DateTime.fromMillisecondsSinceEpoch(ms);
  return '${_months[date.month - 1]} ${date.day}, ${_pad(date.hour)}:${_pad(date.minute)}';
}

/// The desktop validates `issuedAt` as `YYYY-MM-DDTHH:MM:SS.mmmZ` — milliseconds, not Dart's microseconds.
String isoNow() {
  final now = DateTime.now().toUtc();
  String p3(int n) => n.toString().padLeft(3, '0');
  return '${now.year.toString().padLeft(4, '0')}-${_pad(now.month)}-${_pad(now.day)}T${_pad(now.hour)}:${_pad(now.minute)}:${_pad(now.second)}.${p3(now.millisecond)}Z';
}
