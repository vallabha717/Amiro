use std::fs;
use std::path::Path;
use std::process::Command;

#[test]
fn test_bin_amiro_branding_and_instructions() {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let bin_path = Path::new(manifest_dir).join("../../bin/amiro");
    let content = fs::read_to_string(&bin_path)
        .unwrap_or_else(|err| panic!("failed to read {:?}: {}", bin_path, err));

    // Assert Amiro branding present
    assert!(
        content.contains("Amiro CLI") || content.contains("amiro"),
        "Amiro branding missing from bin/amiro"
    );

    // Assert no user-facing jcode instruction
    assert!(
        !content.contains("Run `jcode`"),
        "found user-facing jcode instruction in bin/amiro"
    );
    assert!(
        !content.contains("npm install -g jcode"),
        "found user-facing jcode install instruction in bin/amiro"
    );
    assert!(
        !content.contains("jcode <args>"),
        "found user-facing jcode argument instruction in bin/amiro"
    );
}

#[test]
fn test_bin_amiro_version_execution() {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let bin_path = Path::new(manifest_dir).join("../../bin/amiro");

    let output = Command::new("sh")
        .arg(&bin_path)
        .arg("--version")
        .output()
        .expect("failed to execute sh ../../bin/amiro --version");

    assert!(
        output.status.success(),
        "bin/amiro --version failed with exit code {:?}, stderr: {}",
        output.status.code(),
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("amiro: delegation shim") || stdout.contains("amiro"),
        "output should identify as amiro delegation shim: {}",
        stdout
    );
}

#[test]
fn test_bin_amiro_help_execution() {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let bin_path = Path::new(manifest_dir).join("../../bin/amiro");

    let output = Command::new("sh")
        .arg(&bin_path)
        .arg("--help")
        .output()
        .expect("failed to execute sh ../../bin/amiro --help");

    assert!(
        output.status.success(),
        "bin/amiro --help failed with exit code {:?}, stderr: {}",
        output.status.code(),
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("Usage: amiro"), "output should show usage: {}", stdout);
}

#[test]
fn test_bin_amiro_delegation() {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let bin_path = Path::new(manifest_dir).join("../../bin/amiro");

    // Test that AMIRO_RUNTIME_BIN delegates arguments to the target binary
    let output = Command::new("sh")
        .arg(&bin_path)
        .arg("-c")
        .arg("echo AMIRO_REAL_DELEGATION_TEST")
        .env("AMIRO_RUNTIME_BIN", "sh")
        .output()
        .expect("failed to execute amiro with AMIRO_RUNTIME_BIN=sh");

    assert!(
        output.status.success(),
        "delegated execution failed: code {:?}, stderr: {}",
        output.status.code(),
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("AMIRO_REAL_DELEGATION_TEST"),
        "stdout should contain delegated output: {}",
        stdout
    );
}

#[test]
fn test_bin_amiro_missing_engine_error() {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let bin_path = Path::new(manifest_dir).join("../../bin/amiro");

    // Restrict PATH to standard system dirs so jcode in ~/.local/bin is not found
    let output = Command::new("/bin/sh")
        .arg(&bin_path)
        .arg("some-subcommand")
        .env("PATH", "/usr/bin:/bin")
        .env_remove("AMIRO_RUNTIME_BIN")
        .env_remove("AMIRO_JCODE_BIN")
        .env_remove("JCODE_BIN")
        .output()
        .expect("failed to execute amiro with missing engine");

    assert_eq!(
        output.status.code(),
        Some(127),
        "expected exit 127 when engine is missing"
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("no runtime engine found"),
        "stderr should inform about missing runtime engine: {}",
        stderr
    );
}
