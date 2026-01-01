# StashDB to Whisparr Firefox Extension
# Makefile for packaging

EXTENSION_NAME = stashdb-whisparr-extension
VERSION = $(shell grep '"version"' manifest.json | sed 's/.*: *"\([^"]*\)".*/\1/')
ZIP_FILE = $(EXTENSION_NAME)-$(VERSION).zip

# Files to include in the extension
FILES = \
	manifest.json \
	background.js \
	content.js \
	options.html \
	options.js \
	popup.html \
	popup.js \
	confirm.html \
	confirm.js \
	icons/

.PHONY: all clean zip info

all: zip

# Build the extension zip
zip: clean
	@echo "Packaging $(EXTENSION_NAME) v$(VERSION)..."
	@zip -r $(ZIP_FILE) $(FILES)
	@echo ""
	@echo "Created: $(ZIP_FILE)"
	@echo "Ready for upload to addons.mozilla.org"

# Clean up old zip files
clean:
	@rm -f $(EXTENSION_NAME)-*.zip
	@echo "Cleaned old zip files"

# Show current version info
info:
	@echo "Extension: $(EXTENSION_NAME)"
	@echo "Version:   $(VERSION)"
	@echo "Output:    $(ZIP_FILE)"

