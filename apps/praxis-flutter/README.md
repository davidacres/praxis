# Praxis Mobile (Flutter)

A Flutter implementation of the Praxis mobile companion app, providing a mobile interface to interact with the Praxis desktop application.

## Features

- **Connect to Desktop** — Pair your phone with a running Praxis desktop instance
- **Manage Work** — View and interact with active conversations and work items
- **Real-time Sync** — Theme and settings sync from desktop
- **Activity Feed** — Track recent activity across your projects
- **Attention Items** — See items that need your attention

## Getting Started

### Prerequisites

- Flutter SDK 3.3.0 or higher
- Dart 3.3.0 or higher
- For iOS: Xcode 14 or later
- For Android: Android SDK API 21 or higher

### Setup

```bash
# Install dependencies
flutter pub get

# Run on connected device or emulator
flutter run

# Or run specific platform
flutter run -d ios
flutter run -d android
```

### Building for Release

```bash
# iOS
flutter build ios

# Android
flutter build apk
```

## Architecture

- **State Management**: Provider package for reactive state management
- **Networking**: Socket-based TCP communication with desktop
- **Storage**: Secure storage for configuration and credentials
- **UI**: Material Design 3

## Project Structure

See [AGENTS.md](AGENTS.md) for detailed project structure and guidelines.

## Testing

The Flutter app should be tested against the reference Expo implementation to ensure feature parity:

```bash
flutter test
```

## Troubleshooting

### App won't connect to desktop
- Verify the desktop app is running and listening on the correct port
- Check that host address and public key are entered correctly
- Ensure devices are on the same network

### Theme not updating
- Disconnect and reconnect to the desktop
- Restart the mobile app
- Check that desktop theme changes are being sent

## License

See the root Praxis repository for license information.
