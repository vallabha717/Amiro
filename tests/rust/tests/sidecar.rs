use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::Command;

#[test]
fn test_build_sidecar_script_execution() {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let repo_root = Path::new(manifest_dir).join("../..");
    let script_path = repo_root.join("src-tauri/build-sidecar.sh");

    assert!(script_path.is_file(), "src-tauri/build-sidecar.sh must exist");

    // Execute build-sidecar.sh with explicit triple
    let test_triple = "x86_64-unknown-linux-gnu";
    let output = Command::new("bash")
        .arg(&script_path)
        .arg(test_triple)
        .current_dir(&repo_root)
        .output()
        .expect("failed to run src-tauri/build-sidecar.sh");

    assert!(
        output.status.success(),
        "build-sidecar.sh failed: code {:?}, stderr: {}",
        output.status.code(),
        String::from_utf8_lossy(&output.stderr)
    );

    // Verify generated launcher
    let launcher_path = repo_root.join(format!("src-tauri/binaries/backend-{}", test_triple));
    assert!(
        launcher_path.is_file(),
        "expected sidecar launcher at {:?}",
        launcher_path
    );

    let metadata = fs::metadata(&launcher_path).expect("failed to get launcher metadata");
    let permissions = metadata.permissions();
    let mode = permissions.mode();
    assert!(
        mode & 0o111 != 0,
        "launcher must be executable, got mode {:o}",
        mode
    );

    let content = fs::read_to_string(&launcher_path).expect("failed to read launcher content");
    assert!(
        content.starts_with("#!/usr/bin/env bash"),
        "launcher must have bash shebang: {}",
        content
    );
    assert!(
        content.contains("adapter/src/server.mjs"),
        "launcher must target adapter/src/server.mjs: {}",
        content
    );
}
