use amiro_testkit::{
    find_files_with_extension, find_repo_root, inspect_adapter_server, inspect_tauri_contract,
};

#[test]
fn test_zero_own_go_files_in_repo() {
    let repo_root = find_repo_root();
    // Exclude third-party / ignored directories
    let skip_dirs = &[
        "node_modules",
        "target",
        ".git",
        "runtime",
        ".next",
        "out",
    ];

    let go_files = find_files_with_extension(&repo_root, "go", skip_dirs);
    assert!(
        go_files.is_empty(),
        "found remaining Go files in repo: {:?}",
        go_files
    );
}

#[test]
fn test_real_adapter_server_exists_and_configured() {
    let repo_root = find_repo_root();
    let summary = inspect_adapter_server(&repo_root).expect("failed to inspect adapter server");

    assert!(summary.file_exists, "adapter/src/server.mjs must exist");
    assert!(
        summary.references_amiro_port,
        "adapter/src/server.mjs must reference AMIRO_PORT"
    );
    assert!(
        summary.references_amiro_token,
        "adapter/src/server.mjs must reference AMIRO_TOKEN"
    );
    assert!(
        summary.references_auth_module,
        "adapter/src/server.mjs must reference auth module"
    );
    assert!(
        summary.health_endpoint_defined,
        "adapter/src/auth.mjs must implement health endpoint"
    );
}

#[test]
fn test_real_tauri_configuration_and_license() {
    let repo_root = find_repo_root();
    let summary = inspect_tauri_contract(&repo_root).expect("failed to inspect tauri contract");

    assert!(summary.cargo_toml_exists, "clients/desktop/Cargo.toml must exist");
    assert_eq!(
        summary.lib_name.as_deref(),
        Some("amiro_desktop"),
        "clients/desktop lib name must be amiro_desktop"
    );
    assert_eq!(
        summary.package_license.as_deref(),
        Some("MIT"),
        "clients/desktop package license must be MIT"
    );
    assert!(
        summary.main_calls_lib,
        "clients/desktop/src/main.rs must call amiro_desktop::run()"
    );
}
