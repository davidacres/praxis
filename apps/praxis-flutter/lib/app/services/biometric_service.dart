import 'package:local_auth/local_auth.dart';

class BiometricService {
  static final BiometricService _instance = BiometricService._internal();
  late final LocalAuthentication _auth;
  bool _isSupported = false;
  List<BiometricType> _supportedBiometrics = [];

  BiometricService._internal() {
    _auth = LocalAuthentication();
    _initialize();
  }

  factory BiometricService() => _instance;

  Future<void> _initialize() async {
    try {
      _isSupported = await _auth.canCheckBiometrics;
      _supportedBiometrics = await _auth.getAvailableBiometrics();
    } catch (e) {
      _isSupported = false;
      _supportedBiometrics = [];
    }
  }

  bool get isSupported => _isSupported;
  List<BiometricType> get supportedBiometrics => _supportedBiometrics;

  Future<bool> authenticate({
    required String reason,
    bool stickyAuth = false,
  }) async {
    try {
      if (!_isSupported) return false;

      return await _auth.authenticate(
        localizedReason: reason,
        options: AuthenticationOptions(
          stickyAuth: stickyAuth,
          biometricOnly: true,
        ),
      );
    } catch (e) {
      return false;
    }
  }

  Future<bool> authenticateIfAvailable({
    required String reason,
  }) async {
    if (!_isSupported || _supportedBiometrics.isEmpty) {
      return true; // Skip if not supported
    }
    return authenticate(reason: reason);
  }
}
