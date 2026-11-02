//! The schedule templates that ship with Amiro.
//!
//! One catalog, `backend/schedule-templates.json`, feeds both the Schedules
//! page (`GET /api/schedules/templates`) and the agent
//! (`schedule_templates_list`), so what a user picks on the page is what the
//! agent customizes in chat.

use std::sync::OnceLock;

use serde_json::{json, Value};

const CATALOG: &str = include_str!("../schedule-templates.json");

/// Every template, in display order.
pub fn all() -> &'static [Value] {
    static PARSED: OnceLock<Vec<Value>> = OnceLock::new();
    PARSED.get_or_init(|| serde_json::from_str(CATALOG).expect("schedule-templates.json is valid"))
}

/// The template with this id, if Amiro ships one.
pub fn find(id: &str) -> Option<&'static Value> {
    all().iter().find(|t| t["id"] == id)
}

/// OpenUI string literal (the same quoting and escapes as JSON).
fn quoted(s: &str) -> String {
    Value::from(s).to_string()
}

/// The OpenUI form that customizes a template: one field per `customize`
/// entry, a submit button, and a follow-up that accepts the defaults.
pub fn openui_form(template: &Value) -> String {
    let name = template["name"].as_str().unwrap_or("Schedule");
    let summary = template["summary"].as_str().unwrap_or("");
    let mut refs = Vec::new();
    let mut lines = Vec::new();
    let fields = template["customize"].as_array().map(Vec::as_slice).unwrap_or(&[]);
    for (i, field) in fields.iter().enumerate() {
        let key = quoted(field["key"].as_str().unwrap_or(""));
        let label = quoted(field["label"].as_str().unwrap_or(""));
        let default_text = quoted(field["default"].as_str().unwrap_or(""));
        let line = match field["type"].as_str() {
            Some("switch") => format!(
                "FormSwitch({key}, {label}, {})",
                field["default"].as_bool().unwrap_or(false)
            ),
            Some("select") => {
                format!("FormSelect({key}, {label}, {}, {default_text})", field["options"])
            }
            _ => format!(
                "FormInput({key}, {label}, {}, {default_text})",
                quoted(field["placeholder"].as_str().unwrap_or(""))
            ),
        };
        refs.push(format!("f{i}"));
        lines.push(format!("f{i} = {line}"));
    }
    let submit_message = format!("Create my {name} schedule with these choices");
    let defaults_message = format!("Create my {name} schedule now with the recommended defaults.");
    format!(
        "root = Stack([header, form, followUps])\n\
         header = CardHeader({}, {}, \"Customize\")\n\
         form = InteractiveForm(\"Make it yours\", [{}], \"Create schedule\", {})\n\
         {}\n\
         followUps = FollowUpBlock([fuDefaults])\n\
         fuDefaults = FollowUpItem(\"Use the recommended defaults\", {})",
        quoted(name),
        quoted(summary),
        refs.join(", "),
        quoted(&submit_message),
        lines.join("\n"),
        quoted(&defaults_message),
    )
}

/// What the agent sees for one template: the whole recipe plus how to use it.
pub fn agent_detail(template: &Value) -> Value {
    let id = template["id"].as_str().unwrap_or("");
    json!({
        "template": template,
        "nextSteps": format!(
            "Show the options with ui_render_openui {{\"template_id\":\"{id}\"}}, adapt the prompt to \
             the answers, then call schedule_create with template_id \"{id}\"."
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn catalog_is_complete_and_ids_are_unique() {
        let mut ids = HashSet::new();
        for t in all() {
            let id = t["id"].as_str().expect("id");
            assert!(ids.insert(id), "duplicate template id {id}");
            for field in ["name", "summary", "prompt", "category", "icon"] {
                assert!(t[field].as_str().is_some_and(|s| !s.is_empty()), "{id} lacks {field}");
            }
            assert!(
                ["agent", "execute", "notify"].contains(&t["mode"].as_str().unwrap_or("")),
                "{id} has an unknown mode"
            );
            assert!(
                ["daily", "weekdays", "weekly"].contains(&t["cadence"]["kind"].as_str().unwrap_or("")),
                "{id} has a cadence the schedule form cannot prefill"
            );
            assert!(t["customize"].as_array().is_some_and(|c| !c.is_empty()), "{id} has no options");
        }
        assert!(find("morning-briefing").is_some());
        assert!(find("nope").is_none());
    }

    #[test]
    fn openui_form_has_every_option_and_escapes_text() {
        let form = openui_form(&json!({
            "name": "Quote \"test\"",
            "summary": "s",
            "customize": [
                {"key":"a","type":"switch","label":"A","default":true},
                {"key":"b","type":"select","label":"B","options":["x","y"],"default":"y"},
                {"key":"c","type":"input","label":"C","placeholder":"p"}
            ]
        }));
        assert!(form.contains(r#"FormSwitch("a", "A", true)"#));
        assert!(form.contains(r#"FormSelect("b", "B", ["x","y"], "y")"#));
        assert!(form.contains(r#"FormInput("c", "C", "p", "")"#));
        assert!(form.contains(r#"[f0, f1, f2]"#));
        assert!(form.contains(r#"Quote \"test\""#));
    }
}
