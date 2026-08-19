import os

ROOT = os.path.dirname(os.path.abspath(__file__))
NUM_PKGS = 25
FILES_PER_PKG = 24
FUNCS_PER_FILE = 8

os.makedirs(ROOT, exist_ok=True)

for p in range(NUM_PKGS):
    # Leading underscore: the Go toolchain skips any directory named "_*" at
    # any depth (go help packages), so `go build ./...`/`go vet ./...` in
    # the tests module never tries to compile these as real packages (they
    # are not buildable -- see the README) while repomap.Build's own walker
    # does NOT apply that convention (it only skips "."-prefixed dirs, see
    # repomap.go's alwaysSkipped/HasPrefix check) and still parses them.
    pkg_dir = os.path.join(ROOT, f"_pkg{p:03d}")
    os.makedirs(pkg_dir, exist_ok=True)
    next_pkg = (p + 1) % NUM_PKGS
    for f in range(FILES_PER_PKG):
        lines = [f"package pkg{p:03d}\n"]
        next_file = (f + 1) % FILES_PER_PKG
        for fn in range(FUNCS_PER_FILE):
            name = f"Func{p:03d}_{f:02d}_{fn:02d}"
            called = f"Func{next_pkg:03d}_{next_file:02d}_{fn:02d}"
            lines.append(f"// {name} is a deterministically generated function\n"
                         f"// for the repomap perf fixture; it references {called}\n"
                         f"// so the pagerank/refs step in repomap.Build has real edges\n"
                         f"// to walk, not an isolated file per symbol.\n"
                         f"func {name}(a, b int) int {{\n"
                         f"\tif a > b {{\n"
                         f"\t\treturn {called}(a, b) + a\n"
                         f"\t}}\n"
                         f"\treturn {called}(b, a) - b\n"
                         f"}}\n")
        content = "\n".join(lines)
        with open(os.path.join(pkg_dir, f"file{f:02d}.go"), "w") as fh:
            fh.write(content)

print("done: %d files" % (NUM_PKGS * FILES_PER_PKG))
