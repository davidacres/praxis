import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../app/diagnostics.dart';
import '../app/store.dart';
import '../app/theme.dart';
import '../core/models.dart';
import '../ui/kit.dart';

const _statusMark = {'added': 'A', 'modified': 'M', 'deleted': 'D', 'renamed': 'R', 'conflicted': '!'};

/// What a session changed on disk — the desktop's Changes tab, read-only.
/// Port of `screens/ChangesView.tsx`.
class ChangesView extends StatefulWidget {
  const ChangesView({super.key, required this.sessionId, this.runId, this.run});
  final String sessionId;
  final String? runId;
  final RunSummary? run;

  @override
  State<ChangesView> createState() => _ChangesViewState();
}

class _ChangesViewState extends State<ChangesView> {
  SessionChanges? _changes;
  String? _error;
  bool _loading = false;
  String? _open;
  final Map<String, FileDiff> _diffs = {};
  final Map<String, String> _diffErrors = {};

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _refresh());
  }

  void _refresh() {
    final store = context.read<AppStore>();
    if (!store.changesSupported || store.connection != ShellConnection.ready) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    store
        .sessionChanges(widget.sessionId)
        .then((next) {
          if (!mounted) return;
          setState(() {
            _changes = next;
            _diffs.clear();
            _diffErrors.clear();
          });
        })
        .catchError((Object failure) {
          if (mounted) setState(() => _error = Diagnostics.messageOf(failure));
        })
        .whenComplete(() {
          if (mounted) setState(() => _loading = false);
        });
  }

  void _toggle(String path) {
    if (_open == path) {
      setState(() => _open = null);
      return;
    }
    setState(() => _open = path);
    if (_diffs.containsKey(path) || _diffErrors.containsKey(path)) return;
    context
        .read<AppStore>()
        .fileDiff(widget.sessionId, path)
        .then((diff) {
          if (mounted) setState(() => _diffs[path] = diff);
        })
        .catchError((Object failure) {
          if (mounted) setState(() => _diffErrors[path] = Diagnostics.messageOf(failure));
        });
  }

  @override
  Widget build(BuildContext context) {
    final store = context.watch<AppStore>();
    final t = context.t;
    final p = t.palette;
    final changes = _changes;
    final supported = store.changesSupported;
    final heading = ts(context, 14, weight: FontWeight.w700);
    final run = widget.run;
    final artifacts = <({String key, String label, String kind})>[
      if (run != null)
        for (final stage in run.stages)
          for (final artifact in stage.artifacts)
            (key: '${stage.nodeId}:${artifact.contractId}:${artifact.path ?? artifact.kind}', label: artifact.path ?? artifact.contractId, kind: artifact.kind),
    ];

    final tree = PraxisCard(
      children: [
        Row(
          children: [
            Expanded(child: Text('Working tree', style: heading)),
            if (supported)
              PraxisButton(
                label: _loading ? 'Refreshing…' : 'Refresh',
                ghost: true,
                expand: false,
                disabled: _loading || store.connection != ShellConnection.ready,
                onPressed: _refresh,
              ),
          ],
        ),
        if (!supported) const Body('Update Praxis on the desktop to see a session’s changed files here.', dim: true),
        if (_loading && changes == null) const Center(child: Spinner()),
        if (_error != null) Text(_error!, style: ts(context, 13, color: p.danger)),
        if (changes != null && !changes.repository) const Body('This session’s folder isn’t a git repository, so there is nothing to compare.', dim: true),
        if (changes != null && changes.repository && changes.files.isEmpty) const Body('No uncommitted changes in this session’s working tree.', dim: true),
        if (changes?.branch != null) Body('On ${changes!.branch}', dim: true),
        for (final file in changes?.files ?? const <ChangedFile>[])
          Container(
            padding: EdgeInsets.only(top: t.s(8)),
            decoration: BoxDecoration(
              border: Border(top: BorderSide(color: p.border, width: 0.5)),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Pressable(
                  label: '${file.path}, ${file.status}${file.reportedBySession ? ', edited by this session' : ''}. Show diff.',
                  onTap: () => _toggle(file.path),
                  excludeChildSemantics: true,
                  builder: (context, pressed) => Opacity(
                    opacity: pressed ? 0.7 : 1,
                    child: ConstrainedBox(
                      constraints: BoxConstraints(minHeight: t.s(36)),
                      child: Row(
                        children: [
                          SizedBox(
                            width: t.s(16),
                            child: Text(
                              _statusMark[file.status] ?? '?',
                              style: ts(
                                context,
                                12,
                                weight: FontWeight.w700,
                                family: monospace,
                                color: file.status == 'deleted'
                                    ? p.danger
                                    : file.status == 'added'
                                    ? p.ok
                                    : p.warn,
                              ),
                            ),
                          ),
                          SizedBox(width: t.s(8)),
                          Expanded(
                            child: Text(
                              file.path,
                              maxLines: 2,
                              overflow: TextOverflow.ellipsis,
                              style: file.reportedBySession ? ts(context, 12, family: monospace) : ts(context, 12, color: p.textDim),
                            ),
                          ),
                          if (file.additions != null) ...[
                            SizedBox(width: t.s(8)),
                            Text(
                              '+${file.additions}',
                              style: ts(context, 11.5, family: monospace, color: p.ok),
                            ),
                          ],
                          if (file.deletions != null) ...[
                            SizedBox(width: t.s(8)),
                            Text(
                              '−${file.deletions}',
                              style: ts(context, 11.5, family: monospace, color: p.danger),
                            ),
                          ],
                        ],
                      ),
                    ),
                  ),
                ),
                if (_open == file.path) ...[
                  SizedBox(height: t.s(6)),
                  if (_diffErrors[file.path] != null)
                    Text(_diffErrors[file.path]!, style: ts(context, 13, color: p.danger))
                  else if (_diffs[file.path] != null)
                    _DiffBody(_diffs[file.path]!)
                  else
                    const Center(child: Spinner()),
                ],
              ],
            ),
          ),
        if (changes?.files.any((file) => !file.reportedBySession) ?? false)
          const Body('Dimmed files were not reported by this session’s tools — they may have been changed already, or by a command it ran.', dim: true),
      ],
    );

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        tree,
        if (widget.runId != null) ...[
          SizedBox(height: t.space),
          PraxisCard(
            children: [
              Text('Workflow outputs', style: heading),
              if (widget.run == null) const Body('Loading workflow artifacts…', dim: true),
              if (widget.run != null && artifacts.isEmpty) const Body('No workflow artifacts have been produced yet.', dim: true),
              for (final artifact in artifacts)
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        artifact.label,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: ts(context, 12, family: monospace),
                      ),
                    ),
                    SizedBox(width: t.s(8)),
                    Text(artifact.kind, style: ts(context, 12, color: p.textDim)),
                  ],
                ),
            ],
          ),
        ],
      ],
    );
  }
}

class _DiffBody extends StatelessWidget {
  const _DiffBody(this.diff);
  final FileDiff diff;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final p = t.palette;
    if (diff.binary) return const Body('Binary file — no text diff.', dim: true);
    final hunks = diff.hunks;
    if (hunks.isEmpty) return const Body('No line changes to show (a new, untracked or mode-only change).', dim: true);
    final lineStyle = ts(context, 11.5, lineHeight: 16, family: monospace);
    Widget line(String text, {Color? color, Color? background, double vertical = 0}) => Container(
      color: background,
      padding: EdgeInsets.symmetric(horizontal: t.s(8), vertical: vertical),
      child: Text(text, softWrap: false, style: lineStyle.copyWith(color: color)),
    );
    return Container(
      constraints: BoxConstraints(maxHeight: t.s(420)),
      decoration: BoxDecoration(color: p.bgSunken, borderRadius: BorderRadius.circular(t.s(6))),
      child: SingleChildScrollView(
        child: SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: IntrinsicWidth(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                for (final hunk in hunks) ...[
                  line(hunk.header, color: p.textDim, vertical: t.s(4)),
                  for (final entry in hunk.lines)
                    line(
                      '${'${entry.kind == 'delete' ? entry.oldLine ?? '' : entry.newLine ?? ''}'.padLeft(4)} ${entry.kind == 'add'
                          ? '+'
                          : entry.kind == 'delete'
                          ? '−'
                          : ' '} ${entry.text}',
                      color: entry.kind == 'add'
                          ? p.ok
                          : entry.kind == 'delete'
                          ? p.danger
                          : p.text,
                      background: entry.kind == 'add'
                          ? p.accentSoft
                          : entry.kind == 'delete'
                          ? p.dangerSoft
                          : null,
                    ),
                ],
                if (diff.truncated) line('… more lines on the desktop', color: p.textDim, vertical: t.s(4)),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
