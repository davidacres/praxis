import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:praxis_mobile/app/store.dart';
import 'package:praxis_mobile/app/theme.dart';
import 'package:praxis_mobile/core/models.dart';
import 'package:praxis_mobile/ui/gadget_view.dart';
import 'package:praxis_mobile/ui/image_lightbox.dart';
import 'package:praxis_mobile/ui/kit.dart';
import 'package:praxis_mobile/ui/transcript.dart';
import 'package:provider/provider.dart';

const _pixel =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

class _ImageStore extends AppStore {
  _ImageStore({required super.theme});

  final previews = <String>[];
  Completer<String?>? pendingAttachmentPreview;

  @override
  Future<String?> imagePreview(String sessionId, String path) async {
    previews.add('$sessionId:$path');
    return 'data:image/png;base64,$_pixel';
  }

  @override
  Future<String?> imageAttachmentPreview(
    String sessionId,
    SessionImageAttachment attachment,
  ) async {
    previews.add(
      '$sessionId:${attachment.eventIndex}:${attachment.attachmentIndex}',
    );
    if (attachment.attachmentIndex == 99 && pendingAttachmentPreview != null) {
      return pendingAttachmentPreview!.future;
    }
    return 'data:image/png;base64,$_pixel';
  }
}

void main() {
  testWidgets('renders images attached to user messages and expands on tap', (tester) async {
    final theme = ThemeController();
    final store = _ImageStore(theme: theme);
    final message = transcriptOf(
      SessionSnapshot({
        'sessionId': 's1',
        'messages': [
          {
            'id': 's1:event:2',
            'role': 'user',
            'text': 'What is this?',
            'at': '2026-09-22T09:00:00.000Z',
            'status': 'complete',
            'attachments': [
              {'eventIndex': 2, 'attachmentIndex': 0, 'mimeType': 'image/png'},
            ],
          },
        ],
      }),
    ).single;
    addTearDown(store.dispose);
    await tester.binding.setSurfaceSize(const Size(390, 844));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    await tester.pumpWidget(
      ChangeNotifierProvider<AppStore>.value(
        value: store,
        child: MaterialApp(
          home: PraxisTheme(
            data: theme.data,
            child: Scaffold(
              body: ChatMessage(
                message: message,
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byType(Image), findsOneWidget);
    expect(find.byType(RawImage), findsOneWidget);
    expect(store.previews, ['s1:2:0']);

    await tester.runAsync(() async {
      await Future<void>.delayed(const Duration(milliseconds: 100));
    });
    await tester.pumpAndSettle();

    // Tapping the attached image opens the expanded lightbox
    await tester.tap(find.byType(Image));
    await tester.pumpAndSettle();

    expect(find.byType(ImageLightbox), findsOneWidget);
    expect(find.bySemanticsLabel('Close image'), findsOneWidget);

    // Tapping the close button dismisses the lightbox
    await tester.tap(find.bySemanticsLabel('Close image'));
    await tester.pumpAndSettle();

    expect(find.byType(ImageLightbox), findsNothing);
  });

  testWidgets(
    'resolves Markdown images against the assistant message session',
    (tester) async {
      final theme = ThemeController();
      final store = _ImageStore(theme: theme);
      addTearDown(store.dispose);
      await tester.binding.setSurfaceSize(const Size(390, 844));
      addTearDown(() => tester.binding.setSurfaceSize(null));

      await tester.pumpWidget(
        ChangeNotifierProvider<AppStore>.value(
          value: store,
          child: MaterialApp(
            home: PraxisTheme(
              data: theme.data,
              child: Scaffold(
                body: ChatMessage(
                  message: TranscriptMessage(
                    id: 's1:event:3',
                    author: 'assistant',
                    text: '![result](artifacts/result.png)',
                    at: '09:01',
                    streaming: false,
                    sessionId: 's1',
                  ),
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byType(Image), findsOneWidget);
      expect(find.byType(RawImage), findsOneWidget);
      expect(store.previews, ['s1:artifacts/result.png']);

      await tester.runAsync(() async {
        await Future<void>.delayed(const Duration(milliseconds: 100));
      });
      await tester.pumpAndSettle();

      // Tapping the markdown image opens the lightbox showing the caption
      await tester.tap(find.byType(Image));
      await tester.pumpAndSettle();

      expect(find.byType(ImageLightbox), findsOneWidget);
      expect(find.text('result'), findsOneWidget);
      expect(find.bySemanticsLabel('Close image'), findsOneWidget);

      await tester.tap(find.bySemanticsLabel('Close image'));
      await tester.pumpAndSettle();

      expect(find.byType(ImageLightbox), findsNothing);
    },
  );

  testWidgets(
    'renders image artifacts in a gadget using the gadget session scope',
    (tester) async {
      final theme = ThemeController();
      final store = _ImageStore(theme: theme);
      addTearDown(store.dispose);
      await tester.binding.setSurfaceSize(const Size(390, 844));
      addTearDown(() => tester.binding.setSurfaceSize(null));

      await tester.pumpWidget(
        ChangeNotifierProvider<AppStore>.value(
          value: store,
          child: MaterialApp(
            home: PraxisTheme(
              data: theme.data,
              child: Scaffold(
                body: GadgetViewWidget(
                  view: GadgetView({
                    'state': 'active',
                    'gadget': {
                      'version': 1,
                      'gadgetId': 'g-image',
                      'kind': 'artifact',
                      'scope': {'hostId': 'host-1', 'sessionId': 's1'},
                      'fallbackText': 'Screenshot attached.',
                      'payload': {
                        'title': 'Visual evidence',
                        'artifacts': [
                          {
                            'name': 'result.png',
                            'path': 'artifacts/result.png',
                            'mediaType': 'image/png',
                            'sizeBytes': 128,
                          },
                        ],
                      },
                      'actions': <Object?>[],
                    },
                  }),
                  connected: true,
                  onAnswer: (_, _, _) async {},
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byType(Image), findsOneWidget);
      expect(find.byType(RawImage), findsOneWidget);
      expect(store.previews, ['s1:artifacts/result.png']);

      await tester.runAsync(() async {
        await Future<void>.delayed(const Duration(milliseconds: 100));
      });
      await tester.pumpAndSettle();

      // Tapping the artifact image opens the lightbox
      await tester.tap(find.byType(Image));
      await tester.pumpAndSettle();

      expect(find.byType(ImageLightbox), findsOneWidget);
      expect(
        find.descendant(
          of: find.byType(ImageLightbox),
          matching: find.text('result.png'),
        ),
        findsOneWidget,
      );
      expect(find.bySemanticsLabel('Close image'), findsOneWidget);

      await tester.tap(find.bySemanticsLabel('Close image'));
      await tester.pumpAndSettle();

      expect(find.byType(ImageLightbox), findsNothing);
    },
  );

  testWidgets(
    'image lightbox supports double tap zoom and reset',
    (tester) async {
      final theme = ThemeController();
      final store = _ImageStore(theme: theme);
      addTearDown(store.dispose);
      await tester.binding.setSurfaceSize(const Size(390, 844));
      addTearDown(() => tester.binding.setSurfaceSize(null));

      await tester.pumpWidget(
        ChangeNotifierProvider<AppStore>.value(
          value: store,
          child: MaterialApp(
            home: PraxisTheme(
              data: theme.data,
              child: Scaffold(
                body: ChatMessage(
                  message: TranscriptMessage(
                    id: 's1:event:3',
                    author: 'assistant',
                    text: '![diagram](artifacts/diagram.png)',
                    at: '09:01',
                    streaming: false,
                    sessionId: 's1',
                  ),
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      await tester.runAsync(() async {
        await Future<void>.delayed(const Duration(milliseconds: 100));
      });
      await tester.pumpAndSettle();

      await tester.tap(find.byType(Image));
      await tester.pumpAndSettle();

      expect(find.byType(ImageLightbox), findsOneWidget);
      expect(find.bySemanticsLabel('Reset zoom'), findsNothing);

      // Double-tap the viewer to zoom in
      await tester.tap(find.byType(InteractiveViewer));
      await tester.pump(const Duration(milliseconds: 50));
      await tester.tap(find.byType(InteractiveViewer));
      await tester.pumpAndSettle();

      expect(find.bySemanticsLabel('Reset zoom'), findsOneWidget);

      // Tap reset zoom
      await tester.tap(find.bySemanticsLabel('Reset zoom'));
      await tester.pumpAndSettle();

      expect(find.bySemanticsLabel('Reset zoom'), findsNothing);
    },
  );

  testWidgets(
    'attached images retain stable bytes and do not reload or flicker across rebuilds',
    (tester) async {
      final theme = ThemeController();
      final store = _ImageStore(theme: theme);
      addTearDown(store.dispose);
      await tester.binding.setSurfaceSize(const Size(390, 844));
      addTearDown(() => tester.binding.setSurfaceSize(null));

      Widget buildTree(String text) => ChangeNotifierProvider<AppStore>.value(
            value: store,
            child: MaterialApp(
              home: PraxisTheme(
                data: theme.data,
                child: Scaffold(
                  body: ChatMessage(
                    message: TranscriptMessage(
                      id: 's1:event:2',
                      author: 'user',
                      text: text,
                      at: '09:00',
                      streaming: false,
                      sessionId: 's1',
                      attachments: [
                        SessionImageAttachment({
                          'eventIndex': 2,
                          'attachmentIndex': 0,
                          'mimeType': 'image/png',
                        }),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          );

      await tester.pumpWidget(buildTree('Initial text'));
      await tester.runAsync(() async {
        await Future<void>.delayed(const Duration(milliseconds: 100));
      });
      await tester.pumpAndSettle();

      expect(store.previews, ['s1:2:0']);
      final image1 = tester.widget<Image>(find.byType(Image));
      final bytes1 = (image1.image as MemoryImage).bytes;
      expect(image1.gaplessPlayback, isTrue);

      // Rebuild several times (simulating streaming/state changes)
      for (var i = 1; i <= 5; i++) {
        await tester.pumpWidget(buildTree('Streaming text token $i'));
        await tester.pump();
      }

      // Preview should not have been requested again
      expect(store.previews, ['s1:2:0']);

      // The exact same Uint8List reference must be reused to prevent stream resets
      final image2 = tester.widget<Image>(find.byType(Image));
      final bytes2 = (image2.image as MemoryImage).bytes;
      expect(identical(bytes1, bytes2), isTrue);
    },
  );

  testWidgets(
    'markdown images retain stable bytes across text streaming updates',
    (tester) async {
      final theme = ThemeController();
      final store = _ImageStore(theme: theme);
      addTearDown(store.dispose);
      await tester.binding.setSurfaceSize(const Size(390, 844));
      addTearDown(() => tester.binding.setSurfaceSize(null));

      Widget buildTree(String text) => ChangeNotifierProvider<AppStore>.value(
            value: store,
            child: MaterialApp(
              home: PraxisTheme(
                data: theme.data,
                child: Scaffold(
                  body: ChatMessage(
                    message: TranscriptMessage(
                      id: 's1:event:3',
                      author: 'assistant',
                      text: text,
                      at: '09:01',
                      streaming: true,
                      sessionId: 's1',
                    ),
                  ),
                ),
              ),
            ),
          );

      await tester.pumpWidget(buildTree('![diagram](artifacts/diagram.png)'));
      await tester.runAsync(() async {
        await Future<void>.delayed(const Duration(milliseconds: 100));
      });
      await tester.pumpAndSettle();

      expect(store.previews, ['s1:artifacts/diagram.png']);
      final image1 = tester.widget<Image>(find.byType(Image));
      final bytes1 = (image1.image as MemoryImage).bytes;
      expect(image1.gaplessPlayback, isTrue);

      // Stream more tokens into the reply
      for (var i = 1; i <= 5; i++) {
        await tester.pumpWidget(
          buildTree('![diagram](artifacts/diagram.png)\n\nToken chunk $i of streaming reply...'),
        );
        await tester.pump();
      }

      // Preview should not have been requested again
      expect(store.previews, ['s1:artifacts/diagram.png']);

      // Byte instance must be identical across re-parses
      final image2 = tester.widget<Image>(find.byType(Image));
      final bytes2 = (image2.image as MemoryImage).bytes;
      expect(identical(bytes1, bytes2), isTrue);
    },
  );

  testWidgets(
    'attached image does not flash Image unavailable while loading',
    (tester) async {
      final theme = ThemeController();
      final store = _ImageStore(theme: theme);
      addTearDown(store.dispose);
      await tester.binding.setSurfaceSize(const Size(390, 844));
      addTearDown(() => tester.binding.setSurfaceSize(null));

      final completer = Completer<String?>();
      store.pendingAttachmentPreview = completer;

      await tester.pumpWidget(
        ChangeNotifierProvider<AppStore>.value(
          value: store,
          child: MaterialApp(
            home: PraxisTheme(
              data: theme.data,
              child: Scaffold(
                body: ChatMessage(
                  message: TranscriptMessage(
                    id: 's1:event:2',
                    author: 'user',
                    text: 'Checking image',
                    at: '09:00',
                    streaming: false,
                    sessionId: 's1',
                    attachments: [
                      SessionImageAttachment({
                        'eventIndex': 2,
                        'attachmentIndex': 99,
                        'mimeType': 'image/png',
                      }),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pump();

      // While loading, should show Spinner, NEVER "Image unavailable"
      expect(find.text('Image unavailable'), findsNothing);
      expect(find.byType(Spinner), findsOneWidget);

      completer.complete('data:image/png;base64,$_pixel');
    },
  );
}
