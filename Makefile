NODE ?=
NPM ?=
INSTALL_ARGS ?=
UNINSTALL_ARGS ?=
export NODE NPM HARNESS_BUNDLE_NODE HARNESS_NODE_CACHE HARNESS_NODE_DOWNLOAD

.PHONY: build install install-plan uninstall uninstall-plan test

build:
	@./scripts/with-node.sh build

install: build
	@./scripts/with-node.sh --existing node scripts/install.mjs --apply $(INSTALL_ARGS)

install-plan:
	@./scripts/with-node.sh --existing node scripts/install.mjs $(INSTALL_ARGS)

uninstall:
	@./scripts/with-node.sh --existing node scripts/uninstall.mjs --apply $(UNINSTALL_ARGS)

uninstall-plan:
	@./scripts/with-node.sh --existing node scripts/uninstall.mjs $(UNINSTALL_ARGS)

test:
	@./scripts/with-node.sh --existing npm test
