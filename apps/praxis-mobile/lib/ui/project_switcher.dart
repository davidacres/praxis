import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../app/diagnostics.dart';
import '../app/store.dart';
import '../app/theme.dart';
import 'app_icon.dart';
import 'kit.dart';

/// The selected desktop project's title chip and quick switch menu.
class ProjectSwitcher extends StatefulWidget {
  const ProjectSwitcher({super.key, this.compact = false});

  final bool compact;

  @override
  State<ProjectSwitcher> createState() => _ProjectSwitcherState();
}

class _ProjectSwitcherState extends State<ProjectSwitcher> {
  final MenuController _menu = MenuController();

  @override
  Widget build(BuildContext context) {
    final store = context.watch<AppStore>();
    if (store.availableProjects.isEmpty) return const SizedBox.shrink();
    final t = context.t;
    final p = t.palette;
    final name = store.project.name.isNotEmpty ? store.project.name : 'Praxis';

    return MenuAnchor(
      controller: _menu,
      menuChildren: [
        for (final project in store.availableProjects)
          Pressable(
            label: 'Use project ${project.name}',
            selected: project.projectId == store.project.projectId,
            onTap: () async {
              _menu.close();
              if (project.projectId == store.project.projectId) return;
              try {
                await store.selectProject(project.projectId);
              } catch (error) {
                if (context.mounted) {
                  ScaffoldMessenger.of(context).showSnackBar(
                    SnackBar(content: Text(Diagnostics.messageOf(error))),
                  );
                }
              }
            },
            excludeChildSemantics: true,
            builder: (context, pressed) => Container(
              width: t.s(240),
              constraints: BoxConstraints(minHeight: t.s(44)),
              padding: EdgeInsets.symmetric(horizontal: t.s(12)),
              color: pressed ? p.surfaceRaised : p.surface,
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      project.name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: ts(context, 13, weight: FontWeight.w600),
                    ),
                  ),
                  if (project.projectId == store.project.projectId)
                    AppIcon('check', size: 14, color: p.accent),
                ],
              ),
            ),
          ),
      ],
      builder: (context, controller, _) => Pressable(
        label: 'Switch project, $name',
        onTap: () => controller.isOpen ? controller.close() : controller.open(),
        excludeChildSemantics: true,
        builder: (context, pressed) => Container(
          constraints: BoxConstraints(minHeight: t.s(widget.compact ? 30 : 34)),
          padding: EdgeInsets.symmetric(
            horizontal: t.s(widget.compact ? 5 : 8),
          ),
          decoration: BoxDecoration(
            color: pressed ? p.surfaceRaised : Colors.transparent,
            borderRadius: BorderRadius.circular(t.s(6)),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              AppIcon(
                'folder',
                size: widget.compact ? 13 : 14,
                color: p.accent,
              ),
              SizedBox(width: t.s(6)),
              Flexible(
                child: Text(
                  name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: ts(
                    context,
                    widget.compact ? 12.5 : 13,
                    weight: FontWeight.w600,
                  ),
                ),
              ),
              SizedBox(width: t.s(5)),
              AppIcon('chevron-down', size: 11, color: p.textDim),
            ],
          ),
        ),
      ),
    );
  }
}
