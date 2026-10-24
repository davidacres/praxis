import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../app/store.dart';
import '../app/theme.dart';
import '../core/models.dart';
import 'kit.dart';

class ScheduledRunsSection extends StatelessWidget {
  const ScheduledRunsSection({super.key});

  @override
  Widget build(BuildContext context) {
    final store = context.watch<AppStore>();
    final schedules = store.schedules;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                'SCHEDULED RUNS',
                style: ts(
                  context,
                  11,
                  weight: FontWeight.w700,
                  color: context.p.textDim,
                ),
              ),
            ),
            if (store.canCommand('scheduledRuns.save'))
              _ScheduleButton(
                label: 'New scheduled run',
                text: '+ New',
                onTap: () => showModalBottomSheet<void>(
                  context: context,
                  isScrollControlled: true,
                  useSafeArea: true,
                  backgroundColor: context.p.bg,
                  builder: (_) => ChangeNotifierProvider.value(
                    value: store,
                    child: ScheduleComposer(contextKey: store.contextKey),
                  ),
                ),
              ),
            _ScheduleButton(
              label: 'Refresh scheduled runs',
              text: 'Refresh',
              onTap: store.schedulesSupported && store.connection == ShellConnection.ready ? store.refreshSchedules : null,
            ),
          ],
        ),
        if (!store.schedulesSupported)
          Text(
            'Update Praxis on the desktop to share scheduled runs with this phone.',
            style: ts(context, 11, color: context.p.textDim),
          )
        else ...[
          if (store.hostInfo?.scheduledRunExecution == 'planning-only')
            Text('Schedule planning is available. Automatic ticket execution is not available in this desktop version.', style: ts(context, 11, color: context.p.textDim)),
          if (schedules.status == RemoteStatus.loading)
            Text(
              'Loading schedules…',
              style: ts(context, 11, color: context.p.textDim),
            ),
          if (schedules.status == RemoteStatus.error)
            Text(
              schedules.message ?? 'Could not load schedules.',
              style: ts(context, 11, color: context.p.warn),
            ),
          if (schedules.status == RemoteStatus.ready &&
              schedules.value?.isEmpty == true)
            Text(
              'No scheduled runs in this project yet.',
              style: ts(context, 11, color: context.p.textDim),
            ),
          for (final run in schedules.value ?? <ScheduledRunSnapshot>[])
            _ScheduleCard(key: ValueKey(run.id), run: run),
        ],
      ],
    );
  }
}

class _ScheduleCard extends StatefulWidget {
  const _ScheduleCard({super.key, required this.run});
  final ScheduledRunSnapshot run;
  @override
  State<_ScheduleCard> createState() => _ScheduleCardState();
}

class _ScheduleCardState extends State<_ScheduleCard> {
  bool busy = false;
  String? error;

  Future<void> change({bool? armed, String? resolution}) async {
    setState(() {
      busy = true;
      error = null;
    });
    try {
      await context.read<AppStore>().changeSchedule(
        widget.run.id,
        armed: armed,
        resolution: resolution,
      );
    } catch (e) {
      if (mounted) setState(() => error = e.toString());
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final run = widget.run;
    final store = context.watch<AppStore>();
    final start = DateTime.tryParse(run.scheduledStartAt)?.toLocal();
    final when = start == null
        ? run.scheduledStartAt
        : '${start.year}-${start.month.toString().padLeft(2, '0')}-${start.day.toString().padLeft(2, '0')} ${start.hour.toString().padLeft(2, '0')}:${start.minute.toString().padLeft(2, '0')} ${start.timeZoneName}';
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: PraxisCard(
        children: [
          Text(run.name, style: ts(context, 13, weight: FontWeight.w600)),
          Text(
            '${run.status} · $when',
            style: ts(context, 11, color: context.p.textDim),
          ),
          Text(
            'Schedule timezone: ${run.timezone}',
            style: ts(context, 10, color: context.p.textDim),
          ),
          for (final entry in run.entries)
            Padding(
              padding: const EdgeInsets.only(top: 5),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    '${entry.sequence}. ${entry.issueKey} · ${entry.title}',
                    style: ts(context, 11),
                  ),
                  Text(
                    entry.status,
                    style: ts(context, 10, color: context.p.textDim),
                  ),
                  if (entry.reason != null)
                    Text(
                      entry.reason!,
                      style: ts(context, 11, color: context.p.warn),
                    ),
                  if (entry.workflowRunId != null)
                    _ScheduleButton(
                      label: 'Open run for ${entry.issueKey}',
                      text: 'Open run',
                      onTap: () => store.openRun(entry.workflowRunId),
                    ),
                ],
              ),
            ),
          if (error != null)
            Text(error!, style: ts(context, 11, color: context.p.danger)),
          if (busy)
            Text('Saving…', style: ts(context, 11))
          else
            Wrap(
              spacing: 8,
              children: [
                if (store.canCommand('scheduledRuns.setArmed') &&
                    (run.status == 'draft' || run.status == 'scheduled'))
                  _ScheduleButton(
                    label:
                        '${run.status == 'scheduled' ? 'Hold' : 'Arm'} ${run.name}',
                    text: run.status == 'scheduled' ? 'Hold' : 'Arm',
                    onTap: () => change(armed: run.status != 'scheduled'),
                  ),
                if (store.canCommand('scheduledRuns.resolveMissed') &&
                    run.status == 'missed') ...[
                  _ScheduleButton(
                    label: 'Start ${run.name} now',
                    text: 'Start now',
                    onTap: () => change(resolution: 'start-now'),
                  ),
                  _ScheduleButton(
                    label: 'Skip ${run.name}',
                    text: 'Skip',
                    onTap: () => change(resolution: 'skip'),
                  ),
                ],
              ],
            ),
        ],
      ),
    );
  }
}

class ScheduleComposer extends StatefulWidget {
  const ScheduleComposer({super.key, required this.contextKey});
  final String contextKey;
  @override
  State<ScheduleComposer> createState() => _ScheduleComposerState();
}

class _ScheduleComposerState extends State<ScheduleComposer> {
  final name = TextEditingController();
  final selected = <String>[];
  List<Map<String, dynamic>>? tickets;
  DateTime start = DateTime.now().toUtc().add(const Duration(hours: 1));
  String? error;
  bool busy = false;

  @override
  void initState() {
    super.initState();
    context
        .read<AppStore>()
        .scheduleTickets()
        .then((value) {
          if (mounted) setState(() => tickets = value);
        })
        .catchError((Object e) {
          if (mounted) setState(() => error = e.toString());
        });
  }

  @override
  void dispose() {
    name.dispose();
    super.dispose();
  }

  Future<void> save() async {
    final store = context.read<AppStore>();
    if (store.contextKey != widget.contextKey) return;
    setState(() {
      busy = true;
      error = null;
    });
    try {
      await store.createSchedule({
        'name': name.text.trim(),
        'date': start.toIso8601String().substring(0, 10),
        'time': start.toIso8601String().substring(11, 16),
        'timezone': 'UTC',
        'issueKeys': selected,
      });
      if (mounted) Navigator.pop(context);
    } catch (e) {
      if (mounted) {
        setState(() {
          error = e.toString();
          busy = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final store = context.watch<AppStore>();
    if (store.contextKey != widget.contextKey) {
      return const SafeArea(
        child: Body(
          'The desktop or project changed. Close this sheet and try again.',
        ),
      );
    }
    final available = tickets ?? <Map<String, dynamic>>[];
    final orderedTickets = [
      ...selected.map((key) => available.firstWhere((ticket) => ticket['workId'] == key)),
      ...available.where((ticket) => !selected.contains(ticket['workId'])),
    ];
    return Padding(
      padding: EdgeInsets.fromLTRB(
        16,
        16,
        16,
        MediaQuery.viewInsetsOf(context).bottom + 16,
      ),
      child: SizedBox(
        height: MediaQuery.sizeOf(context).height * .75,
        child: ListView(
          children: [
            Text(
              'New scheduled run',
              style: ts(context, 18, weight: FontWeight.w700),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: name,
              onChanged: (_) => setState(() {}),
              style: ts(context, 14),
              decoration: const InputDecoration(labelText: 'Schedule name'),
            ),
            const SizedBox(height: 8),
            Text(
              'Start: ${start.toIso8601String().substring(0, 16).replaceFirst('T', ' ')} UTC',
              style: ts(context, 13),
            ),
            Wrap(
              spacing: 8,
              children: [
                _ScheduleButton(
                  label: 'Choose schedule date',
                  text: 'Date',
                  onTap: () async {
                    final value = await showDatePicker(
                      context: context,
                      initialDate: start,
                      firstDate: DateTime.now().toUtc().subtract(
                        const Duration(days: 1),
                      ),
                      lastDate: DateTime.now().add(const Duration(days: 3650)),
                    );
                    if (value != null && mounted) {
                      setState(
                        () => start = DateTime.utc(
                          value.year,
                          value.month,
                          value.day,
                          start.hour,
                          start.minute,
                        ),
                      );
                    }
                  },
                ),
                _ScheduleButton(
                  label: 'Choose schedule time UTC',
                  text: 'Time (UTC)',
                  onTap: () async {
                    final value = await showTimePicker(
                      context: context,
                      initialTime: TimeOfDay(
                        hour: start.hour,
                        minute: start.minute,
                      ),
                    );
                    if (value != null && mounted) {
                      setState(
                        () => start = DateTime.utc(
                          start.year,
                          start.month,
                          start.day,
                          value.hour,
                          value.minute,
                        ),
                      );
                    }
                  },
                ),
              ],
            ),
            Text(
              'Tap tickets in run order. Tap again to remove.',
              style: ts(context, 12, color: context.p.textDim),
            ),
            if (tickets == null && error == null)
              Text('Loading project tickets…', style: ts(context, 12)),
            if (tickets?.isEmpty == true)
              Text(
                'No project tickets available. Add tickets on the desktop first.',
                style: ts(context, 12),
              ),
            for (final ticket in orderedTickets)
              _ScheduleButton(
                label: 'Queue ${ticket['workId']}',
                text:
                    '${selected.contains(ticket['workId']) ? '${selected.indexOf(ticket['workId'] as String) + 1}. ' : ''}${ticket['workId']} · ${ticket['title']}',
                onTap: busy
                    ? null
                    : () => setState(() {
                        final key = ticket['workId'] as String;
                        selected.contains(key)
                            ? selected.remove(key)
                            : selected.add(key);
                      }),
              ),
            if (error != null)
              Text(error!, style: ts(context, 12, color: context.p.danger)),
            _ScheduleButton(
              label: 'Save schedule draft',
              text: busy ? 'Saving…' : 'Save draft',
              onTap: busy || selected.isEmpty || name.text.trim().isEmpty
                  ? null
                  : save,
            ),
            _ScheduleButton(
              label: 'Close scheduled run editor',
              text: 'Close',
              onTap: busy ? null : () => Navigator.pop(context),
            ),
          ],
        ),
      ),
    );
  }
}

class _ScheduleButton extends StatelessWidget {
  const _ScheduleButton({required this.label, required this.text, this.onTap});
  final String label;
  final String text;
  final VoidCallback? onTap;
  @override
  Widget build(BuildContext context) => Pressable(
    label: label,
    onTap: onTap,
    excludeChildSemantics: true,
    builder: (context, pressed) => Container(
      constraints: const BoxConstraints(minHeight: 40),
      padding: const EdgeInsets.all(8),
      child: Text(
        text,
        style: ts(
          context,
          12,
          color: onTap == null ? context.p.textDim : context.p.accent,
        ),
      ),
    ),
  );
}
