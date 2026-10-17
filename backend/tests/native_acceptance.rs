//! Acceptance checks run the real native executable, never the Node adapter.
use reqwest::{Client, StatusCode};
use serde_json::{json, Value};
use std::{
    fs,
    net::TcpListener,
    path::PathBuf,
    process::{Child, Command, Stdio},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

struct Server {
    child: Child,
    home: PathBuf,
    url: String,
    client: Client,
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        // This directory is created uniquely by this fixture, never user state.
        let _ = fs::remove_dir_all(&self.home);
    }
}

impl Server {
    async fn start(secret: &str) -> Self {
        Self::start_config(secret, false).await
    }

    async fn start_config(secret: &str, registration: bool) -> Self {
        let port = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::var_os("AMIRO_TEST_TEMP_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let home = root.join(format!(
            "amiro-native-acceptance-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(home.join("runtime")).unwrap();
        let child = Command::new(env!("CARGO_BIN_EXE_amiro-backend"))
            .env("AMIRO_HOME", &home)
            .env("AMIRO_RUNTIME_HOME", home.join("runtime"))
            .env("AMIRO_API_SOCKET", home.join("absent-runtime.sock"))
            .env("AMIRO_PORT", port.to_string())
            .env("AMIRO_HOST", "127.0.0.1")
            .env("AMIRO_TOKEN", secret)
            .env("AMIRO_SEED_ADMIN", "1")
            .env(
                "AMIRO_ALLOW_REGISTRATION",
                if registration { "1" } else { "0" },
            )
            .env("AMIRO_ALLOWED_ORIGIN", "http://tauri.localhost")
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let client = Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let mut server = Self {
            child,
            home,
            url: format!("http://127.0.0.1:{port}"),
            client,
        };
        for _ in 0..100 {
            if let Some(status) = server.child.try_wait().unwrap() {
                panic!("native backend exited before readiness: {status}");
            }
            if server
                .client
                .get(format!("{}/health", server.url))
                .header("X-Amiro-Token", secret)
                .send()
                .await
                .is_ok_and(|r| r.status().is_success())
            {
                return server;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        panic!("native backend did not become healthy");
    }

    async fn login(&self, secret: &str) -> String {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(self.home.join("admin-initial-password"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(
                mode & 0o077,
                0,
                "bootstrap password must not be readable by other users"
            );
        }
        let credentials: Value = serde_json::from_slice(
            &fs::read(self.home.join("admin-initial-password"))
                .expect("native backend must persist a generated bootstrap password"),
        )
        .unwrap();
        let response = self
            .client
            .post(format!("{}/api/auth/login", self.url))
            .header("X-Amiro-Token", secret)
            .json(&json!({"email": credentials["email"], "password": credentials["password"]}))
            .send()
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::OK,
            "bootstrap credentials must authenticate without resetting any account"
        );
        let body: Value = response.json().await.unwrap();
        body["token"].as_str().expect("login token").to_owned()
    }
}

#[tokio::test]
async fn native_sidecar_secret_and_bearer_are_independent_boundaries() {
    let server = Server::start("test-sidecar-secret").await;
    let response = server
        .client
        .get(format!("{}/api/auth/status", server.url))
        .send()
        .await
        .unwrap();
    assert!(matches!(
        response.status(),
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN
    ));
    let response = server
        .client
        .get(format!("{}/api/agent/identity", server.url))
        .header("X-Amiro-Token", "test-sidecar-secret")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let token = server.login("test-sidecar-secret").await;
    let response = server
        .client
        .get(format!("{}/api/agent/identity", server.url))
        .bearer_auth(&token)
        .header("X-Amiro-Token", "wrong-secret")
        .send()
        .await
        .unwrap();
    assert!(matches!(
        response.status(),
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN
    ));
    let response = server
        .client
        .put(format!("{}/api/agent/identity", server.url))
        .bearer_auth(&token)
        .header("X-Amiro-Token", "test-sidecar-secret")
        .header("Origin", "https://untrusted.invalid")
        .json(&json!({"name":"Untrusted change"}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn native_identity_roundtrip_and_workspace_are_real_and_contained() {
    let server = Server::start("").await;
    let token = server.login("").await;
    let response = server.client.put(format!("{}/api/agent/identity", server.url)).bearer_auth(&token)
        .json(&json!({"name":"Amiro Studio", "tagline":"Native acceptance", "traits":{"bodyShape":"cloud","eyeStyle":"curious","color":"purple"}})).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let identity: Value = server
        .client
        .get(format!("{}/api/agent/identity", server.url))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(identity["name"], "Amiro Studio");
    assert_eq!(identity["traits"]["bodyShape"], "cloud");
    let response = server
        .client
        .put(format!("{}/api/agent/identity", server.url))
        .bearer_auth(&token)
        .json(&json!({"customImageUrl":"data:image/svg+xml;base64,PHN2Zz4="}))
        .send()
        .await
        .unwrap();
    assert_eq!(
        response.status(),
        StatusCode::BAD_REQUEST,
        "active SVG avatar content must remain blocked"
    );
    let response = server
        .client
        .get(format!("{}/api/agent/workspace", server.url))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let listing: Value = response.json().await.unwrap();
    let roots = listing["roots"].as_array().expect("workspace roots");
    assert!(roots.iter().any(|r| r["id"] == "runtime"));
    assert!(
        !serde_json::to_string(&listing)
            .unwrap()
            .to_lowercase()
            .contains("jcode"),
        "fresh native workspace must use Amiro branding"
    );
    for path in [
        "../users.json",
        "auth.json",
        "credentials.json",
        ".ssh/id_rsa",
    ] {
        let response = server
            .client
            .get(format!("{}/api/agent/workspace/file", server.url))
            .query(&[("root", "runtime"), ("path", path)])
            .bearer_auth(&token)
            .send()
            .await
            .unwrap();
        assert!(
            matches!(
                response.status(),
                StatusCode::BAD_REQUEST | StatusCode::FORBIDDEN | StatusCode::NOT_FOUND
            ),
            "sensitive path {path} unexpectedly accessible: {}",
            response.status()
        );
    }
    #[cfg(unix)]
    {
        fs::create_dir_all(server.home.join("runtime/memory")).unwrap();
        fs::write(
            server.home.join("outside.json"),
            "{\"secret\":\"outside-runtime-root\"}",
        )
        .unwrap();
        std::os::unix::fs::symlink(
            server.home.join("outside.json"),
            server.home.join("runtime/memory/escape.json"),
        )
        .unwrap();
        let response = server
            .client
            .get(format!("{}/api/agent/workspace/file", server.url))
            .query(&[("root", "runtime"), ("path", "memory/escape.json")])
            .bearer_auth(&token)
            .send()
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::FORBIDDEN,
            "allowlisted names must not bypass realpath containment"
        );
    }
    let response = server.client.put(format!("{}/api/agent/workspace/file", server.url)).bearer_auth(&token)
        .json(&json!({"root":"runtime","path":"prompt-overlay.md","content":"must not overwrite shared runtime state"})).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::NOT_IMPLEMENTED);
    assert!(!server.home.join("runtime/prompt-overlay.md").exists());
}

#[tokio::test]
async fn native_registration_cannot_escalate_or_clobber_another_persona() {
    let server = Server::start_config("", true).await;
    let admin_token = server.login("").await;
    let registration = server.client.post(format!("{}/api/auth/register", server.url))
        .json(&json!({"name":"Studio Member","email":"member@example.test","password":"acceptance-only-password-9071","role":"admin"}))
        .send().await.unwrap();
    assert!(registration.status().is_success());
    let member: Value = registration.json().await.unwrap();
    assert_eq!(
        member["user"]["role"], "user",
        "registration must ignore requested privileged roles"
    );
    let token = member["token"].as_str().unwrap();
    let response = server
        .client
        .put(format!("{}/api/agent/identity", server.url))
        .bearer_auth(token)
        .json(&json!({"name":"Member Persona"}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let identity: Value = server
        .client
        .get(format!("{}/api/agent/identity", server.url))
        .bearer_auth(&admin_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_ne!(
        identity["name"], "Member Persona",
        "personas must remain per-user"
    );
    let member_identity: Value = server
        .client
        .get(format!("{}/api/agent/identity", server.url))
        .bearer_auth(token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(member_identity["name"], "Member Persona");
    assert!(
        member_identity.get("memoryStats").is_none(),
        "shared machine memory statistics are admin-only"
    );
    for route in ["/api/agent/workspace", "/api/agent/memory"] {
        let response = server
            .client
            .get(format!("{}{route}", server.url))
            .bearer_auth(token)
            .send()
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::FORBIDDEN,
            "member must not access {route}"
        );
    }
}
