import 'dart:async';
import 'package:flutter_test/flutter_test.dart';
import 'package:praxis_mobile/app/desktop_registry.dart';
import 'package:praxis_mobile/app/store.dart';
import 'package:praxis_mobile/app/theme.dart';
import 'desktop_registry_test.dart' show MemoryDesktopStorage, hostConfig;
import 'desktop_switching_test.dart' show ControlledDesktop;

class ScheduleDesktop extends ControlledDesktop {
  ScheduleDesktop(super.config);
  String scheduleStatus = 'scheduled';
  Completer<Object?>? scheduleRead;
  @override
  Future<Object?> read(Map<String, Object?> request) async {
    if (request['operation'] == 'scheduledRuns.list') {
      if (scheduleRead != null) return scheduleRead!.future;
      return [{'id': 'same-schedule', 'projectId': 'same-project', 'name': '${config.hostId} schedule', 'status': scheduleStatus}];
    }
    final result = await super.read(request);
    if (request['operation'] == 'host.info') {
      final info = result as Map<String, dynamic>;
      (info['readOperations'] as List).add('scheduledRuns.list');
      (info['commandOperations'] as List).add('scheduledRuns.setArmed');
    }
    return result;
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  test('schedule events refresh current desktop and late reads cannot cross a switch', () async {
    final connections = <ScheduleDesktop>[];
    final theme = ThemeController();
    final store = AppStore(theme: theme, repository: DesktopRepository(MemoryDesktopStorage()), initialize: false,
      connectionFactory: (config) { final connection = ScheduleDesktop(config); connections.add(connection); return connection; });
    addTearDown(() { store.dispose(); theme.dispose(); });
    await store.connect(hostConfig('A'));
    expect(store.schedules.value!.single.name, 'A schedule');
    final a = connections.last;
    a.scheduleStatus = 'draft';
    a.events.single({'sequence': 2, 'event': {'type': 'scheduledRuns.changed'}});
    await Future<void>.delayed(Duration.zero);
    expect(store.schedules.value!.single.status, 'draft');
    final held = Completer<Object?>();
    a.scheduleRead = held;
    final pending = store.refreshSchedules();
    await store.connect(hostConfig('B'));
    held.complete([{'id': 'same-schedule', 'projectId': 'same-project', 'name': 'STALE'}]);
    await pending;
    expect(store.schedules.value!.single.name, 'B schedule');
    store.disconnect();
    expect(store.schedules.value, isNull);
  });
}
