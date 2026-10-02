// Typed views over what the desktop sends, mirroring `@praxis/core`'s mobile
// protocol types. Extension types keep the decoded JSON as-is — nothing is
// copied — while screens read typed fields.

typedef Json = Map<String, dynamic>;

String? _str(Json json, String key) {
  final value = json[key];
  return value is String ? value : null;
}

int? _int(Json json, String key) {
  final value = json[key];
  return value is num ? value.toInt() : null;
}

double? _num(Json json, String key) {
  final value = json[key];
  return value is num ? value.toDouble() : null;
}

bool _bool(Json json, String key) => json[key] == true;

List<Json> _list(Json json, String key) {
  final value = json[key];
  return value is List ? value.whereType<Map<String, dynamic>>().toList() : const [];
}

List<String> _strings(Json json, String key) {
  final value = json[key];
  return value is List ? value.whereType<String>().toList() : const [];
}

Json? _map(Json json, String key) {
  final value = json[key];
  return value is Map<String, dynamic> ? value : null;
}

extension type HostInfo(Json json) {
  String get hostId => _str(json, 'hostId') ?? '';
  String get hostName => _str(json, 'hostName') ?? '';
  int get protocolVersion => _int(json, 'protocolVersion') ?? 1;
  int get surfaceRevision => _int(json, 'surfaceRevision') ?? 1;
  List<String> get readOperations => _strings(json, 'readOperations');
  List<String> get commandOperations => _strings(json, 'commandOperations');
  int get latestSequence => _int(json, 'latestSequence') ?? 0;
  String? get hostEpoch => _str(json, 'hostEpoch');
  Object? get appearance => json['appearance'];
}

extension type TokenUsage(Json json) {
  int? get inputTokens => _int(json, 'inputTokens');
  int? get outputTokens => _int(json, 'outputTokens');
  int? get totalTokens => _int(json, 'totalTokens');
}

extension type Cost(Json json) {
  String get currency => _str(json, 'currency') ?? 'USD';
  double get amount => _num(json, 'amount') ?? 0;
}

extension type ProviderOption(Json json) {
  String get provider => _str(json, 'provider') ?? '';
  String get label => _str(json, 'label') ?? provider;
  String get kind => _str(json, 'kind') ?? 'api';
  bool get available => _bool(json, 'available');
  String? get unavailableMessage => _str(json, 'unavailableMessage');
  String? get defaultModel => _str(json, 'defaultModel');
}

extension type SessionModeOption(Json json) {
  String get mode => _str(json, 'mode') ?? 'chat';
  bool get available => _bool(json, 'available');
  String? get toolAccess => _str(json, 'toolAccess');
  String? get unavailableMessage => _str(json, 'unavailableMessage');
}

extension type ProviderCatalog(Json json) {
  String get defaultProvider => _str(json, 'defaultProvider') ?? '';
  String? get defaultModel => _str(json, 'defaultModel');
  List<ProviderOption> get providers => _list(json, 'providers').map(ProviderOption.new).toList();
  List<SessionModeOption> get sessionModes => _list(json, 'sessionModes').map(SessionModeOption.new).toList();
}

extension type ModelOption(Json json) {
  String get modelId => _str(json, 'modelId') ?? '';
  String get name => _str(json, 'name') ?? modelId;
  int? get contextLength => _int(json, 'contextLength');
}

extension type ModelCatalog(Json json) {
  String get provider => _str(json, 'provider') ?? '';
  String get status => _str(json, 'status') ?? 'unavailable';
  String? get message => _str(json, 'message');
  String? get defaultModel => _str(json, 'defaultModel');
  List<ModelOption> get models => _list(json, 'models').map(ModelOption.new).toList();
}

extension type SessionUsage(Json json) {
  String? get provider => _str(json, 'provider');
  String? get providerLabel => _str(json, 'providerLabel');
  String? get model => _str(json, 'model');
  TokenUsage? get tokenUsage => _map(json, 'tokenUsage') == null ? null : TokenUsage(_map(json, 'tokenUsage')!);
  int? get contextTokens => _int(json, 'contextTokens');
  int? get contextLimit => _int(json, 'contextLimit');
  Cost? get cost => _map(json, 'cost') == null ? null : Cost(_map(json, 'cost')!);
  int get sequence => _int(json, 'sequence') ?? 0;
}

extension type DeviceAccess(Json json) {
  String get deviceId => _str(json, 'deviceId') ?? '';
  String? get label => _str(json, 'label');
  List<String> get capabilities => _strings(json, 'capabilities');
  List<({String projectId, String name})> get projects => _list(json, 'projects').map((p) => (projectId: _str(p, 'projectId') ?? '', name: _str(p, 'name') ?? '')).toList();
  String? get pairedAt => _str(json, 'pairedAt');
  String? get lastSeenAt => _str(json, 'lastSeenAt');
  String? get hostKeyFingerprint => _str(json, 'hostKeyFingerprint');
  String get accessMode => _str(json, 'accessMode') ?? 'off';
}

extension type GadgetActionDescriptor(Json json) {
  String get actionId => _str(json, 'actionId') ?? '';
  String get label => _str(json, 'label') ?? actionId;
  String get effect => _str(json, 'effect') ?? 'informational';
  bool get danger => _bool(json, 'danger');
  String? get description => _str(json, 'description');
}

/// Where a gadget belongs — carried through as-is from `@praxis/core`'s
/// `GadgetScope`, so `sessionId` (and `workId`, when a gadget is scoped to
/// one) is available to resolve a local image the gadget references, exactly
/// as the desktop's `ArtifactGadget` uses `gadget.scope.workId ?? gadget.scope.sessionId`.
extension type GadgetScope(Json json) {
  String get hostId => _str(json, 'hostId') ?? '';
  String? get projectId => _str(json, 'projectId');
  String get sessionId => _str(json, 'sessionId') ?? '';
  String? get workId => _str(json, 'workId');
}

extension type GadgetEnvelope(Json json) {
  int get version => _int(json, 'version') ?? 0;
  String get gadgetId => _str(json, 'gadgetId') ?? '';
  String get kind => _str(json, 'kind') ?? '';
  String get fallbackText => _str(json, 'fallbackText') ?? '';
  Json get payload => _map(json, 'payload') ?? const {};
  List<GadgetActionDescriptor> get actions => _list(json, 'actions').map(GadgetActionDescriptor.new).toList();
  GadgetScope get scope => GadgetScope(_map(json, 'scope') ?? const {});

  /// The session an image reference in this gadget resolves against.
  String? get imageSessionId {
    final workId = scope.workId;
    final sessionId = scope.sessionId;
    return (workId != null && workId.isNotEmpty) ? workId : (sessionId.isNotEmpty ? sessionId : null);
  }
}

extension type GadgetView(Json json) {
  GadgetEnvelope get gadget => GadgetEnvelope(_map(json, 'gadget') ?? const {});
  String get state => _str(json, 'state') ?? 'active';
  String? get resultStatus => _map(json, 'result') == null ? null : _str(_map(json, 'result')!, 'status');
  String? get resultMessage => _map(json, 'result') == null ? null : _str(_map(json, 'result')!, 'message');
}

extension type SessionImageAttachment(Json json) {
  int get eventIndex => _int(json, 'eventIndex') ?? -1;
  int get attachmentIndex => _int(json, 'attachmentIndex') ?? -1;
  String get mimeType => _str(json, 'mimeType') ?? '';
}

extension type SessionMessage(Json json) {
  String get id => _str(json, 'id') ?? '';
  String get role => _str(json, 'role') ?? 'assistant';
  String get text => _str(json, 'text') ?? '';
  String get at => _str(json, 'at') ?? '';
  String get status => _str(json, 'status') ?? 'complete';
  String? get model => _str(json, 'model');
  List<GadgetView> get gadgets => _list(json, 'gadgets').map(GadgetView.new).toList();
  List<SessionImageAttachment> get attachments => _list(json, 'attachments').map(SessionImageAttachment.new).toList();
  TokenUsage? get tokenUsage => _map(json, 'tokenUsage') == null ? null : TokenUsage(_map(json, 'tokenUsage')!);
  Cost? get cost => _map(json, 'cost') == null ? null : Cost(_map(json, 'cost')!);
}

extension type PendingPermission(Json json) {
  String get requestId => _str(json, 'requestId') ?? '';
  String get summary => _str(json, 'summary') ?? '';
  String? get detail => _str(json, 'detail');
  String get createdAt => _str(json, 'createdAt') ?? '';
}

/// A session summary (`sessions.list`) or snapshot (`sessions.get`, `session.snapshot`).
extension type SessionSnapshot(Json json) {
  String get sessionId => _str(json, 'sessionId') ?? '';
  String get sessionKey => _str(json, 'sessionKey') ?? sessionId;
  String? get projectId => _str(json, 'projectId');
  String? get runId => _str(json, 'runId');
  String get title => _str(json, 'title') ?? '';
  String get lifecycle => _str(json, 'lifecycle') ?? 'idle';
  String? get provider => _str(json, 'provider');
  String? get model => _str(json, 'model');
  String get mode => _str(json, 'mode') ?? 'chat';
  bool get archived => _bool(json, 'archived');
  String? get startedAt => _str(json, 'startedAt');
  String? get completedAt => _str(json, 'completedAt');
  int get sequence => _int(json, 'sequence') ?? 0;
  List<SessionMessage> get messages => _list(json, 'messages').map(SessionMessage.new).toList();
  List<PendingPermission> get pendingPermissions => _list(json, 'pendingPermissions').map(PendingPermission.new).toList();
  TokenUsage? get tokenUsage => _map(json, 'tokenUsage') == null ? null : TokenUsage(_map(json, 'tokenUsage')!);
  int? get contextTokens => _int(json, 'contextTokens');
  int? get contextLimit => _int(json, 'contextLimit');
  Cost? get cost => _map(json, 'cost') == null ? null : Cost(_map(json, 'cost')!);
  bool get canContinue => _bool(json, 'canContinue');
  bool get canCancel => _bool(json, 'canCancel');
}

extension type RunStage(Json json) {
  String get nodeId => _str(json, 'nodeId') ?? '';
  String get name => _str(json, 'name') ?? '';
  String get type => _str(json, 'type') ?? '';
  String get lane => _str(json, 'lane') ?? 'idle';
  int get attempts => _int(json, 'attempts') ?? 0;
  String? get sessionId => _str(json, 'sessionId');
  String? get sessionKey => _str(json, 'sessionKey');
  String? get provider => _str(json, 'provider');
  String? get lastError => _str(json, 'lastError');
  String? get pause => _str(json, 'pause');
  String? get command => _str(json, 'command');
  int? get exitCode => _int(json, 'exitCode');
  String? get gate => _str(json, 'gate');
  Json? get metrics => _map(json, 'metrics');
  Map<String, int> get findingsSummary => (_map(json, 'findingsSummary') ?? const {}).map((key, value) => MapEntry(key, value is num ? value.toInt() : 0));
  String? get prompt => _str(json, 'prompt');
}

extension type RunSnapshot(Json json) {
  String get runId => _str(json, 'runId') ?? '';
  String get projectId => _str(json, 'projectId') ?? '';
  String get workflowName => _str(json, 'workflowName') ?? '';
  String get status => _str(json, 'status') ?? '';
  bool get paused => _bool(json, 'paused');
  String get explanation => _str(json, 'explanation') ?? '';
  String get startedAt => _str(json, 'startedAt') ?? '';
  String? get issueKey => _str(json, 'issueKey');
  String? get aiProvider => _str(json, 'aiProvider');
  String? get aiModel => _str(json, 'aiModel');
  String? get currentNodeId => _str(json, 'currentNodeId');
  List<RunStage> get stages => _list(json, 'stages').map(RunStage.new).toList();
  bool get canApprove => _bool(json, 'canApprove');
  int get sequence => _int(json, 'sequence') ?? 0;
}

/// `workflowRuns.get`: a run's progress with its artifacts.
extension type RunSummary(Json json) {
  String get runId => _str(json, 'runId') ?? '';
  String get workflowName => _str(json, 'workflowName') ?? '';
  String get status => _str(json, 'status') ?? '';
  String get explanation => _str(json, 'explanation') ?? '';
  List<({String nodeId, String name, String outcome, String lane, List<({String contractId, String kind, String? path})> artifacts})> get stages => _list(json, 'stages').map((stage) => (nodeId: _str(stage, 'nodeId') ?? '', name: _str(stage, 'name') ?? '', outcome: _str(stage, 'outcome') ?? '', lane: _str(stage, 'lane') ?? '', artifacts: _list(stage, 'artifacts').map((artifact) => (contractId: _str(artifact, 'contractId') ?? '', kind: _str(artifact, 'kind') ?? '', path: _str(artifact, 'path'))).toList())).toList();
}

extension type ChangedFile(Json json) {
  String get path => _str(json, 'path') ?? '';
  String get status => _str(json, 'status') ?? 'modified';
  int? get additions => _int(json, 'additions');
  int? get deletions => _int(json, 'deletions');
  bool get reportedBySession => _bool(json, 'reportedBySession');
}

extension type SessionChanges(Json json) {
  bool get repository => _bool(json, 'repository');
  String? get branch => _str(json, 'branch');
  List<ChangedFile> get files => _list(json, 'files').map(ChangedFile.new).toList();
}

extension type DiffLine(Json json) {
  String get kind => _str(json, 'kind') ?? 'context';
  String get text => _str(json, 'text') ?? '';
  int? get oldLine => _int(json, 'oldLine');
  int? get newLine => _int(json, 'newLine');
}

extension type FileDiff(Json json) {
  bool get binary => _bool(json, 'binary');
  bool get truncated => _bool(json, 'truncated');
  List<({String header, List<DiffLine> lines})> get hunks => _list(json, 'hunks').map((hunk) => (header: _str(hunk, 'header') ?? '', lines: _list(hunk, 'lines').map(DiffLine.new).toList())).toList();
}

extension type WorkflowChoice(Json json) {
  String get workflowId => _str(json, 'workflowId') ?? '';
  String get name => _str(json, 'name') ?? workflowId;
  String get trigger => _str(json, 'trigger') ?? 'manual';
}

extension type ProjectSummary(Json json) {
  String get projectId => _str(json, 'projectId') ?? '';
  String get name => _str(json, 'name') ?? '';
}

class AttentionItem {
  AttentionItem({required this.id, required this.kind, required this.hostId, required this.projectId, this.sessionId, this.runId, this.requestId, this.summary, this.detail, required this.createdAt, this.resolved = false});

  factory AttentionItem.fromJson(Json json) => AttentionItem(id: _str(json, 'id') ?? '', kind: _str(json, 'kind') ?? 'approval', hostId: _str(json, 'hostId') ?? '', projectId: _str(json, 'projectId') ?? '', sessionId: _str(json, 'sessionId'), runId: _str(json, 'runId'), requestId: _str(json, 'requestId'), summary: _str(json, 'summary'), detail: _str(json, 'detail'), createdAt: _str(json, 'createdAt') ?? '', resolved: _bool(json, 'resolved'));

  final String id;
  final String kind;
  final String hostId;
  final String projectId;
  final String? sessionId;
  final String? runId;
  final String? requestId;
  final String? summary;
  final String? detail;
  final String createdAt;
  final bool resolved;

  AttentionItem resolve() => AttentionItem(id: id, kind: kind, hostId: hostId, projectId: projectId, sessionId: sessionId, runId: runId, requestId: requestId, summary: summary, detail: detail, createdAt: createdAt, resolved: true);
}
