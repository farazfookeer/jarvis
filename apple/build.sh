#!/bin/sh
# Builds the read-only Apple helper. The Info.plist is embedded in the binary
# so macOS can show a proper permission prompt for Calendar and Reminders.
set -e
cd "$(dirname "$0")/.."
mkdir -p bin
swiftc -O apple/JarvisApple.swift -o bin/jarvis-apple \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker apple/Info.plist
echo "Built bin/jarvis-apple"
