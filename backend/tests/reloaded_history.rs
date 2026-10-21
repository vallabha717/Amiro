//! A saved chat reopened after a reload must look like the live one: the
//! model's thinking becomes `reasoning` parts and runtime bookkeeping rows
//! (the "[auto]" capability-guidance turn) never reach the page.
use serde_json::Value;

#[test]
fn reloaded_thread_has_reasoning_parts_and_no_leaked_markup() {
    let rows: Vec<Value> =
        serde_json::from_str(include_str!("fixtures/reloaded_reasoning_history.json")).unwrap();
    let messages = backend::threads::history_to_messages("t", "s", &rows);
    let dump = serde_json::to_string(&messages).unwrap();

    assert!(!dump.contains('\u{2063}'), "reasoning sentinel leaked into the page");
    assert!(!dump.contains("Credential Security"), "[auto] guidance leaked");
    assert!(!dump.contains("<Human Label>"), "SECRET_PROMPT template leaked");

    let reasoning_parts = messages
        .iter()
        .flat_map(|m| m["parts"].as_array().cloned().unwrap_or_default())
        .filter(|p| p["type"] == "reasoning")
        .count();
    assert!(reasoning_parts >= 3, "expected reasoning parts, got {reasoning_parts}");
    for m in &messages {
        for p in m["parts"].as_array().into_iter().flatten() {
            if p["type"] == "text" {
                let t = p["text"].as_str().unwrap_or("");
                assert!(!t.starts_with('*'), "dim/italic wrapper leaked into answer text: {t:?}");
            }
        }
    }
}
