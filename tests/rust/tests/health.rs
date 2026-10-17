use std::env;
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

#[test]
fn test_health_check() {
    let url_opt = env::var("AMIRO_TEST_URL")
        .or_else(|_| env::var("AMIRO_SERVER_URL"))
        .ok();

    let url = match url_opt {
        Some(u) if !u.trim().is_empty() => u,
        _ => {
            eprintln!("AMIRO_TEST_URL not set; skipping health check.");
            return;
        }
    };

    let trimmed = url
        .trim_start_matches("http://")
        .trim_start_matches("https://");
    let host_port = trimmed.split('/').next().unwrap_or(trimmed);
    let mut parts = host_port.split(':');
    let host = parts.next().unwrap_or("127.0.0.1");
    let port: u16 = parts.next().and_then(|p| p.parse().ok()).unwrap_or(80);

    let addrs: Vec<_> = match (host, port).to_socket_addrs() {
        Ok(iter) => iter.collect(),
        Err(e) => {
            panic!("failed to resolve {}:{}: {}", host, port, e);
        }
    };

    let addr = match addrs.first() {
        Some(a) => *a,
        None => panic!("no socket address resolved for {}:{}", host, port),
    };

    let mut stream = match TcpStream::connect_timeout(&addr, Duration::from_secs(5)) {
        Ok(s) => s,
        Err(e) => {
            panic!("failed to connect to {}: {}", addr, e);
        }
    };

    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .expect("failed to set read timeout");
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .expect("failed to set write timeout");

    let request = format!(
        "GET /health HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n\r\n",
        host
    );
    stream
        .write_all(request.as_bytes())
        .expect("failed to send request");

    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .expect("failed to read response");

    assert!(
        response.starts_with("HTTP/1.1 200") || response.starts_with("HTTP/1.0 200"),
        "expected 200 OK from /health, got:\n{}",
        response
    );
}
