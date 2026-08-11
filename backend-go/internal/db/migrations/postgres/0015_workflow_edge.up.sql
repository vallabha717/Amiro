CREATE TABLE workflow_edge (
    id TEXT PRIMARY KEY,
    version TEXT NOT NULL DEFAULT '0.1.0',
    workflow_id TEXT NOT NULL REFERENCES workflow(id) ON DELETE CASCADE,
    source TEXT NOT NULL REFERENCES workflow_node(id) ON DELETE CASCADE,
    target TEXT NOT NULL REFERENCES workflow_node(id) ON DELETE CASCADE,
    ui_config JSONB DEFAULT '{}',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX workflow_edge_workflow_id_idx ON workflow_edge(workflow_id);
CREATE INDEX workflow_edge_source_idx ON workflow_edge(source);
CREATE INDEX workflow_edge_target_idx ON workflow_edge(target);
