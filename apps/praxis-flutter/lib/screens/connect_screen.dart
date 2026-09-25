import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../app/store/store_provider.dart';
import '../app/store/types.dart';

class ConnectScreen extends StatefulWidget {
  const ConnectScreen({Key? key}) : super(key: key);

  @override
  State<ConnectScreen> createState() => _ConnectScreenState();
}

class _ConnectScreenState extends State<ConnectScreen> {
  final _hostController = TextEditingController();
  final _portController = TextEditingController(text: '9876');
  final _keyController = TextEditingController();
  String? _connectionError;
  bool _isConnecting = false;

  @override
  void dispose() {
    _hostController.dispose();
    _portController.dispose();
    _keyController.dispose();
    super.dispose();
  }

  Future<void> _handleConnect(BuildContext context) async {
    final host = _hostController.text.trim();
    final port = int.tryParse(_portController.text.trim()) ?? 9876;
    final key = _keyController.text.trim();

    if (host.isEmpty || key.isEmpty) {
      setState(() {
        _connectionError = 'Please enter host address and public key';
      });
      return;
    }

    setState(() {
      _isConnecting = true;
      _connectionError = null;
    });

    try {
      final store = context.read<AppStore>();
      final config = MobileHostConfiguration(
        hostId: host,
        address: host,
        port: port,
        hostPublicKeyHex: key,
      );
      await store.connect(config);
    } catch (e) {
      setState(() {
        _connectionError = 'Connection failed: $e';
      });
    } finally {
      setState(() {
        _isConnecting = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Connect to Praxis Desktop'),
        elevation: 0,
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(24),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const SizedBox(height: 32),
            Center(
              child: Text(
                'Praxis',
                style: theme.textTheme.displayMedium,
              ),
            ),
            const SizedBox(height: 8),
            Center(
              child: Text(
                'Mobile Companion',
                style: theme.textTheme.titleMedium?.copyWith(
                  color: theme.textTheme.bodyMedium?.color?.withAlpha(180),
                ),
              ),
            ),
            const SizedBox(height: 48),
            Text(
              'Desktop Address',
              style: theme.textTheme.titleSmall,
            ),
            const SizedBox(height: 8),
            TextField(
              controller: _hostController,
              decoration: const InputDecoration(
                hintText: '192.168.1.100 or localhost',
              ),
            ),
            const SizedBox(height: 24),
            Text(
              'Port',
              style: theme.textTheme.titleSmall,
            ),
            const SizedBox(height: 8),
            TextField(
              controller: _portController,
              keyboardType: TextInputType.number,
              decoration: const InputDecoration(
                hintText: '9876',
              ),
            ),
            const SizedBox(height: 24),
            Text(
              'Host Public Key',
              style: theme.textTheme.titleSmall,
            ),
            const SizedBox(height: 8),
            TextField(
              controller: _keyController,
              maxLines: 3,
              decoration: const InputDecoration(
                hintText: 'Paste the 32-byte hex key from the desktop',
              ),
            ),
            if (_connectionError != null) ...[
              const SizedBox(height: 16),
              Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: Colors.red.withAlpha(20),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Text(
                  _connectionError!,
                  style: theme.textTheme.bodySmall?.copyWith(color: Colors.red),
                ),
              ),
            ],
            const SizedBox(height: 32),
            ElevatedButton(
              onPressed: _isConnecting ? null : () => _handleConnect(context),
              child: Padding(
                padding: const EdgeInsets.symmetric(vertical: 12),
                child: _isConnecting
                    ? const SizedBox(
                        height: 20,
                        width: 20,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Text('Connect'),
              ),
            ),
            const SizedBox(height: 16),
            Center(
              child: Text(
                'The desktop will display a pairing code and public key',
                style: theme.textTheme.bodySmall,
                textAlign: TextAlign.center,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
