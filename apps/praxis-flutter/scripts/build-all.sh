#!/bin/bash
set -e

echo "🔨 Building Praxis Flutter Mobile App"
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Get dependencies
echo -e "${YELLOW}→ Getting dependencies...${NC}"
flutter pub get

# Run tests
echo -e "${YELLOW}→ Running tests...${NC}"
flutter test || echo -e "${RED}⚠ Tests failed${NC}"

# Check code
echo -e "${YELLOW}→ Analyzing code...${NC}"
flutter analyze || echo -e "${RED}⚠ Analysis found issues${NC}"

# Format code
echo -e "${YELLOW}→ Formatting code...${NC}"
flutter format lib/ test/ --line-length=100

# Build web (for quick testing)
echo -e "${YELLOW}→ Building web version...${NC}"
flutter build web --release

# Suggest next steps
echo ""
echo -e "${GREEN}✓ Build complete!${NC}"
echo ""
echo "Next steps:"
echo "  1. iOS: flutter run -d ios"
echo "  2. Android: flutter run -d android"
echo "  3. Web: flutter run -d web (already built)"
echo ""
echo "For testing:"
echo "  - Run: flutter test"
echo "  - Debug: flutter run -v"
echo "  - Profile: flutter run --profile"
