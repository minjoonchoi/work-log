NODE ?= node
NPM ?= npm
INSTALL_ARGS ?=
UNINSTALL_ARGS ?=

.PHONY: build install install-plan uninstall uninstall-plan test

build:
	$(NPM) ci
	$(NPM) run build:mac

install: build
	$(NODE) scripts/install.mjs --apply $(INSTALL_ARGS)

install-plan:
	$(NODE) scripts/install.mjs $(INSTALL_ARGS)

uninstall:
	$(NODE) scripts/uninstall.mjs --apply $(UNINSTALL_ARGS)

uninstall-plan:
	$(NODE) scripts/uninstall.mjs $(UNINSTALL_ARGS)

test:
	$(NPM) test
