#!/bin/bash

set -euo pipefail

# Ensure running in the project root directory
cd "$(dirname "$0")"

usage() {
  cat <<'EOF'
Usage: ./build.sh [--mac] [--win] [--linux] [--linux-x64] [--linux-arm64] [--mobile-web]

Options:
  --mac          Build desktop macOS package
  --win          Build desktop Windows package
  --linux        Build desktop Linux packages for both x64 and arm64
  --linux-x64    Build desktop Linux package (x64: AppImage + deb + pacman + rpm)
  --linux-arm64  Build desktop Linux package (arm64: AppImage + deb + pacman + rpm)
  --mobile-web   Build and zip standalone mobile-web package

No options means building all targets (mac, win, linux x64 + arm64, mobile-web).
EOF
}

zip_mobile_web() {
  local app_version="$1"
  local mobile_dist_dir="apps/mobile-web/dist"
  local stage_root="out/mobile-web-package"
  local stage_dir="$stage_root/RTerm-Mobile-Web"
  local zip_name="RTerm.MobileWeb.${app_version}.zip"

  if ! command -v zip >/dev/null 2>&1; then
    echo "Error: 'zip' command not found. Please install zip first."
    exit 1
  fi

  if [ ! -d "$mobile_dist_dir" ]; then
    echo "Error: mobile-web build output missing at '$mobile_dist_dir'."
    exit 1
  fi

  rm -rf "$stage_root"
  mkdir -p "$stage_dir"
  cp -R "$mobile_dist_dir"/. "$stage_dir"/

  (
    cd "$stage_root"
    zip -rq "../../dist/$zip_name" "RTerm-Mobile-Web"
  )

  echo "Mobile-web package: dist/$zip_name"
}

# Initialize flags
BUILD_MAC=false
BUILD_WIN=false
BUILD_LINUX=false
BUILD_LINUX_X64=false
BUILD_LINUX_ARM64=false
BUILD_MOBILE_WEB=false

# Parse arguments
if [ $# -eq 0 ]; then
  BUILD_MAC=true
  BUILD_WIN=true
  BUILD_LINUX=true
  BUILD_MOBILE_WEB=true
else
  for arg in "$@"; do
    case "$arg" in
      --mac)
        BUILD_MAC=true
        ;;
      --win)
        BUILD_WIN=true
        ;;
      --linux)
        BUILD_LINUX=true
        ;;
      --linux-x64)
        BUILD_LINUX_X64=true
        ;;
      --linux-arm64)
        BUILD_LINUX_ARM64=true
        ;;
      --mobile-web)
        BUILD_MOBILE_WEB=true
        ;;
      --help|-h)
        usage
        exit 0
        ;;
      *)
        echo "Unknown argument: $arg"
        usage
        exit 1
        ;;
    esac
  done
fi

if [ "$BUILD_LINUX" = true ]; then
  BUILD_LINUX_X64=true
  BUILD_LINUX_ARM64=true
fi

echo "Cleaning build directories..."
rm -rf dist out
mkdir -p dist out

APP_VERSION="$(node -p "JSON.parse(require('fs').readFileSync('package.json','utf8')).version")"
echo "Release version: $APP_VERSION"

if [ "$BUILD_MAC" = true ]; then
  echo "Building macOS version..."
  npm run dist:mac
fi

if [ "$BUILD_WIN" = true ]; then
  echo "Building Windows version..."
  npm run dist:win
fi

if [ "$BUILD_LINUX_X64" = true ]; then
  echo "Building Linux x64 version..."
  npm run dist:linux
fi

if [ "$BUILD_LINUX_ARM64" = true ]; then
  echo "Building Linux arm64 version..."
  npm run dist:linux-arm64
fi

if [ "$BUILD_MOBILE_WEB" = true ]; then
  echo "Building standalone mobile-web..."
  npm run build:mobile-web
  zip_mobile_web "$APP_VERSION"
fi

echo "Build completed."
