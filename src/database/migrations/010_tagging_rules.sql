-- Migration: 010_tagging_rules
-- Created: 2026-01-16
-- Description: Adds tagging rules engine for automated video tagging based on patterns

-- Tagging rules table
CREATE TABLE IF NOT EXISTS tagging_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    rule_type TEXT NOT NULL DEFAULT 'path_match',
    is_enabled BOOLEAN DEFAULT 1,
    priority INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tagging_rules_enabled ON tagging_rules(is_enabled);
CREATE INDEX IF NOT EXISTS idx_tagging_rules_priority ON tagging_rules(priority);

-- Rule conditions (what to match)
CREATE TABLE IF NOT EXISTS tagging_rule_conditions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_id INTEGER NOT NULL,
    condition_type TEXT NOT NULL,
    operator TEXT NOT NULL,
    value TEXT NOT NULL,
    FOREIGN KEY (rule_id) REFERENCES tagging_rules(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tagging_rule_conditions_rule ON tagging_rule_conditions(rule_id);

-- Rule actions (what to do when matched)
CREATE TABLE IF NOT EXISTS tagging_rule_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_id INTEGER NOT NULL,
    action_type TEXT NOT NULL,
    target_id INTEGER,
    target_name TEXT,
    dynamic_value TEXT,
    FOREIGN KEY (rule_id) REFERENCES tagging_rules(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tagging_rule_actions_rule ON tagging_rule_actions(rule_id);

-- Tagging rule execution log
CREATE TABLE IF NOT EXISTS tagging_rule_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_id INTEGER NOT NULL,
    video_id INTEGER NOT NULL,
    applied_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    success BOOLEAN DEFAULT 1,
    error_message TEXT,
    FOREIGN KEY (rule_id) REFERENCES tagging_rules(id) ON DELETE CASCADE,
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tagging_rule_log_video ON tagging_rule_log(video_id);
CREATE INDEX IF NOT EXISTS idx_tagging_rule_log_rule ON tagging_rule_log(rule_id);
CREATE INDEX IF NOT EXISTS idx_tagging_rule_log_applied ON tagging_rule_log(applied_at);

-- Seed example rules
INSERT OR IGNORE INTO tagging_rules (id, name, description, rule_type, is_enabled, priority) VALUES
    (1, 'OnlyFans Creator Folders', 'Tag videos from creator folders in OnlyFans directory', 'path_match', 1, 100),
    (2, 'Fansly Videos', 'Tag videos from Fansly platform', 'path_match', 1, 90),
    (3, '4K Videos', 'Tag videos with 4K resolution', 'metadata_match', 1, 80);

INSERT OR IGNORE INTO tagging_rule_conditions (rule_id, condition_type, operator, value) VALUES
    (1, 'path_pattern', 'matches', '/OnlyFans/(?<creator>[^/]+)/*'),
    (2, 'path_pattern', 'matches', '(?i)/*fansly*/*'),
    (3, 'resolution', 'equals', '3840x2160');

INSERT OR IGNORE INTO tagging_rule_actions (rule_id, action_type, target_name) VALUES
    (1, 'add_tag', 'OnlyFans'),
    (1, 'add_creator', NULL),
    (2, 'add_tag', 'Fansly'),
    (3, 'add_tag', '4K');
