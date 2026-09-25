import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../app/diagnostics.dart';
import '../app/store.dart';
import '../app/theme.dart';
import '../core/session_options.dart';
import '../core/time.dart';
import '../ui/kit.dart';
import '../ui/motif_backdrop.dart';
import '../ui/permission_card.dart';
import '../ui/transcript.dart';
import 'changes_view.dart';
import 'provider_model_sheet.dart';
import 'run_screen.dart';
import 'session_composer.dart';

/// A session, a run, or the "choose a session" state. Port of `screens/WorkScreen.tsx`.
class WorkScreen extends StatelessWidget {
  const WorkScreen({super.key, required this.onOpenSidebar});
  final VoidCallback onOpenSidebar;

  @override
  Widget build(BuildContext context) {
    final store = context.watch<AppStore>();
    final runId = store.openRunId;
    if (runId != null && store.workflowRuns.any((run) => run.runId == runId)) {
      return RunDetail(key: ValueKey('run:$runId'), runId: runId, onOpenSidebar: onOpenSidebar);
    }
    final open = store.work.where((item) => item.workId == store.openWorkId).firstOrNull;
    if (open == null) return _EmptySession(onOpenSidebar: onOpenSidebar);
    return WorkDetail(key: ValueKey('work:${open.workId}'), workId: open.workId, onOpenSidebar: onOpenSidebar);
  }
}

class _EmptySession extends StatelessWidget {
  const _EmptySession({required this.onOpenSidebar});
  final VoidCallback onOpenSidebar;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    return Stack(
      children: [
        const MotifBackdrop(),
        Column(
          children: [
            SessionHeader(title: 'Sessions', onOpenSidebar: onOpenSidebar),
            Expanded(
              child: Padding(
                padding: const EdgeInsets.all(28),
                child: Center(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text('Choose a session', style: ts(context, 18, weight: FontWeight.w700)),
                      SizedBox(height: t.s(7)),
                      ConstrainedBox(
                        constraints: BoxConstraints(maxWidth: t.s(260)),
                        child: Text(
                          'Open a previous session or start a new chat from the sidebar.',
                          textAlign: TextAlign.center,
                          style: ts(context, 12, lineHeight: 18, color: t.palette.textDim),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ],
        ),
      ],
    );
  }
}

class SessionHeader extends StatelessWidget {
  const SessionHeader({super.key, required this.title, required this.onOpenSidebar});
  final String title;
  final VoidCallback onOpenSidebar;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    return Container(
      constraints: BoxConstraints(minHeight: t.s(48)),
      padding: EdgeInsets.symmetric(horizontal: t.s(10)),
      decoration: BoxDecoration(
        color: t.palette.chrome,
        border: Border(bottom: BorderSide(color: t.palette.border)),
      ),
      child: Row(
        children: [
          MenuButton(onTap: onOpenSidebar, size: 30, radius: 6, glyph: 15),
          SizedBox(width: t.s(9)),
          Expanded(
            child: Semantics(
              header: true,
              child: Text(
                title,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: ts(context, 14, weight: FontWeight.w700),
              ),
            ),
          ),
          SizedBox(width: t.s(9)),
          const ConnectionBadge(),
        ],
      ),
    );
  }
}

/// A message the phone sent that the desktop has not taken yet — sending, or failed with Retry.
class _PendingFollowUp extends StatelessWidget {
  const _PendingFollowUp({required this.followUp, required this.canRetry, required this.onRetry});
  final FollowUp followUp;
  final bool canRetry;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final p = t.palette;
    final failed = followUp.state == FollowUpState.failed;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        ChatMessage(
          message: TranscriptMessage(id: followUp.messageId, author: 'user', text: followUp.text, at: formatClock(followUp.createdAt), streaming: false),
        ),
        Align(
          alignment: failed ? Alignment.centerLeft : Alignment.center,
          child: Container(
            margin: EdgeInsets.only(bottom: t.s(12)),
            padding: EdgeInsets.fromLTRB(t.s(12), t.s(9), t.s(12), t.s(11)),
            width: failed ? null : double.infinity,
            decoration: BoxDecoration(
              color: failed ? p.dangerSoft : p.assistantMessage,
              borderRadius: BorderRadius.circular(t.s(7)),
              border: Border.all(color: failed ? p.danger : p.border),
            ),
            child: failed
                ? Semantics(
                    liveRegion: true,
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(
                          'NOT SENT',
                          style: ts(context, 10, weight: FontWeight.w700, letterSpacing: 0.8, color: p.textDim),
                        ),
                        SizedBox(height: t.s(8)),
                        Text(followUp.result ?? 'The desktop did not accept this message.', style: ts(context, 13, lineHeight: 19)),
                        SizedBox(height: t.s(8)),
                        PraxisButton(label: 'Retry', ghost: true, disabled: !canRetry, onPressed: onRetry, expand: false),
                      ],
                    ),
                  )
                : Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Padding(
                        padding: EdgeInsets.only(bottom: t.s(7)),
                        child: Row(
                          mainAxisAlignment: MainAxisAlignment.spaceBetween,
                          children: [
                            Text(
                              'AI AGENT',
                              style: ts(context, 10, weight: FontWeight.w700, letterSpacing: 0.8, color: p.textDim),
                            ),
                            Text(
                              'SENDING',
                              style: ts(context, 10, color: p.textDim, features: tabular),
                            ),
                          ],
                        ),
                      ),
                      Text(
                        'Sending to the desktop…',
                        style: ts(context, 13, lineHeight: 19, color: p.textDim, style: FontStyle.italic),
                      ),
                    ],
                  ),
          ),
        ),
      ],
    );
  }
}

sealed class _Entry {
  const _Entry(this.key);
  final String key;
}

class _MessageEntry extends _Entry {
  _MessageEntry(this.message) : super(message.id);
  final TranscriptMessage message;
}

class _FollowUpEntry extends _Entry {
  _FollowUpEntry(this.followUp) : super(followUp.messageId);
  final FollowUp followUp;
}

class WorkDetail extends StatefulWidget {
  const WorkDetail({super.key, required this.workId, required this.onOpenSidebar});
  final String workId;
  final VoidCallback onOpenSidebar;

  @override
  State<WorkDetail> createState() => _WorkDetailState();
}

class _WorkDetailState extends State<WorkDetail> {
  final _draft = TextEditingController();
  String? _composerError;
  String? _previousStatus;
  int? _loadedRunSequence;
  String? _loadedRunDetail;

  @override
  void dispose() {
    _draft.dispose();
    super.dispose();
  }

  void _send(AppStore store, WorkItem item) {
    final text = _draft.text.trim();
    if (text.isEmpty) return;
    setState(() => _composerError = null);
    _draft.clear();
    store.sendFollowUp(item, text).catchError((Object error) {
      if (!mounted) return;
      _draft.text = text;
      setState(() => _composerError = Diagnostics.messageOf(error));
    });
  }

  /// Effects the Expo screen runs on render: load models to name them, refresh usage when a turn ends, re-read run progress.
  void _effects(AppStore store, WorkItem item, SelectionInfo info) {
    final providerId = info.providerId;
    if (providerId != null && !store.models.containsKey(providerId) && store.connection == ShellConnection.ready && (item.draft || info.canConfigure)) {
      WidgetsBinding.instance.addPostFrameCallback((_) => store.loadModels(providerId));
    }
    if (!item.draft && _previousStatus == 'active' && item.status != 'active') {
      WidgetsBinding.instance.addPostFrameCallback(
        (_) => store.refreshUsage(item.sessionId).catchError((Object error) => Diagnostics.instance.record('Refreshing usage', error)),
      );
    }
    _previousStatus = item.status;
    final runId = item.runId;
    if (store.detail != 'chat' && runId != null) {
      final sequence = store.workflowRuns.where((run) => run.runId == runId).firstOrNull?.sequence;
      if (_loadedRunSequence != sequence || _loadedRunDetail != store.detail || !store.runs.containsKey(runId)) {
        _loadedRunSequence = sequence;
        _loadedRunDetail = store.detail;
        WidgetsBinding.instance.addPostFrameCallback(
          (_) => store.loadRun(runId).catchError((Object error) => Diagnostics.instance.record('Loading workflow progress', error)),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final store = context.watch<AppStore>();
    final item = store.work.where((entry) => entry.workId == widget.workId).firstOrNull;
    if (item == null) return const SizedBox.shrink();
    final info = SelectionInfo(store, item);
    _effects(store, item, info);
    final t = context.t;
    final p = t.palette;
    final ready = store.connection == ShellConnection.ready;
    final itemFollowUps = store.followUps.where((message) => message.workId == item.workId).toList();
    final session = store.sessionFor(item.sessionId);
    final messages = store.transcriptFor(item.sessionId);
    final model = session?.model ?? (item.draft ? info.selection?.model : item.model);
    final verdict = item.draft
        ? validateSelection(info.catalog, info.selection ?? defaultSessionSelection, info.providerId != null ? info.providerModels?.value : null)
        : null;
    final blockedReason = store.connection == ShellConnection.reconnecting
        ? 'Reconnecting to ${store.host.hostName.isNotEmpty ? store.host.hostName : 'the desktop'}… you can send again once it is back.'
        : verdict;
    final entries = <_Entry>[...messages.map(_MessageEntry.new), ...itemFollowUps.map(_FollowUpEntry.new)];
    final permissions = store.openAttention.where((entry) => entry.kind == 'permission' && entry.sessionId == item.sessionId).toList()
      ..sort((a, b) => a.createdAt.compareTo(b.createdAt));
    final sending = item.status == 'active' ||itemFollowUps.any((message) => message.state == FollowUpState.pending);

    Widget body;
    if (store.detail == 'chat') {
      body = Column(
        children: [
          Expanded(
            child: Transcript<_Entry>(
              data: entries,
              keyOf: (entry) => entry.key,
              resetKey: item.workId,
              header: item.draft && messages.isEmpty && itemFollowUps.isEmpty
                  ? Padding(
                      padding: EdgeInsets.symmetric(vertical: t.s(24)),
                      child: Column(
                        children: [
                          Text('New chat', style: ts(context, 18, weight: FontWeight.w700)),
                          SizedBox(height: t.s(7)),
                          ConstrainedBox(
                            constraints: BoxConstraints(maxWidth: t.s(260)),
                            child: Text(
                              'Choose the provider, model and mode below, then send your first message. The session runs on ${store.host.hostName.isNotEmpty ? store.host.hostName : 'the desktop'}.',
                              textAlign: TextAlign.center,
                              style: ts(context, 12, lineHeight: 18, color: p.textDim),
                            ),
                          ),
                        ],
                      ),
                    )
                  : null,
              itemBuilder: (context, entry) => switch (entry) {
                _MessageEntry(:final message) => ChatMessage(
                  message: message.withMeta(
                    model: message.author == 'assistant' ? model : null,
                    tokens: message.author == 'assistant' ? session?.tokenUsage : null,
                    cost: message.author == 'assistant' ? session?.cost : null,
                  ),
                  connected: ready,
                  onAnswer: (gadget, action, value) => store.answerGadget(item.sessionId, gadget, action, value),
                ),
                _FollowUpEntry(:final followUp) => _PendingFollowUp(
                  followUp: followUp,
                  canRetry: ready,
                  onRetry: () => store.retryFollowUp(followUp.messageId),
                ),
              },
            ),
          ),
          // The agent is blocked until this is answered, so it sits over the composer, not in the scrollback.
          // The desktop answers a session's requests oldest first, so only the oldest is offered.
          if (permissions.isNotEmpty)
            Padding(
              padding: EdgeInsets.fromLTRB(t.s(12), t.s(8), t.s(12), 0),
              child: PermissionCard(
                key: ValueKey(permissions.first.id),
                item: permissions.first,
                subject: permissions.length > 1 ? 'The agent is waiting for you · ${permissions.length - 1} more after this' : null,
              ),
            ),
          SessionComposer(
            controller: _draft,
            onSend: () => _send(store, item),
            onStop: item.draft
                ? null
                : () => store.cancelSession(item.sessionId).catchError((Object error) => setState(() => _composerError = Diagnostics.messageOf(error))),
            sending: sending,
            blockedReason: blockedReason,
            error: _composerError,
            editable: info.editable,
            draft: item.draft,
            lockedReason: info.lockedReason,
            providerLabel: info.providerLabel,
            modelLabel: info.shownModel,
            mode: info.mode,
            onOpenProviderPicker: () {
              if (info.catalog == null) store.refreshProviders();
              ProviderModelSheet.show(context, workId: item.workId, kind: 'provider');
            },
            onOpenModelPicker: () {
              final providerId = info.providerId;
              if (providerId != null && !store.models.containsKey(providerId)) store.loadModels(providerId);
              ProviderModelSheet.show(context, workId: item.workId, kind: 'model');
            },
            modeOptions: composerModeOptions(info.catalog),
            onChangeMode: (next) {
              if (item.draft) {
                store.updateDraftSelection(item.workId, (current) => current.copyWith(mode: next));
              } else {
                store.configureSession(item, mode: next).catchError((Object error) => setState(() => _composerError = Diagnostics.messageOf(error)));
              }
            },
            usage: store.usageFor(item),
            onRefreshUsage: item.draft
                ? null
                : () => store.refreshUsage(item.sessionId).catchError((Object error) => Diagnostics.instance.record('Refreshing usage', error)),
            workflows: store.workflows,
            onStartWorkflow: ready
                ? (workflowId) =>
                      store.startWorkflow(workflowId, item.title).catchError((Object error) => setState(() => _composerError = Diagnostics.messageOf(error)))
                : null,
          ),
        ],
      );
    } else {
      final run = item.runId != null ? store.runs[item.runId] : null;
      body = ListView(
        padding: EdgeInsets.all(t.space),
        children: [
          if (store.detail == 'progress')
            PraxisCard(
              children: [
                Body(
                  run != null
                      ? '${run.workflowName} · ${run.status}'
                      : item.runId != null
                      ? 'Loading workflow progress…'
                      : 'No workflow run is attached to this session.',
                  dim: true,
                ),
                if (run != null)
                  for (final stage in run.stages)
                    Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        Expanded(child: Body(stage.name)),
                        Pill(
                          stage.outcome,
                          tone: stage.outcome == 'succeeded'
                              ? Tone.ok
                              : stage.lane == 'awaiting'
                              ? Tone.warn
                              : Tone.neutral,
                        ),
                      ],
                    ),
                if (run != null) Body(run.explanation, dim: true),
              ],
            ),
          if (store.detail == 'changes')
            item.draft
                ? const PraxisCard(children: [Body('Send the first message to start a session; its changes appear here.', dim: true)])
                : ChangesView(sessionId: item.sessionId, runId: item.runId, run: run),
        ],
      );
    }

    return Stack(
      children: [
        const MotifBackdrop(),
        Column(
          children: [
            SessionHeader(title: item.title, onOpenSidebar: widget.onOpenSidebar),
            Expanded(child: body),
          ],
        ),
      ],
    );
  }
}
