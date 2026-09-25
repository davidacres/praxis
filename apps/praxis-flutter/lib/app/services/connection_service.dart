import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import '../store/types.dart';

const String _hostConfigKey = 'praxis.mobile.hostConfiguration.v1';
const String _deviceKeyKey = 'praxis.mobile.devicePrivateKey.v1';

class ConnectionService {
  static final ConnectionService _instance = ConnectionService._internal();
  final FlutterSecureStorage _storage = const FlutterSecureStorage();

  Socket? _socket;
  StreamSubscription? _socketSubscription;
  final _onEventController = StreamController<Map<String, dynamic>>.broadcast();

  Stream<Map<String, dynamic>> get onEvent => _onEventController.stream;
  bool get isConnected => _socket != null;

  ConnectionService._internal();

  factory ConnectionService() {
    return _instance;
  }

  Future<MobileHostConfiguration?> loadConfiguration() async {
    try {
      final stored = await _storage.read(key: _hostConfigKey);
      if (stored == null) return null;
      final json = jsonDecode(stored) as Map<String, dynamic>;
      return MobileHostConfiguration.fromJson(json);
    } catch (e) {
      return null;
    }
  }

  Future<void> saveConfiguration(MobileHostConfiguration config) async {
    await _storage.write(
      key: _hostConfigKey,
      value: jsonEncode(config.toJson()),
    );
  }

  Future<void> connect(MobileHostConfiguration config) async {
    try {
      _socket = await Socket.connect(config.address, config.port);
      await saveConfiguration(config);

      _socketSubscription = _socket!.listen(
        (data) {
          _handleData(data);
        },
        onError: (error) {
          _handleError(error);
        },
        onDone: () {
          _handleDone();
        },
      );
    } catch (e) {
      throw Exception('Failed to connect: $e');
    }
  }

  void _handleData(List<int> data) {
    try {
      final text = utf8.decode(data);
      final lines = text.split('\n');
      for (final line in lines) {
        if (line.trim().isEmpty) continue;
        final json = jsonDecode(line) as Map<String, dynamic>;
        _onEventController.add(json);
      }
    } catch (e) {
      // Handle parse error
    }
  }

  void _handleError(dynamic error) {
    _onEventController.addError(error);
  }

  void _handleDone() {
    disconnect();
  }

  Future<void> sendCommand(Map<String, dynamic> command) async {
    if (!isConnected) {
      throw Exception('Not connected');
    }
    try {
      final json = jsonEncode(command);
      _socket!.write('$json\n');
      await _socket!.flush();
    } catch (e) {
      throw Exception('Failed to send command: $e');
    }
  }

  Future<void> disconnect() async {
    await _socketSubscription?.cancel();
    await _socket?.close();
    _socket = null;
  }

  Future<void> forgetConfiguration() async {
    await _storage.delete(key: _hostConfigKey);
  }

  void dispose() {
    _socketSubscription?.cancel();
    _socket?.close();
    _onEventController.close();
  }
}
