import 'package:flutter_test/flutter_test.dart';
import 'package:praxis_mobile/app/store/store_provider.dart';
import 'package:praxis_mobile/app/store/types.dart';

void main() {
  group('AppStore', () {
    late AppStore store;

    setUp(() {
      store = AppStore();
    });

    test('initializes with correct defaults', () {
      expect(store.primaryRoute, 'work');
      expect(store.isConnected, false);
      expect(store.work, isEmpty);
    });

    test('setRoute updates navigation', () {
      store.setRoute('attention');
      expect(store.primaryRoute, 'attention');
    });

    test('openWork updates openWorkId', () {
      store.openWork('work-123');
      expect(store.openWorkId, 'work-123');
    });

    test('updateWork replaces work list', () {
      final items = [
        MobileWorkItem(
          workId: 'w1',
          title: 'Test',
          status: 'pending',
          sessionId: 's1',
          mode: 'interactive',
        ),
      ];
      store.updateWork(items);
      expect(store.work, items);
    });

    test('addTranscriptMessage appends to transcript', () {
      final msg = TranscriptMessage(
        id: '1',
        role: 'user',
        text: 'Hello',
        timestamp: DateTime.now().toString(),
      );
      store.addTranscriptMessage(msg);
      expect(store.currentTranscript, contains(msg));
    });
  });
}
