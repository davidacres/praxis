import 'models.dart';

// The composer's usage line, from desktop-recorded totals only. Cost is shown
// only when the provider reported one — "not reported" is never zero.
// Port of `renderer/mobileUsage.ts`.

enum UsageState { loading, empty, ready }

class UsageView {
  const UsageView({
    required this.state,
    required this.subject,
    this.tokens,
    required this.cost,
    required this.costReported,
    required this.details,
    required this.summary,
  });
  final UsageState state;
  final String subject;
  final String? tokens;
  final String cost;
  final bool costReported;
  final List<({String label, String value})> details;
  final String summary;
}

String _trim(double value) => value >= 100 ? value.round().toString() : value.toStringAsFixed(1).replaceFirst(RegExp(r'\.0$'), '');

String formatTokenCount(num value) {
  if (!value.isFinite || value < 0) return '0';
  if (value >= 1000000) return '${_trim(value / 1000000)}m';
  if (value >= 1000) return '${_trim(value / 1000)}k';
  return value.round().toString();
}

String formatCost(Cost cost) {
  final currency = cost.currency.toUpperCase();
  final prefix = currency == 'USD' ? r'US$' : '';
  final suffix = prefix.isNotEmpty ? '' : ' $currency';
  if (cost.amount > 0 && cost.amount < 0.01) return '<${prefix}0.01$suffix';
  return '$prefix${cost.amount.toStringAsFixed(2)}$suffix';
}

/// What usage is drawn from: a session snapshot or a `sessions.usage` read, whichever is newer.
class UsageSource {
  const UsageSource({this.provider, this.providerLabel, this.model, this.tokenUsage, this.contextTokens, this.contextLimit, this.cost, required this.sequence});
  final String? provider;
  final String? providerLabel;
  final String? model;
  final TokenUsage? tokenUsage;
  final int? contextTokens;
  final int? contextLimit;
  final Cost? cost;
  final int sequence;
}

UsageSource? latestUsage(SessionSnapshot? snapshot, SessionUsage? read) {
  UsageSource fromRead(SessionUsage r) => UsageSource(
    provider: r.provider,
    providerLabel: r.providerLabel,
    model: r.model,
    tokenUsage: r.tokenUsage,
    contextTokens: r.contextTokens,
    contextLimit: r.contextLimit,
    cost: r.cost,
    sequence: r.sequence,
  );
  if (snapshot == null) return read == null ? null : fromRead(read);
  if (read != null && read.sequence > snapshot.sequence) return fromRead(read);
  return UsageSource(
    provider: snapshot.provider,
    providerLabel: read?.providerLabel,
    model: snapshot.model,
    tokenUsage: snapshot.tokenUsage,
    contextTokens: snapshot.contextTokens,
    contextLimit: snapshot.contextLimit,
    cost: snapshot.cost,
    sequence: snapshot.sequence,
  );
}

UsageView describeUsage({required UsageSource? source, required bool loading, String? providerLabel, bool draft = false}) {
  final label = source?.providerLabel ?? providerLabel ?? source?.provider;
  final subject = source?.model ?? label ?? 'This session';
  if (draft) {
    return UsageView(
      state: UsageState.empty,
      subject: providerLabel ?? 'New chat',
      cost: 'No usage yet',
      costReported: false,
      details: const [],
      summary: 'Usage appears after the first reply.',
    );
  }
  if (source == null) {
    return loading
        ? UsageView(state: UsageState.loading, subject: subject, cost: '', costReported: false, details: const [], summary: 'Loading usage from the desktop…')
        : UsageView(
            state: UsageState.empty,
            subject: subject,
            cost: '',
            costReported: false,
            details: const [],
            summary: 'The desktop has not reported usage for this session.',
          );
  }
  final usage = source.tokenUsage;
  int? total = usage?.totalTokens;
  if (total == null) {
    final sum = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
    total = sum == 0 ? null : sum;
  }
  final tokens = total != null ? '${formatTokenCount(total)} tokens' : null;
  final cost = source.cost;
  final costReported = cost != null;
  final costText = cost != null ? formatCost(cost) : 'Cost not reported${label != null ? ' by $label' : ''}';
  final details = <({String label, String value})>[];
  if (label != null) details.add((label: 'Provider', value: label));
  details.add((label: 'Model', value: source.model ?? 'Provider default'));
  if (usage?.inputTokens != null) details.add((label: 'Input tokens', value: formatTokenCount(usage!.inputTokens!)));
  if (usage?.outputTokens != null) details.add((label: 'Output tokens', value: formatTokenCount(usage!.outputTokens!)));
  if (total != null) details.add((label: 'Total tokens', value: formatTokenCount(total)));
  if (source.contextTokens != null) {
    details.add((
      label: 'Context',
      value: source.contextLimit != null
          ? '${formatTokenCount(source.contextTokens!)} of ${formatTokenCount(source.contextLimit!)}'
          : formatTokenCount(source.contextTokens!),
    ));
  }
  details.add((label: 'Cost', value: costText));
  if (tokens == null && !costReported && source.contextTokens == null) {
    return UsageView(
      state: UsageState.empty,
      subject: subject,
      cost: costText,
      costReported: costReported,
      details: details,
      summary: '$subject · no usage recorded yet',
    );
  }
  return UsageView(
    state: UsageState.ready,
    subject: subject,
    tokens: tokens,
    cost: costText,
    costReported: costReported,
    details: details,
    summary: [subject, ?tokens, costReported ? costText : 'no cost data'].join(' · '),
  );
}
