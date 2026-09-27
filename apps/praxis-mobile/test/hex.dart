import 'dart:typed_data';

Uint8List fromHex(String hex) =>
    Uint8List.fromList(List<int>.generate(hex.length ~/ 2, (i) => int.parse(hex.substring(i * 2, i * 2 + 2), radix: 16)));

String toHex(List<int> bytes) => bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
