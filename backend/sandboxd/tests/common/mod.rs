//! Shared helpers: drive the supervisor router in-process.

#![allow(dead_code)]

use axum::body::{to_bytes, Body};
use axum::http::{Method, Request};
use axum::Router;
use sandboxd::credential::agent_credential;
use serde_json::Value;
use tower::ServiceExt;

pub const TOKEN: &str = "test-supervisor-token-0123456789abcdef";
pub const MASTER: &str = "test-master-secret-fedcba9876543210ffff";

pub struct Call<'a> {
    pub method: Method,
    pub path: String,
    pub token: Option<&'a str>,
    /// Agent id whose credential to send.
    pub as_agent: Option<&'a str>,
    pub body: Option<Value>,
}

pub async fn call(app: &Router, call: Call<'_>) -> (u16, Value) {
    let mut builder = Request::builder().method(call.method).uri(call.path);
    if let Some(token) = call.token {
        builder = builder.header("authorization", format!("Bearer {token}"));
    }
    if let Some(agent) = call.as_agent {
        builder = builder.header(sandboxd::CREDENTIAL_HEADER, agent_credential(MASTER, agent));
    }
    let body = match call.body {
        Some(body) => {
            builder = builder.header("content-type", "application/json");
            Body::from(body.to_string())
        }
        None => Body::empty(),
    };
    let response = app.clone().oneshot(builder.body(body).unwrap()).await.unwrap();
    let status = response.status().as_u16();
    let bytes = to_bytes(response.into_body(), 4 * 1024 * 1024).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

/// An authorised call for `agent` to `/v1/agents/{agent}/{action}`.
pub async fn agent(app: &Router, method: Method, agent: &str, action: &str, body: Option<Value>) -> (u16, Value) {
    call(
        app,
        Call {
            method,
            path: format!("/v1/agents/{agent}/{action}"),
            token: Some(TOKEN),
            as_agent: Some(agent),
            body,
        },
    )
    .await
}
