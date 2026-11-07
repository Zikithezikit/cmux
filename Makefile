# chrome-tmux — common tasks. Run `make` (or `make help`) for the list.

SHELL := /bin/sh
.DEFAULT_GOAL := help

ROOT        := $(CURDIR)
VERSION     := $(shell node -p "require('./manifest.json').version" 2>/dev/null)
# Chrome derives an unpacked extension's ID from its absolute path, so the
# workspace URL is known without asking the browser.
EXT_ID      := $(shell printf %s "$(ROOT)" | sha256sum | head -c32 | tr 0-9a-f a-p)
WORKSPACE   := chrome-extension://$(EXT_ID)/src/workspace/workspace.html
OPTIONS     := chrome-extension://$(EXT_ID)/src/options/options.html

# Chromium for `run` / `e2e` (branded Google Chrome ignores --load-extension).
CHROMIUM    ?= $(or $(CHROME_PATH),$(shell ls -d $(HOME)/.cache/ms-playwright/chromium-*/chrome-linux64/chrome 2>/dev/null | sort -V | tail -1),$(shell command -v chromium 2>/dev/null))
# Your everyday Chrome, for `app` (extension loaded via chrome://extensions).
CHROME      ?= $(shell command -v google-chrome 2>/dev/null || command -v google-chrome-stable 2>/dev/null || command -v chromium 2>/dev/null)
DEV_PROFILE ?= $(ROOT)/.dev-profile
CHROME_CONFIG ?= $(HOME)/.config/google-chrome
# Ubuntu 23.10+ blocks the sandbox of Chromium builds AppArmor doesn't know
# (like Playwright's). The dev profile only runs the extension and test pages,
# so fall back to --no-sandbox there. Set RUN_FLAGS= to override.
USERNS_RESTRICTED := $(shell cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)
RUN_FLAGS ?= $(if $(and $(filter 1,$(USERNS_RESTRICTED)),$(findstring ms-playwright,$(CHROMIUM))),--no-sandbox)

.PHONY: help install build typecheck lint test e2e check icons package screenshots run app info clean distclean

help: ## Show this help
	@awk 'BEGIN {FS = ":.*## "} /^[a-z0-9-]+:.*## / {printf "  \033[32mmake %-12s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)
	@echo
	@echo "  Extension ID: $(EXT_ID)  (for an unpacked load of $(ROOT))"

node_modules: package.json
	PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install
	@touch node_modules

install: node_modules ## Install dev dependencies (TypeScript, playwright-core; no browser download)

build: node_modules ## Compile the TypeScript sources in place (src/**/*.ts -> .js)
	npm run -s build

typecheck: node_modules ## Type-check everything without emitting
	npm run -s typecheck

lint: node_modules ## Lint with ESLint + typescript-eslint (type-aware rules)
	npm run -s lint

test: node_modules ## Build, then run the unit tests (Node, no browser)
	npm test

e2e: node_modules ## Drive the extension in Chromium (SCREENSHOTS=dir keeps screenshots)
	CHROME_PATH="$(CHROMIUM)" npm run -s e2e

check: typecheck lint test e2e ## Type-check + lint + unit tests + browser test

icons: node_modules ## Regenerate icons/*.png
	npm run -s icons

package: node_modules ## Build dist/chrome-tmux-<version>.zip
	npm run -s package

screenshots: node_modules ## Regenerate docs/screenshots/*.png for the README (loads real sites)
	npm run -s build
	CHROME_PATH="$(CHROMIUM)" node tools/screenshots.mjs

run: build ## Launch Chromium with the extension loaded and the workspace open (dev profile)
	@test -n "$(CHROMIUM)" || { echo "No Chromium found; set CHROMIUM=/path/to/chromium"; exit 1; }
	@$(if $(RUN_FLAGS),echo "note: AppArmor blocks this Chromium's sandbox; running the dev profile with $(RUN_FLAGS)")
	"$(CHROMIUM)" $(RUN_FLAGS) --user-data-dir="$(DEV_PROFILE)" \
	  --disable-extensions-except="$(ROOT)" --load-extension="$(ROOT)" \
	  "$(OPTIONS)" "$(WORKSPACE)"

app: build ## Open the workspace as a chromeless app window in your Chrome
	@test -n "$(CHROME)" || { echo "No Chrome found; set CHROME=/path/to/chrome"; exit 1; }
	@profile=$$(node tools/chrome-profile.mjs $(EXT_ID) "$(CHROME_CONFIG)"); \
	if [ -z "$$profile" ]; then \
	  echo "chrome-tmux isn't installed in your Chrome yet (one-time setup):"; \
	  echo "  1. open chrome://extensions in the profile you want to use"; \
	  echo "  2. turn on Developer mode (top right)"; \
	  echo "  3. Load unpacked -> $(ROOT)"; \
	  echo "  4. Details -> enable 'Allow access to file URLs' (to read ~/.tmux.conf from disk)"; \
	  echo "then run 'make app' again."; \
	  exit 1; \
	fi; \
	echo "opening the workspace in Chrome profile '$$profile'"; \
	"$(CHROME)" --profile-directory="$$profile" --app="$(WORKSPACE)" >/dev/null 2>&1 &

info: build ## Print version, extension ID, URLs and browsers used
	@echo "version    $(VERSION)"
	@echo "id         $(EXT_ID)"
	@echo "workspace  $(WORKSPACE)"
	@echo "options    $(OPTIONS)"
	@echo "app cmd    google-chrome --app=$(WORKSPACE)"
	@echo "chromium   $(or $(CHROMIUM),not found)"
	@echo "chrome     $(or $(CHROME),not found)"
	@p=$$(node tools/chrome-profile.mjs $(EXT_ID) "$(CHROME_CONFIG)"); \
	if [ -n "$$p" ]; then echo "installed  yes, Chrome profile '$$p'"; else echo "installed  no (Load unpacked in chrome://extensions)"; fi

clean: ## Remove build output and the dev profile
	rm -rf dist "$(DEV_PROFILE)"

distclean: clean ## Also remove node_modules
	rm -rf node_modules
