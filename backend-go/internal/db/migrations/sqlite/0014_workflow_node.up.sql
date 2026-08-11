CREATE TABLE workflow_node (
    id TEXT PRIMARY KEY,
    version TEXT NOT NULL DEFAULT '0.1.0',
    workflow_id TEXT NOT NULL REFERENCES workflow(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    ui_config TEXT DEFAULT '{}',
    node_config TEXT DEFAULT '{}',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX workflow_node_workflow_id_idx ON workflow_node(workflow_id);
CREATE INDEX workflow_node_kind_idx ON workflow_node(kind);
