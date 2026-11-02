//! Records the git commit this backend is built from (`AMIRO_BUILD_COMMIT`),
//! so a server run from a source checkout can tell when its branch has moved
//! past the code it is running (`src/updates.rs`). Empty outside a checkout.

use std::path::Path;
use std::process::Command;

fn git(root: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new("git").arg("-C").arg(root).args(args).output().ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
}

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let commit = git(&root, &["rev-parse", "HEAD"]).unwrap_or_default();
    println!("cargo:rustc-env=AMIRO_BUILD_COMMIT={commit}");
    // Rebuild when HEAD moves: HEAD itself (branch switches), the branch ref
    // (commits, fast-forwards) and packed-refs (a ref that was packed).
    let mut watched = vec!["HEAD".to_string(), "packed-refs".to_string()];
    if let Some(branch) = git(&root, &["symbolic-ref", "-q", "HEAD"]) {
        watched.push(branch);
    }
    for name in watched {
        if let Some(path) = git(&root, &["rev-parse", "--path-format=absolute", "--git-path", &name]) {
            println!("cargo:rerun-if-changed={path}");
        }
    }
}
