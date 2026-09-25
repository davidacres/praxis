import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:provider/provider.dart';

import '../app/connection.dart';
import '../app/discovery.dart';
import '../app/store.dart';
import '../app/theme.dart';
import '../core/invitation.dart';
import '../core/time.dart';
import '../ui/kit.dart';
import '../ui/wordmark.dart';

/// Pairing and reconnecting. Port of `screens/ConnectScreen.tsx`.
class ConnectScreen extends StatefulWidget {
  const ConnectScreen({super.key});

  @override
  State<ConnectScreen> createState() => _ConnectScreenState();
}

class _ConnectScreenState extends State<ConnectScreen> {
  final _address = TextEditingController();
  final _port = TextEditingController(text: '43100');
  final _hostId = TextEditingController();
  final _projectId = TextEditingController();
  final _invitationText = TextEditingController();
  String _hostName = '';
  InvitationDetails? _invitation;
  String? _formError;
  List<DiscoveredHost> _discovered = const [];
  bool _advancedOpen = false;
  void Function()? _stopDiscovery;

  @override
  void initState() {
    super.initState();
    final store = context.read<AppStore>();
    if (store.autoConnectEnabled) {
      loadHostConfiguration().then((config) {
        if (!mounted || config == null) return;
        _applySaved(config);
        store.connect(config);
      });
    }
    listenForHosts((host) {
      if (!mounted) return;
      setState(() => _discovered = [host, ..._discovered.where((item) => item.hostId != host.hostId)].take(5).toList());
    }).then((stop) {
      if (mounted) {
        _stopDiscovery = stop;
      } else {
        stop();
      }
    });
  }

  @override
  void dispose() {
    _stopDiscovery?.call();
    for (final controller in [_address, _port, _hostId, _projectId, _invitationText]) {
      controller.dispose();
    }
    super.dispose();
  }

  void _applySaved(HostConfiguration config) => setState(() {
    _address.text = config.address;
    _port.text = '${config.port}';
    _hostId.text = config.hostId;
    _hostName = config.hostName ?? '';
    _projectId.text = config.projectId ?? '';
    _invitation = InvitationDetails(hostPublicKeyHex: config.hostPublicKeyHex);
    _invitationText.text = config.hostPublicKeyHex;
  });

  void _importConnectionDetails(String value) {
    setState(() {
      _formError = null;
      final parsed = parseMobileInvitation(value);
      if (parsed.kind == InvitationKind.unrecognised) {
        _invitation = null;
        if (value.trim().isNotEmpty) {
          _formError = 'That is not a Praxis pairing invitation or host key. Copy the invitation from Settings → Mobile access on the desktop.';
        }
        return;
      }
      final details = parsed.details;
      _invitation = details;
      // A project belongs to one desktop: an invitation from another drops the old one's.
      if (details.hostId != null && details.hostId != _hostId.text) _projectId.text = '';
      if (details.hostId != null) _hostId.text = details.hostId!;
      if (details.hostName != null) _hostName = details.hostName!;
      if (details.address != null) _address.text = details.address!;
      if (details.port != null) _port.text = '${details.port}';
      if (parsed.kind == InvitationKind.invitation && parsed.expired) {
        _formError = 'This invitation expired at ${formatClock(details.expiresAt)}. Create a new one in Settings → Mobile access on the desktop.';
      }
    });
  }

  /// Forgets the paired desktop and everything the form remembered about it.
  void _forgetDesktop() {
    context.read<AppStore>().disconnect(forget: true);
    setState(() {
      _address.clear();
      _port.text = '43100';
      _hostId.clear();
      _hostName = '';
      _projectId.clear();
      _invitation = null;
      _invitationText.clear();
      _formError = null;
    });
  }

  Future<void> _openScanner() async {
    final data = await Navigator.of(context).push<String>(MaterialPageRoute(fullscreenDialog: true, builder: (_) => const _Scanner()));
    if (data != null && mounted) {
      _invitationText.text = data;
      _importConnectionDetails(data);
    }
  }

  void _submit() {
    setState(() => _formError = null);
    final port = int.tryParse(_port.text.trim());
    String? error;
    final invitation = _invitation;
    if (_address.text.trim().isEmpty) {
      error = 'Enter the desktop’s address, or scan its pairing invitation.';
    } else if (_hostId.text.trim().isEmpty) {
      error = 'Enter the desktop’s host ID, or scan its pairing invitation.';
    } else if (port == null || port < 1 || port > 65535) {
      error = 'The port must be a number from 1 to 65535.';
    } else if (invitation?.hostPublicKeyHex == null) {
      error = 'Scan or paste the desktop’s pairing invitation so this phone can pin its host key.';
    } else if (invitation!.expiresAt != null && (parseInstant(invitation.expiresAt) ?? 1 << 62) <= DateTime.now().millisecondsSinceEpoch) {
      error = 'This invitation has expired. Create a new one in Settings → Mobile access on the desktop.';
    }
    if (error != null) {
      setState(() => _formError = error);
      return;
    }
    context.read<AppStore>().connect(
      HostConfiguration(
        address: _address.text.trim(),
        port: port!,
        hostId: _hostId.text.trim(),
        hostName: _hostName.trim().isEmpty ? null : _hostName.trim(),
        hostPublicKeyHex: invitation!.hostPublicKeyHex!,
        projectId: _projectId.text.trim().isEmpty ? null : _projectId.text.trim(),
        pairingTokenId: invitation.tokenId,
        pairingExpiresAt: invitation.expiresAt,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final store = context.watch<AppStore>();
    final t = context.t;
    final p = t.palette;
    final connecting = store.connection == ShellConnection.connecting;
    final pairingPending = store.connection == ShellConnection.pairing;
    final issue = store.connectionIssue;
    final desktopName = [
      store.hostConfig?.hostName,
      _hostName,
      _address.text,
    ].firstWhere((value) => value != null && value.isNotEmpty, orElse: () => 'the desktop')!;

    if (!_advancedOpen) {
      return ColoredBox(
        color: p.bg,
        child: SingleChildScrollView(
          padding: EdgeInsets.all(t.space),
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 520),
            child: Stack(
              alignment: Alignment.center,
              children: [
                SizedBox(
                  width: double.infinity,
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 20),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        const PraxisWordmark(width: 210, height: 78),
                        const SizedBox(height: 12),
                        H1(issue != null ? 'We couldn’t connect' : 'Connect to Praxis', align: TextAlign.center),
                        const SizedBox(height: 12),
                        Body(
                          issue != null
                              ? 'The desktop is not reachable right now. Your work stays safely on the desktop until the connection returns.'
                              : 'Open your work from the paired Praxis desktop. Your files stay on the desktop.',
                          dim: true,
                          align: TextAlign.center,
                        ),
                        const SizedBox(height: 12),
                        if (pairingPending)
                          Padding(
                            padding: const EdgeInsets.only(top: 8),
                            child: PraxisCard(
                              children: [
                                Row(
                                  children: [
                                    Spinner(color: p.warn),
                                    const SizedBox(width: 10),
                                    Expanded(
                                      child: Text('Waiting for confirmation', style: ts(context, 15, scaled: false, weight: FontWeight.w700)),
                                    ),
                                  ],
                                ),
                                Body(store.pairing?.message ?? 'Confirm this phone in Settings → Mobile access on $desktopName.'),
                                PraxisButton(label: 'Cancel', ghost: true, onPressed: store.cancelConnect),
                              ],
                            ),
                          )
                        else if (connecting)
                          Padding(
                            padding: const EdgeInsets.only(top: 8),
                            child: PraxisCard(
                              children: [
                                Row(
                                  children: [
                                    Spinner(color: p.accent),
                                    const SizedBox(width: 10),
                                    Expanded(
                                      child: Text('Connecting to $desktopName…', style: ts(context, 15, scaled: false, weight: FontWeight.w700)),
                                    ),
                                  ],
                                ),
                                PraxisButton(label: 'Cancel', ghost: true, onPressed: store.cancelConnect),
                              ],
                            ),
                          )
                        else ...[
                          if (issue != null) ...[
                            Semantics(
                              liveRegion: true,
                              child: Text(
                                issue.title,
                                textAlign: TextAlign.center,
                                style: ts(context, 16, scaled: false, weight: FontWeight.w700),
                              ),
                            ),
                            const SizedBox(height: 12),
                          ],
                          PraxisButton(
                            label: issue != null ? 'Try again' : 'Connect',
                            onPressed: () {
                              if (store.hostConfig != null) {
                                store.retryConnection();
                              } else {
                                setState(() => _advancedOpen = true);
                              }
                            },
                          ),
                          const SizedBox(height: 12),
                          PraxisButton(label: 'Add connection', ghost: true, onPressed: () => setState(() => _advancedOpen = true)),
                        ],
                      ],
                    ),
                  ),
                ),
                Positioned(
                  right: 4,
                  bottom: 10,
                  child: Pressable(
                    label: 'Advanced settings',
                    onTap: () => setState(() => _advancedOpen = true),
                    excludeChildSemantics: true,
                    builder: (context, _) => Container(
                      width: 46,
                      height: 46,
                      alignment: Alignment.center,
                      decoration: BoxDecoration(
                        color: p.surface,
                        shape: BoxShape.circle,
                        border: Border.all(color: p.border),
                      ),
                      child: Text('⚙', style: ts(context, 22, scaled: false, color: p.textSecondary)),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      );
    }

    final labelStyle = ts(context, 10, scaled: false, weight: FontWeight.w700, letterSpacing: 0.7, color: p.textDim);
    Widget label(String text) => Padding(
      padding: const EdgeInsets.only(top: 5),
      child: Text(text, style: labelStyle),
    );

    return ScreenScroll(
      children: [
        Container(
          constraints: const BoxConstraints(minHeight: 54),
          decoration: BoxDecoration(
            border: Border(bottom: BorderSide(color: p.border)),
          ),
          child: Row(
            children: [
              Pressable(
                label: 'Back to connection',
                onTap: () => setState(() => _advancedOpen = false),
                excludeChildSemantics: true,
                builder: (context, _) => SizedBox(
                  width: 38,
                  height: 38,
                  child: Center(
                    child: Text(
                      '‹',
                      style: ts(context, 28, scaled: false, weight: FontWeight.w300, color: p.textSecondary),
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 8),
              Text('Connection settings', style: ts(context, 16, scaled: false, weight: FontWeight.w700)),
            ],
          ),
        ),
        if (_discovered.isNotEmpty)
          PraxisCard(
            children: [
              Text('DESKTOPS ON THIS NETWORK', style: labelStyle),
              for (final item in _discovered)
                Pressable(
                  label: item.displayName,
                  onTap: () => setState(() {
                    _hostId.text = item.hostId;
                    _hostName = item.displayName;
                    if (item.addresses.isNotEmpty) _address.text = item.addresses.first;
                    _port.text = '${item.port}';
                  }),
                  builder: (context, pressed) => Container(
                    padding: const EdgeInsets.all(10),
                    decoration: BoxDecoration(
                      color: pressed ? p.surfaceRaised : p.input,
                      borderRadius: BorderRadius.circular(8),
                      border: Border.all(color: p.border),
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(item.displayName, style: ts(context, 14, scaled: false, weight: FontWeight.w700)),
                        const SizedBox(height: 3),
                        Text(
                          '${item.addresses.isNotEmpty ? item.addresses.first : 'Address unavailable'}:${item.port} · ${item.fingerprint}',
                          style: ts(context, 10, scaled: false, color: p.textDim),
                        ),
                      ],
                    ),
                  ),
                ),
              const Body('Discovery identifies a host only. Scan or paste its current pairing invitation to pin the full host key.', dim: true),
            ],
          ),
        PraxisCard(
          children: [
            PraxisButton(label: 'Scan pairing QR', ghost: true, onPressed: _openScanner),
            label('PAIRING INVITATION OR HOST KEY'),
            _Field(
              label: 'Pairing invitation or desktop host key',
              controller: _invitationText,
              placeholder: 'Paste the invitation copied from Praxis desktop',
              multiline: true,
              onChanged: _importConnectionDetails,
            ),
            if (_invitation?.tokenId != null)
              Body(
                'Invitation ${_invitation!.tokenId}${formatClock(_invitation!.expiresAt).isNotEmpty ? ' · expires ${formatClock(_invitation!.expiresAt)}' : ''}',
                dim: true,
              )
            else if (_invitation?.hostPublicKeyHex != null)
              const Body('Host key pinned. A phone the desktop already trusts reconnects without an invitation.', dim: true),
            label('DESKTOP ADDRESS'),
            _Field(label: 'Desktop address', controller: _address, placeholder: '192.168.1.2'),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      label('PORT'),
                      const SizedBox(height: 6),
                      _Field(label: 'Desktop port', controller: _port, number: true),
                    ],
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      label('HOST ID'),
                      const SizedBox(height: 6),
                      _Field(label: 'Host ID', controller: _hostId),
                    ],
                  ),
                ),
              ],
            ),
            label('PROJECT ID'),
            _Field(label: 'Project ID', controller: _projectId, placeholder: 'Optional — first granted project'),
            if (_formError != null)
              Semantics(
                liveRegion: true,
                child: Text(_formError!, style: ts(context, 12, scaled: false, lineHeight: 17, color: p.danger)),
              ),
            const Body('The phone’s identity key stays in this device’s secure storage.', dim: true),
            if (store.hostConfig != null && issue?.action == IssueAction.rescan)
              PraxisButton(label: 'Forget this desktop', ghost: true, onPressed: _forgetDesktop),
            PraxisButton(
              label: connecting || pairingPending
                  ? 'Connecting…'
                  : _invitation?.tokenId != null
                  ? 'Pair and connect'
                  : 'Connect',
              disabled: connecting || pairingPending,
              onPressed: _submit,
            ),
          ],
        ),
      ],
    );
  }
}

class _Field extends StatelessWidget {
  const _Field({required this.label, required this.controller, this.placeholder, this.multiline = false, this.number = false, this.onChanged});
  final String label;
  final TextEditingController controller;
  final String? placeholder;
  final bool multiline;
  final bool number;
  final ValueChanged<String>? onChanged;

  @override
  Widget build(BuildContext context) {
    final p = context.p;
    return Semantics(
      label: label,
      textField: true,
      child: Container(
        constraints: BoxConstraints(minHeight: multiline ? 82 : 42),
        padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 9),
        decoration: BoxDecoration(
          color: p.input,
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: p.border),
        ),
        child: CupertinoTextField.borderless(
          textAlignVertical: TextAlignVertical.top,
          controller: controller,
          padding: EdgeInsets.zero,
          placeholder: placeholder,
          placeholderStyle: ts(context, multiline ? 12 : 14, scaled: false, color: p.textDim),
          style: ts(context, multiline ? 12 : 14, scaled: false),
          autocorrect: false,
          enableSuggestions: false,
          textCapitalization: TextCapitalization.none,
          keyboardType: number
              ? TextInputType.number
              : multiline
              ? TextInputType.multiline
              : TextInputType.url,
          maxLines: multiline ? null : 1,
          cursorColor: p.accent,
          onChanged: onChanged,
        ),
      ),
    );
  }
}

class _Scanner extends StatefulWidget {
  const _Scanner();
  @override
  State<_Scanner> createState() => _ScannerState();
}

class _ScannerState extends State<_Scanner> {
  // One controller for the page's life: building a new one on every rebuild restarts
  // the camera session, so the preview never settles and detections are dropped.
  final MobileScannerController _controller = MobileScannerController(formats: const [BarcodeFormat.qrCode], detectionSpeed: DetectionSpeed.noDuplicates);
  bool _done = false;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final p = context.p;
    return Scaffold(
      backgroundColor: p.camera,
      body: Stack(
        alignment: Alignment.center,
        children: [
          Positioned.fill(
            child: MobileScanner(
              controller: _controller,
              fit: BoxFit.cover,
              errorBuilder: (context, error) => Center(
                child: Padding(
                  padding: const EdgeInsets.all(24),
                  child: Text(
                    'Camera access is off for Praxis. Paste the invitation copied from the desktop instead, or allow the camera in iOS Settings.',
                    textAlign: TextAlign.center,
                    style: ts(context, 14, scaled: false, color: p.danger),
                  ),
                ),
              ),
              onDetect: (capture) {
                final value = capture.barcodes.map((barcode) => barcode.rawValue).whereType<String>().firstOrNull;
                if (value == null || _done) return;
                _done = true;
                _controller.stop();
                Navigator.of(context).pop(value);
              },
            ),
          ),
          Container(
            width: 250,
            height: 250,
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(18),
              border: Border.all(color: p.accent, width: 2),
            ),
          ),
          Positioned(
            bottom: 48,
            child: Pressable(
              label: 'Cancel',
              onTap: () => Navigator.of(context).pop(),
              excludeChildSemantics: true,
              builder: (context, _) => Container(
                padding: const EdgeInsets.symmetric(horizontal: 22, vertical: 12),
                decoration: BoxDecoration(color: p.bgSunken, borderRadius: BorderRadius.circular(10)),
                child: Text('Cancel', style: ts(context, 15, scaled: false, weight: FontWeight.w700)),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
