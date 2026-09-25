import 'package:flutter/foundation.dart';

typedef MobileSessionMode = String;

class MobileHostSummary {
  final String hostId;
  final String hostName;
  final bool online;

  MobileHostSummary({
    required this.hostId,
    required this.hostName,
    required this.online,
  });
}

class MobileProjectSummary {
  final String projectId;
  final String name;
  final String? workflow;

  MobileProjectSummary({
    required this.projectId,
    required this.name,
    this.workflow,
  });
}

class MobileWorkflowChoice {
  final String workflowId;
  final String name;
  final String trigger;

  MobileWorkflowChoice({
    required this.workflowId,
    required this.name,
    required this.trigger,
  });
}

class MobileRunSummary {
  final String runId;
  final String workflowName;
  final String status;
  final String explanation;
  final List<WorkflowStage> stages;

  MobileRunSummary({
    required this.runId,
    required this.workflowName,
    required this.status,
    required this.explanation,
    required this.stages,
  });
}

class WorkflowStage {
  final String nodeId;
  final String name;
  final String outcome;
  final String lane;
  final List<Artifact> artifacts;

  WorkflowStage({
    required this.nodeId,
    required this.name,
    required this.outcome,
    required this.lane,
    required this.artifacts,
  });
}

class Artifact {
  final String contractId;
  final String kind;
  final String? path;

  Artifact({
    required this.contractId,
    required this.kind,
    this.path,
  });
}

class MobileWorkItem {
  final String workId;
  final String title;
  final String status;
  final String sessionId;
  final String? runId;
  final String? provider;
  final String? model;
  final MobileSessionMode mode;
  final bool? draft;

  MobileWorkItem({
    required this.workId,
    required this.title,
    required this.status,
    required this.sessionId,
    this.runId,
    this.provider,
    this.model,
    required this.mode,
    this.draft,
  });
}

class TranscriptMessage {
  final String id;
  final String role;
  final String text;
  final String timestamp;

  TranscriptMessage({
    required this.id,
    required this.role,
    required this.text,
    required this.timestamp,
  });
}

class MobileActivityEntry {
  final String id;
  final String at;
  final String workId;
  final String title;
  final String text;

  MobileActivityEntry({
    required this.id,
    required this.at,
    required this.workId,
    required this.title,
    required this.text,
  });
}

class Remote<T> {
  final String status; // 'idle', 'loading', 'ready', 'unsupported', 'error'
  final T? value;
  final String? message;

  Remote({
    required this.status,
    this.value,
    this.message,
  });
}

class MobileHostConfiguration {
  final String hostId;
  final String? hostName;
  final String address;
  final int port;
  final String hostPublicKeyHex;
  final String? projectId;
  final String? pairingTokenId;
  final String? pairingExpiresAt;

  MobileHostConfiguration({
    required this.hostId,
    this.hostName,
    required this.address,
    required this.port,
    required this.hostPublicKeyHex,
    this.projectId,
    this.pairingTokenId,
    this.pairingExpiresAt,
  });

  Map<String, dynamic> toJson() => {
    'hostId': hostId,
    'hostName': hostName,
    'address': address,
    'port': port,
    'hostPublicKeyHex': hostPublicKeyHex,
    'projectId': projectId,
    'pairingTokenId': pairingTokenId,
    'pairingExpiresAt': pairingExpiresAt,
  };

  factory MobileHostConfiguration.fromJson(Map<String, dynamic> json) =>
      MobileHostConfiguration(
        hostId: json['hostId'],
        hostName: json['hostName'],
        address: json['address'],
        port: json['port'],
        hostPublicKeyHex: json['hostPublicKeyHex'],
        projectId: json['projectId'],
        pairingTokenId: json['pairingTokenId'],
        pairingExpiresAt: json['pairingExpiresAt'],
      );
}
