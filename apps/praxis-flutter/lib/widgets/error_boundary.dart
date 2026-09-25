import 'package:flutter/material.dart';

class ErrorBoundary extends StatefulWidget {
  final Widget child;
  final String area;

  const ErrorBoundary({
    Key? key,
    required this.child,
    this.area = 'the app',
  }) : super(key: key);

  @override
  State<ErrorBoundary> createState() => _ErrorBoundaryState();
}

class _ErrorBoundaryState extends State<ErrorBoundary> {
  Object? _error;
  StackTrace? _stackTrace;

  @override
  Widget build(BuildContext context) {
    if (_error != null) {
      return Scaffold(
        appBar: AppBar(
          title: Text('Error in ${widget.area}'),
          elevation: 0,
        ),
        body: SingleChildScrollView(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'Something went wrong',
                style: Theme.of(context).textTheme.headlineSmall,
              ),
              const SizedBox(height: 16),
              Text(
                _error.toString(),
                style: Theme.of(context).textTheme.bodyMedium,
              ),
              if (_stackTrace != null) ...[
                const SizedBox(height: 16),
                Text(
                  'Stack trace:',
                  style: Theme.of(context).textTheme.labelMedium,
                ),
                const SizedBox(height: 8),
                SelectableText(
                  _stackTrace.toString(),
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                        fontFamily: 'monospace',
                      ),
                ),
              ],
              const SizedBox(height: 24),
              ElevatedButton(
                onPressed: () => setState(() {
                  _error = null;
                  _stackTrace = null;
                }),
                child: const Text('Try Again'),
              ),
            ],
          ),
        ),
      );
    }

    return ErrorWidget(
      child: widget.child,
      onError: (error, stackTrace) => setState(() {
        _error = error;
        _stackTrace = stackTrace;
      }),
    );
  }
}

class ErrorWidget extends StatefulWidget {
  final Widget child;
  final Function(Object, StackTrace) onError;

  const ErrorWidget({
    Key? key,
    required this.child,
    required this.onError,
  }) : super(key: key);

  @override
  State<ErrorWidget> createState() => _ErrorWidgetState();
}

class _ErrorWidgetState extends State<ErrorWidget> {
  @override
  Widget build(BuildContext context) {
    return widget.child;
  }

  @override
  void didUpdateWidget(ErrorWidget oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.child != widget.child) {
      // Reset error state when child changes
    }
  }
}
