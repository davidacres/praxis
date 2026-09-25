import 'dart:convert';

import 'models.dart';

// What the phone decides about a gadget before drawing it. Port of
// `renderer/mobileGadgets.ts`.

const mobileGadgetKinds = ['choice', 'confirmation', 'form', 'table', 'chart', 'progress', 'diff', 'artifact', 'handoff', 'conflict', 'approval'];

bool canDrawGadget(GadgetEnvelope gadget) => gadget.version == 1 && mobileGadgetKinds.contains(gadget.kind);

/// Answerable now: the host says it is active and no answer has settled it.
bool isGadgetAnswerable(GadgetView view) {
  if (view.state != 'active') return false;
  return !(view.resultStatus == 'completed' || view.resultStatus == 'accepted');
}

String? inertGadgetReason(GadgetView view) {
  if (isGadgetAnswerable(view)) return null;
  final message = view.resultMessage;
  if (message != null && message.isNotEmpty) return message;
  return switch (view.state) {
    'submitted' || 'completed' => 'Answered.',
    'submitting' => 'Sending your answer…',
    'expired' => 'This question expired.',
    'superseded' => 'A newer question replaced this one.',
    'revoked' => 'The desktop withdrew this question.',
    'disconnected' => 'Reconnect to the desktop to answer.',
    _ => 'Answered.',
  };
}

/// An answer that approves or changes something, or is marked dangerous, is confirmed with Face ID first.
bool answerNeedsIdentity(GadgetActionDescriptor? descriptor) {
  if (descriptor == null) return false;
  return descriptor.effect != 'informational' || descriptor.danger;
}

typedef FormValues = Map<String, Object>;

List<Json> formFields(Json payload) => (payload['fields'] as List? ?? const []).whereType<Json>().toList();

FormValues initialFormValues(Json payload) {
  final values = <String, Object>{};
  for (final field in formFields(payload)) {
    final name = field['name'] as String? ?? '';
    final value = field['defaultValue'];
    if (field['type'] == 'boolean') {
      values[name] = value == true;
    } else {
      values[name] = value == null ? '' : _plain(value as Object);
    }
  }
  return values;
}

String _plain(Object value) => value is double && value == value.roundToDouble() ? value.toInt().toString() : value.toString();

String? _fieldError(Json field, Object? raw) {
  if (field['type'] == 'boolean') return null;
  final label = field['label'] as String? ?? '';
  final text = raw is String ? raw.trim() : '';
  if (text.isEmpty) return field['required'] == true ? '$label is required.' : null;
  final maxLength = field['maxLength'];
  if (maxLength is num && text.length > maxLength) return '$label must be at most ${maxLength.toInt()} characters.';
  if (field['type'] == 'number') {
    final value = double.tryParse(text);
    if (value == null || !value.isFinite) return '$label must be a number.';
    final min = field['min'];
    final max = field['max'];
    if (min is num && value < min) return '$label must be at least ${_plain(min)}.';
    if (max is num && value > max) return '$label must be at most ${_plain(max)}.';
  }
  if (field['type'] == 'select') {
    final options = (field['options'] as List? ?? const []).whereType<Json>();
    if (options.isNotEmpty && !options.any((option) => option['value'] == text)) return 'Choose a ${label.toLowerCase()}.';
  }
  return null;
}

Map<String, String> validateFormValues(Json payload, FormValues values) {
  final errors = <String, String>{};
  for (final field in formFields(payload)) {
    final name = field['name'] as String? ?? '';
    final error = _fieldError(field, values[name]);
    if (error != null) errors[name] = error;
  }
  return errors;
}

Json formActionValue(Json payload, FormValues values) {
  final fields = <String, Object>{};
  for (final field in formFields(payload)) {
    final name = field['name'] as String? ?? '';
    final raw = values[name];
    if (field['type'] == 'boolean') {
      fields[name] = raw == true;
      continue;
    }
    final text = raw is String ? raw.trim() : '';
    if (text.isEmpty) continue;
    if (field['type'] == 'number') {
      final number = double.parse(text);
      fields[name] = number == number.roundToDouble() && !text.contains('.') ? number.toInt() : number;
    } else {
      fields[name] = text;
    }
  }
  return {'kind': 'form', 'fields': fields};
}

class ChartBar {
  const ChartBar(this.label, this.value, this.fraction);
  final String label;
  final num value;
  final double fraction;
}

({String series, List<ChartBar> bars, int more}) chartBars(Json payload, [int limit = 12]) {
  final series = (payload['series'] as List? ?? const []).whereType<Json>().toList();
  if (series.isEmpty) return (series: '', bars: const [], more: 0);
  final first = series.first;
  final all = (first['points'] as List? ?? const []).whereType<Json>().toList();
  final points = all.take(limit).toList();
  num max = 0;
  for (final point in points) {
    final y = (point['y'] as num? ?? 0).abs();
    if (y > max) max = y;
  }
  return (
    series: first['label'] as String? ?? '',
    bars: points.map((point) {
      final y = point['y'] as num? ?? 0;
      final x = point['x'];
      return ChartBar(x is num ? _plain(x) : '$x', y, max > 0 ? y.abs() / max : 0);
    }).toList(),
    more: (all.length - limit).clamp(0, 1 << 30),
  );
}

/// Distinct per logical answer, reused if the same answer is retried.
String gadgetIdempotencyKey(String gadgetId, String actionId, Object value) => 'gadget:$gadgetId:$actionId:${_stableHash(jsonEncode(value))}';

String _stableHash(String text) {
  var hash = 5381;
  for (final unit in text.codeUnits) {
    hash = ((hash << 5) + hash + unit) & 0xffffffff;
  }
  return hash.toRadixString(36);
}
