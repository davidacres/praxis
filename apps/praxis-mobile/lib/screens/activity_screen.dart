import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../app/store.dart';
import '../app/theme.dart';
import '../ui/kit.dart';

/// The latest turn of each session, newest first. Port of `screens/ActivityScreen.tsx`.
class ActivityScreen extends StatelessWidget {
  const ActivityScreen({super.key, required this.onOpenSidebar});
  final VoidCallback onOpenSidebar;

  @override
  Widget build(BuildContext context) {
    final store = context.watch<AppStore>();
    final p = context.p;
    final activity = store.activity;
    return Column(
      children: [
        AppHeader(title: 'Activity', onOpenSidebar: onOpenSidebar),
        Expanded(
          child: ScreenScroll(
            children: [
              if (activity.isEmpty)
                const PraxisCard(
                  children: [Body('No session activity in this project yet. Sessions started here or on the desktop appear as they run.', dim: true)],
                ),
              for (final entry in activity)
                Pressable(
                  label: '${entry.at} ${entry.title}. ${entry.text}',
                  hint: 'Opens the session',
                  onTap: () {
                    store.setRoute('work');
                    store.openWork(entry.workId);
                  },
                  excludeChildSemantics: true,
                  builder: (context, _) => PraxisCard(
                    children: [
                      Row(
                        children: [
                          Text(
                            entry.at,
                            style: ts(context, 12, scaled: false, color: p.textDim, features: tabular),
                          ),
                          const SizedBox(width: 10),
                          Container(
                            width: 6,
                            height: 6,
                            decoration: BoxDecoration(color: p.accent, shape: BoxShape.circle),
                          ),
                          const SizedBox(width: 10),
                          Expanded(
                            child: Text(
                              entry.title,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: ts(context, 14, scaled: false, weight: FontWeight.w700),
                            ),
                          ),
                        ],
                      ),
                      Body(entry.text, dim: true),
                    ],
                  ),
                ),
            ],
          ),
        ),
      ],
    );
  }
}
