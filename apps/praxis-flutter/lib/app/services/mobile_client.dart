import 'dart:async';
import 'dart:convert';
import '../models/mobile_appearance.dart';
import '../store/store_provider.dart';
import '../store/types.dart';
import 'connection_service.dart';

/// Bridges ConnectionService events to the AppStore.
class MobileClient {
  final ConnectionService _connection;
  final AppStore _store;
  StreamSubscription? _eventSubscription;

  MobileClient({
    required ConnectionService connection,
    required AppStore store,
  })  : _connection = connection,
        _store = store;

  Future<void> connect(MobileHostConfiguration config) async {
    try {
      await _connection.connect(config);
      _listenToEvents();
      _store.notifyListeners();
    } catch (e) {
      rethrow;
    }
  }

  void _listenToEvents() {
    _eventSubscription?.cancel();
    _eventSubscription = _connection.onEvent.listen(
      _handleEvent,
      onError: _handleError,
    );
  }

  Future<void> _handleEvent(Map<String, dynamic> event) async {
    final type = event['type'] as String?;

    switch (type) {
      case 'host.info':
        _handleHostInfo(event);
        break;
      case 'project.selected':
        _handleProjectSelected(event);
        break;
      case 'work.updated':
        _handleWorkUpdated(event);
        break;
      case 'activity.updated':
        _handleActivityUpdated(event);
        break;
      case 'transcript.message':
        _handleTranscriptMessage(event);
        break;
      case 'run.snapshot':
        _handleRunSnapshot(event);
        break;
      case 'tm-theme-changed':
        _handleThemeChanged(event);
        break;
      case 'work-session-created':
        _handleWorkSessionCreated(event);
        break;
    }
  }

  void _handleHostInfo(Map<String, dynamic> event) {
    final hostId = event['hostId'] as String?;
    final hostName = event['hostName'] as String?;

    if (hostId != null && hostName != null) {
      _store.updateHostInfo(
        MobileHostSummary(
          hostId: hostId,
          hostName: hostName,
          online: true,
        ),
      );
    }
  }

  void _handleProjectSelected(Map<String, dynamic> event) {
    final projectId = event['projectId'] as String?;
    final name = event['name'] as String?;

    if (projectId != null && name != null) {
      _store.updateProject(
        MobileProjectSummary(
          projectId: projectId,
          name: name,
        ),
      );
    }
  }

  void _handleWorkUpdated(Map<String, dynamic> event) {
    final items = event['items'] as List?;
    if (items == null) return;

    final workItems = items.map((item) {
      return MobileWorkItem(
        workId: item['workId'] as String,
        title: item['title'] as String,
        status: item['status'] as String,
        sessionId: item['sessionId'] as String,
        runId: item['runId'] as String?,
        provider: item['provider'] as String?,
        model: item['model'] as String?,
        mode: item['mode'] as String,
        draft: item['draft'] as bool?,
      );
    }).toList();

    _store.updateWork(workItems);
  }

  void _handleActivityUpdated(Map<String, dynamic> event) {
    final entries = event['entries'] as List?;
    if (entries == null) return;

    final activity = entries.map((entry) {
      return MobileActivityEntry(
        id: entry['id'] as String,
        at: entry['at'] as String,
        workId: entry['workId'] as String,
        title: entry['title'] as String,
        text: entry['text'] as String,
      );
    }).toList();

    _store.updateActivity(activity);
  }

  void _handleTranscriptMessage(Map<String, dynamic> event) {
    final message = TranscriptMessage(
      id: event['id'] as String? ?? DateTime.now().millisecondsSinceEpoch.toString(),
      role: event['role'] as String? ?? 'assistant',
      text: event['text'] as String? ?? '',
      timestamp: event['timestamp'] as String? ?? DateTime.now().toString(),
    );
    _store.addTranscriptMessage(message);
  }

  void _handleRunSnapshot(Map<String, dynamic> event) {
    final runId = event['runId'] as String?;
    final snapshot = event['snapshot'] as Map<String, dynamic>?;

    if (runId != null && snapshot != null) {
      _store.addRunSnapshot(
        MobileRunSummary(
          runId: runId,
          workflowName: snapshot['workflowName'] as String? ?? '',
          status: snapshot['status'] as String? ?? 'pending',
          explanation: snapshot['explanation'] as String? ?? '',
          stages: [],
        ),
      );
    }
  }

  void _handleThemeChanged(Map<String, dynamic> event) {
    final appearance = event['appearance'] as Map<String, dynamic>?;
    if (appearance != null) {
      _store.updateAppearance(
        MobileAppearance(
          name: appearance['name'] as String? ?? 'default',
          mode: appearance['mode'] as String? ?? 'light',
          primaryColor: appearance['primaryColor'] as String? ?? '#007AFF',
          backgroundColor: appearance['backgroundColor'] as String? ?? '#FFFFFF',
          surfaceColor: appearance['surfaceColor'] as String? ?? '#F2F2F7',
          textColor: appearance['textColor'] as String? ?? '#000000',
          secondaryTextColor: appearance['secondaryTextColor'] as String? ?? '#666666',
        ),
      );
    }
  }

  void _handleWorkSessionCreated(Map<String, dynamic> event) {
    final workId = event['workId'] as String?;
    if (workId != null) {
      _store.openWork(workId);
    }
  }

  void _handleError(dynamic error) {
    // Log error, update UI state
  }

  Future<void> sendMessage(String text) async {
    try {
      await _connection.sendCommand({
        'type': 'transcript.send-message',
        'text': text,
        'timestamp': DateTime.now().toIso8601String(),
      });
    } catch (e) {
      rethrow;
    }
  }

  Future<void> disconnect() async {
    await _eventSubscription?.cancel();
    await _connection.disconnect();
  }
}
