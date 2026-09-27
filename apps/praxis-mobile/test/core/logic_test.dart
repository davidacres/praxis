// Ports of the Expo app's renderer tests (apps/praxis-mobile/renderer/*.test.ts),
// so the Flutter logic is held to the same cases.
import 'dart:ui';

import 'package:flutter_test/flutter_test.dart';
import 'package:praxis_mobile/core/attention.dart';
import 'package:praxis_mobile/core/gadgets.dart';
import 'package:praxis_mobile/core/invitation.dart';
import 'package:praxis_mobile/core/markdown.dart';
import 'package:praxis_mobile/core/models.dart';
import 'package:praxis_mobile/core/palette.dart';
import 'package:praxis_mobile/core/session_options.dart';
import 'package:praxis_mobile/core/usage.dart';
import 'package:praxis_mobile/core/workflow_runs.dart';
import 'package:praxis_mobile/protocol/wire.dart';

String typeOf(Object block) => switch (block) {
      MdHeading() => 'heading',
      MdParagraph() => 'paragraph',
      MdCodeBlock() => 'code',
      MdList() => 'list',
      MdQuote() => 'quote',
      MdTable() => 'table',
      MdRule() => 'rule',
      MdText() => 'text',
      MdCode() => 'code',
      MdStyled(:final style) => switch (style) { MdStyle.strong => 'strong', MdStyle.em => 'em', MdStyle.strike => 'strike' },
      MdLink() => 'link',
      _ => '?',
    };

void main() {
  group('markdown', () {
    test('headings, paragraphs and rules', () {
      final blocks = parseBlocks('# Title\n\nFirst line\nsecond line\n\n---\n\n### Small');
      expect(blocks.map(typeOf), ['heading', 'paragraph', 'rule', 'heading']);
      expect((blocks[0] as MdHeading).level, 1);
      expect(inlineText((blocks[1] as MdParagraph).children), 'First line\nsecond line');
    });

    test('fenced code keeps its text and language verbatim', () {
      final code = parseBlocks('```ts\nconst a = **b**;\n# not a heading\n```').single as MdCodeBlock;
      expect(code.language, 'ts');
      expect(code.text, 'const a = **b**;\n# not a heading');
    });

    test('an unclosed fence (still streaming) is code to the end', () {
      final blocks = parseBlocks('Look:\n```\nline 1\nline 2');
      expect(blocks.map(typeOf), ['paragraph', 'code']);
      expect((blocks[1] as MdCodeBlock).text, 'line 1\nline 2');
    });

    test('bullet, numbered, task and nested lists', () {
      final blocks = parseBlocks('- one\n- [x] two\n  - nested\n- three\n\n3. c\n4. d');
      final bullets = blocks[0] as MdList;
      final numbers = blocks[1] as MdList;
      expect(bullets.ordered, false);
      expect(bullets.items.map((item) => inlineText(item.children)), ['one', 'two', 'three']);
      expect(bullets.items[1].checked, true);
      expect(inlineText(bullets.items[1].sublist!.items[0].children), 'nested');
      expect(numbers.ordered, true);
      expect(numbers.start, 3);
    });

    test('tables with alignment and escaped pipes', () {
      final table = parseBlocks('| File | Lines |\n| :--- | ---: |\n| `a\\|b.ts` | 12 |\n| c.ts | 3 |').single as MdTable;
      expect(table.align, [MdAlign.left, MdAlign.right]);
      expect(inlineText(table.rows[0][0]), 'a|b.ts');
      expect(table.rows.length, 2);
    });

    test('block quotes hold blocks', () {
      final quote = parseBlocks('> **Note**\n> keep going').single as MdQuote;
      expect(quote.blocks.first, isA<MdParagraph>());
    });

    test('inline bold, italic, code, strikethrough and links', () {
      final spans = parseInline('**bold** and *it* and `x*y` and ~~old~~ [site](https://praxis.dev)');
      expect(spans.map(typeOf), ['strong', 'text', 'em', 'text', 'code', 'text', 'strike', 'text', 'link']);
      expect((spans[4] as MdCode).text, 'x*y');
    });

    test('snake_case and unclosed markers stay as text', () {
      expect(inlineText(parseInline('call my_long_name now')), 'call my_long_name now');
      expect(parseInline('call my_long_name now').map(typeOf), ['text']);
      expect(parseInline('2 * 3 = 6').map(typeOf), ['text']);
    });

    test('unsafe links become plain text', () {
      expect(isSafeLink('javascript:alert(1)'), false);
      expect(isSafeLink('https://example.com'), true);
      expect(parseInline('[click](javascript:alert(1))').any((span) => span is MdLink), false);
    });
  });

  group('usage', () {
    SessionSnapshot snapshot([Json overrides = const {}]) => SessionSnapshot({
          'sessionId': 's1', 'sessionKey': 'SESSION-1', 'title': 'x', 'lifecycle': 'completed', 'mode': 'chat', 'archived': false,
          'startedAt': '2026-09-23T09:00:00.000Z', 'sequence': 10, 'messages': <Object?>[], 'pendingPermissions': <Object?>[], 'canContinue': true, 'canCancel': false,
          'provider': 'claude-code-cli', 'model': 'opus', ...overrides,
        });

    test('formats token counts and costs compactly', () {
      expect(formatTokenCount(950), '950');
      expect(formatTokenCount(1234), '1.2k');
      expect(formatTokenCount(4600000), '4.6m');
      expect(formatTokenCount(250000), '250k');
      expect(formatCost(Cost({'currency': 'USD', 'amount': 2.81})), r'US$2.81');
      expect(formatCost(Cost({'currency': 'USD', 'amount': 0.004})), r'<US$0.01');
      expect(formatCost(Cost({'currency': 'eur', 'amount': 1.5})), '1.50 EUR');
    });

    test('real provider, model, token and cost figures when the desktop reports them', () {
      final view = describeUsage(
        source: latestUsage(snapshot({'tokenUsage': {'inputTokens': 1200, 'outputTokens': 300, 'totalTokens': 1500}, 'contextTokens': 9000, 'contextLimit': 200000, 'cost': {'currency': 'USD', 'amount': 0.42}}), null),
        loading: false,
        providerLabel: 'Claude Code (local)',
      );
      expect(view.state, UsageState.ready);
      expect(view.summary, r'opus · 1.5k tokens · US$0.42');
      expect(view.details.map((row) => row.label), ['Provider', 'Model', 'Input tokens', 'Output tokens', 'Total tokens', 'Context', 'Cost']);
      expect(view.details.firstWhere((row) => row.label == 'Context').value, '9k of 200k');
    });

    test('a provider that reports no cost says so rather than showing zero', () {
      final view = describeUsage(source: latestUsage(snapshot({'provider': 'anthropic', 'model': 'claude-opus-4-6', 'tokenUsage': {'totalTokens': 50}}), null), loading: false, providerLabel: 'Anthropic');
      expect(view.costReported, false);
      expect(view.cost, 'Cost not reported by Anthropic');
      expect(view.summary, 'claude-opus-4-6 · 50 tokens · no cost data');
    });

    test('loading, absent and draft states are distinct', () {
      expect(describeUsage(source: null, loading: true).state, UsageState.loading);
      final absent = describeUsage(source: latestUsage(snapshot(), null), loading: false);
      expect(absent.state, UsageState.empty);
      expect(absent.summary, contains('no usage recorded yet'));
      expect(describeUsage(source: null, loading: false, draft: true, providerLabel: 'Anthropic').summary, 'Usage appears after the first reply.');
    });

    test('a streamed snapshot supersedes an older usage read and vice versa', () {
      Json read = {'sessionId': 's1', 'lifecycle': 'completed', 'costStatus': 'not-reported', 'tokenUsage': {'totalTokens': 100}, 'sequence': 5, 'providerLabel': 'Codex CLI (local)'};
      final streamed = snapshot({'sequence': 9, 'tokenUsage': {'totalTokens': 900}});
      expect(latestUsage(streamed, SessionUsage(read))!.tokenUsage!.totalTokens, 900);
      expect(latestUsage(streamed, SessionUsage(read))!.providerLabel, 'Codex CLI (local)');
      expect(latestUsage(streamed, SessionUsage({...read, 'sequence': 12, 'tokenUsage': {'totalTokens': 1200}}))!.tokenUsage!.totalTokens, 1200);
    });
  });

  group('theme', () {
    final praxisLight = <String, dynamic>{
      'themeId': 'praxis-light',
      'themeName': 'Praxis Light',
      'mode': 'light',
      'colors': {
        'bg': '#f5f2eb', 'bgElevated': '#fffdf8', 'bgSunken': '#ebe7de', 'bgInput': '#fffdf8', 'border': '#d5c8b8',
        'borderStrong': '#ad9a85', 'text': '#2c2620', 'textSecondary': '#74695e', 'textTertiary': '#958878',
        'accent': '#c6431f', 'accentContrast': '#fffdf8', 'success': '#467a5b', 'warning': '#9b6b22', 'danger': '#b94a48',
      },
    };

    test('a desktop theme maps straight onto the phone palette', () {
      final palette = Palette.fromAppearance(readMobileAppearance(praxisLight)!);
      expect(palette.bg, hexColor('#f5f2eb'));
      expect(palette.surface, hexColor('#fffdf8'));
      expect(palette.textDim, hexColor('#958878'));
      expect(palette.onAccent, hexColor('#fffdf8'));
      expect(palette.accentSoft, hexColor(mixHex('#f5f2eb', '#c6431f', 0.12)));
      expect(palette.chrome.a, closeTo(0.95, 0.01));
      expect(Palette.praxisDark.bg, hexColor('#100e0b'));
    });

    test('mixHex blends channel by channel', () {
      expect(mixHex('#000000', '#ffffff', 0.5), '#808080');
      expect(mixHex('#102030', '#102030', 0.7), '#102030');
    });

    test('only a complete, hex-coloured appearance is worn', () {
      expect(readMobileAppearance(praxisLight), isNotNull);
      expect(readMobileAppearance({...praxisLight, 'colors': {...praxisLight['colors'] as Map, 'accent': 'tomato'}}), isNull);
      expect(readMobileAppearance({...praxisLight, 'mode': 'sepia'}), isNull);
      expect(readMobileAppearance(null), isNull);
      expect(readMobileAppearance({...praxisLight, 'themeName': ''})!.themeName, 'praxis-light');
    });

    const cornerSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="760" height="760"><rect width="760" height="760"/></svg>';
    test('the motif keeps its corners; a malformed one is dropped while the colours stay', () {
      final layer = {'svg': cornerSvg, 'width': 760, 'height': 760, 'anchor': 'top-right', 'repeat': false};
      final kept = readMobileAppearance({...praxisLight, 'motif': {'opacity': 0.27, 'layers': [layer, {...layer, 'anchor': 'bottom-left'}]}});
      expect(kept!.motif!.layers.map((layer) => layer.anchor), ['top-right', 'bottom-left']);
      final bad = readMobileAppearance({...praxisLight, 'motif': {'opacity': 0.27, 'layers': [{...layer, 'svg': 'javascript:alert(1)'}]}});
      expect(bad!.motif, isNull);
      expect(bad.colors['accent'], '#c6431f');
    });

    test('a repeating layer is wrapped in a pattern covering the whole surface', () {
      const tile = MotifLayer(svg: '<svg xmlns="http://www.w3.org/2000/svg" width="38" height="66"><path d="M0 0"/></svg>', width: 38, height: 66, anchor: 'center', repeat: true);
      final xml = tiledMotifSvg(tile, 430, 900);
      expect(xml, contains('<pattern id="mt" width="38" height="66" patternUnits="userSpaceOnUse"><path d="M0 0"/></pattern>'));
      expect(xml, contains('<rect width="430" height="900" fill="url(#mt)"/>'));
    });

    test('a corner motif keeps its share of the screen', () {
      const lattice = MotifLayer(
        svg: '<svg xmlns="http://www.w3.org/2000/svg" width="760" height="760" viewBox="0 0 760 760"><defs>'
            '<mask id="sm"><rect width="760" height="760" fill="url(#sf)"/></mask>'
            '<pattern id="sp" width="76" height="131.64" patternUnits="userSpaceOnUse"><path d="M0 0"/></pattern></defs>'
            '<rect width="760" height="760" fill="url(#sp)" mask="url(#sm)"/></svg>',
        width: 760, height: 760, anchor: 'top-right', repeat: false,
      );
      const motif = Motif(opacity: 0.27, layers: [lattice], viewport: Size(1664, 936));
      final scale = motifSpreadScale(motif, 430, 630);
      expect(scale, closeTo(1060 / 2600, 1e-9));
      final fitted = fitCornerMotifSvg(lattice, scale);
      expect(fitted.size, (760 * scale).roundToDouble());
      expect(fitted.svg.contains('760'), false);
      expect(fitted.svg, contains('<pattern id="sp" width="76" height="131.64"'));
      expect(motifSpreadScale(const Motif(opacity: 0.27, layers: [lattice]), 430, 630), 1);
      expect(fitCornerMotifSvg(lattice, 1).svg, lattice.svg);
    });
  });

  group('workflow runs', () {
    Json stage(String nodeId, [Json patch = const {}]) =>
        {'nodeId': nodeId, 'name': nodeId[0].toUpperCase() + nodeId.substring(1), 'type': 'agent-task', 'lane': 'idle', 'attempts': 0, ...patch};
    RunSnapshot run([Json patch = const {}]) => RunSnapshot({
          'runId': '8b14fe21-527f-4f52-b20c-0f1decc4e9fd',
          'projectId': 'p1',
          'workflowName': 'Governed delivery — FX-BF-035',
          'status': 'running',
          'paused': false,
          'explanation': 'Implement is running.',
          'startedAt': '2026-09-23T22:55:59.686Z',
          'currentNodeId': 'implement',
          'stages': [
            stage('plan', {'lane': 'done', 'attempts': 3, 'sessionId': 's-plan', 'sessionKey': 'WF-8B14FE21-plan', 'provider': 'claude-code-cli'}),
            stage('implement', {'lane': 'running', 'attempts': 2, 'sessionId': 's-impl', 'sessionKey': 'WF-8B14FE21-implement', 'provider': 'claude-code-cli'}),
            stage('qa', {'type': 'check', 'lane': 'idle'}),
            stage('approve', {'type': 'approval', 'lane': 'idle'}),
          ],
          'canApprove': false,
          'sequence': 10,
          ...patch,
        });

    test('a live snapshot replaces an older one and never a newer one', () {
      final moved = mergeRun(mergeRun([], run()), run({'sequence': 12, 'currentNodeId': 'qa'}));
      expect(moved.length, 1);
      expect(moved[0].currentNodeId, 'qa');
      expect(mergeRun(moved, run({'sequence': 11, 'currentNodeId': 'implement'}))[0].currentNodeId, 'qa');
      expect(removeRun(moved, run().runId), isEmpty);
    });

    test('newest first, and a fresh read keeps a live event that beat it', () {
      final older = run({'runId': 'c7cdfc50-a44c-4c77-ab7d-195ca6b2ccb9', 'startedAt': '2026-09-22T10:00:00.000Z', 'status': 'failed'});
      expect(mergeRun(mergeRun([], older), run()).map((entry) => entry.runId.substring(0, 8)), ['8b14fe21', 'c7cdfc50']);
      final live = [run({'sequence': 20, 'currentNodeId': 'qa'})];
      final refreshed = replaceRuns(live, [run({'sequence': 15}), older]);
      expect(refreshed.firstWhere((entry) => entry.runId == run().runId).currentNodeId, 'qa');
      expect(refreshed.length, 2);
      expect(replaceRuns(live, []), isEmpty);
    });

    test('the view follows the current stage unless a person pinned one', () {
      expect(currentStage(run())!.nodeId, 'implement');
      expect(viewedStage(run(), 'plan')!.nodeId, 'plan');
      expect(viewedStage(run(), 'gone')!.nodeId, 'implement');
      expect(stepPosition(run(), 'implement'), 'Step 2 of 4');
    });

    test('stage sessions are recognised', () {
      expect(runStageSessionKeys([run()]), {'WF-8B14FE21-plan', 'WF-8B14FE21-implement'});
      expect(isStageSessionKey('WF-8B14FE21-review', '8b14fe21-527f-4f52-b20c-0f1decc4e9fd'), true);
      expect(isStageSessionKey('SESSION-1', '8b14fe21-527f-4f52-b20c-0f1decc4e9fd'), false);
      expect(isStageSessionKey('WF-8B14FE21-plan', null), false);
    });

    test('statuses read the way the desktop monitor does', () {
      expect(runStatus(run()).label, 'Running');
      expect(runStatus(run({'paused': true})).label, 'Paused');
      expect(runStatus(run({'status': 'awaiting-approval'})).label, 'Needs approval');
      expect(runCaption(run()), 'Running · Implement');
      expect(runCaption(run({'status': 'succeeded', 'currentNodeId': 'approve'})), 'Succeeded');
      expect(stageStatus(RunStage(stage('review', {'lane': 'paused', 'pause': 'provider-limit'}))).label, 'Paused · AI out of budget');
      expect(stageWithoutSession(RunStage(stage('qa', {'type': 'check', 'lane': 'running'}))), contains('check'));
      expect(stageWithoutSession(RunStage(stage('qa', {'type': 'check'}))), contains('not started'));
    });

    test('approval context lists the steps before the gate, their outcomes and findings', () {
      Json s(Json overrides) => {'nodeId': 'x', 'name': 'x', 'type': 'check', 'lane': 'done', 'attempts': 1, ...overrides};
      final context = approvalContext(RunSnapshot({
        'runId': 'r', 'projectId': 'p', 'workflowName': 'Release', 'status': 'awaiting-approval', 'paused': false, 'explanation': 'Waiting for approval.',
        'startedAt': 't', 'canApprove': true, 'sequence': 1,
        'stages': [
          s({'nodeId': 'impl', 'name': 'Implement', 'type': 'agent-task', 'attempts': 2}),
          s({'nodeId': 'sast', 'name': 'SAST', 'findingsSummary': {'high': 1, 'low': 3}}),
          s({'nodeId': 'join', 'name': 'Gates', 'type': 'join'}),
          s({'nodeId': 'tests', 'name': 'Tests', 'lane': 'failed', 'exitCode': 1}),
          s({'nodeId': 'approve', 'name': 'Approve release', 'type': 'approval', 'lane': 'awaiting', 'prompt': 'Check the SAST report.', 'gate': 'release'}),
          s({'nodeId': 'deploy', 'name': 'Deploy', 'type': 'deployment', 'lane': 'idle'}),
        ],
      }))!;
      expect(context.stageName, 'Approve release');
      expect(context.prompt, 'Check the SAST report.');
      expect(context.steps.map((step) => [step.name, step.label, step.detail]), [
        ['Implement', 'Done', '2 attempts'],
        ['SAST', 'Done', null],
        ['Tests', 'Failed', 'exit 1'],
      ]);
      expect(context.findings.map((f) => [f.severity, f.count]), [['low', 3], ['high', 1]]);
    });
  });

  group('gadgets', () {
    final choice = <String, dynamic>{
      'version': 1, 'gadgetId': 'msg-1-1', 'kind': 'choice', 'fallbackText': 'Pick',
      'payload': {'question': 'Which?', 'options': [{'value': 'a', 'label': 'A'}]}, 'actions': [{'actionId': 'answer', 'label': 'Answer', 'effect': 'informational'}],
    };
    GadgetView view([Json overrides = const {}]) => GadgetView({'gadget': choice, 'state': 'active', ...overrides});

    test('a gadget is answerable only while active and unanswered', () {
      expect(isGadgetAnswerable(view()), true);
      expect(isGadgetAnswerable(view({'state': 'expired'})), false);
      expect(isGadgetAnswerable(view({'result': {'status': 'completed', 'message': 'Recorded: A.'}})), false);
      expect(isGadgetAnswerable(view({'result': {'status': 'rejected'}})), true);
      expect(inertGadgetReason(view({'result': {'status': 'completed', 'message': 'Recorded: A.'}})), 'Recorded: A.');
      expect(inertGadgetReason(view({'state': 'superseded'})), 'A newer question replaced this one.');
      expect(inertGadgetReason(view()), isNull);
    });

    test('unknown kinds and versions fall back to text', () {
      expect(canDrawGadget(GadgetEnvelope(choice)), true);
      expect(canDrawGadget(GadgetEnvelope({'kind': 'choice', 'version': 2})), false);
      expect(canDrawGadget(GadgetEnvelope({'kind': 'hologram', 'version': 1})), false);
    });

    test('approving, changing or dangerous answers need identity', () {
      expect(answerNeedsIdentity(GadgetActionDescriptor({'effect': 'informational'})), false);
      expect(answerNeedsIdentity(GadgetActionDescriptor({'effect': 'approval'})), true);
      expect(answerNeedsIdentity(GadgetActionDescriptor({'effect': 'mutating'})), true);
      expect(answerNeedsIdentity(GadgetActionDescriptor({'effect': 'informational', 'danger': true})), true);
      expect(answerNeedsIdentity(null), false);
    });

    final form = <String, dynamic>{
      'title': 'Details',
      'fields': [
        {'name': 'title', 'label': 'Title', 'type': 'text', 'required': true, 'maxLength': 10},
        {'name': 'count', 'label': 'Count', 'type': 'number', 'min': 1, 'max': 5, 'defaultValue': 2},
        {'name': 'urgent', 'label': 'Urgent', 'type': 'boolean'},
        {'name': 'kind', 'label': 'Kind', 'type': 'select', 'options': [{'value': 'bug', 'label': 'Bug'}]},
      ],
    };

    test('forms open on their defaults, validate each field, and answer in declared types', () {
      final values = initialFormValues(form);
      expect(values, {'title': '', 'count': '2', 'urgent': false, 'kind': ''});
      expect(validateFormValues(form, values).keys, ['title']);
      expect(validateFormValues(form, {...values, 'title': 'x', 'count': '9'})['count'], contains('at most 5'));
      expect(validateFormValues(form, {...values, 'title': 'x', 'kind': 'feature'})['kind'], contains('Choose a kind'));
      expect(validateFormValues(form, {...values, 'title': 'Fix it', 'kind': 'bug'}), isEmpty);
      expect(formActionValue(form, {'title': ' Fix it ', 'count': '3', 'urgent': true, 'kind': ''}), {
        'kind': 'form',
        'fields': {'title': 'Fix it', 'count': 3, 'urgent': true},
      });
    });

    test('chart bars scale to the largest value and say how many were left off', () {
      final bars = chartBars({'chartKind': 'bar', 'series': [{'label': 'Runs', 'points': [{'x': 'Mon', 'y': 2}, {'x': 'Tue', 'y': 4}, {'x': 'Wed', 'y': 1}]}]}, 2);
      expect(bars.bars.map((bar) => bar.fraction), [0.5, 1]);
      expect(bars.more, 1);
    });

    test('the same answer gets the same idempotency key', () {
      final first = gadgetIdempotencyKey('g', 'answer', {'kind': 'choice', 'selected': 'a'});
      expect(first, gadgetIdempotencyKey('g', 'answer', {'kind': 'choice', 'selected': 'a'}));
      expect(first, isNot(gadgetIdempotencyKey('g', 'answer', {'kind': 'choice', 'selected': 'b'})));
    });
  });

  group('pairing invitation', () {
    final key = 'ab' * 32;
    final now = DateTime.parse('2026-09-23T10:00:00.000Z');

    test('the compact QR keeps its single-use token and expiry', () {
      final parsed = parseMobileInvitation('P1|dave-mac|$key|192.168.1.20:43100|a1b2c3d4e5f6|2026-09-23T10:10:00.000Z', now);
      expect(parsed.kind, InvitationKind.invitation);
      expect([parsed.details.hostId, parsed.details.hostPublicKeyHex, parsed.details.address, parsed.details.port, parsed.details.tokenId],
          ['dave-mac', key, '192.168.1.20', 43100, 'a1b2c3d4e5f6']);
      expect(parsed.expired, false);
    });

    test('the JSON invitation parses the same, and expiry is caught before connecting', () {
      final parsed = parseMobileInvitation(
          '{"version":1,"hostId":"dave-mac","displayName":"Dave Mac","publicKeyHex":"$key","endpoints":[{"address":"10.0.0.4","port":43100}],"tokenId":"tok123456789","expiresAt":"2026-09-23T09:59:00.000Z"}',
          now);
      expect(parsed.kind, InvitationKind.invitation);
      expect(parsed.details.hostName, 'Dave Mac');
      expect(parsed.details.tokenId, 'tok123456789');
      expect(parsed.expired, true);
    });

    test('a bare key is a reconnect, and junk is rejected', () {
      final parsed = parseMobileInvitation(key.toUpperCase());
      expect(parsed.kind, InvitationKind.key);
      expect(parsed.details.hostPublicKeyHex, key);
      expect(parseMobileInvitation('hello').kind, InvitationKind.unrecognised);
      expect(parseMobileInvitation('P1|host|not-a-key|1.2.3.4:1').kind, InvitationKind.unrecognised);
    });

    test('connection failures become actionable issues', () {
      final revoked = describeConnectionIssue(MobileConnectionError.fromStatus(mobileConnectionStatus('device-revoked')));
      expect([revoked.title, revoked.action, revoked.retryable], ['Access revoked', IssueAction.rescan, false]);
      expect(describeConnectionIssue(MobileConnectionError.fromStatus(mobileConnectionStatus('pairing-pending'))).action, IssueAction.wait);
      final unreachable = describeConnectionIssue(classifyMobileTransportFailure(stage: ConnectionStage.connect, endpoint: '10.0.0.4:43100', cause: 'ECONNREFUSED'));
      expect(unreachable.title, 'Desktop unreachable');
      expect(unreachable.message, contains('10.0.0.4:43100 (ECONNREFUSED)'));
      expect(unreachable.retryable, true);
      expect(describeConnectionIssue(classifyMobileTransportFailure(stage: ConnectionStage.handshake, endpoint: 'x')).action, IssueAction.rescan);
      expect(describeConnectionIssue(Exception('boom')).title, 'Couldn’t connect');
    });

    test('reconnect backs off exponentially to a cap', () {
      expect([0, 1, 2, 3, 10].map((attempt) => reconnectDelay(attempt).inMilliseconds), [1000, 2000, 4000, 8000, 30000]);
    });
  });

  group('session options', () {
    final catalog = ProviderCatalog({
      'defaultProvider': 'openai',
      'providers': [
        {'provider': 'openai', 'label': 'OpenAI', 'kind': 'api', 'available': false, 'unavailableMessage': 'OpenAI has no API key on the desktop. Add one in Settings → AI Provider.'},
        {'provider': 'anthropic', 'label': 'Anthropic', 'kind': 'api', 'available': true, 'defaultModel': 'claude-sonnet-4-6'},
        {'provider': 'codex-cli', 'label': 'Codex CLI (local)', 'kind': 'cli-agent', 'available': true},
      ],
      'sessionModes': [
        {'mode': 'chat', 'available': true, 'toolAccess': 'full'},
        {'mode': 'analysis', 'available': false, 'toolAccess': 'read-only', 'unavailableMessage': 'Set an analysis system prompt under Settings → AI Provider on the desktop first.'},
        {'mode': 'review', 'available': true, 'toolAccess': 'read-only'},
      ],
    });
    final anthropicModels = ModelCatalog({
      'provider': 'anthropic', 'status': 'ok', 'defaultModel': 'claude-sonnet-4-6',
      'models': [{'modelId': 'claude-sonnet-4-6', 'name': 'Claude Sonnet 4.6'}, {'modelId': 'claude-opus-4-6', 'name': 'Claude Opus 4.6'}],
    });

    test('only configured and enabled providers are offered', () {
      expect(availableProviderOptions(catalog).map((option) => option.provider), ['anthropic', 'codex-cli']);
    });

    test('an unavailable desktop default falls through to the first available provider', () {
      final selection = effectiveSelection(catalog, const SessionSelection());
      expect(selection.provider, 'anthropic');
      expect(validateSelection(catalog, selection), isNull);
    });

    test('an unavailable provider cannot be selected, and says why', () {
      expect(effectiveSelection(catalog, const SessionSelection(provider: 'openai')).provider, 'anthropic');
      expect(validateSelection(catalog, const SessionSelection(provider: 'openai')), 'OpenAI has no API key on the desktop. Add one in Settings → AI Provider.');
    });

    test('provider A + model A reach the create payload; a model from another provider is dropped', () {
      final chosen = effectiveSelection(catalog, const SessionSelection(provider: 'anthropic', model: 'claude-opus-4-6', mode: 'review'), anthropicModels);
      expect(selectionPayload(chosen), {'provider': 'anthropic', 'model': 'claude-opus-4-6', 'mode': 'review'});
      expect(effectiveSelection(catalog, const SessionSelection(provider: 'anthropic', model: 'gpt-5.5'), anthropicModels).model, isNull);
      expect(validateSelection(catalog, const SessionSelection(provider: 'anthropic', model: 'gpt-5.5'), anthropicModels), isNotNull);
    });

    test('an unavailable mode is refused with the desktop reason', () {
      expect(effectiveSelection(catalog, const SessionSelection(provider: 'anthropic', mode: 'analysis')).mode, 'chat');
      expect(validateSelection(catalog, const SessionSelection(provider: 'anthropic', mode: 'analysis')),
          'Set an analysis system prompt under Settings → AI Provider on the desktop first.');
    });

    test('model labels name the default the desktop will actually use', () {
      expect(modelLabel(anthropicModels, null), 'Default (Claude Sonnet 4.6)');
      expect(modelLabel(anthropicModels, 'claude-opus-4-6'), 'Claude Opus 4.6');
      expect(modelLabel(null, null), 'Provider default');
      expect(validateSelection(null, const SessionSelection()), isNull);
    });
  });

  group('attention', () {
    test('attention type titles are readable and categorised', () {
      expect(attentionTypeTitle('permission'), 'Permission Request');
      expect(attentionTypeTitle('approval'), 'Approval Required');
      expect(attentionTypeTitle('failure'), 'Step Failed');
      expect(attentionTypeTitle('unknown'), 'Action Required');
    });
  });
}
