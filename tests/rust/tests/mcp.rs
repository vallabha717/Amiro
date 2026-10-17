use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Command, Stdio};

#[test]
fn test_mcp_fixture_jsonrpc_protocol() {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let fixture_path = Path::new(manifest_dir).join("../../tests/fixtures/mcp/server/server.mjs");

    assert!(
        fixture_path.is_file(),
        "MCP test fixture must exist at {:?}",
        fixture_path
    );

    let mut child = Command::new("node")
        .arg(&fixture_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("failed to spawn node with MCP server fixture");

    let mut stdin = child.stdin.take().expect("failed to open stdin");
    let stdout = child.stdout.take().expect("failed to open stdout");
    let mut reader = BufReader::new(stdout);

    // 1. Initialize
    let init_req = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#;
    writeln!(stdin, "{}", init_req).expect("failed to write initialize request");
    stdin.flush().expect("failed to flush stdin");

    let mut init_res = String::new();
    reader
        .read_line(&mut init_res)
        .expect("failed to read initialize response");
    assert!(
        init_res.contains("deterministic-mcp-fixture"),
        "initialize response must contain fixture name: {}",
        init_res
    );
    assert!(
        init_res.contains(r#""protocolVersion":"2024-11-05""#),
        "initialize response must have protocolVersion: {}",
        init_res
    );

    // 2. Tools list
    let list_req = r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#;
    writeln!(stdin, "{}", list_req).expect("failed to write tools/list request");
    stdin.flush().expect("failed to flush stdin");

    let mut list_res = String::new();
    reader
        .read_line(&mut list_res)
        .expect("failed to read tools/list response");
    assert!(list_res.contains("echo"), "tools list must contain echo");
    assert!(list_res.contains("slow"), "tools list must contain slow");
    assert!(list_res.contains("fail"), "tools list must contain fail");
    assert!(list_res.contains("crash"), "tools list must contain crash");
    assert!(list_res.contains("big"), "tools list must contain big");
    assert!(
        list_res.contains("needs_approval"),
        "tools list must contain needs_approval"
    );

    // 3. Tool call: echo
    let call_req = r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"echo","arguments":{"message":"hello-mcp-test"}}}"#;
    writeln!(stdin, "{}", call_req).expect("failed to write tools/call request");
    stdin.flush().expect("failed to flush stdin");

    let mut call_res = String::new();
    reader
        .read_line(&mut call_res)
        .expect("failed to read tools/call response");
    assert!(
        call_res.contains("echo: hello-mcp-test"),
        "tool call result must echo back: {}",
        call_res
    );

    // Drop stdin to close pipe and let child exit gracefully
    drop(stdin);
    let status = child.wait().expect("failed to wait on child process");
    assert!(status.success() || status.code() == Some(0));
}
