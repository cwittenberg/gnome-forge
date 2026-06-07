#!/bin/bash

EXTENSION_DIR=$(dirname "$(readlink -f "$0")")
UUID="gnome-forge@cwittenberg"

echo "Compiling schemas..."
glib-compile-schemas "$EXTENSION_DIR/schemas/"

echo "Packaging extension into gnome-forge.zip..."
cd "$EXTENSION_DIR" || exit

# Force remove any existing/corrupted archive before building
rm -f gnome-forge.zip

zip -r gnome-forge.zip . \
    -x "*.git*" \
    -x "build.sh" \
    -x "gnome-forge.zip" \
    -x "library/*" \
    -x "**/__pycache__/*" \
    -x "**/*.pyc"

echo "Build complete."
echo "To install locally, run: gnome-extensions install -f gnome-forge.zip"