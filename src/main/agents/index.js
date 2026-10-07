'use strict';

// Entry point for main.js. Adapters (hermes, claude, codex) are loaded by the hub, each on its own.

const { AgentHub, toolLabel } = require('./hub');
const { AgentConfig, AgentError, AGENT_IDS } = require('./config');
const { McpServer } = require('./mcp');

module.exports = { AgentHub, AgentConfig, AgentError, AGENT_IDS, McpServer, toolLabel };
