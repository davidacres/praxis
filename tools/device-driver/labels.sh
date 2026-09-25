#!/bin/bash
# Prints the de-duplicated element types and labels from the last step's tree —
# usually all you need to pick the next tap target.
source "$(dirname "$0")/lib.sh"
grep -oE "(Button|StaticText|TextView|TextField|Other), 0x[0-9a-f]+, \{\{[^}]*\}, \{[^}]*\}\}, (identifier: '[^']*', )?label: '[^']{0,${1:-120}}" "$RUN_DIR/tree.txt" \
  | sed -E "s/, 0x[0-9a-f]+//; s/\{\{[^}]*\}, \{[^}]*\}\}, //" | grep -v 'scroll bar' | awk '!seen[$0]++'
