// Native entry point for the bundled CLI. exec preserves signals and exit codes.
#include <mach-o/dyld.h>
#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char **argv) {
    char executable[PATH_MAX], resolved[PATH_MAX];
    uint32_t size = sizeof(executable);
    if (_NSGetExecutablePath(executable, &size) != 0 || !realpath(executable, resolved)) {
        fputs("worklog: cannot resolve executable path\n", stderr);
        return 1;
    }
    char *slash = strrchr(resolved, '/');
    if (!slash) return 1;
    *slash = '\0';
    char node[PATH_MAX], script[PATH_MAX];
    int n = snprintf(node, sizeof(node), "%s/../MacOS/node", resolved);
    int s = snprintf(script, sizeof(script), "%s/../Resources/harness/bin/harness.mjs", resolved);
    if (n < 0 || (size_t)n >= sizeof(node) || s < 0 || (size_t)s >= sizeof(script)) {
        fputs("worklog: bundled path is too long\n", stderr);
        return 1;
    }
    char **args = calloc((size_t)argc + 2, sizeof(char *));
    if (!args) { perror("worklog"); return 1; }
    args[0] = node;
    args[1] = script;
    for (int i = 1; i < argc; i++) args[i + 1] = argv[i];
    execv(node, args);
    int error = errno;
    fprintf(stderr, "worklog: cannot start bundled runtime: %s\n", strerror(error));
    free(args);
    return error == ENOENT ? 127 : 126;
}
