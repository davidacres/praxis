import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:praxis_mobile/app/store.dart';
import 'package:praxis_mobile/app/theme.dart';
import 'package:praxis_mobile/core/models.dart';
import 'package:praxis_mobile/ui/gadget_view.dart';
import 'package:praxis_mobile/ui/transcript.dart';
import 'package:provider/provider.dart';

const _pixel =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

class _ImageStore extends AppStore {
  _ImageStore({required super.theme});

  final previews = <String>[];

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
    return 'data:image/png;base64,$_pixel';
  }
}

void main() {
  testWidgets('renders images attached to user messages', (tester) async {
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
    },
  );
}
