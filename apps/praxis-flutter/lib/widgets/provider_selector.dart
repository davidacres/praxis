import 'package:flutter/material.dart';

class ProviderSelector extends StatefulWidget {
  final String? selectedProvider;
  final String? selectedModel;
  final List<String> availableProviders;
  final Map<String, List<String>> modelsByProvider;
  final ValueChanged<String>? onProviderChanged;
  final ValueChanged<String>? onModelChanged;

  const ProviderSelector({
    Key? key,
    this.selectedProvider,
    this.selectedModel,
    required this.availableProviders,
    required this.modelsByProvider,
    this.onProviderChanged,
    this.onModelChanged,
  }) : super(key: key);

  @override
  State<ProviderSelector> createState() => _ProviderSelectorState();
}

class _ProviderSelectorState extends State<ProviderSelector> {
  late String? _selectedProvider;
  late String? _selectedModel;

  @override
  void initState() {
    super.initState();
    _selectedProvider = widget.selectedProvider;
    _selectedModel = widget.selectedModel;
  }

  @override
  void didUpdateWidget(ProviderSelector oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.selectedProvider != widget.selectedProvider) {
      _selectedProvider = widget.selectedProvider;
    }
    if (oldWidget.selectedModel != widget.selectedModel) {
      _selectedModel = widget.selectedModel;
    }
  }

  void _handleProviderChange(String? provider) {
    if (provider != null) {
      setState(() {
        _selectedProvider = provider;
        _selectedModel = null; // Reset model when provider changes
      });
      widget.onProviderChanged?.call(provider);
    }
  }

  void _handleModelChange(String? model) {
    if (model != null) {
      setState(() {
        _selectedModel = model;
      });
      widget.onModelChanged?.call(model);
    }
  }

  @override
  Widget build(BuildContext context) {
    final models =
        _selectedProvider != null ? widget.modelsByProvider[_selectedProvider] ?? [] : [];

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          'Provider',
          style: Theme.of(context).textTheme.labelMedium,
        ),
        const SizedBox(height: 8),
        DropdownButton<String>(
          value: _selectedProvider,
          isExpanded: true,
          hint: const Text('Select a provider'),
          onChanged: _handleProviderChange,
          items: widget.availableProviders.map((provider) {
            return DropdownMenuItem<String>(
              value: provider,
              child: Text(provider),
            );
          }).toList(),
        ),
        const SizedBox(height: 16),
        if (_selectedProvider != null) ...[
          Text(
            'Model',
            style: Theme.of(context).textTheme.labelMedium,
          ),
          const SizedBox(height: 8),
          DropdownButton<String>(
            value: _selectedModel,
            isExpanded: true,
            hint: const Text('Select a model'),
            onChanged: models.isNotEmpty ? _handleModelChange : null,
            items: models.map((model) {
              return DropdownMenuItem<String>(
                value: model,
                child: Text(model),
              );
            }).toList(),
          ),
        ],
      ],
    );
  }
}
