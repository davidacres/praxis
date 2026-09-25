# Agent notes: `apps/praxis-flutter`

Flutter version of the Praxis mobile companion app.

## Overview

This is a Flutter implementation that mirrors the functionality of the React Native (Expo) app in `apps/praxis-mobile`. It provides a mobile companion to the Praxis desktop app, allowing users to view and interact with work items, conversations, and activity from their phone.

## Project Structure

```
lib/
├── main.dart                 # App entry point and root shell
├── app/
│   ├── models/              # Data models (appearance, etc.)
│   ├── services/            # Connection service for desktop communication
│   ├── store/
│   │   ├── store_provider.dart    # State management (AppStore)
│   │   └── types.dart             # Store type definitions
│   └── theme.dart            # Theme building and appearance
├── screens/
│   ├── connect_screen.dart   # Pairing/connection screen
│   ├── work_screen.dart      # Main work/conversation screen
│   ├── attention_screen.dart # Attention items screen
│   └── activity_screen.dart  # Activity feed screen
└── widgets/
    ├── transcript_view.dart  # Chat transcript display
    └── session_composer.dart # Message input widget
```

## State Management

Uses Flutter's `Provider` package for state management. The `AppStore` class in `store/store_provider.dart` holds all app state:

- Navigation state (primary route, detail tab, open work/run)
- Connection state (host config, connection status)
- Data (work items, activity, workflows, runs, messages)
- Theme/appearance (synced from desktop)

## Connection & Protocol

The `ConnectionService` in `app/services/connection_service.dart` handles TCP communication with the desktop app:

- Establishes socket connection to desktop
- Sends/receives JSON-encoded commands and events
- Stores configuration securely using `flutter_secure_storage`
- Mirrors the protocol from the Expo version

## Theme

Theme system syncs with the desktop app:
- Desktop sends appearance settings via `host.appearance` event
- Colors are parsed from hex strings and applied via Material theme
- Use `Theme.of(context)` to access colors and text styles

## Building & Testing

```bash
flutter pub get              # Install dependencies
flutter run                  # Run on connected device/emulator
flutter build ios            # Build iOS app for release
flutter build apk            # Build Android app
```

## Migration from Expo

When replacing the Expo app with this Flutter version:

1. Connection logic is in `ConnectionService` (mirror of `mobileConnection.ts`)
2. Store structure mirrors the Expo store structure
3. Screen layouts should match the Expo version for consistency
4. Theme syncing happens the same way (desktop sends appearance)

## Testing expectations

- Test navigation between screens
- Verify connection establishment and error handling
- Compare transcript rendering with Expo version
- Test message sending/receiving
- Verify theme updates from desktop
