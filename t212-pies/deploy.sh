#!/bin/bash

# Trading 212 Pies Applet Deployment Script
# This script copies the applet to the appropriate Cinnamon directory

# Get the UUID from metadata.json
UUID=$(grep -o '"uuid": "[^"]*"' metadata.json | cut -d'"' -f4)

if [ -z "$UUID" ]; then
    echo "Error: Could not find UUID in metadata.json"
    exit 1
fi

echo "Deploying applet with UUID: $UUID"

# Define the target directory
TARGET_DIR="$HOME/.local/share/cinnamon/applets/$UUID"

# Create the target directory if it doesn't exist
mkdir -p "$TARGET_DIR"

# Copy all applet files to the target directory
echo "Copying files to $TARGET_DIR..."
cp -v applet.js "$TARGET_DIR/"
cp -v metadata.json "$TARGET_DIR/"

# Copy the API key file (required for the applet to function)
if [ -f "api-key" ]; then
    cp -v api-key "$TARGET_DIR/"
    chmod 600 "$TARGET_DIR/api-key"  # Restrict permissions for security
    echo "API key file copied with restricted permissions"
else
    echo "Warning: api-key file not found. The applet will not function without it."
    echo "Please create an 'api-key' file containing your Trading 212 API key."
fi

# Copy any additional files if they exist
if [ -f "icon.png" ]; then
    cp -v icon.png "$TARGET_DIR/"
fi

if [ -f "icon.svg" ]; then
    cp -v icon.svg "$TARGET_DIR/"
fi

if [ -d "assets/icons" ]; then
    mkdir -p "$TARGET_DIR/assets/icons"
    cp -v assets/icons/*.{svg,png} "$TARGET_DIR/assets/icons/" 2>/dev/null || true
fi

# Copy optional files
if [ -f "stylesheet.css" ]; then
    cp -v stylesheet.css "$TARGET_DIR/"
fi

if [ -f "settings-schema.json" ]; then
    cp -v settings-schema.json "$TARGET_DIR/"
fi

# Set proper permissions
chmod +x "$TARGET_DIR/applet.js"
chmod 644 "$TARGET_DIR/metadata.json"

echo "Deployment completed successfully!"
echo "Target directory: $TARGET_DIR"
echo ""
echo "To enable the applet:"
echo "1. Right-click on the Cinnamon panel"
echo "2. Select 'Applets'"
echo "3. Find 'Trading 212 pies' in the list"
echo "4. Click the '+' button to add it to your panel"
echo ""
echo "Or restart Cinnamon with Alt+F2, type 'r' and press Enter"