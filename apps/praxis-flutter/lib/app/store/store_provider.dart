import 'package:flutter/foundation.dart';
import 'types.dart';
import '../models/mobile_appearance.dart';

class AppStore extends ChangeNotifier {
  // Navigation
  String _primaryRoute = 'work';
  String? _detailTab;
  String? _openWorkId;
  String? _openRunId;

  // Connection state
  bool _isConnected = false;
  MobileHostConfiguration? _hostConfig;
  bool _autoConnectEnabled = true;

  // Data
  MobileHostSummary? _host;
  MobileProjectSummary? _project;
  List<MobileWorkItem> _work = [];
  List<MobileActivityEntry> _activity = [];
  List<MobileWorkflowChoice> _workflows = [];
  Map<String, MobileRunSummary> _runs = {};
  List<MobileRunSummary> _workflowRuns = [];
  bool _runsSupported = false;
  List<TranscriptMessage> _currentTranscript = [];

  // Theme/Appearance
  MobileAppearance? _appearance;
  int _themeVersion = 0;

  // Connection status
  String? _connectionIssue;

  // Additional data
  String? _connectionError;

  // Getters
  String get primaryRoute => _primaryRoute;
  String? get detailTab => _detailTab;
  String? get openWorkId => _openWorkId;
  String? get openRunId => _openRunId;
  bool get isConnected => _isConnected;
  MobileHostConfiguration? get hostConfig => _hostConfig;
  bool get autoConnectEnabled => _autoConnectEnabled;
  MobileHostSummary? get host => _host;
  MobileProjectSummary? get project => _project;
  List<MobileWorkItem> get work => _work;
  List<MobileActivityEntry> get activity => _activity;
  List<MobileWorkflowChoice> get workflows => _workflows;
  Map<String, MobileRunSummary> get runs => _runs;
  List<MobileRunSummary> get workflowRuns => _workflowRuns;
  bool get runsSupported => _runsSupported;
  List<TranscriptMessage> get currentTranscript => _currentTranscript;
  MobileAppearance? get appearance => _appearance;
  int get themeVersion => _themeVersion;
  String? get connectionIssue => _connectionIssue;
  String? get connectionError => _connectionError;

  // Actions
  void setRoute(String route) {
    _primaryRoute = route;
    notifyListeners();
  }

  void setDetail(String? detail) {
    _detailTab = detail;
    notifyListeners();
  }

  void openWork(String? workId) {
    _openWorkId = workId;
    notifyListeners();
  }

  void openRun(String? runId) {
    _openRunId = runId;
    notifyListeners();
  }

  Future<void> connect(MobileHostConfiguration config) async {
    _hostConfig = config;
    _isConnected = true;
    _autoConnectEnabled = true;
    notifyListeners();
    // TODO: Establish actual connection
  }

  void disconnect({bool forget = false}) {
    _isConnected = false;
    _hostConfig = null;
    if (forget) {
      _autoConnectEnabled = false;
    }
    notifyListeners();
  }

  void retryConnection() {
    if (_hostConfig != null) {
      connect(_hostConfig!);
    }
  }

  void updateWork(List<MobileWorkItem> work) {
    _work = work;
    notifyListeners();
  }

  void updateActivity(List<MobileActivityEntry> activity) {
    _activity = activity;
    notifyListeners();
  }

  void updateWorkflows(List<MobileWorkflowChoice> workflows) {
    _workflows = workflows;
    notifyListeners();
  }

  void updateRuns(Map<String, MobileRunSummary> runs) {
    _runs = runs;
    notifyListeners();
  }

  void updateWorkflowRuns(List<MobileRunSummary> runs) {
    _workflowRuns = runs;
    notifyListeners();
  }

  void updateAppearance(MobileAppearance appearance) {
    _appearance = appearance;
    _themeVersion++;
    notifyListeners();
  }

  void updateTranscript(List<TranscriptMessage> messages) {
    _currentTranscript = messages;
    notifyListeners();
  }

  void addTranscriptMessage(TranscriptMessage message) {
    _currentTranscript = [..._currentTranscript, message];
    notifyListeners();
  }

  void startNewChat() {
    _openWorkId = null;
    _currentTranscript = [];
    notifyListeners();
  }

  void updateHostInfo(MobileHostSummary host) {
    _host = host;
    _isConnected = true;
    _connectionError = null;
    notifyListeners();
  }

  void updateProject(MobileProjectSummary project) {
    _project = project;
    notifyListeners();
  }

  void addRunSnapshot(MobileRunSummary run) {
    _workflowRuns = [..._workflowRuns, run];
    _runsSupported = true;
    notifyListeners();
  }

  void setConnectionError(String? error) {
    _connectionError = error;
    if (error != null) {
      _isConnected = false;
    }
    notifyListeners();
  }
}
