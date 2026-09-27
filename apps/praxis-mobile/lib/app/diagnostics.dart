import 'package:flutter/foundation.dart';

import '../core/time.dart';

/// What went wrong talking to the desktop, kept where a person can see it — a
/// background refresh that fails must not leave stale data looking current.
/// Port of `app/diagnostics.ts` + `renderer/mobileDiagnostics.ts`.
class DiagnosticEntry {
  const DiagnosticEntry(this.at, this.what, this.message);
  final String at;
  final String what;
  final String message;
}

const maxDiagnostics = 50;

class Diagnostics extends ChangeNotifier {
  Diagnostics._();
  static final Diagnostics instance = Diagnostics._();

  List<DiagnosticEntry> _entries = const [];
  String? _lastOkAt;
  ({String what, String message, String since})? _failing;

  List<DiagnosticEntry> get entries => _entries;

  static String messageOf(Object? error) {
    if (error == null) return 'Unknown error';
    final text = error.toString().replaceFirst(RegExp(r'^(Exception|Bad state|StateError): '), '');
    return text.isEmpty ? 'Unknown error' : text;
  }

  void record(String what, Object? error) {
    _entries = [DiagnosticEntry(isoNow(), what, messageOf(error)), ..._entries].take(maxDiagnostics).toList();
    notifyListeners();
  }

  void refreshFailed(String what, Object? error) {
    final message = messageOf(error);
    final failing = _failing;
    _failing = failing == null ? (what: what, message: message, since: isoNow()) : (what: what, message: message, since: failing.since);
    _entries = [DiagnosticEntry(isoNow(), what, message), ..._entries].take(maxDiagnostics).toList();
    notifyListeners();
  }

  void refreshSucceeded() {
    final wasFailing = _failing != null;
    _failing = null;
    _lastOkAt = isoNow();
    if (wasFailing) notifyListeners();
  }

  void clear() {
    _entries = const [];
    _failing = null;
    _lastOkAt = null;
    notifyListeners();
  }

  /// One line for the banner: what failed, and how old the shown data is.
  String? get staleness {
    final failing = _failing;
    if (failing == null) return null;
    final age = _lastOkAt != null ? ' Showing what was last received at ${formatClock(_lastOkAt)}.' : '';
    return '${failing.what} failed: ${failing.message}.$age';
  }
}
